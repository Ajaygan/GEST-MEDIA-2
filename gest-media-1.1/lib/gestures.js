/**
 * Pure, dependency-free hand-gesture classification helpers.
 *
 * Input is the 21-point landmark array produced by MediaPipe Hands /
 * HandLandmarker (normalised image coordinates, origin top-left, y grows
 * downwards). Everything here is deliberately side-effect free so it can be
 * unit tested with `npm test` outside of a browser.
 *
 * Landmark indices (MediaPipe):
 *   0 wrist
 *   1-4   thumb  (CMC, MCP, IP, TIP)
 *   5-8   index  (MCP, PIP, DIP, TIP)
 *   9-12  middle (MCP, PIP, DIP, TIP)
 *   13-16 ring   (MCP, PIP, DIP, TIP)
 *   17-20 pinky  (MCP, PIP, DIP, TIP)
 */

export const GESTURES = {
  FIST: 'fist',
  OPEN_PALM: 'open_palm',
  POINT_RIGHT: 'point_right',
  POINT_LEFT: 'point_left',
  THUMB_UP: 'thumb_up',
  THUMB_DOWN: 'thumb_down',
  NONE: 'none'
};

/**
 * Thumb tip must clear the knuckle line by this much (in hand-scale units)
 * before 👍/👎 is even considered — this is what stops a fist, whose thumb sits
 * right on the knuckles, from being read as a thumbs up or down.
 */
const THUMB_CLEARANCE = 0.3;
const THUMB_MIN_EXTENSION = 0.45;
const THUMB_MIN_VERTICALITY = 0.25;
/** Two gestures within this confidence gap are treated as "no gesture". */
const AMBIGUITY_MARGIN = 0.08;

const WRIST = 0;
const THUMB = { cmc: 1, mcp: 2, ip: 3, tip: 4 };
const FINGERS = {
  index: { mcp: 5, pip: 6, dip: 7, tip: 8 },
  middle: { mcp: 9, pip: 10, dip: 11, tip: 12 },
  ring: { mcp: 13, pip: 14, dip: 15, tip: 16 },
  pinky: { mcp: 17, pip: 18, dip: 19, tip: 20 }
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function avg(...values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function norm(v) {
  const len = Math.hypot(v.x, v.y) || 1e-6;
  return { x: v.x / len, y: v.y / len, len };
}

/** Angle (deg) at point `b` in the poly-line a-b-c. 180 = perfectly straight. */
function jointAngle(a, b, c) {
  const v1 = sub(a, b);
  const v2 = sub(c, b);
  const dot = v1.x * v2.x + v1.y * v2.y;
  const m = (Math.hypot(v1.x, v1.y) || 1e-6) * (Math.hypot(v2.x, v2.y) || 1e-6);
  return (Math.acos(Math.max(-1, Math.min(1, dot / m))) * 180) / Math.PI;
}

/** Rough hand size, used to make every threshold scale invariant. */
export function handScale(lm) {
  return (
    Math.max(
      dist(lm[WRIST], lm[FINGERS.middle.mcp]),
      dist(lm[FINGERS.index.mcp], lm[FINGERS.pinky.mcp])
    ) || 1e-6
  );
}

/**
 * Per-finger extension state.
 * @returns {{index:number, middle:number, ring:number, pinky:number}} 0..1
 *          where 1 = fully extended, 0 = fully curled.
 */
export function fingerExtension(lm) {
  const scale = handScale(lm);
  const out = {};
  for (const [name, ids] of Object.entries(FINGERS)) {
    const tipReach = dist(lm[ids.tip], lm[WRIST]) / scale;
    const pipReach = dist(lm[ids.pip], lm[WRIST]) / scale;
    // 1) how much further the tip is from the wrist than the middle joint
    const reachScore = clamp01((tipReach - pipReach) / 0.55 + 0.15);
    // 2) how straight the finger is (angle at PIP)
    const straight = clamp01((jointAngle(lm[ids.mcp], lm[ids.pip], lm[ids.tip]) - 100) / 60);
    out[name] = clamp01(reachScore * 0.55 + straight * 0.45);
  }
  return out;
}

/** Thumb state: extension 0..1 plus its pointing direction unit vector. */
export function thumbState(lm) {
  const scale = handScale(lm);
  const straight = clamp01((jointAngle(lm[THUMB.mcp], lm[THUMB.ip], lm[THUMB.tip]) - 120) / 50);
  const away = clamp01((dist(lm[THUMB.tip], lm[FINGERS.index.mcp]) / scale - 0.45) / 0.55);
  const reach = clamp01((dist(lm[THUMB.tip], lm[WRIST]) / scale - 0.75) / 0.5);
  const dir = norm(sub(lm[THUMB.tip], lm[THUMB.mcp]));
  return {
    extension: clamp01(straight * 0.35 + away * 0.4 + reach * 0.25),
    dir
  };
}

/** Direction the index finger points at (unit vector, image coordinates). */
export function pointingDirection(lm) {
  return norm(sub(lm[FINGERS.index.tip], lm[FINGERS.index.mcp]));
}

/** Centre of the four knuckles — the "plane" a tucked thumb never crosses. */
export function knuckleCentre(lm) {
  const ids = [FINGERS.index.mcp, FINGERS.middle.mcp, FINGERS.ring.mcp, FINGERS.pinky.mcp];
  return {
    x: avg(...ids.map((i) => lm[i].x)),
    y: avg(...ids.map((i) => lm[i].y))
  };
}

/**
 * How far the thumb tip sticks out past the knuckles along the image vertical,
 * in hand-scale units. Positive = above the knuckles (👍), negative = below
 * them (👎), around zero = tucked against the fist (👊).
 *
 * This is the measurement that actually separates a fist from a thumbs
 * up/down: thumb "extension" alone is far too noisy, because MediaPipe often
 * reports a semi-straight thumb lying across a closed fist.
 */
export function thumbVerticalOffset(lm) {
  const scale = handScale(lm);
  const knuckles = knuckleCentre(lm);
  return (knuckles.y - lm[THUMB.tip].y) / scale;
}

/**
 * Classify a single hand.
 *
 * @param {Array<{x:number,y:number,z?:number}>} lm 21 landmarks
 * @param {{mirrored?:boolean}} [opts] `mirrored` (default true) means the
 *        camera image is mirrored like a selfie view, so a hand that points to
 *        the left of the *image* is the user pointing to their right.
 * @returns {{gesture:string, confidence:number, debug:object}}
 */
export function classifyLandmarks(lm, opts = {}) {
  const mirrored = opts.mirrored !== false;
  const empty = { gesture: GESTURES.NONE, confidence: 0, debug: {} };
  if (!Array.isArray(lm) || lm.length < 21) return empty;

  const f = fingerExtension(lm);
  const thumb = thumbState(lm);
  const point = pointingDirection(lm);
  const debug = { fingers: f, thumb: thumb.extension, thumbDir: thumb.dir, point };

  const extendedCount = [f.index, f.middle, f.ring, f.pinky].filter((v) => v > 0.55).length;
  const foldedOthers = avg(1 - f.middle, 1 - f.ring, 1 - f.pinky);
  const allFolded = avg(1 - f.index, 1 - f.middle, 1 - f.ring, 1 - f.pinky);
  const thumbLift = thumbVerticalOffset(lm);
  const thumbVertical = Math.abs(thumb.dir.y) - Math.abs(thumb.dir.x);
  debug.thumbLift = thumbLift;
  debug.thumbVertical = thumbVertical;

  const candidates = [];

  // ✋ Open palm — every finger extended.
  if (extendedCount >= 4) {
    candidates.push({
      gesture: GESTURES.OPEN_PALM,
      confidence: clamp01(avg(f.index, f.middle, f.ring, f.pinky) * 0.85 + 0.15)
    });
  }

  // 👉 / 👈 Pointing — index out, the rest curled, index mostly horizontal.
  if (f.index > 0.6 && foldedOthers > 0.6) {
    const horizontal = Math.abs(point.x) - Math.abs(point.y);
    if (horizontal > 0.15) {
      const imageRight = point.x > 0;
      // In a mirrored (selfie) image the user's right hand-point appears left.
      const userRight = mirrored ? !imageRight : imageRight;
      candidates.push({
        gesture: userRight ? GESTURES.POINT_RIGHT : GESTURES.POINT_LEFT,
        confidence: clamp01(f.index * 0.4 + foldedOthers * 0.3 + clamp01(horizontal) * 0.3)
      });
    }
  }

  // 👊 vs 👍 vs 👎 — all three are "four fingers curled", so they are decided
  // together instead of competing as independent scores. The thumb must both
  // point vertically AND clear the knuckle line by a real margin before it
  // counts as a thumbs up/down; otherwise it is a fist.
  if (allFolded > 0.6) {
    const clearsKnuckles = Math.abs(thumbLift) - THUMB_CLEARANCE;
    const isThumbSignal =
      thumb.extension > THUMB_MIN_EXTENSION &&
      thumbVertical > THUMB_MIN_VERTICALITY &&
      clearsKnuckles > 0;

    if (isThumbSignal) {
      const confidence = clamp01(
        0.35 +
          allFolded * 0.2 +
          clamp01(thumb.extension) * 0.15 +
          clamp01(thumbVertical) * 0.15 +
          clamp01(clearsKnuckles / 0.45) * 0.15
      );
      candidates.push({
        gesture: thumbLift > 0 ? GESTURES.THUMB_UP : GESTURES.THUMB_DOWN,
        confidence
      });
    } else if (allFolded > 0.68) {
      // The less the thumb looks like a deliberate up/down signal, the more
      // confident we are that this is a plain fist.
      const tucked = clamp01(1 - Math.abs(thumbLift) / (THUMB_CLEARANCE + 0.25));
      const sideways = clamp01(1 - Math.max(0, thumbVertical));
      candidates.push({
        gesture: GESTURES.FIST,
        confidence: clamp01(allFolded * 0.55 + tucked * 0.3 + sideways * 0.15)
      });
    }
  }

  if (!candidates.length) return { ...empty, debug };
  candidates.sort((a, b) => b.confidence - a.confidence);
  const [best, runnerUp] = candidates;
  // Refuse to guess when two gestures score almost the same — a dropped frame
  // is much cheaper than pausing when the user meant "play".
  if (runnerUp && best.confidence - runnerUp.confidence < AMBIGUITY_MARGIN) {
    return { gesture: GESTURES.NONE, confidence: 0, debug: { ...debug, ambiguous: true } };
  }
  return { gesture: best.gesture, confidence: best.confidence, debug };
}

/**
 * Turns a noisy per-frame gesture stream into discrete, de-bounced actions.
 *
 * - a gesture must be seen `holdFrames` times in a row before it fires
 * - one-shot gestures (play/pause/next/prev) fire once and then need the hand
 *   to change/leave before they can fire again
 * - repeatable gestures (volume) keep firing every `repeatMs` while held
 */
export class GestureStabilizer {
  constructor(options = {}) {
    this.configure(options);
    this.reset();
  }

  configure(options = {}) {
    this.holdFrames = options.holdFrames ?? 3;
    this.minConfidence = options.minConfidence ?? 0.55;
    this.cooldownMs = options.cooldownMs ?? 1200;
    this.repeatMs = options.repeatMs ?? 450;
    this.repeatable = new Set(options.repeatable ?? [GESTURES.THUMB_UP, GESTURES.THUMB_DOWN]);
    this.missFramesToClear = options.missFramesToClear ?? 3;
  }

  reset() {
    this.candidate = GESTURES.NONE;
    this.streak = 0;
    this.missStreak = 0;
    this.armedGesture = null; // gesture currently "held down"
    this.lastFireAt = -Infinity;
    this.lastFired = null;
  }

  /**
   * @param {string} gesture raw per-frame gesture
   * @param {number} confidence 0..1
   * @param {number} now epoch ms
   * @returns {{gesture:string, repeat:boolean}|null} action to dispatch
   */
  push(gesture, confidence, now = Date.now()) {
    const valid = gesture && gesture !== GESTURES.NONE && confidence >= this.minConfidence;

    if (!valid) {
      this.missStreak += 1;
      if (this.missStreak >= this.missFramesToClear) {
        this.candidate = GESTURES.NONE;
        this.streak = 0;
        this.armedGesture = null; // hand left -> re-arm one-shot gestures
      }
      return null;
    }
    this.missStreak = 0;

    if (gesture === this.candidate) {
      this.streak += 1;
    } else {
      this.candidate = gesture;
      this.streak = 1;
      if (this.armedGesture && this.armedGesture !== gesture) this.armedGesture = null;
    }

    if (this.streak < this.holdFrames) return null;

    const isRepeatable = this.repeatable.has(gesture);
    const sinceFire = now - this.lastFireAt;

    if (this.armedGesture === gesture) {
      // Still holding the same gesture.
      if (!isRepeatable) return null;
      if (sinceFire < this.repeatMs) return null;
      this.lastFireAt = now;
      this.lastFired = gesture;
      return { gesture, repeat: true };
    }

    if (sinceFire < Math.min(this.cooldownMs, isRepeatable ? this.repeatMs : this.cooldownMs)) {
      return null;
    }

    this.armedGesture = gesture;
    this.lastFireAt = now;
    this.lastFired = gesture;
    return { gesture, repeat: false };
  }
}
