/**
 * Timing worker.
 *
 * Chrome throttles timers in hidden documents (an offscreen document is always
 * hidden), which would stall the detection loop after a few minutes. Workers
 * are not throttled the same way, so the worker owns the clock and the document
 * only reacts to ticks.
 */
let timer = null;

self.onmessage = (event) => {
  const { type, intervalMs } = event.data || {};
  if (type === 'start' || type === 'interval') {
    if (timer) clearInterval(timer);
    timer = setInterval(() => self.postMessage({ type: 'tick' }), Math.max(16, intervalMs || 100));
  } else if (type === 'stop') {
    if (timer) clearInterval(timer);
    timer = null;
  }
};
