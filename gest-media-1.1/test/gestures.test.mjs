import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GESTURES,
  GestureStabilizer,
  classifyLandmarks,
  fingerExtension,
  thumbState,
  thumbVerticalOffset
} from '../lib/gestures.js';
import { POSES } from './fixtures/hand-poses.mjs';

test('finger extension separates curled from extended fingers', () => {
  const open = fingerExtension(POSES.openPalm());
  const fist = fingerExtension(POSES.fist());
  for (const finger of ['index', 'middle', 'ring', 'pinky']) {
    assert.ok(open[finger] > 0.7, `${finger} should read as extended (${open[finger]})`);
    assert.ok(fist[finger] < 0.3, `${finger} should read as curled (${fist[finger]})`);
  }
});

test('thumb state detects an extended, upward thumb', () => {
  const up = thumbState(POSES.thumbUp());
  assert.ok(up.extension > 0.5, `thumb should read as extended (${up.extension})`);
  assert.ok(up.dir.y < -0.7, 'thumb should point upwards in image space');

  const tucked = thumbState(POSES.fist());
  assert.ok(tucked.extension < 0.45, `tucked thumb should read as folded (${tucked.extension})`);
});

test('classifies the six control gestures', () => {
  const cases = [
    [POSES.fist(), GESTURES.FIST],
    [POSES.openPalm(), GESTURES.OPEN_PALM],
    [POSES.thumbUp(), GESTURES.THUMB_UP],
    [POSES.thumbDown(), GESTURES.THUMB_DOWN]
  ];
  for (const [lm, expected] of cases) {
    const res = classifyLandmarks(lm);
    assert.equal(res.gesture, expected);
    assert.ok(res.confidence > 0.5, `${expected} confidence too low: ${res.confidence}`);
  }
});

test('pointing respects the mirrored selfie view', () => {
  // Mirrored preview (default): pointing to the left of the image is the user
  // pointing to their own right -> "next".
  assert.equal(classifyLandmarks(POSES.pointImageLeft()).gesture, GESTURES.POINT_RIGHT);
  assert.equal(classifyLandmarks(POSES.pointImageRight()).gesture, GESTURES.POINT_LEFT);

  // Non-mirrored source: image direction is taken literally.
  assert.equal(
    classifyLandmarks(POSES.pointImageRight(), { mirrored: false }).gesture,
    GESTURES.POINT_RIGHT
  );
  assert.equal(
    classifyLandmarks(POSES.pointImageLeft(), { mirrored: false }).gesture,
    GESTURES.POINT_LEFT
  );
});

test('a fist is never read as thumbs up or down', () => {
  const cases = {
    'plain fist': POSES.fist(),
    'thumb resting high on the fist': POSES.fistThumbHigh(),
    'fist tilted +20°': POSES.fistTilted(20),
    'fist tilted -20°': POSES.fistTilted(-20)
  };
  for (const [name, lm] of Object.entries(cases)) {
    const { gesture } = classifyLandmarks(lm);
    assert.ok(
      gesture !== GESTURES.THUMB_UP && gesture !== GESTURES.THUMB_DOWN,
      `${name} was misread as ${gesture}`
    );
    assert.equal(gesture, GESTURES.FIST, `${name} should stay a fist`);
  }
});

test('a thumbs up is never read as a fist, even tilted or shallow', () => {
  for (const [name, lm] of Object.entries({
    'thumbs up': POSES.thumbUp(),
    'thumbs up tilted +20°': POSES.thumbUpTilted(20),
    'thumbs up tilted -20°': POSES.thumbUpTilted(-20),
    'shallow thumbs up': POSES.thumbUpShallow()
  })) {
    assert.equal(classifyLandmarks(lm).gesture, GESTURES.THUMB_UP, `${name} misread`);
  }
});

test('thumb clearance over the knuckles is what separates the three', () => {
  const fist = thumbVerticalOffset(POSES.fist());
  const high = thumbVerticalOffset(POSES.fistThumbHigh());
  const up = thumbVerticalOffset(POSES.thumbUp());
  const down = thumbVerticalOffset(POSES.thumbDown());
  assert.ok(Math.abs(fist) < 0.3, `fist thumb should sit on the knuckle line (${fist})`);
  assert.ok(Math.abs(high) < 0.3, `resting thumb should sit on the knuckle line (${high})`);
  assert.ok(up > 0.5, `thumbs up should clear the knuckles (${up})`);
  assert.ok(down < -0.5, `thumbs down should drop below the knuckles (${down})`);
});

test('returns none for junk input', () => {
  assert.equal(classifyLandmarks([]).gesture, GESTURES.NONE);
  assert.equal(classifyLandmarks(null).gesture, GESTURES.NONE);
});

test('stabilizer needs consecutive frames before firing', () => {
  const s = new GestureStabilizer({ holdFrames: 3, cooldownMs: 1000 });
  let t = 0;
  assert.equal(s.push(GESTURES.FIST, 0.9, (t += 100)), null);
  assert.equal(s.push(GESTURES.FIST, 0.9, (t += 100)), null);
  const fired = s.push(GESTURES.FIST, 0.9, (t += 100));
  assert.deepEqual(fired, { gesture: GESTURES.FIST, repeat: false });
});

test('stabilizer ignores low-confidence frames', () => {
  const s = new GestureStabilizer({ holdFrames: 2, minConfidence: 0.6 });
  let t = 0;
  for (let i = 0; i < 10; i += 1) {
    assert.equal(s.push(GESTURES.OPEN_PALM, 0.4, (t += 100)), null);
  }
});

test('one-shot gestures do not repeat while held, but re-arm after a change', () => {
  const s = new GestureStabilizer({ holdFrames: 2, cooldownMs: 500 });
  let t = 0;
  s.push(GESTURES.FIST, 0.9, (t += 100));
  assert.ok(s.push(GESTURES.FIST, 0.9, (t += 100)));
  for (let i = 0; i < 30; i += 1) {
    assert.equal(s.push(GESTURES.FIST, 0.9, (t += 100)), null, 'must not auto-repeat');
  }
  // hand leaves the frame
  for (let i = 0; i < 4; i += 1) s.push(GESTURES.NONE, 0, (t += 100));
  s.push(GESTURES.FIST, 0.9, (t += 100));
  assert.ok(s.push(GESTURES.FIST, 0.9, (t += 100)), 'should re-arm after the hand leaves');
});

test('volume gestures repeat while held, at the configured cadence', () => {
  const s = new GestureStabilizer({ holdFrames: 1, cooldownMs: 1000, repeatMs: 400 });
  let t = 0;
  assert.ok(s.push(GESTURES.THUMB_UP, 0.9, (t += 100)));
  assert.equal(s.push(GESTURES.THUMB_UP, 0.9, (t += 100)), null);
  assert.equal(s.push(GESTURES.THUMB_UP, 0.9, (t += 200)), null);
  const repeat = s.push(GESTURES.THUMB_UP, 0.9, (t += 200));
  assert.deepEqual(repeat, { gesture: GESTURES.THUMB_UP, repeat: true });
});

test('switching gestures respects the cooldown', () => {
  const s = new GestureStabilizer({ holdFrames: 1, cooldownMs: 1000 });
  let t = 1000;
  assert.ok(s.push(GESTURES.FIST, 0.9, t));
  assert.equal(s.push(GESTURES.OPEN_PALM, 0.9, t + 300), null, 'too soon');
  assert.ok(s.push(GESTURES.OPEN_PALM, 0.9, t + 1200));
});

/* ------------------------------------------------------------- cameras */

test('camera picker skips phone / virtual cameras', async () => {
  const { chooseCamera, isVirtualCamera } = await import('../lib/camera.js');

  assert.ok(isVirtualCamera('V2545 (Link to Windows)'));
  assert.ok(isVirtualCamera('OBS Virtual Camera'));
  assert.ok(isVirtualCamera('DroidCam Source 3'));
  assert.ok(!isVirtualCamera('Integrated Webcam'));

  const devices = [
    { deviceId: 'phone', kind: 'videoinput', label: 'V2545 (Link to Windows)' },
    { deviceId: 'built-in', kind: 'videoinput', label: 'Integrated Webcam' },
    { deviceId: 'usb', kind: 'videoinput', label: 'Logitech C270' }
  ];
  assert.equal(chooseCamera(devices).deviceId, 'built-in');
  assert.equal(chooseCamera(devices, 'usb').deviceId, 'usb', 'explicit choice wins');
  assert.equal(
    chooseCamera([devices[0], devices[2]]).deviceId,
    'usb',
    'falls back to the first physical camera'
  );
  assert.equal(
    chooseCamera([devices[0]]).deviceId,
    'phone',
    'uses a virtual camera only when it is the only one'
  );
  assert.equal(chooseCamera([]), null);
});

test('openCameraStream never opens the browser default when devices are known', async () => {
  const { openCameraStream } = await import('../lib/camera.js');
  const calls = [];
  const devices = [
    { deviceId: 'phone', kind: 'videoinput', label: 'V2545 (Link to Windows)' },
    { deviceId: 'built-in', kind: 'videoinput', label: 'Integrated Webcam' }
  ];
  const mediaDevices = {
    enumerateDevices: async () => devices,
    getUserMedia: async (constraints) => {
      calls.push(constraints);
      const id = constraints.video?.deviceId?.exact;
      if (!id) throw new Error('generic getUserMedia must not be used here');
      return { getVideoTracks: () => [{ label: devices.find((d) => d.deviceId === id).label }] };
    }
  };

  const opened = await openCameraStream({ width: 320, height: 240, fps: 15, mediaDevices });
  assert.equal(opened.deviceId, 'built-in');
  assert.equal(calls.length, 1, 'exactly one getUserMedia call');
  assert.equal(calls[0].video.deviceId.exact, 'built-in');
  assert.ok(
    !calls.some((c) => c.video === true),
    'must never request the browser default camera'
  );
});

test('openCameraStream falls back past a dead camera but keeps phones last', async () => {
  const { openCameraStream } = await import('../lib/camera.js');
  const tried = [];
  const devices = [
    { deviceId: 'phone', kind: 'videoinput', label: 'V2545 (Link to Windows)' },
    { deviceId: 'built-in', kind: 'videoinput', label: 'Integrated Webcam' },
    { deviceId: 'usb', kind: 'videoinput', label: 'Logitech C270' }
  ];
  const mediaDevices = {
    enumerateDevices: async () => devices,
    getUserMedia: async (constraints) => {
      const id = constraints.video.deviceId.exact;
      tried.push(id);
      if (id === 'built-in') throw Object.assign(new Error('busy'), { name: 'NotReadableError' });
      return { getVideoTracks: () => [{ label: devices.find((d) => d.deviceId === id).label }] };
    }
  };

  const opened = await openCameraStream({ width: 320, height: 240, fps: 15, mediaDevices });
  assert.deepEqual(tried, ['built-in', 'usb']);
  assert.equal(opened.deviceId, 'usb');
  assert.ok(!tried.includes('phone'), 'phone camera must not be tried while a real one works');
});
