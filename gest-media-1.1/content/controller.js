/**
 * GestMedia content script — the universal media controller.
 *
 * Injected into every frame of every page. It:
 *   1. finds the "most interesting" <video>/<audio> element in this frame
 *      (including elements inside open shadow roots),
 *   2. reports its state to the service worker so the worker can route a
 *      gesture to exactly one frame in the whole browser,
 *   3. executes play / pause / next / previous / volume commands using a site
 *      adapter when one exists and sane generic fallbacks everywhere else,
 *   4. renders the on-page confirmation toast.
 *
 * Classic script on purpose (MV3 content scripts are not modules), so a couple
 * of constants are duplicated from lib/constants.js.
 */

(() => {
  if (window.__gestMediaInjected) return;
  window.__gestMediaInjected = true;

  const MSG = {
    MEDIA_REPORT: 'gm:media-report',
    COMMAND: 'gm:command',
    HUD: 'gm:hud'
  };

  const ACTION_META = {
    play: { emoji: '▶️', label: 'Play' },
    pause: { emoji: '⏸️', label: 'Pause' },
    next: { emoji: '⏭️', label: 'Next' },
    previous: { emoji: '⏮️', label: 'Previous' },
    volume_up: { emoji: '🔊', label: 'Volume' },
    volume_down: { emoji: '🔉', label: 'Volume' }
  };

  const isTop = window.top === window;

  /* ------------------------------------------------------------ discovery */

  /** Collect media elements, descending into open shadow roots. */
  function collectMedia(root = document, depth = 0, out = []) {
    if (depth > 6 || out.length > 40) return out;
    let nodes = [];
    try {
      nodes = root.querySelectorAll('video, audio');
    } catch {
      return out;
    }
    for (const node of nodes) out.push(node);
    let hosts = [];
    try {
      hosts = root.querySelectorAll('*');
    } catch {
      return out;
    }
    if (hosts.length < 4000) {
      for (const host of hosts) {
        if (host.shadowRoot) collectMedia(host.shadowRoot, depth + 1, out);
      }
    }
    return out;
  }

  function elementArea(el) {
    const rect = el.getBoundingClientRect?.();
    if (!rect) return 0;
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function scoreMedia(el) {
    if (!el || el.ended) return -1;
    let score = 0;
    if (!el.paused) score += 1000;
    if (el.readyState >= 2) score += 100;
    if (Number.isFinite(el.duration) && el.duration > 0) score += 60;
    if (el.currentTime > 0) score += 40;
    if (!el.muted) score += 20;
    score += Math.min(300, elementArea(el) / 2000);
    if (el.tagName === 'AUDIO') score += 80; // audio players have no box
    return score;
  }

  let cachedMedia = null;

  function findMedia({ force = false } = {}) {
    if (!force && cachedMedia && cachedMedia.isConnected && scoreMedia(cachedMedia) > 0) {
      // keep using the current element unless something is clearly playing
      const playingElsewhere = collectMedia().find((m) => m !== cachedMedia && !m.paused);
      if (!playingElsewhere) return cachedMedia;
    }
    const candidates = collectMedia();
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      const s = scoreMedia(el);
      if (s > bestScore) {
        bestScore = s;
        best = el;
      }
    }
    cachedMedia = best;
    return best;
  }

  /* ------------------------------------------------------------- adapters */

  const click = (el) => {
    if (!el) return false;
    const disabled = el.getAttribute?.('aria-disabled') === 'true' || el.disabled;
    if (disabled) return false;
    el.click();
    return true;
  };

  const q = (selectors) => {
    for (const sel of selectors) {
      let el = null;
      try {
        el = document.querySelector(sel);
      } catch {
        el = null;
      }
      if (el && el.offsetParent !== null) return el;
      if (el) return el;
    }
    return null;
  };

  /** Last-resort: look for a control button by accessible name. */
  function findByLabel(patterns) {
    const nodes = document.querySelectorAll(
      'button, [role="button"], a[role="button"], div[tabindex], [data-testid]'
    );
    for (const node of nodes) {
      const label = `${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''} ${
        node.getAttribute('data-testid') || ''
      } ${node.className && typeof node.className === 'string' ? node.className : ''}`;
      if (!label.trim()) continue;
      if (patterns.some((re) => re.test(label))) return node;
    }
    return null;
  }

  const ADAPTERS = [
    {
      id: 'youtube',
      match: /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i,
      next: () => click(q(['.ytp-next-button:not([aria-disabled="true"])'])),
      previous: () => click(q(['.ytp-prev-button:not([aria-disabled="true"])']))
    },
    {
      id: 'hotstar',
      match: /(^|\.)(hotstar\.com|jiohotstar\.com)$/i,
      next: () =>
        click(
          q([
            '[data-testid="next-episode-button"]',
            '.next-episode-button',
            'button[aria-label*="Next" i]',
            '[class*="NextEpisode" i] button'
          ])
        ),
      previous: () => click(q(['button[aria-label*="Previous" i]', '[class*="PrevEpisode" i] button']))
    },
    {
      id: 'jiocinema',
      match: /(^|\.)(jiocinema\.com|voot\.com)$/i,
      next: () =>
        click(
          q([
            '[data-testid*="next" i]',
            'button[aria-label*="Next" i]',
            '[class*="next-episode" i]',
            '[class*="nextEpisode" i]'
          ])
        ),
      previous: () =>
        click(q(['[data-testid*="prev" i]', 'button[aria-label*="Previous" i]', '[class*="prev-episode" i]']))
    },
    {
      id: 'netflix',
      match: /(^|\.)netflix\.com$/i,
      next: () => click(q(['[data-uia="next-episode-seamless-button"]', '[data-uia*="next-episode"]'])),
      previous: () => false
    },
    {
      id: 'prime-video',
      match: /(^|\.)(primevideo\.com|amazon\.[a-z.]+)$/i,
      next: () => click(q(['.atvwebplayersdk-nextupcard-button', '[class*="nexttitle" i] button'])),
      previous: () => false
    },
    {
      id: 'spotify',
      match: /(^|\.)spotify\.com$/i,
      next: () => click(q(['[data-testid="control-button-skip-forward"]'])),
      previous: () => click(q(['[data-testid="control-button-skip-back"]'])),
      play: () => click(q(['[data-testid="control-button-playpause"][aria-label*="Play" i]'])),
      pause: () => click(q(['[data-testid="control-button-playpause"][aria-label*="Pause" i]']))
    },
    {
      id: 'soundcloud',
      match: /(^|\.)soundcloud\.com$/i,
      next: () => click(q(['.skipControl__next'])),
      previous: () => click(q(['.skipControl__previous']))
    },
    {
      id: 'apple-music',
      match: /(^|\.)music\.apple\.com$/i,
      next: () => click(q(['button[aria-label*="Next" i]'])),
      previous: () => click(q(['button[aria-label*="Previous" i]']))
    },
    {
      id: 'jiosaavn',
      match: /(^|\.)(jiosaavn\.com|gaana\.com|wynk\.in)$/i,
      next: () => click(q(['.next', '[aria-label*="Next" i]'])),
      previous: () => click(q(['.prev', '[aria-label*="Previous" i]']))
    },
    {
      id: 'vimeo-dailymotion',
      match: /(^|\.)(vimeo\.com|dailymotion\.com)$/i,
      next: () => click(q(['[data-next]', 'button[aria-label*="Next" i]'])),
      previous: () => click(q(['button[aria-label*="Previous" i]']))
    }
  ];

  function adapterFor(host) {
    return ADAPTERS.find((a) => a.match.test(host)) || null;
  }

  const NEXT_PATTERNS = [/next(?!ed)/i, /skip[-_ ]?forward/i, /forward[-_ ]?button/i, /siguiente/i];
  const PREV_PATTERNS = [/previous/i, /\bprev\b/i, /skip[-_ ]?back/i, /rewind[-_ ]?button/i];

  /* ------------------------------------------------------------- commands */

  function ensureAudible(media) {
    if (media.muted) {
      media.muted = false;
      return true;
    }
    return false;
  }

  async function runCommand(action, cfg) {
    const media = findMedia({ force: true });
    const adapter = adapterFor(location.hostname);
    const step = cfg?.volumeStep ?? 0.08;
    const seek = cfg?.seekSeconds ?? 10;

    switch (action) {
      case 'play': {
        if (adapter?.play && adapter.play()) return { ok: true, detail: adapter.id };
        if (!media) return { ok: false, detail: 'no media element' };
        try {
          await media.play();
        } catch (err) {
          return { ok: false, detail: String(err?.message || err) };
        }
        return { ok: true, detail: 'element.play()' };
      }

      case 'pause': {
        if (adapter?.pause && adapter.pause()) return { ok: true, detail: adapter.id };
        if (!media) return { ok: false, detail: 'no media element' };
        media.pause();
        return { ok: true, detail: 'element.pause()' };
      }

      case 'next':
      case 'previous': {
        const isNext = action === 'next';
        if (adapter && adapter[action] && adapter[action]()) {
          return { ok: true, detail: `${adapter.id} ${action}` };
        }
        const btn = findByLabel(isNext ? NEXT_PATTERNS : PREV_PATTERNS);
        if (btn && click(btn)) return { ok: true, detail: 'control button' };
        if (media) {
          // No playlist control on this site -> seek instead, which is what
          // people intuitively expect from 👉 / 👈 on a single video.
          const delta = isNext ? seek : -seek;
          media.currentTime = Math.max(
            0,
            Math.min((media.duration || Infinity) - 0.5, media.currentTime + delta)
          );
          return { ok: true, detail: `seek ${delta > 0 ? '+' : ''}${delta}s`, seek: delta };
        }
        return { ok: false, detail: 'nothing to control' };
      }

      case 'volume_up':
      case 'volume_down': {
        if (!media) return { ok: false, detail: 'no media element' };
        const delta = action === 'volume_up' ? step : -step;
        const unmuted = delta > 0 ? ensureAudible(media) : false;
        const next = Math.max(0, Math.min(1, (media.volume ?? 1) + delta));
        media.volume = next;
        if (next === 0) media.muted = true;
        return {
          ok: true,
          detail: `${Math.round(next * 100)}%${unmuted ? ' (unmuted)' : ''}`,
          volume: next
        };
      }

      default:
        return { ok: false, detail: `unknown action ${action}` };
    }
  }

  /* ------------------------------------------------------------------ HUD */

  let hudHost = null;
  let hudTimer = null;

  function showHud({ action, detail, ok }) {
    if (!isTop) {
      chrome.runtime.sendMessage({ type: MSG.HUD, action, detail, ok }).catch(() => {});
      return;
    }
    try {
      if (!hudHost) {
        hudHost = document.createElement('div');
        hudHost.style.cssText =
          'position:fixed;inset:auto auto 24px 50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;';
        const shadow = hudHost.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
          <style>
            .toast{display:flex;align-items:center;gap:10px;font:600 15px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
              color:#fff;background:rgba(18,18,22,.92);border:1px solid rgba(255,255,255,.12);
              padding:10px 16px;border-radius:999px;box-shadow:0 8px 30px rgba(0,0,0,.45);
              opacity:0;transform:translateY(8px);transition:opacity .16s ease,transform .16s ease;}
            .toast.show{opacity:1;transform:translateY(0);}
            .toast.err{background:rgba(70,20,20,.92)}
            .emoji{font-size:19px}
            .detail{opacity:.65;font-weight:500;font-size:13px}
          </style>
          <div class="toast"><span class="emoji"></span><span class="label"></span><span class="detail"></span></div>`;
        (document.body || document.documentElement).appendChild(hudHost);
      }
      const shadow = hudHost.shadowRoot;
      const toast = shadow.querySelector('.toast');
      const meta = ACTION_META[action] || { emoji: '✋', label: action };
      shadow.querySelector('.emoji').textContent = ok ? meta.emoji : '⚠️';
      shadow.querySelector('.label').textContent = meta.label;
      shadow.querySelector('.detail').textContent = detail || '';
      toast.classList.toggle('err', !ok);
      toast.classList.add('show');
      clearTimeout(hudTimer);
      hudTimer = setTimeout(() => toast.classList.remove('show'), 1300);
    } catch {
      /* pages with exotic CSP can refuse the overlay; ignore */
    }
  }

  /* --------------------------------------------------------- state report */

  let lastReport = 0;
  let lastSentAt = 0;
  let reportTimer = null;
  let lastSignature = '';

  function report(force = false) {
    const now = Date.now();
    if (!force && now - lastReport < 900) return;
    lastReport = now;
    const media = findMedia();
    const payload = {
      type: MSG.MEDIA_REPORT,
      hasMedia: Boolean(media),
      playing: Boolean(media && !media.paused && !media.ended),
      duration: media && Number.isFinite(media.duration) ? media.duration : 0,
      area: media ? Math.round(elementArea(media)) : 0
    };
    const signature = `${payload.hasMedia}|${payload.playing}|${Math.round(payload.duration)}`;
    // Skip identical reports, but always refresh the worker's registry every
    // 15s so entries never go stale while media is still on the page.
    if (signature === lastSignature && now - lastSentAt < 15_000) return;
    lastSignature = signature;
    lastSentAt = now;
    try {
      chrome.runtime.sendMessage(payload).catch(() => {});
    } catch {
      /* extension reloaded */
    }
  }

  function scheduleReport() {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => report(true), 250);
  }

  for (const evt of ['play', 'pause', 'ended', 'loadedmetadata', 'volumechange', 'emptied']) {
    document.addEventListener(evt, scheduleReport, true);
  }
  document.addEventListener('visibilitychange', () => report(true));
  window.addEventListener('pagehide', () => {
    try {
      chrome.runtime.sendMessage({ type: MSG.MEDIA_REPORT, hasMedia: false }).catch(() => {});
    } catch {
      /* ignore */
    }
  });

  // Cheap heartbeat: keeps the worker's registry warm and copes with SPA
  // navigations without an expensive MutationObserver on the whole DOM.
  setInterval(() => report(true), 8000);
  setTimeout(() => report(true), 800);

  /* -------------------------------------------------------------- inbound */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === MSG.COMMAND) {
      runCommand(msg.action, msg.settings)
        .then((result) => {
          if (msg.settings?.showHud !== false) {
            showHud({ action: msg.action, detail: result.detail, ok: result.ok });
          }
          scheduleReport();
          sendResponse(result);
        })
        .catch((err) => sendResponse({ ok: false, detail: String(err?.message || err) }));
      return true;
    }
    if (msg?.type === MSG.HUD && isTop) {
      showHud(msg);
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });
})();
