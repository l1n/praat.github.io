// Microphone capture, recording, playback and tone generation with the Web Audio API.

import * as praat from './praat-client.js';

let ctx = null;

export function audioContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// ---------------------------------------------------------------------------
// Microphone

const mic = {
  stream: null,
  source: null,
  node: null,
  running: false,
  recording: null, // array of Float32Array chunks while recording
  chunkListeners: new Set(),
};

export function micRunning() {
  return mic.running;
}

export function micSampleRate() {
  return ctx ? ctx.sampleRate : 48000;
}

/**
 * Start the microphone and live Praat analysis.
 * Voice analysis needs the raw signal, so echo cancellation, noise suppression
 * and automatic gain control are switched off.
 */
export async function startMic({ deviceId, liveParams }) {
  if (mic.running) return;
  const c = audioContext();
  const constraints = {
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  };
  mic.stream = await navigator.mediaDevices.getUserMedia(constraints);
  await c.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
  mic.source = c.createMediaStreamSource(mic.stream);
  mic.node = new AudioWorkletNode(c, 'capture');
  mic.node.port.onmessage = (e) => {
    const block = e.data;
    if (mic.recording) mic.recording.push(block.slice());
    for (const fn of mic.chunkListeners) fn(block);
    praat.liveChunk(block);
  };
  mic.source.connect(mic.node);
  // The worklet must be pulled by the graph; a muted gain keeps the mic out of the speakers.
  const mute = c.createGain();
  mute.gain.value = 0;
  mic.node.connect(mute).connect(c.destination);
  mic.mute = mute;
  praat.liveStart(c.sampleRate, liveParams);
  mic.running = true;
}

export function stopMic() {
  if (!mic.running) return;
  praat.liveStop();
  mic.node.port.onmessage = null;
  mic.source.disconnect();
  mic.node.disconnect();
  mic.mute.disconnect();
  for (const track of mic.stream.getTracks()) track.stop();
  mic.running = false;
  mic.recording = null;
}

export function onMicChunk(fn) {
  mic.chunkListeners.add(fn);
  return () => mic.chunkListeners.delete(fn);
}

export function startRecording() {
  mic.recording = [];
}

export function isRecording() {
  return !!mic.recording;
}

/** Stop recording and return { samples, sampleRate }. */
export function stopRecording() {
  const chunks = mic.recording || [];
  mic.recording = null;
  return { samples: concat(chunks), sampleRate: micSampleRate() };
}

export function recordingSeconds() {
  if (!mic.recording) return 0;
  return mic.recording.length * 1024 / micSampleRate();
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export async function listInputs() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Playback

let playing = null;

/**
 * Play samples from `from` to `to` seconds. Calls onTime(t) on every animation frame and onEnd() at the end.
 * Returns a stop function.
 */
export function play(samples, sampleRate, { from = 0, to = samples.length / sampleRate, onTime, onEnd } = {}) {
  stopPlayback();
  const c = audioContext();
  const buffer = c.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(c.destination);
  const startAt = c.currentTime + 0.02;
  src.start(startAt, from, Math.max(0.01, to - from));
  let raf = 0;
  const tick = () => {
    const t = from + (c.currentTime - startAt);
    if (onTime) onTime(Math.min(Math.max(t, from), to));
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  const handle = {
    stop() {
      cancelAnimationFrame(raf);
      try { src.stop(); } catch { /* already stopped */ }
      src.onended = null;
      if (playing === handle) playing = null;
      onEnd?.();
    },
  };
  src.onended = () => handle.stop();
  playing = handle;
  return () => handle.stop();
}

export function stopPlayback() {
  if (playing) playing.stop();
}

export function isPlaying() {
  return !!playing;
}

/** Play a soft, voice-like reference tone at `hz`. */
export function playTone(hz, seconds = 1.2) {
  const c = audioContext();
  const t0 = c.currentTime + 0.01;
  const out = c.createGain();
  out.gain.setValueAtTime(0, t0);
  out.gain.linearRampToValueAtTime(0.22, t0 + 0.06);
  out.gain.setValueAtTime(0.22, t0 + seconds - 0.15);
  out.gain.linearRampToValueAtTime(0, t0 + seconds);
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = Math.min(4000, hz * 6);
  const osc = c.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = hz;
  osc.connect(filter).connect(out).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + seconds + 0.05);
  return new Promise((resolve) => { osc.onended = resolve; });
}

// ---------------------------------------------------------------------------
// Files

/** Decode any browser-supported audio file to mono samples. */
export async function decodeFile(file) {
  const data = await file.arrayBuffer();
  const c = audioContext();
  const buffer = await c.decodeAudioData(data);
  const n = buffer.length;
  const mono = new Float32Array(n);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < n; i++) mono[i] += d[i] / buffer.numberOfChannels;
  }
  return { samples: mono, sampleRate: buffer.sampleRate };
}

/** Encode mono samples as a 16-bit WAV file. */
export function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Trim leading and trailing silence (below -50 dBFS), keeping a little margin. */
export function trimSilence(samples, sampleRate, thresholdDb = -50) {
  const win = Math.round(sampleRate * 0.02);
  const thr = 10 ** (thresholdDb / 20);
  let first = -1, last = -1;
  for (let i = 0; i + win <= samples.length; i += win) {
    let peak = 0;
    for (let j = i; j < i + win; j++) peak = Math.max(peak, Math.abs(samples[j]));
    if (peak > thr) {
      if (first < 0) first = i;
      last = i + win;
    }
  }
  if (first < 0) return samples;
  const margin = Math.round(sampleRate * 0.15);
  return samples.slice(Math.max(0, first - margin), Math.min(samples.length, last + margin));
}
