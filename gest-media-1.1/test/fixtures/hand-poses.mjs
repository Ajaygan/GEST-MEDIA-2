/**
 * Synthetic hand-landmark builder used by the unit tests.
 *
 * Produces MediaPipe-shaped 21-point landmark arrays for known poses so the
 * classifier can be tested without a webcam.
 */

const FINGER_ORDER = ['index', 'middle', 'ring', 'pinky'];

function rot(p, deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/**
 * @param {object} spec
 * @param {Record<string, 'extended'|'curled'>} spec.fingers
 * @param {'up'|'down'|'tucked'|'side'} spec.thumb
 * @param {number} [spec.rotation] degrees, clockwise in image space
 * @param {{x:number,y:number}} [spec.origin] wrist position (normalised)
 * @param {number} [spec.scale]
 */
export function makeHand(spec) {
  const { fingers = {}, thumb = 'tucked', rotation = 0, origin = { x: 0.5, y: 0.75 }, scale = 0.25 } =
    spec;

  const local = new Array(21);
  local[0] = { x: 0, y: 0 };

  const mcpX = { index: -0.18, middle: -0.06, ring: 0.06, pinky: 0.18 };
  const mcpY = { index: -0.88, middle: -0.92, ring: -0.88, pinky: -0.8 };
  const lengths = { index: 0.85, middle: 0.92, ring: 0.85, pinky: 0.68 };
  const baseIds = { index: 5, middle: 9, ring: 13, pinky: 17 };

  for (const name of FINGER_ORDER) {
    const mcp = { x: mcpX[name], y: mcpY[name] };
    const len = lengths[name];
    const dir = { x: 0, y: -1 };
    const perp = { x: 1, y: 0 };
    const state = fingers[name] ?? 'curled';
    const id = baseIds[name];
    local[id] = mcp;
    if (state === 'extended') {
      local[id + 1] = { x: mcp.x + dir.x * len * 0.42, y: mcp.y + dir.y * len * 0.42 };
      local[id + 2] = { x: mcp.x + dir.x * len * 0.72, y: mcp.y + dir.y * len * 0.72 };
      local[id + 3] = { x: mcp.x + dir.x * len, y: mcp.y + dir.y * len };
    } else {
      // curled: knuckle up, fingertip folded back into the palm
      local[id + 1] = { x: mcp.x + dir.x * len * 0.38, y: mcp.y + dir.y * len * 0.38 };
      local[id + 2] = {
        x: mcp.x + dir.x * len * 0.24 + perp.x * 0.08,
        y: mcp.y + dir.y * len * 0.24 + perp.y * 0.08
      };
      local[id + 3] = {
        x: mcp.x + dir.x * len * 0.02 + perp.x * 0.06,
        y: mcp.y + dir.y * len * 0.02 + perp.y * 0.06
      };
    }
  }

  // Thumb chain: CMC(1), MCP(2), IP(3), TIP(4)
  const thumbPoses = {
    tucked: [
      { x: -0.22, y: -0.2 },
      { x: -0.34, y: -0.42 },
      { x: -0.3, y: -0.62 },
      { x: -0.18, y: -0.74 }
    ],
    up: [
      { x: -0.24, y: -0.18 },
      { x: -0.3, y: -0.42 },
      { x: -0.34, y: -1.0 },
      { x: -0.36, y: -1.62 }
    ],
    down: [
      { x: -0.24, y: -0.18 },
      { x: -0.3, y: -0.42 },
      { x: -0.34, y: 0.18 },
      { x: -0.36, y: 0.8 }
    ],
    // thumb resting high on the side of a closed fist — the classic
    // false-positive for 👍
    restingHigh: [
      { x: -0.22, y: -0.2 },
      { x: -0.3, y: -0.5 },
      { x: -0.3, y: -0.8 },
      { x: -0.3, y: -1.05 }
    ],
    // half-hearted thumbs up: thumb only just clears the knuckles
    halfUp: [
      { x: -0.24, y: -0.18 },
      { x: -0.3, y: -0.42 },
      { x: -0.33, y: -0.9 },
      { x: -0.35, y: -1.35 }
    ],
    side: [
      { x: -0.22, y: -0.2 },
      { x: -0.42, y: -0.36 },
      { x: -0.75, y: -0.5 },
      { x: -1.05, y: -0.6 }
    ]
  };
  const chain = thumbPoses[thumb] ?? thumbPoses.tucked;
  chain.forEach((p, i) => {
    local[1 + i] = { x: p.x, y: p.y };
  });

  return local.map((p) => {
    const r = rot(p, rotation);
    return { x: origin.x + r.x * scale, y: origin.y + r.y * scale, z: 0 };
  });
}

export const POSES = {
  fist: () => makeHand({ fingers: {}, thumb: 'tucked' }),
  openPalm: () =>
    makeHand({
      fingers: { index: 'extended', middle: 'extended', ring: 'extended', pinky: 'extended' },
      thumb: 'side'
    }),
  thumbUp: () => makeHand({ fingers: {}, thumb: 'up' }),
  /** closed fist whose thumb lies high along the side of the index finger */
  fistThumbHigh: () => makeHand({ fingers: {}, thumb: 'restingHigh' }),
  /** fist rotated as if the knuckles face the camera at an angle */
  fistTilted: (deg = 20) => makeHand({ fingers: {}, thumb: 'tucked', rotation: deg }),
  /** thumbs up with the hand tilted */
  thumbUpTilted: (deg = 20) => makeHand({ fingers: {}, thumb: 'up', rotation: deg }),
  /** thumb only just past the knuckles */
  thumbUpShallow: () => makeHand({ fingers: {}, thumb: 'halfUp' }),
  thumbDown: () => makeHand({ fingers: {}, thumb: 'down' }),
  /** index finger pointing towards the right-hand side of the image */
  pointImageRight: () => makeHand({ fingers: { index: 'extended' }, thumb: 'tucked', rotation: 90 }),
  /** index finger pointing towards the left-hand side of the image */
  pointImageLeft: () => makeHand({ fingers: { index: 'extended' }, thumb: 'tucked', rotation: -90 })
};
