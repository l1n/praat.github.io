// Pitch helpers: conversions between Hz, semitones and note names.

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/** MIDI note number (69 = A4 = 440 Hz), fractional. */
export function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Nearest note name with octave, e.g. "A3". */
export function noteName(hz) {
  if (!(hz > 0)) return '–';
  const midi = Math.round(hzToMidi(hz));
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

/** Deviation from the nearest note in cents (-50..50). */
export function centsOff(hz) {
  const midi = hzToMidi(hz);
  return Math.round((midi - Math.round(midi)) * 100);
}

/** Distance between two frequencies in semitones. */
export function semitones(fromHz, toHz) {
  return 12 * Math.log2(toHz / fromHz);
}

export function formatHz(hz, digits = 0) {
  return Number.isFinite(hz) ? `${hz.toFixed(digits)} Hz` : '–';
}

/** Statistics over the finite values of an array. */
export function stats(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => {
    const i = (v.length - 1) * p;
    const lo = Math.floor(i), hi = Math.ceil(i);
    return v[lo] + (v[hi] - v[lo]) * (i - lo);
  };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length - 1));
  return { n: v.length, mean, sd, min: v[0], max: v[v.length - 1], median: q(0.5), p05: q(0.05), p95: q(0.95), q };
}

/** Standard deviation of pitch in semitones (relative to the median), a common measure of intonation range. */
export function pitchSdSemitones(hzValues) {
  const s = stats(hzValues);
  if (!s) return NaN;
  const st = hzValues.filter(Number.isFinite).map((f) => semitones(s.median, f));
  return stats(st).sd;
}
