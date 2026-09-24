// Web Worker that owns the Praat WebAssembly module.
// It receives either live audio chunks (for real-time feedback) or whole recordings (for detailed analysis).

import createPraat from '../wasm/praat.mjs';

let P = null;
const ready = createPraat().then((module) => {
  P = module;
  P._pw_init();
});

// ---- helpers around the C API ----

let scratchPtr = 0;
let scratchLen = 0;
function upload(samples) {
  if (samples.length > scratchLen) {
    if (scratchPtr) P._free(scratchPtr);
    scratchLen = Math.max(samples.length, 1 << 14);
    scratchPtr = P._malloc(scratchLen * 4);
  }
  P.HEAPF32.set(samples, scratchPtr >> 2);
  return scratchPtr;
}

function readResult(ptr) {
  if (!ptr) throw new Error(P.UTF8ToString(P._pw_lastError()) || 'Praat analysis failed');
  const n = P._pw_resultLength();
  return Float64Array.from(P.HEAPF64.subarray(ptr >> 3, (ptr >> 3) + n));
}

function track(buf, stride = 1) {
  const t1 = buf[0], dt = buf[1], n = buf[2];
  return { t1, dt, n, values: buf.subarray(3, 3 + n * stride) };
}

// ---- live analysis ----

const live = {
  sampleRate: 48000,
  ring: new Float32Array(0),
  write: 0,
  filled: 0,
  sinceLast: 0,
  params: null,
};

function liveConfigure(sampleRate, params) {
  live.sampleRate = sampleRate;
  live.params = params;
  const size = Math.round(sampleRate * params.windowSeconds);
  live.ring = new Float32Array(size);
  live.linear = new Float32Array(size);
  live.write = 0;
  live.filled = 0;
  live.sinceLast = 0;
  live.hop = Math.round(sampleRate * params.hopSeconds);
  live.clock = 0;
}

function livePush(chunk) {
  const ring = live.ring;
  for (let i = 0; i < chunk.length; i++) {
    ring[live.write] = chunk[i];
    live.write = (live.write + 1) % ring.length;
  }
  live.filled = Math.min(ring.length, live.filled + chunk.length);
  live.sinceLast += chunk.length;
  live.clock += chunk.length;
  if (live.filled < ring.length || live.sinceLast < live.hop) return;
  live.sinceLast = 0;
  // Unroll the ring buffer so that the newest sample is last.
  const n = ring.length;
  live.linear.set(ring.subarray(live.write), 0);
  live.linear.set(ring.subarray(0, live.write), n - live.write);
  const p = live.params;
  const ptr = P._pw_live(upload(live.linear), n, live.sampleRate, p.pitchFloor, p.pitchCeiling, p.formantCeiling, p.silenceDb);
  const r = readResult(ptr);
  postMessage({
    type: 'live',
    time: live.clock / live.sampleRate + r[6],
    f0: r[0], strength: r[1], f1: r[2], f2: r[3], f3: r[4], f4: r[7], level: r[5],
  });
}

// ---- full analysis ----

function analyze(samples, sampleRate, opts) {
  const duration = P._pw_setSound(upload(samples), samples.length, sampleRate);
  if (!Number.isFinite(duration)) throw new Error(P.UTF8ToString(P._pw_lastError()));

  const pitchBuf = readResult(P._pw_pitch(0.01, opts.pitchFloor, opts.pitchCeiling));
  const pn = pitchBuf[2];
  const pitch = { t1: pitchBuf[0], dt: pitchBuf[1], n: pn, f0: pitchBuf.slice(3, 3 + pn), strength: pitchBuf.slice(3 + pn, 3 + 2 * pn) };

  const fBuf = readResult(P._pw_formants(0.01, 5, opts.formantCeiling, 0.025));
  const fn = fBuf[2];
  const formants = { t1: fBuf[0], dt: fBuf[1], n: fn, F: [[], [], [], []], B: [[], [], [], []] };
  for (let i = 0; i < fn; i++) {
    for (let k = 0; k < 4; k++) {
      formants.F[k].push(fBuf[3 + 8 * i + k]);
      formants.B[k].push(fBuf[3 + 8 * i + 4 + k]);
    }
  }
  formants.F = formants.F.map((a) => Float64Array.from(a));
  formants.B = formants.B.map((a) => Float64Array.from(a));

  const iBuf = readResult(P._pw_intensity(Math.max(opts.pitchFloor, 75), 0.01));
  const intensity = { ...track(iBuf), values: iBuf.slice(3) };

  const hBuf = readResult(P._pw_harmonicity(0.01, Math.max(opts.pitchFloor, 75)));
  const harmonicity = { ...track(hBuf), values: hBuf.slice(3) };

  // Keep the spectrogram to a sensible number of columns for display.
  const timeStep = Math.max(0.002, duration / 1500);
  const sBuf = readResult(P._pw_spectrogram(0.005, opts.spectrogramMax || 5500, timeStep, 20, 70));
  const spectrogram = {
    t1: sBuf[0], dt: sBuf[1], nt: sBuf[2], f1: sBuf[3], df: sBuf[4], nf: sBuf[5],
    db: Float32Array.from(sBuf.subarray(6)),
  };

  // The voice report takes about a second per 5 s of audio; for longer recordings the
  // page asks for it separately (with 'report') so the charts can appear first.
  const report = duration <= 8 ? voiceReport(0, 0, opts) : null;
  return { duration, sampleRate, pitch, formants, intensity, harmonicity, spectrogram, report };
}

function voiceReport(tmin, tmax, opts) {
  const r = readResult(P._pw_voiceReport(tmin, tmax, Math.max(opts.pitchFloor, 60), Math.min(opts.pitchCeiling, 600)));
  return {
    jitterLocal: r[0], jitterRap: r[1], jitterPpq5: r[2],
    shimmerLocal: r[3], shimmerLocalDb: r[4], shimmerApq3: r[5],
    hnr: r[6], cpps: r[7], pulses: r[8], periods: r[9], meanPeriod: r[10], unvoicedFraction: r[11],
  };
}

// ---- message loop ----

onmessage = async (e) => {
  const msg = e.data;
  try {
    await ready;
    switch (msg.type) {
      case 'live-start':
        liveConfigure(msg.sampleRate, msg.params);
        break;
      case 'live-params':
        live.params = { ...live.params, ...msg.params };
        break;
      case 'chunk':
        if (live.ring.length) livePush(msg.samples);
        break;
      case 'live-stop':
        live.ring = new Float32Array(0);
        break;
      case 'analyze': {
        const t0 = performance.now();
        const result = analyze(msg.samples, msg.sampleRate, msg.opts);
        result.elapsedMs = performance.now() - t0;
        postMessage({ type: 'result', id: msg.id, result });
        break;
      }
      case 'report': {
        // Voice report for a selection of the last analysed sound.
        postMessage({ type: 'result', id: msg.id, result: voiceReport(msg.tmin, msg.tmax, msg.opts) });
        break;
      }
      case 'ping':
        postMessage({ type: 'result', id: msg.id, result: 'ready' });
        break;
    }
  } catch (err) {
    if (msg.id !== undefined) postMessage({ type: 'error', id: msg.id, message: String(err.message || err) });
    else postMessage({ type: 'live-error', message: String(err.message || err) });
  }
};
