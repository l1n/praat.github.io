// Synthetic test signals with known pitch and formants.

/**
 * Glottal-pulse train filtered through second-order resonators: a crude but
 * well-defined vowel with fundamental `f0` (number or function of time) and formants `formants`.
 */
export function vowel({ sampleRate = 44100, duration = 1, f0 = 200, formants = [700, 1200, 2600, 3500, 4500], bandwidths = [80, 90, 120, 150, 200], jitter = 0, noise = 0 }) {
  const n = Math.round(duration * sampleRate);
  const source = new Float64Array(n);
  let phase = 0;
  let rand = 12345;
  const rnd = () => ((rand = (rand * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f = typeof f0 === 'function' ? f0(t) : f0;
    phase += f / sampleRate;
    if (phase >= 1) {
      phase -= 1 + (jitter ? (rnd() - 0.5) * jitter : 0);
      source[i] = 1;
    }
    if (noise) source[i] += (rnd() - 0.5) * noise;
  }
  let signal = source;
  for (let k = 0; k < formants.length; k++) {
    const r = Math.exp(-Math.PI * bandwidths[k] / sampleRate);
    const theta = 2 * Math.PI * formants[k] / sampleRate;
    const a1 = 2 * r * Math.cos(theta), a2 = -r * r, g = 1 - a1 - a2;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = g * signal[i] + a1 * (out[i - 1] || 0) + a2 * (out[i - 2] || 0);
    signal = out;
  }
  // Remove DC and normalize to a peak of 0.5.
  const y = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    y[i] = signal[i];
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += y[i] / n;
  for (let i = 0; i < n; i++) {
    y[i] -= mean;
    peak = Math.max(peak, Math.abs(y[i]));
  }
  for (let i = 0; i < n; i++) y[i] *= 0.5 / peak;
  return y;
}
