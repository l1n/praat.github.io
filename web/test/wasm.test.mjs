// Checks the Praat WebAssembly module against synthetic signals.
// Run with: node --test web/test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import createPraat from '../public/wasm/praat.mjs';
import { vowel } from './synth.mjs';

const P = await createPraat();
P._pw_init();

function call(fnName, samples, ...args) {
  const ptr = P._malloc(samples.length * 4);
  P.HEAPF32.set(samples, ptr >> 2);
  try {
    const res = P[fnName](ptr, samples.length, ...args);
    if (!res) throw new Error(P.UTF8ToString(P._pw_lastError()));
    return Float64Array.from(P.HEAPF64.subarray(res >> 3, (res >> 3) + P._pw_resultLength()));
  } finally {
    P._free(ptr);
  }
}

function setSound(samples, sr) {
  const ptr = P._malloc(samples.length * 4);
  P.HEAPF32.set(samples, ptr >> 2);
  const d = P._pw_setSound(ptr, samples.length, sr);
  P._free(ptr);
  return d;
}

function result(ptr) {
  if (!ptr) throw new Error(P.UTF8ToString(P._pw_lastError()));
  return Float64Array.from(P.HEAPF64.subarray(ptr >> 3, (ptr >> 3) + P._pw_resultLength()));
}

const median = (a) => {
  const v = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  return v[Math.floor(v.length / 2)];
};

test('live analysis finds pitch and formants of a steady vowel', () => {
  const sr = 48000;
  const s = vowel({ sampleRate: sr, duration: 0.2, f0: 180, formants: [700, 1220, 2600, 3500, 4500] });
  const r = call('_pw_live', s, sr, 60, 600, 5500, -60);
  assert.ok(Math.abs(r[0] - 180) < 2, `f0 ${r[0]}`);
  assert.ok(Math.abs(r[2] - 700) < 90, `F1 ${r[2]}`);
  assert.ok(Math.abs(r[3] - 1220) < 120, `F2 ${r[3]}`);
  assert.ok(Math.abs(r[4] - 2600) < 200, `F3 ${r[4]}`);
  assert.ok(r[5] < 0 && r[5] > -30, `level ${r[5]}`);
});

test('live analysis reports silence as unvoiced', () => {
  const s = new Float32Array(9600);
  const r = call('_pw_live', s, 48000, 60, 600, 5500, -60);
  assert.ok(Number.isNaN(r[0]));
});

test('pitch contour follows a glide', () => {
  const sr = 44100;
  const s = vowel({ sampleRate: sr, duration: 1.5, f0: (t) => 120 + 80 * t });
  assert.ok(Math.abs(setSound(s, sr) - 1.5) < 1e-3);
  const r = result(P._pw_pitch(0.01, 60, 600));
  const [t1, dt, n] = r;
  let checked = 0;
  for (let i = 0; i < n; i++) {
    const t = t1 + i * dt, f = r[3 + i];
    if (!Number.isFinite(f) || t < 0.1 || t > 1.4) continue;
    assert.ok(Math.abs(f - (120 + 80 * t)) < 4, `t=${t} f=${f}`);
    checked++;
  }
  assert.ok(checked > 100, `checked ${checked}`);
});

test('formant tracks, intensity, harmonicity and spectrogram', () => {
  const sr = 22050;
  const s = vowel({ sampleRate: sr, duration: 1, f0: 115, formants: [340, 2250, 3000, 3700, 4700], bandwidths: [60, 100, 150, 200, 250] });
  setSound(s, sr);
  const f = result(P._pw_formants(0.01, 5, 5500, 0.025));
  const n = f[2];
  const F1 = [], F2 = [];
  for (let i = 0; i < n; i++) { F1.push(f[3 + 8 * i]); F2.push(f[3 + 8 * i + 1]); }
  assert.ok(Math.abs(median(F1) - 340) < 60, `F1 ${median(F1)}`);
  assert.ok(Math.abs(median(F2) - 2250) < 150, `F2 ${median(F2)}`);

  const it = result(P._pw_intensity(75, 0.01));
  assert.ok(it[2] > 50 && Number.isFinite(median(it.subarray(3))));

  const h = result(P._pw_harmonicity(0.01, 75));
  assert.ok(median(h.subarray(3)) > 15, `HNR ${median(h.subarray(3))}`);

  const sp = result(P._pw_spectrogram(0.005, 5000, 0.002, 20, 70));
  assert.equal(sp.length, 6 + sp[2] * sp[5]);
  assert.ok(Math.max(...sp.subarray(6)) === 0);
});

test('voice report: clean vs jittery voice', () => {
  const sr = 44100;
  setSound(vowel({ sampleRate: sr, duration: 1.5, f0: 140 }), sr);
  const clean = result(P._pw_voiceReport(0, 0, 75, 500));
  setSound(vowel({ sampleRate: sr, duration: 1.5, f0: 140, jitter: 0.03, noise: 0.1 }), sr);
  const rough = result(P._pw_voiceReport(0, 0, 75, 500));
  assert.ok(clean[0] < 0.01, `clean jitter ${clean[0]}`);
  assert.ok(rough[0] > clean[0], `rough jitter ${rough[0]} vs ${clean[0]}`);
  assert.ok(clean[6] > rough[6], `HNR ${clean[6]} vs ${rough[6]}`);
  assert.ok(Number.isFinite(clean[7]), `CPPS ${clean[7]}`);
  assert.ok(clean[8] > 150, `pulses ${clean[8]}`);
});

test('errors are reported, not thrown', () => {
  const s = new Float32Array(100);
  setSound(s, 44100);
  assert.equal(P._pw_pitch(0.01, 60, 600), 0);
  assert.ok(P.UTF8ToString(P._pw_lastError()).length > 0);
});

test('live analysis is fast enough for real time', () => {
  const sr = 48000;
  const s = vowel({ sampleRate: sr, duration: 0.2, f0: 220 });
  const t0 = performance.now();
  for (let i = 0; i < 40; i++) call('_pw_live', s, sr, 60, 600, 5500, -60);
  const perCall = (performance.now() - t0) / 40;
  assert.ok(perCall < 15, `${perCall.toFixed(1)} ms per call`);
  console.log(`live analysis: ${perCall.toFixed(2)} ms per 0.2 s buffer`);
});
