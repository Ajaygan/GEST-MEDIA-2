/**
 * Shared constants + default settings.
 * Imported by the service worker, offscreen document, popup and options page.
 * (The content script keeps its own tiny copy of the few values it needs so it
 * can stay a classic, dependency-free script.)
 */

export const GESTURES = /** @type {const} */ ({
  FIST: 'fist',
  OPEN_PALM: 'open_palm',
  POINT_RIGHT: 'point_right',
  POINT_LEFT: 'point_left',
  THUMB_UP: 'thumb_up',
  THUMB_DOWN: 'thumb_down',
  NONE: 'none'
});

export const ACTIONS = /** @type {const} */ ({
  PLAY: 'play',
  PAUSE: 'pause',
  NEXT: 'next',
  PREVIOUS: 'previous',
  VOLUME_UP: 'volume_up',
  VOLUME_DOWN: 'volume_down'
});

/** Default gesture -> action mapping (user remappable in Options). */
export const DEFAULT_MAPPING = {
  [GESTURES.FIST]: ACTIONS.PLAY,
  [GESTURES.OPEN_PALM]: ACTIONS.PAUSE,
  [GESTURES.POINT_RIGHT]: ACTIONS.NEXT,
  [GESTURES.POINT_LEFT]: ACTIONS.PREVIOUS,
  [GESTURES.THUMB_UP]: ACTIONS.VOLUME_UP,
  [GESTURES.THUMB_DOWN]: ACTIONS.VOLUME_DOWN
};

export const GESTURE_META = {
  [GESTURES.FIST]: { emoji: '👊', label: 'Fist' },
  [GESTURES.OPEN_PALM]: { emoji: '✋', label: 'Open palm' },
  [GESTURES.POINT_RIGHT]: { emoji: '👉', label: 'Point right' },
  [GESTURES.POINT_LEFT]: { emoji: '👈', label: 'Point left' },
  [GESTURES.THUMB_UP]: { emoji: '👍', label: 'Thumbs up' },
  [GESTURES.THUMB_DOWN]: { emoji: '👎', label: 'Thumbs down' }
};

export const ACTION_META = {
  [ACTIONS.PLAY]: { emoji: '▶️', label: 'Play' },
  [ACTIONS.PAUSE]: { emoji: '⏸️', label: 'Pause' },
  [ACTIONS.NEXT]: { emoji: '⏭️', label: 'Next' },
  [ACTIONS.PREVIOUS]: { emoji: '⏮️', label: 'Previous' },
  [ACTIONS.VOLUME_UP]: { emoji: '🔊', label: 'Volume up' },
  [ACTIONS.VOLUME_DOWN]: { emoji: '🔉', label: 'Volume down' }
};

/**
 * Performance presets. `low` is the default so the extension behaves well on
 * cheap laptops / Chromebooks: 160px inference frames, 6 fps, CPU delegate.
 */
export const PERFORMANCE_PRESETS = {
  low: {
    id: 'low',
    label: 'Battery saver (low-end devices)',
    activeFps: 6,
    idleFps: 2,
    inferenceWidth: 160,
    captureWidth: 320,
    captureHeight: 240,
    captureFps: 15,
    delegate: 'CPU',
    // 3 frames at 6 fps ≈ half a second of a steady pose before anything fires
    holdFrames: 3,
    minHandDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
    minHandPresenceConfidence: 0.5
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    activeFps: 12,
    idleFps: 4,
    inferenceWidth: 224,
    captureWidth: 480,
    captureHeight: 360,
    captureFps: 24,
    delegate: 'GPU',
    holdFrames: 3,
    minHandDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
    minHandPresenceConfidence: 0.5
  },
  accurate: {
    id: 'accurate',
    label: 'Accurate (needs a decent GPU)',
    activeFps: 24,
    idleFps: 8,
    inferenceWidth: 320,
    captureWidth: 640,
    captureHeight: 480,
    captureFps: 30,
    delegate: 'GPU',
    holdFrames: 4,
    minHandDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
    minHandPresenceConfidence: 0.6
  }
};

export const DEFAULT_SETTINGS = {
  enabled: false,
  performance: 'low',
  /**
   * Which webcam to use. Empty = auto, which prefers the built-in camera and
   * skips virtual ones (Windows "Link to Windows"/Phone Link, OBS, DroidCam…).
   */
  cameraDeviceId: '',
  /** Webcam preview is mirrored, so "point right" means the user's right. */
  mirrored: true,
  /** Only run the camera while a tab actually has media. Big battery win. */
  onlyWhenMediaPresent: true,
  /** Stop inference when no hand has been seen for a while (idle fps). */
  adaptiveThrottle: true,
  /** Show the on-page toast when an action fires. */
  showHud: true,
  /** ms a one-shot gesture must wait before it can fire again. */
  cooldownMs: 1200,
  /** ms between repeats while a volume gesture is held. */
  volumeRepeatMs: 450,
  /** Volume change per volume gesture tick (0..1). */
  volumeStep: 0.08,
  /** Seek fallback (seconds) when a site has no next/previous track. */
  seekSeconds: 10,
  /** Per-gesture enable flags. */
  disabledGestures: [],
  /** Custom gesture -> action mapping. */
  mapping: { ...DEFAULT_MAPPING },
  /** Sites where gesture control should never run (hostnames). */
  blockedHosts: []
};

export const MSG = /** @type {const} */ ({
  // popup/options -> service worker
  GET_STATE: 'gm:get-state',
  SET_SETTINGS: 'gm:set-settings',
  SET_ENABLED: 'gm:set-enabled',
  // offscreen -> service worker
  ENGINE_STATUS: 'gm:engine-status',
  GESTURE: 'gm:gesture',
  // service worker -> offscreen
  ENGINE_START: 'gm:engine-start',
  ENGINE_STOP: 'gm:engine-stop',
  ENGINE_CONFIG: 'gm:engine-config',
  ENGINE_SUSPEND: 'gm:engine-suspend',
  ENGINE_RESUME: 'gm:engine-resume',
  ENGINE_PING: 'gm:engine-ping',
  // content <-> service worker
  MEDIA_REPORT: 'gm:media-report',
  MEDIA_GONE: 'gm:media-gone',
  COMMAND: 'gm:command',
  HUD: 'gm:hud',
  PROBE: 'gm:probe'
});

export const ENGINE_STATE = /** @type {const} */ ({
  OFF: 'off',
  LOADING: 'loading',
  RUNNING: 'running',
  SUSPENDED: 'suspended',
  ERROR: 'error',
  NEEDS_PERMISSION: 'needs-permission'
});

export const MODEL_REMOTE_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
export const MODEL_LOCAL_PATH = 'vendor/models/hand_landmarker.task';
