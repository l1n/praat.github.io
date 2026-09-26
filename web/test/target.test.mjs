// Checks how a target range is derived from an analysed recording.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTarget } from '../public/js/target.js';

/** A fake analysis result with the given pitch values (NaN = unvoiced) at 10 ms steps. */
function fakeResult(f0, formants = [500, 1800, 2800]) {
  const n = f0.length;
  return {
    duration: n * 0.01,
    pitch: { t1: 0.005, dt: 0.01, n, f0: Float64Array.from(f0) },
    formants: { t1: 0.005, dt: 0.01, n, F: formants.map((f) => new Float64Array(n).fill(f)).concat([new Float64Array(n).fill(3800)]) },
  };
}

test('range is the middle 80% of pitch, rounded to 5 Hz', () => {
  const f0 = Array.from({ length: 300 }, (_, i) => 150 + (100 * i) / 299); // 150..250 Hz evenly
  const d = deriveTarget(fakeResult(f0));
  assert.ok(d.ok);
  assert.equal(d.low, 160);
  assert.equal(d.high, 240);
  assert.ok(Math.abs(d.median - 200) < 1);
  assert.deepEqual(d.formants, [500, 1800, 2800]);
});

test('a monotone voice still gets at least ±2 semitones', () => {
  const d = deriveTarget(fakeResult(new Array(200).fill(200)));
  assert.equal(d.low, 180); // 200 * 2^(-2/12) = 178.2
  assert.equal(d.high, 225); // 200 * 2^(2/12) = 224.5
});

test('octave errors and unvoiced frames are ignored', () => {
  const f0 = Array.from({ length: 300 }, (_, i) => (i % 10 === 0 ? 400 : i % 7 === 0 ? NaN : 200));
  const d = deriveTarget(fakeResult(f0));
  assert.ok(d.high < 260, `high ${d.high}`);
});

test('a selection limits the frames used', () => {
  const f0 = [...new Array(200).fill(120), ...new Array(200).fill(220)];
  const d = deriveTarget(fakeResult(f0), 2.0, 4.0);
  assert.ok(Math.abs(d.median - 220) < 1);
});

test('too little voicing is refused', () => {
  const d = deriveTarget(fakeResult([...new Array(50).fill(200), ...new Array(200).fill(NaN)]));
  assert.equal(d.ok, false);
});

test('the vowel cloud is thinned to at most 300 points', () => {
  const d = deriveTarget(fakeResult(new Array(2000).fill(200)));
  assert.ok(d.points.length <= 300 && d.points.length > 100, `${d.points.length} points`);
});
