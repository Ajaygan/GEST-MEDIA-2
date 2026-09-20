import {
  ACTIONS,
  ACTION_META,
  DEFAULT_SETTINGS,
  GESTURE_META,
  MSG,
  PERFORMANCE_PRESETS
} from '../lib/constants.js';
import { classifyLandmarks } from '../lib/gestures.js';
import {
  chooseCamera,
  isVirtualCamera,
  listCameras,
  openCameraStream,
  requestCameraPermission
} from '../lib/camera.js';
import { loadModel } from '../lib/model-loader.js';

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULT_SETTINGS };

/* ----------------------------------------------------------------- state */

async function send(type, payload = {}) {
  try {
    return await chrome.runtime.sendMessage({ type, ...payload });
  } catch {
    return null;
  }
}

async function patch(patchObj) {
  const res = await send(MSG.SET_SETTINGS, { settings: patchObj });
  if (res?.settings) settings = res.settings;
  render();
}

/* --------------------------------------------------------------- camera */

async function refreshCameraStatus() {
  const el = $('camera-status');
  try {
    const status = await navigator.permissions.query({ name: 'camera' });
    const map = {
      granted: ['Camera access granted — you are good to go.', 'ok'],
      prompt: ['Camera access not granted yet. Click the button below and accept the prompt.', ''],
      denied: [
        'Camera access is blocked for this extension. Use “Open Chrome camera settings” to allow it.',
        'bad'
      ]
    };
    const [text, cls] = map[status.state] || ['Unknown camera permission state.', ''];
    el.textContent = text;
    el.className = `muted ${cls}`;
    $('grant').disabled = status.state === 'granted';
    status.onchange = () => refreshCameraStatus();
  } catch {
    el.textContent = 'Click below and accept the browser prompt to allow the camera.';
  }
}

async function requestCamera() {
  // Deliberately does NOT use getUserMedia({video:true}): that opens Chrome's
  // default device, which on Windows is often the Phone Link virtual camera.
  const { granted, error } = await requestCameraPermission(settings.cameraDeviceId);
  if (!granted) {
    $('camera-status').textContent = `Camera request failed: ${error?.message || error}`;
    $('camera-status').className = 'muted bad';
    return;
  }
  await refreshCameraStatus();
  await renderCameraList();
  if (settings.enabled) await send(MSG.SET_ENABLED, { enabled: true });
}

async function renderCameraList() {
  const select = $('cameraDeviceId');
  const hint = $('camera-hint');
  const cameras = await listCameras();
  select.innerHTML = '';

  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Auto — prefer this computer’s built-in camera';
  select.appendChild(auto);

  for (const cam of cameras) {
    const opt = document.createElement('option');
    opt.value = cam.deviceId;
    const label = cam.label || 'Camera (grant access to see its name)';
    opt.textContent = isVirtualCamera(label) ? `${label} — phone / virtual` : label;
    select.appendChild(opt);
  }
  select.value = cameras.some((c) => c.deviceId === settings.cameraDeviceId)
    ? settings.cameraDeviceId
    : '';

  if (!cameras.length) {
    hint.textContent = 'No cameras found yet — grant access above.';
  } else if (!cameras.some((c) => c.label)) {
    hint.textContent = `${cameras.length} camera(s) found. Grant access to see their names.`;
  } else {
    const picked = chooseCamera(cameras, settings.cameraDeviceId);
    hint.textContent = picked ? `Using: ${picked.label || 'camera'} (${picked.reason})` : '';
  }
}

/* -------------------------------------------------------- live preview */

const HAND_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]
];

const preview = {
  running: false,
  stream: null,
  landmarker: null,
  raf: null,
  lastTs: 0
};

async function startPreview() {
  const video = $('preview');
  const badge = $('preview-badge');
  badge.textContent = 'loading model…';
  try {
    const { FilesetResolver, HandLandmarker } = await import(
      '../vendor/tasks-vision/vision_bundle.mjs'
    );
    const fileset = await FilesetResolver.forVisionTasks(
      chrome.runtime.getURL('vendor/tasks-vision/wasm')
    );
    const { buffer } = await loadModel((stage) => {
      badge.textContent = `model: ${stage}…`;
    });
    const preset = PERFORMANCE_PRESETS[settings.performance] || PERFORMANCE_PRESETS.low;
    preview.landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: buffer, delegate: preset.delegate },
      runningMode: 'VIDEO',
      numHands: 1
    }).catch(() =>
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: buffer, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: 1
      })
    );

    const opened = await openCameraStream({
      preferredId: settings.cameraDeviceId,
      width: preset.captureWidth,
      height: preset.captureHeight,
      fps: preset.captureFps
    });
    preview.stream = opened.stream;
    $('camera-hint').textContent = `Using: ${opened.label || 'camera'} (${opened.reason})`;
    video.srcObject = preview.stream;
    await video.play();
    preview.running = true;
    $('preview-toggle').textContent = 'Stop preview';
    loopPreview();
  } catch (err) {
    badge.textContent = `error: ${err?.message || err}`;
    stopPreview();
  }
}

function stopPreview() {
  preview.running = false;
  cancelAnimationFrame(preview.raf);
  preview.stream?.getTracks().forEach((t) => t.stop());
  preview.stream = null;
  $('preview').srcObject = null;
  $('preview-toggle').textContent = 'Start preview';
  $('preview-badge').textContent = 'idle';
  $('preview-stats').textContent = '';
  const canvas = $('overlay');
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
}

function loopPreview() {
  if (!preview.running) return;
  const video = $('preview');
  const canvas = $('overlay');
  const ctx = canvas.getContext('2d');
  if (video.videoWidth) {
    if (canvas.width !== video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    const started = performance.now();
    let ts = Math.round(started);
    if (ts <= preview.lastTs) ts = preview.lastTs + 1;
    preview.lastTs = ts;
    let result = null;
    try {
      result = preview.landmarker.detectForVideo(video, ts);
    } catch {
      /* transient */
    }
    const took = performance.now() - started;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const lm = result?.landmarks?.[0];
    if (lm) {
      ctx.strokeStyle = 'rgba(124,77,255,.9)';
      ctx.lineWidth = Math.max(2, canvas.width / 220);
      for (const [a, b] of HAND_EDGES) {
        ctx.beginPath();
        ctx.moveTo(lm[a].x * canvas.width, lm[a].y * canvas.height);
        ctx.lineTo(lm[b].x * canvas.width, lm[b].y * canvas.height);
        ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      for (const p of lm) {
        ctx.beginPath();
        ctx.arc(p.x * canvas.width, p.y * canvas.height, ctx.lineWidth, 0, Math.PI * 2);
        ctx.fill();
      }
      const { gesture, confidence, debug } = classifyLandmarks(lm, {
        mirrored: settings.mirrored
      });
      const meta = GESTURE_META[gesture];
      const lift = typeof debug?.thumbLift === 'number' ? ` · thumb ${debug.thumbLift.toFixed(2)}` : '';
      if (meta) {
        const action = settings.mapping?.[gesture];
        $('preview-badge').textContent =
          `${meta.emoji} ${meta.label} → ${ACTION_META[action]?.label ?? '—'} (${confidence.toFixed(2)})${lift}`;
      } else if (debug?.ambiguous) {
        $('preview-badge').textContent = `🤔 unsure — hold the pose steady${lift}`;
      } else {
        $('preview-badge').textContent = `hand detected${lift}`;
      }
    } else {
      $('preview-badge').textContent = 'no hand';
    }
    $('preview-stats').textContent = `${took.toFixed(1)} ms / frame`;
  }
  preview.raf = requestAnimationFrame(loopPreview);
}

/* -------------------------------------------------------------- render */

function renderMapping() {
  const body = $('mapping-body');
  body.innerHTML = '';
  for (const [gesture, meta] of Object.entries(GESTURE_META)) {
    const tr = document.createElement('tr');

    const tdGesture = document.createElement('td');
    tdGesture.innerHTML = `<span class="emoji">${meta.emoji}</span>${meta.label}`;

    const tdAction = document.createElement('td');
    const select = document.createElement('select');
    for (const action of Object.values(ACTIONS)) {
      const opt = document.createElement('option');
      opt.value = action;
      opt.textContent = `${ACTION_META[action].emoji} ${ACTION_META[action].label}`;
      select.appendChild(opt);
    }
    select.value = settings.mapping?.[gesture] ?? DEFAULT_SETTINGS.mapping[gesture];
    select.addEventListener('change', () =>
      patch({ mapping: { ...settings.mapping, [gesture]: select.value } })
    );
    tdAction.appendChild(select);

    const tdEnabled = document.createElement('td');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = !settings.disabledGestures.includes(gesture);
    check.addEventListener('change', () => {
      const disabled = new Set(settings.disabledGestures);
      if (check.checked) disabled.delete(gesture);
      else disabled.add(gesture);
      patch({ disabledGestures: [...disabled] });
    });
    tdEnabled.appendChild(check);

    tr.append(tdGesture, tdAction, tdEnabled);
    body.appendChild(tr);
  }
}

function renderBlocked() {
  const list = $('block-list');
  list.innerHTML = '';
  for (const host of settings.blockedHosts) {
    const li = document.createElement('li');
    li.textContent = host;
    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.title = `Re-enable ${host}`;
    remove.addEventListener('click', () =>
      patch({ blockedHosts: settings.blockedHosts.filter((h) => h !== host) })
    );
    li.appendChild(remove);
    list.appendChild(li);
  }
  if (!settings.blockedHosts.length) {
    const li = document.createElement('li');
    li.textContent = 'none';
    li.style.opacity = '.5';
    list.appendChild(li);
  }
}

const SLIDERS = {
  cooldownMs: (v) => `${v} ms`,
  volumeRepeatMs: (v) => `${v} ms`,
  volumeStep: (v) => `${Math.round(v * 100)} %`,
  seekSeconds: (v) => `${v} s`
};

function render() {
  $('toggle').checked = Boolean(settings.enabled);
  $('performance').value = settings.performance;
  for (const key of ['onlyWhenMediaPresent', 'adaptiveThrottle', 'mirrored', 'showHud']) {
    $(key).checked = Boolean(settings[key]);
  }
  for (const [key, fmt] of Object.entries(SLIDERS)) {
    $(key).value = settings[key];
    $(`${key}-out`).textContent = fmt(settings[key]);
  }
  const preset = PERFORMANCE_PRESETS[settings.performance] || PERFORMANCE_PRESETS.low;
  $('preset-detail').textContent =
    `${preset.label}: ${preset.activeFps} fps active / ${preset.idleFps} fps idle · ` +
    `${preset.inferenceWidth}px inference frames · ${preset.delegate} delegate · ` +
    `${preset.captureWidth}×${preset.captureHeight} capture.`;
  renderMapping();
  renderBlocked();
}

/* ---------------------------------------------------------------- wiring */

function wire() {
  const select = $('performance');
  for (const preset of Object.values(PERFORMANCE_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = preset.id;
    opt.textContent = preset.label;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => patch({ performance: select.value }));

  $('toggle').addEventListener('change', async (e) => {
    const res = await send(MSG.SET_ENABLED, { enabled: e.target.checked });
    if (res?.settings) settings = res.settings;
    render();
  });

  for (const key of ['onlyWhenMediaPresent', 'adaptiveThrottle', 'mirrored', 'showHud']) {
    $(key).addEventListener('change', (e) => patch({ [key]: e.target.checked }));
  }
  for (const key of Object.keys(SLIDERS)) {
    const input = $(key);
    input.addEventListener('input', () => {
      $(`${key}-out`).textContent = SLIDERS[key](Number(input.value));
    });
    input.addEventListener('change', () => patch({ [key]: Number(input.value) }));
  }

  $('grant').addEventListener('click', requestCamera);
  $('cameraDeviceId').addEventListener('change', async (e) => {
    await patch({ cameraDeviceId: e.target.value });
    await renderCameraList();
    if (preview.running) {
      stopPreview();
      startPreview();
    }
  });
  $('refresh-cameras').addEventListener('click', renderCameraList);
  $('use-builtin').addEventListener('click', async () => {
    await requestCameraPermission(settings.cameraDeviceId);
    const cameras = await listCameras();
    const physical = cameras.filter((c) => c.deviceId && !isVirtualCamera(c.label || ''));
    const pick = chooseCamera(physical, '');
    if (!pick?.deviceId) {
      $('camera-hint').textContent =
        'No physical camera found. Check Windows Settings → Cameras, then refresh.';
      return;
    }
    await patch({ cameraDeviceId: pick.deviceId });
    await renderCameraList();
    $('camera-hint').textContent = `Locked to: ${pick.label || 'built-in camera'}`;
    if (preview.running) {
      stopPreview();
      startPreview();
    }
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', renderCameraList);
  $('site-settings').addEventListener('click', () => {
    chrome.tabs.create({ url: `chrome://settings/content/camera` });
  });
  $('preview-toggle').addEventListener('click', () =>
    preview.running ? stopPreview() : startPreview()
  );
  $('block-add').addEventListener('click', () => {
    const raw = $('block-input').value.trim().toLowerCase();
    if (!raw) return;
    const host = raw.replace(/^https?:\/\//, '').split('/')[0];
    if (host && !settings.blockedHosts.includes(host)) {
      patch({ blockedHosts: [...settings.blockedHosts, host] });
    }
    $('block-input').value = '';
  });
  window.addEventListener('pagehide', stopPreview);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'gm:state-changed') {
    settings = msg.settings;
    render();
  }
});

(async () => {
  wire();
  const state = await send(MSG.GET_STATE);
  if (state?.settings) settings = state.settings;
  render();
  await refreshCameraStatus();
  await renderCameraList();
  if (location.hash === '#camera') $('camera-card').scrollIntoView({ behavior: 'smooth' });
})();
