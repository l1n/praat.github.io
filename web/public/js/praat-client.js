// Promise-based wrapper around the Praat worker.

let worker = null;
let nextId = 1;
const pending = new Map();
const liveListeners = new Set();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./praat-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'live') {
      for (const fn of liveListeners) fn(msg);
    } else if (msg.type === 'result' || msg.type === 'error') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.type === 'result') p.resolve(msg.result);
      else p.reject(new Error(msg.message));
    } else if (msg.type === 'live-error') {
      console.warn('Live analysis error:', msg.message);
    }
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'Analysis engine failed to load'));
    pending.clear();
  };
  return worker;
}

function call(msg, transfer = []) {
  const w = ensureWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ ...msg, id }, transfer);
  });
}

/** Resolves when the WebAssembly module has loaded. */
export function warmUp() {
  return call({ type: 'ping' });
}

/** Full Praat analysis of a recording. `samples` is copied. */
export function analyze(samples, sampleRate, opts) {
  const copy = Float32Array.from(samples);
  return call({ type: 'analyze', samples: copy, sampleRate, opts }, [copy.buffer]);
}

/** Voice report (jitter, shimmer, HNR, CPPS) over a selection of the last analysed recording. */
export function report(tmin, tmax, opts) {
  return call({ type: 'report', tmin, tmax, opts });
}

export function liveStart(sampleRate, params) {
  ensureWorker().postMessage({ type: 'live-start', sampleRate, params });
}

export function liveParams(params) {
  ensureWorker().postMessage({ type: 'live-params', params });
}

export function liveChunk(samples) {
  worker?.postMessage({ type: 'chunk', samples }, [samples.buffer]);
}

export function liveStop() {
  worker?.postMessage({ type: 'live-stop' });
}

export function onLive(fn) {
  liveListeners.add(fn);
  return () => liveListeners.delete(fn);
}
