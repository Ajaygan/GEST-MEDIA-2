/**
 * Offscreen detector: webcam capture + MediaPipe HandLandmarker + gesture
 * classification. Runs once for the whole browser and only reports discrete,
 * de-bounced gestures back to the service worker.
 *
 * Low-end device strategy:
 *   - one hand only, lite float16 model, optional CPU delegate
 *   - the camera is opened at a small resolution (320x240 by default) and each
 *     frame is downscaled again before inference
 *   - the loop runs at a low fixed fps (6 by default) and drops to `idleFps`
 *     when no hand has been seen for a few seconds
 *   - if inference consistently takes longer than the frame budget the loop
 *     slows itself down instead of piling up work
 *   - the whole pipeline is suspended (camera released) whenever no tab is
 *     playing media
 */

import { FilesetResolver, HandLandmarker } from '../vendor/tasks-vision/vision_bundle.mjs';
import { classifyLandmarks, GestureStabilizer } from '../lib/gestures.js';
import { openCameraStream } from '../lib/camera.js';
import { loadModel } from '../lib/model-loader.js';
import { DEFAULT_SETTINGS, ENGINE_STATE, MSG, PERFORMANCE_PRESETS } from '../lib/constants.js';

const video = /** @type {HTMLVideoElement} */ (document.getElementById('cam'));

const state = {
  settings: { ...DEFAULT_SETTINGS },
  preset: PERFORMANCE_PRESETS.low,
  landmarker: null,
  stream: null,
  canvas: null,
  ctx: null,
  ticker: null,
  running: false,
  suspended: false,
  busy: false,
  lastHandAt: 0,
  lastTimestamp: 0,
  cameraLabel: '',
  currentIntervalMs: 0,
  avgInferenceMs: 0,
  frames: 0,
  stabilizer: new GestureStabilizer()
};

function report(patch) {
  chrome.runtime
    .sendMessage({ type: MSG.ENGINE_STATUS, ...patch })
    .catch(() => {/* service worker asleep */});
}

function applySettings(settings) {
  state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  state.preset = PERFORMANCE_PRESETS[state.settings.performance] || PERFORMANCE_PRESETS.low;
  state.stabilizer.configure({
    holdFrames: state.preset.holdFrames,
    cooldownMs: state.settings.cooldownMs,
    repeatMs: state.settings.volumeRepeatMs,
    minConfidence: 0.55
  });
}

function targetIntervalMs() {
  const idle = state.settings.adaptiveThrottle && Date.now() - state.lastHandAt > 4000;
  const fps = idle ? state.preset.idleFps : state.preset.activeFps;
  const base = 1000 / Math.max(1, fps);
  // Never schedule faster than ~1.4x the measured inference cost.
  return Math.max(base, state.avgInferenceMs * 1.4);
}

function setTickInterval(ms) {
  const rounded = Math.round(ms / 25) * 25;
  if (rounded === state.currentIntervalMs) return;
  state.currentIntervalMs = rounded;
  state.ticker?.postMessage({ type: 'interval', intervalMs: rounded });
}

async function ensureLandmarker() {
  if (state.landmarker) return state.landmarker;
  report({ state: ENGINE_STATE.LOADING, detail: 'Loading model…' });
  const fileset = await FilesetResolver.forVisionTasks(
    chrome.runtime.getURL('vendor/tasks-vision/wasm')
  );
  const { buffer, source } = await loadModel((stage) =>
    report({ state: ENGINE_STATE.LOADING, detail: `Model: ${stage}…` })
  );

  const create = (delegate) =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: buffer, delegate },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: state.preset.minHandDetectionConfidence,
      minHandPresenceConfidence: state.preset.minHandPresenceConfidence,
      minTrackingConfidence: state.preset.minTrackingConfidence
    });

  try {
    state.landmarker = await create(state.preset.delegate);
  } catch (err) {
    console.warn('[GestMedia] falling back to CPU delegate', err);
    state.landmarker = await create('CPU');
  }
  report({ modelSource: source });
  return state.landmarker;
}

async function openCamera() {
  if (state.stream) return;
  const p = state.preset;
  const { stream, label, reason, deviceId } = await openCameraStream({
    preferredId: state.settings.cameraDeviceId,
    width: p.captureWidth,
    height: p.captureHeight,
    fps: p.captureFps
  });
  state.stream = stream;
  state.cameraLabel = label;
  report({ camera: { label, reason, deviceId } });
  video.srcObject = state.stream;
  await video.play();
  await new Promise((resolve) => {
    if (video.videoWidth) return resolve();
    video.onloadedmetadata = () => resolve();
  });

  const w = state.preset.inferenceWidth;
  const h = Math.round((w * (video.videoHeight || 3)) / (video.videoWidth || 4));
  state.canvas = new OffscreenCanvas(w, h);
  state.ctx = state.canvas.getContext('2d', { alpha: false, willReadFrequently: false });
}

function closeCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  video.srcObject = null;
  state.canvas = null;
  state.ctx = null;
}

function onTick() {
  if (!state.running || state.suspended || state.busy) return;
  if (!state.landmarker || !state.ctx || video.readyState < 2) return;
  state.busy = true;
  try {
    const started = performance.now();
    state.ctx.drawImage(video, 0, 0, state.canvas.width, state.canvas.height);
    let ts = Math.round(started);
    if (ts <= state.lastTimestamp) ts = state.lastTimestamp + 1;
    state.lastTimestamp = ts;

    const result = state.landmarker.detectForVideo(state.canvas, ts);
    const elapsed = performance.now() - started;
    state.avgInferenceMs = state.avgInferenceMs
      ? state.avgInferenceMs * 0.8 + elapsed * 0.2
      : elapsed;
    state.frames += 1;

    const landmarks = result?.landmarks?.[0];
    let gesture = 'none';
    let confidence = 0;
    if (landmarks && landmarks.length >= 21) {
      state.lastHandAt = Date.now();
      const classified = classifyLandmarks(landmarks, { mirrored: state.settings.mirrored });
      gesture = classified.gesture;
      confidence = classified.confidence;
    }

    const fired = state.stabilizer.push(gesture, confidence, Date.now());
    if (fired && !state.settings.disabledGestures.includes(fired.gesture)) {
      chrome.runtime
        .sendMessage({
          type: MSG.GESTURE,
          gesture: fired.gesture,
          repeat: fired.repeat,
          confidence
        })
        .catch(() => {});
    }

    // Lightweight telemetry for the popup (throttled to ~1/s).
    if (state.frames % Math.max(1, Math.round(1000 / Math.max(1, state.currentIntervalMs))) === 0) {
      report({
        state: ENGINE_STATE.RUNNING,
        live: {
          gesture,
          confidence: Number(confidence.toFixed(2)),
          fps: Number((1000 / Math.max(1, state.currentIntervalMs)).toFixed(1)),
          inferenceMs: Number(state.avgInferenceMs.toFixed(1)),
          handVisible: gesture !== 'none' || Date.now() - state.lastHandAt < 1000
        }
      });
    }

    setTickInterval(targetIntervalMs());
  } catch (err) {
    console.error('[GestMedia] detection error', err);
    report({ state: ENGINE_STATE.ERROR, detail: String(err?.message || err) });
  } finally {
    state.busy = false;
  }
}

function startTicker() {
  if (!state.ticker) {
    state.ticker = new Worker(chrome.runtime.getURL('offscreen/ticker-worker.js'));
    state.ticker.onmessage = onTick;
  }
  state.currentIntervalMs = 0;
  setTickInterval(targetIntervalMs());
  state.ticker.postMessage({ type: 'start', intervalMs: state.currentIntervalMs || 150 });
}

function stopTicker() {
  state.ticker?.postMessage({ type: 'stop' });
}

async function start(settings) {
  applySettings(settings);
  if (state.running) {
    await resume();
    return;
  }
  try {
    await ensureLandmarker();
    await openCamera();
    state.running = true;
    state.suspended = false;
    state.stabilizer.reset();
    startTicker();
    report({ state: ENGINE_STATE.RUNNING, detail: 'Watching for gestures' });
  } catch (err) {
    const needsPermission =
      err?.name === 'NotAllowedError' || err?.name === 'SecurityError' || err?.name === 'NotFoundError';
    report({
      state: needsPermission ? ENGINE_STATE.NEEDS_PERMISSION : ENGINE_STATE.ERROR,
      detail: String(err?.message || err)
    });
    stop();
  }
}

function stop() {
  state.running = false;
  state.suspended = false;
  stopTicker();
  closeCamera();
  state.stabilizer.reset();
  report({ state: ENGINE_STATE.OFF });
}

function suspend() {
  if (!state.running || state.suspended) return;
  state.suspended = true;
  stopTicker();
  closeCamera(); // release the camera light while nothing is playing
  report({ state: ENGINE_STATE.SUSPENDED, detail: 'Paused — no media on screen' });
}

async function resume() {
  if (!state.running) return;
  if (!state.suspended && state.stream) return;
  try {
    await openCamera();
    state.suspended = false;
    state.stabilizer.reset();
    startTicker();
    report({ state: ENGINE_STATE.RUNNING, detail: 'Watching for gestures' });
  } catch (err) {
    report({ state: ENGINE_STATE.ERROR, detail: String(err?.message || err) });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case MSG.ENGINE_START:
      start(msg.settings);
      sendResponse({ ok: true });
      break;
    case MSG.ENGINE_STOP:
      stop();
      sendResponse({ ok: true });
      break;
    case MSG.ENGINE_CONFIG: {
      const hadPreset = state.preset.id;
      applySettings(msg.settings);
      if (state.running && hadPreset !== state.preset.id) {
        // resolution / delegate changed -> rebuild the whole pipeline
        state.landmarker?.close?.();
        state.landmarker = null;
        stopTicker();
        closeCamera();
        state.running = false;
        start(msg.settings);
      }
      sendResponse({ ok: true });
      break;
    }
    case MSG.ENGINE_SUSPEND:
      suspend();
      sendResponse({ ok: true });
      break;
    case MSG.ENGINE_RESUME:
      resume();
      sendResponse({ ok: true });
      break;
    case MSG.ENGINE_PING:
      sendResponse({
        ok: true,
        running: state.running,
        suspended: state.suspended,
        inferenceMs: state.avgInferenceMs
      });
      break;
    default:
      return false;
  }
  return true;
});

report({ state: ENGINE_STATE.OFF, detail: 'Detector ready' });
