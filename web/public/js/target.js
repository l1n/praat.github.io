// Deriving a target from a recording of a voice you want to aim for.

import { h, modal, toast } from './ui.js';
import { state, updateSettings } from './state.js';
import { RangeStrip } from './charts.js';
import { noteName, stats } from './music.js';

const MIN_VOICED_SECONDS = 1;
const MAX_REFERENCE_POINTS = 300;

/**
 * Pitch range and vowel space of the voiced part of an analysis between t1 and t2.
 * The range is the 10th to 90th percentile of pitch, widened to at least ±2 semitones around the
 * median, so that a very monotone clip still leaves room for natural intonation.
 */
export function deriveTarget(result, t1 = 0, t2 = result.duration) {
  const p = result.pitch;
  const f0 = [];
  for (let i = 0; i < p.n; i++) {
    const t = p.t1 + i * p.dt;
    if (t >= t1 && t <= t2 && Number.isFinite(p.f0[i])) f0.push(p.f0[i]);
  }
  const voicedSeconds = f0.length * p.dt;
  const rough = stats(f0);
  if (!rough || voicedSeconds < MIN_VOICED_SECONDS) return { voicedSeconds, ok: false };
  // Drop octave jumps before taking percentiles.
  const clean = f0.filter((f) => f > rough.median / 1.8 && f < rough.median * 1.8);
  const s = stats(clean);
  const round5 = (v) => Math.round(v / 5) * 5;
  const low = round5(Math.min(s.q(0.1), s.median * 2 ** (-2 / 12)));
  const high = round5(Math.max(s.q(0.9), s.median * 2 ** (2 / 12)));

  // Formants of voiced frames: medians plus a thinned-out F1/F2 cloud for the vowel chart.
  const fm = result.formants;
  const F = [[], [], []];
  const points = [];
  for (let i = 0; i < fm.n; i++) {
    const t = fm.t1 + i * fm.dt;
    if (t < t1 || t > t2) continue;
    const pi = Math.round((t - p.t1) / p.dt);
    if (!Number.isFinite(p.f0[pi])) continue;
    for (let k = 0; k < 3; k++) if (Number.isFinite(fm.F[k][i])) F[k].push(fm.F[k][i]);
    if (Number.isFinite(fm.F[0][i]) && Number.isFinite(fm.F[1][i])) points.push([Math.round(fm.F[0][i]), Math.round(fm.F[1][i])]);
  }
  const step = Math.max(1, Math.ceil(points.length / MAX_REFERENCE_POINTS));
  return {
    ok: true,
    voicedSeconds,
    median: s.median,
    low,
    high,
    formants: F.map((a) => stats(a)?.median ?? NaN),
    points: points.filter((_, i) => i % step === 0),
  };
}

/** Show the derived target and let the user adopt it. Resolves true if they did. */
export async function offerTarget(result, range, title) {
  const d = deriveTarget(result, range?.[0], range?.[1]);
  if (!d.ok) {
    toast(`Not enough voiced speech${range ? ' in the selection' : ''} (${d.voicedSeconds.toFixed(1)} s); at least ${MIN_VOICED_SECONDS} s is needed.`, { error: true, ms: 6000 });
    return false;
  }
  const lowInput = h('input', { type: 'number', min: 50, max: 900, value: d.low });
  const highInput = h('input', { type: 'number', min: 50, max: 900, value: d.high });
  const stripBox = h('div', { class: 'range-preview' });
  const keepVowels = h('input', { type: 'checkbox', checked: true });
  const fmt = (v) => (Number.isFinite(v) ? v.toFixed(0) : '–');
  const content = h('div', { class: 'stack', style: { gap: '14px' } },
    h('p', { class: 'muted' }, `From ${d.voicedSeconds.toFixed(1)} s of voiced speech in “${title}”${range ? ` (${range[0].toFixed(1)}–${range[1].toFixed(1)} s)` : ''}.`),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Median pitch'), h('div', { class: 'value' }, fmt(d.median), h('small', {}, 'Hz')), h('div', { class: 'sub' }, noteName(d.median))),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'F1 · F2 · F3'), h('div', { class: 'value', style: { fontSize: '1.05rem' } }, d.formants.map(fmt).join(' · ')), h('div', { class: 'sub' }, 'median formants, Hz'))),
    h('div', { class: 'grid grid-2', style: { gap: '12px' } },
      h('label', { class: 'field' }, h('span', {}, 'Target bottom (Hz)'), lowInput),
      h('label', { class: 'field' }, h('span', {}, 'Target top (Hz)'), highInput)),
    stripBox,
    h('p', { class: 'small muted' }, 'Suggested from the middle 80% of this voice’s pitch. Adjust it if you like.'),
    h('label', { class: 'check' }, keepVowels,
      h('span', {}, h('b', {}, 'Show this voice’s vowels on the resonance chart'),
        h('div', { class: 'small muted' }, 'A cloud of its F1/F2 values, so you can compare your resonance with it.'))));
  // The modal is in the DOM once modal() returns its promise, so the strip can measure itself.
  const answer = modal({
    title: 'Use this voice as your target?',
    content,
    actions: [{ label: 'Cancel', value: false }, { label: 'Use as target', primary: true, value: true }],
  });
  const strip = new RangeStrip(stripBox);
  strip.set(d.low, d.high);
  const onInput = () => strip.set(+lowInput.value || d.low, +highInput.value || d.high);
  lowInput.addEventListener('input', onInput);
  highInput.addEventListener('input', onInput);
  const ok = await answer;
  strip.destroy();
  if (!ok) return false;

  const low = Math.round(+lowInput.value), high = Math.round(+highInput.value);
  if (!(low >= 50 && high <= 900 && high > low + 5)) {
    toast('The range should be between 50 and 900 Hz, with the top above the bottom.', { error: true });
    return false;
  }
  updateSettings({
    targetPreset: 'recording',
    targetLow: low,
    targetHigh: high,
    reference: {
      title,
      date: Date.now(),
      median: d.median,
      low: d.low,
      high: d.high,
      formants: d.formants,
      points: keepVowels.checked ? d.points : [],
    },
  });
  toast(`Target set to ${low}–${high} Hz (${noteName(low)}–${noteName(high)}).`);
  return true;
}

/** The saved reference voice, if any. */
export function referenceVoice() {
  return state.settings.reference || null;
}

export function clearReference() {
  updateSettings({ reference: null, targetPreset: 'custom' });
}
