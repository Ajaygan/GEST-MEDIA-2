/**
 * Camera selection helpers.
 *
 * Windows 11 ("Link to Windows" / Phone Link), OBS, DroidCam, Iriun and friends
 * install *virtual* cameras that often sort first in `enumerateDevices()`, so a
 * naive `getUserMedia({ video: true })` can end up asking your phone for frames.
 * `chooseCamera()` avoids that by preferring a real, built-in camera unless the
 * user explicitly picked a device.
 *
 * Kept pure (no DOM access) so it can be unit tested.
 */

/** Devices we never auto-select — they need a phone/another app to be running. */
export const VIRTUAL_CAMERA_PATTERNS = [
  /link to windows/i,
  /phone link/i,
  /your phone/i,
  /\bmobile\b.*\bcamera\b/i,
  /windows virtual camera/i,
  /virtual camera/i,
  /\bobs\b/i,
  /droidcam/i,
  /iriun/i,
  /epoccam/i,
  /ivcam/i,
  /camo\b/i,
  /manycam/i,
  /snap camera/i,
  /xsplit/i,
  /nvidia broadcast/i,
  /elgato virtual/i,
  /\bdummy\b/i
];

/** Labels that strongly suggest the laptop's own camera. */
const BUILT_IN_PATTERNS = [
  /integrated/i,
  /built[- ]?in/i,
  /internal/i,
  /\bhd (user|web)?cam/i,
  /facetime/i,
  /laptop/i,
  /\bwebcam\b/i
];

export const isVirtualCamera = (label = '') =>
  VIRTUAL_CAMERA_PATTERNS.some((re) => re.test(label));

const isBuiltIn = (label = '') => BUILT_IN_PATTERNS.some((re) => re.test(label));

/**
 * Pick which camera to open.
 *
 * @param {Array<{deviceId:string,label?:string,kind?:string}>} devices
 * @param {string} [preferredId] deviceId the user explicitly chose
 * @returns {{deviceId:string, label:string, reason:string}|null}
 */
export function chooseCamera(devices, preferredId = '') {
  const cams = (devices || []).filter((d) => !d.kind || d.kind === 'videoinput');
  if (!cams.length) return null;

  if (preferredId) {
    const exact = cams.find((d) => d.deviceId === preferredId);
    if (exact) return { deviceId: exact.deviceId, label: exact.label || '', reason: 'user choice' };
  }

  const real = cams.filter((d) => !isVirtualCamera(d.label || ''));
  const builtIn = real.find((d) => isBuiltIn(d.label || ''));
  if (builtIn) {
    return { deviceId: builtIn.deviceId, label: builtIn.label || '', reason: 'built-in camera' };
  }
  if (real.length) {
    return { deviceId: real[0].deviceId, label: real[0].label || '', reason: 'first physical camera' };
  }
  return { deviceId: cams[0].deviceId, label: cams[0].label || '', reason: 'only camera available' };
}

/** Media-devices accessor, overridable in tests. */
const md = (override) => override || globalThis.navigator?.mediaDevices;

/** List video inputs (labels are only populated once permission is granted). */
export async function listCameras(mediaDevices) {
  try {
    const devices = await md(mediaDevices).enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  } catch {
    return [];
  }
}

/** True when the camera permission has already been granted to this origin. */
export async function cameraPermissionGranted() {
  try {
    const status = await navigator.permissions.query({ name: 'camera' });
    return status.state === 'granted';
  } catch {
    return false;
  }
}

/**
 * Ask for camera permission without opening the browser's default device.
 *
 * A plain `getUserMedia({ video: true })` hands you whatever Chrome considers
 * the default camera — on Windows that is frequently the "Link to Windows" /
 * Phone Link virtual camera, which then pops up "connect to Wi-Fi…" on the
 * phone. So: enumerate first, and if usable deviceIds are already exposed,
 * request one *specific* physical camera. Only when the browser exposes
 * nothing at all do we fall back to a generic request.
 *
 * @returns {Promise<{granted:boolean, error?:Error}>}
 */
export async function requestCameraPermission(preferredId = '') {
  if (await cameraPermissionGranted()) return { granted: true };
  const devices = await listCameras();
  const usable = devices.filter((d) => d.deviceId);
  const choice = chooseCamera(usable, preferredId);
  const constraints = choice?.deviceId
    ? { audio: false, video: { deviceId: { exact: choice.deviceId } } }
    : { audio: false, video: true };
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    stream.getTracks().forEach((t) => t.stop());
    return { granted: true };
  } catch (error) {
    return { granted: false, error };
  }
}

/**
 * Open a camera stream, never touching a phone/virtual camera unless it is the
 * only device present or the user explicitly picked it.
 *
 * @param {{preferredId?:string, width:number, height:number, fps:number,
 *          allowVirtual?:boolean}} opts
 * @returns {Promise<{stream: MediaStream, deviceId: string, label: string, reason: string}>}
 */
export async function openCameraStream({
  preferredId = '',
  width,
  height,
  fps,
  allowVirtual = false,
  mediaDevices
}) {
  const devicesApi = md(mediaDevices);
  const base = {
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: fps, max: 30 }
  };
  const openExact = (deviceId) =>
    devicesApi.getUserMedia({
      audio: false,
      video: { ...base, deviceId: { exact: deviceId } }
    });

  // 1. An explicit user choice is always honoured, with no probing at all.
  if (preferredId) {
    try {
      const stream = await openExact(preferredId);
      return {
        stream,
        deviceId: preferredId,
        label: stream.getVideoTracks()[0]?.label || '',
        reason: 'user choice'
      };
    } catch (err) {
      if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') throw err;
      // chosen camera unplugged -> fall through to auto-selection
    }
  }

  // 2. Auto-selection over the enumerated devices. Labels are visible as soon
  //    as permission exists, so the virtual-camera filter can do its job.
  const devices = await listCameras(devicesApi);
  const named = devices.filter((d) => d.deviceId);
  const ordered = [];
  const primary = chooseCamera(named, '');
  if (primary) ordered.push(primary);
  for (const device of named) {
    if (ordered.some((c) => c.deviceId === device.deviceId)) continue;
    if (!allowVirtual && isVirtualCamera(device.label || '')) continue;
    ordered.push({ deviceId: device.deviceId, label: device.label || '', reason: 'next camera' });
  }
  // Virtual cameras are only ever tried as an absolute last resort.
  for (const device of named) {
    if (ordered.some((c) => c.deviceId === device.deviceId)) continue;
    ordered.push({
      deviceId: device.deviceId,
      label: device.label || '',
      reason: 'last resort (virtual camera)'
    });
  }

  let lastError = null;
  for (const candidate of ordered) {
    try {
      const stream = await openExact(candidate.deviceId);
      return { stream, ...candidate, label: stream.getVideoTracks()[0]?.label || candidate.label };
    } catch (err) {
      lastError = err;
      if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') throw err;
    }
  }

  // 3. Nothing enumerable (permission not granted yet) -> generic request.
  if (!named.length) {
    const stream = await devicesApi.getUserMedia({
      audio: false,
      video: { ...base, facingMode: 'user' }
    });
    const track = stream.getVideoTracks()[0];
    const label = track?.label || '';
    // If Chrome handed us a phone/virtual camera, immediately swap to a real
    // one now that permission (and therefore labels) exists.
    if (!allowVirtual && isVirtualCamera(label)) {
      const real = chooseCamera((await listCameras(devicesApi)).filter((d) => d.deviceId), '');
      if (real?.deviceId && !isVirtualCamera(real.label || '')) {
        stream.getTracks().forEach((t) => t.stop());
        const better = await openExact(real.deviceId);
        return {
          stream: better,
          deviceId: real.deviceId,
          label: better.getVideoTracks()[0]?.label || real.label,
          reason: 'switched off virtual camera'
        };
      }
    }
    return { stream, deviceId: '', label, reason: 'browser default' };
  }

  throw lastError || new Error('No camera could be opened');
}
