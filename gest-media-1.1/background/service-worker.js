/**
 * GestMedia service worker.
 *
 * Owns settings, the offscreen detector's lifecycle and the registry of frames
 * that currently contain playable media. Gestures arrive from the offscreen
 * document and are routed as concrete commands to the single best media frame.
 */

import { ACTIONS, DEFAULT_SETTINGS, ENGINE_STATE, MSG } from '../lib/constants.js';

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const STALE_MS = 45_000;

/** @type {Map<string, any>} */
const mediaFrames = new Map();

let settings = { ...DEFAULT_SETTINGS };
let engine = { state: ENGINE_STATE.OFF, detail: '', live: null, modelSource: null };
let lastAction = null;
let creatingOffscreen = null;

const frameKey = (tabId, frameId) => `${tabId}:${frameId}`;

/* ------------------------------------------------------------------ state */

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  return settings;
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

function setBadge() {
  const on = settings.enabled && engine.state !== ENGINE_STATE.ERROR;
  const suspended = engine.state === ENGINE_STATE.SUSPENDED;
  chrome.action.setBadgeText({ text: on ? (suspended ? '⏸' : 'ON') : '' }).catch(() => {});
  chrome.action
    .setBadgeBackgroundColor({ color: suspended ? '#8a6d3b' : '#6d3bff' })
    .catch(() => {});
}

function broadcastState() {
  chrome.runtime
    .sendMessage({ type: 'gm:state-changed', settings, engine, lastAction })
    .catch(() => {});
}

/* --------------------------------------------------------------- offscreen */

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA'],
      justification: 'Webcam hand-gesture recognition for media playback control.'
    })
    .catch((err) => {
      if (!String(err).includes('Only a single offscreen')) throw err;
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  return creatingOffscreen;
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

function sendToEngine(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, settings, ...extra }).catch(() => {});
}

async function startEngine() {
  await ensureOffscreen();
  engine = { ...engine, state: ENGINE_STATE.LOADING, detail: 'Starting…' };
  lastSuspendCommand = null;
  setBadge();
  broadcastState();
  await sendToEngine(MSG.ENGINE_START);
  evaluateSuspension();
}

async function stopEngine() {
  await sendToEngine(MSG.ENGINE_STOP);
  await closeOffscreen();
  engine = { state: ENGINE_STATE.OFF, detail: '', live: null, modelSource: engine.modelSource };
  setBadge();
  broadcastState();
}

async function setEnabled(enabled) {
  await saveSettings({ enabled });
  if (enabled) await startEngine();
  else await stopEngine();
}

/* ------------------------------------------------------------ media routing */

function pruneFrames() {
  const now = Date.now();
  for (const [key, frame] of mediaFrames) {
    if (now - frame.updatedAt > STALE_MS) mediaFrames.delete(key);
  }
}

function isBlocked(url) {
  try {
    const host = new URL(url).hostname;
    return settings.blockedHosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

async function pickTargetFrame() {
  pruneFrames();
  if (!mediaFrames.size) return null;

  let activeTabId = -1;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTabId = tab?.id ?? -1;
  } catch {
    /* ignore */
  }

  let audibleTabIds = new Set();
  try {
    const audible = await chrome.tabs.query({ audible: true });
    audibleTabIds = new Set(audible.map((t) => t.id));
  } catch {
    /* ignore */
  }

  const now = Date.now();
  let best = null;
  let bestScore = -Infinity;
  for (const frame of mediaFrames.values()) {
    if (!frame.hasMedia || isBlocked(frame.url)) continue;
    let score = 0;
    if (frame.playing) score += 1000;
    if (audibleTabIds.has(frame.tabId)) score += 400;
    if (frame.tabId === activeTabId) score += 250;
    if (frame.duration > 0) score += 50;
    score += Math.max(0, 120 - (now - frame.updatedAt) / 250);
    score += frame.area ? Math.min(100, frame.area / 5000) : 0;
    if (score > bestScore) {
      bestScore = score;
      best = frame;
    }
  }
  return best;
}

function actionForGesture(gesture) {
  if (settings.disabledGestures.includes(gesture)) return null;
  return settings.mapping?.[gesture] ?? DEFAULT_SETTINGS.mapping[gesture] ?? null;
}

async function dispatchGesture(gesture, repeat) {
  const action = actionForGesture(gesture);
  if (!action) return;
  if (repeat && action !== ACTIONS.VOLUME_UP && action !== ACTIONS.VOLUME_DOWN) return;

  const target = await pickTargetFrame();
  if (!target) {
    lastAction = { action, gesture, at: Date.now(), ok: false, reason: 'No media found' };
    broadcastState();
    return;
  }

  try {
    const result = await chrome.tabs.sendMessage(
      target.tabId,
      {
        type: MSG.COMMAND,
        action,
        gesture,
        repeat,
        settings: {
          volumeStep: settings.volumeStep,
          seekSeconds: settings.seekSeconds,
          showHud: settings.showHud
        }
      },
      { frameId: target.frameId }
    );
    lastAction = {
      action,
      gesture,
      at: Date.now(),
      ok: Boolean(result?.ok),
      detail: result?.detail || '',
      host: safeHost(target.url)
    };
  } catch (err) {
    mediaFrames.delete(frameKey(target.tabId, target.frameId));
    lastAction = { action, gesture, at: Date.now(), ok: false, reason: String(err?.message || err) };
  }
  broadcastState();
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

let lastSuspendCommand = null;

/** Suspend the camera when nothing on screen can be controlled. */
function evaluateSuspension() {
  if (!settings.enabled) {
    lastSuspendCommand = null;
    return;
  }
  let command = MSG.ENGINE_RESUME;
  if (settings.onlyWhenMediaPresent) {
    pruneFrames();
    const anyMedia = [...mediaFrames.values()].some((f) => f.hasMedia && !isBlocked(f.url));
    command = anyMedia ? MSG.ENGINE_RESUME : MSG.ENGINE_SUSPEND;
  }
  if (command === lastSuspendCommand) return; // avoid chatty no-op messages
  lastSuspendCommand = command;
  sendToEngine(command);
}

/* -------------------------------------------------------------- messaging */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case MSG.GET_STATE:
        await loadSettings();
        sendResponse({ settings, engine, lastAction, mediaFrames: mediaFrames.size });
        break;

      case MSG.SET_ENABLED:
        await setEnabled(Boolean(msg.enabled));
        sendResponse({ ok: true, settings, engine });
        break;

      case MSG.SET_SETTINGS: {
        const before = settings.performance;
        await saveSettings(msg.settings || {});
        if (settings.enabled) {
          await ensureOffscreen();
          await sendToEngine(MSG.ENGINE_CONFIG, { presetChanged: before !== settings.performance });
          evaluateSuspension();
        }
        setBadge();
        broadcastState();
        sendResponse({ ok: true, settings });
        break;
      }

      case MSG.ENGINE_STATUS: {
        engine = {
          ...engine,
          ...(msg.state ? { state: msg.state } : {}),
          ...(msg.detail !== undefined ? { detail: msg.detail } : {}),
          ...(msg.live ? { live: msg.live } : {}),
          ...(msg.modelSource ? { modelSource: msg.modelSource } : {}),
          ...(msg.camera ? { camera: msg.camera } : {})
        };
        setBadge();
        broadcastState();
        sendResponse({ ok: true });
        break;
      }

      case MSG.GESTURE:
        await dispatchGesture(msg.gesture, Boolean(msg.repeat));
        sendResponse({ ok: true });
        break;

      case MSG.MEDIA_REPORT: {
        if (sender.tab?.id == null) return sendResponse({ ok: false });
        const key = frameKey(sender.tab.id, sender.frameId ?? 0);
        if (!msg.hasMedia) mediaFrames.delete(key);
        else
          mediaFrames.set(key, {
            tabId: sender.tab.id,
            frameId: sender.frameId ?? 0,
            url: sender.url || sender.tab.url || '',
            hasMedia: true,
            playing: Boolean(msg.playing),
            duration: msg.duration || 0,
            area: msg.area || 0,
            updatedAt: Date.now()
          });
        evaluateSuspension();
        sendResponse({ ok: true, enabled: settings.enabled });
        break;
      }

      case MSG.HUD: {
        // an iframe asked for the toast; draw it in the tab's top frame
        if (sender.tab?.id != null) {
          chrome.tabs
            .sendMessage(sender.tab.id, { type: MSG.HUD, ...msg }, { frameId: 0 })
            .catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      default:
        return;
    }
  })();
  return true;
});

/* ------------------------------------------------------------- tab events */

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const key of [...mediaFrames.keys()]) {
    if (key.startsWith(`${tabId}:`)) mediaFrames.delete(key);
  }
  evaluateSuspension();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    for (const key of [...mediaFrames.keys()]) {
      if (key.startsWith(`${tabId}:`)) mediaFrames.delete(key);
    }
  }
  if (changeInfo.audible !== undefined) evaluateSuspension();
});

chrome.commands?.onCommand.addListener(async (command) => {
  if (command === 'toggle-gestures') {
    await loadSettings();
    await setEnabled(!settings.enabled);
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await loadSettings();
  setBadge();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html?welcome=1') });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
  setBadge();
  if (settings.enabled) await startEngine();
});

// Wake-up path (service worker restarted while enabled).
(async () => {
  await loadSettings();
  setBadge();
  if (settings.enabled) await startEngine();
})();
