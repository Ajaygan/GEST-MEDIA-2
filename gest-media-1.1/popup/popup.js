import {
  ACTION_META,
  DEFAULT_SETTINGS,
  ENGINE_STATE,
  GESTURE_META,
  MSG,
  PERFORMANCE_PRESETS
} from '../lib/constants.js';

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULT_SETTINGS };
let currentHost = '';

async function send(type, payload = {}) {
  try {
    return await chrome.runtime.sendMessage({ type, ...payload });
  } catch {
    return null;
  }
}

function renderGestures() {
  const list = $('gesture-list');
  list.innerHTML = '';
  for (const [gesture, meta] of Object.entries(GESTURE_META)) {
    const action = settings.mapping?.[gesture] ?? DEFAULT_SETTINGS.mapping[gesture];
    const li = document.createElement('li');
    li.className = settings.disabledGestures.includes(gesture) ? 'off' : '';
    li.innerHTML = `<span class="emoji">${meta.emoji}</span><span>${
      ACTION_META[action]?.label ?? action
    }</span>`;
    li.title = `${meta.label} → ${ACTION_META[action]?.label ?? action}`;
    list.appendChild(li);
  }
}

function renderEngine(engine, lastAction, frames) {
  const dot = $('live-dot');
  const gestureEl = $('live-gesture');
  const perfEl = $('live-perf');
  dot.className = 'live-dot';

  const statusText = {
    [ENGINE_STATE.OFF]: 'Off',
    [ENGINE_STATE.LOADING]: 'Starting…',
    [ENGINE_STATE.RUNNING]: 'Watching for gestures',
    [ENGINE_STATE.SUSPENDED]: 'Idle — no media on screen',
    [ENGINE_STATE.ERROR]: 'Error',
    [ENGINE_STATE.NEEDS_PERMISSION]: 'Camera access needed'
  };
  $('status-line').textContent = engine?.detail || statusText[engine?.state] || 'Off';

  if (engine?.state === ENGINE_STATE.RUNNING) dot.classList.add('on');
  else if (engine?.state === ENGINE_STATE.SUSPENDED || engine?.state === ENGINE_STATE.LOADING)
    dot.classList.add('warn');
  else if (engine?.state === ENGINE_STATE.ERROR || engine?.state === ENGINE_STATE.NEEDS_PERMISSION)
    dot.classList.add('err');

  const live = engine?.live;
  if (live?.gesture && live.gesture !== 'none') {
    gestureEl.textContent = `${GESTURE_META[live.gesture]?.emoji ?? ''} ${
      GESTURE_META[live.gesture]?.label ?? live.gesture
    }`;
  } else if (engine?.state === ENGINE_STATE.RUNNING) {
    gestureEl.textContent = 'Show a gesture…';
  } else {
    gestureEl.textContent = statusText[engine?.state] ?? '—';
  }
  perfEl.textContent = live ? `${live.fps} fps · ${live.inferenceMs} ms` : '';

  $('permission-card').classList.toggle(
    'hidden',
    engine?.state !== ENGINE_STATE.NEEDS_PERMISSION
  );

  const parts = [];
  parts.push(frames ? `${frames} media frame${frames === 1 ? '' : 's'} detected` : 'No media detected yet.');
  if (lastAction) {
    const meta = ACTION_META[lastAction.action];
    parts.push(
      `Last: ${meta?.emoji ?? ''} ${meta?.label ?? lastAction.action}${
        lastAction.ok ? '' : ` (${lastAction.reason || lastAction.detail || 'failed'})`
      }`
    );
  }
  $('target-line').textContent = parts.join(' · ');

  const cam = engine?.camera;
  const camLine = $('camera-line');
  if (cam?.label) {
    camLine.textContent = `📷 ${cam.label}`;
    camLine.title = `Chosen because: ${cam.reason}. Change it in All settings.`;
  } else {
    camLine.textContent = '';
  }
}

function renderSettings() {
  $('toggle').checked = Boolean(settings.enabled);
  $('performance').value = settings.performance;
  $('onlyWhenMediaPresent').checked = Boolean(settings.onlyWhenMediaPresent);
  $('showHud').checked = Boolean(settings.showHud);
  $('mirrored').checked = Boolean(settings.mirrored);
  const blocked = currentHost && settings.blockedHosts.includes(currentHost);
  $('block-site').textContent = blocked
    ? `Enable on ${currentHost}`
    : currentHost
      ? `Disable on ${currentHost}`
      : 'Disable on this site';
  renderGestures();
}

async function refresh() {
  const state = await send(MSG.GET_STATE);
  if (!state) return;
  settings = state.settings;
  renderSettings();
  renderEngine(state.engine, state.lastAction, state.mediaFrames);
}

function initPresets() {
  const select = $('performance');
  for (const preset of Object.values(PERFORMANCE_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = preset.id;
    opt.textContent = preset.label;
    select.appendChild(opt);
  }
}

async function patch(patchObj) {
  const res = await send(MSG.SET_SETTINGS, { settings: patchObj });
  if (res?.settings) settings = res.settings;
  renderSettings();
}

function wire() {
  $('toggle').addEventListener('change', async (e) => {
    const res = await send(MSG.SET_ENABLED, { enabled: e.target.checked });
    if (res?.settings) settings = res.settings;
    setTimeout(refresh, 400);
  });
  $('performance').addEventListener('change', (e) => patch({ performance: e.target.value }));
  for (const key of ['onlyWhenMediaPresent', 'showHud', 'mirrored']) {
    $(key).addEventListener('change', (e) => patch({ [key]: e.target.checked }));
  }
  $('grant').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#camera') });
    window.close();
  });
  $('open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
  $('block-site').addEventListener('click', async () => {
    if (!currentHost) return;
    const blocked = settings.blockedHosts.includes(currentHost);
    const blockedHosts = blocked
      ? settings.blockedHosts.filter((h) => h !== currentHost)
      : [...settings.blockedHosts, currentHost];
    await patch({ blockedHosts });
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'gm:state-changed') {
    settings = msg.settings;
    renderSettings();
    renderEngine(msg.engine, msg.lastAction);
  }
});

(async () => {
  initPresets();
  wire();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.startsWith('http')) currentHost = new URL(tab.url).hostname;
  } catch {
    /* ignore */
  }
  await refresh();
  setInterval(refresh, 1500);
})();
