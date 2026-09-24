// Practice view: guided exercises with scoring.

import { h, icon, statTile, toast, formatDuration } from '../ui.js';
import { state, liveParams, target, analysisOptions } from '../state.js';
import { LivePitchChart } from '../charts.js';
import { noteName, midiToHz, hzToMidi, stats, pitchSdSemitones } from '../music.js';
import * as audio from '../audio.js';
import * as praat from '../praat-client.js';
import { saveSession } from '../store.js';

const EXERCISES = [
  {
    id: 'match', icon: 'note', title: 'Pitch match',
    blurb: 'Hear a note from your target range, then hum or sing it back and hold it.',
    meta: '8 notes · about 2 minutes', run: pitchMatch,
  },
  {
    id: 'glide', icon: 'glide', title: 'Glide along',
    blurb: 'Follow a smooth curve through your range, like a siren. Builds control and flexibility.',
    meta: '30 seconds', run: glide,
  },
  {
    id: 'sustain', icon: 'vowel', title: 'Steady vowel',
    blurb: 'Hold an “ah” for five seconds. Praat measures stability, jitter, shimmer and HNR.',
    meta: '5 seconds', run: sustain,
  },
  {
    id: 'read', icon: 'book', title: 'Read aloud',
    blurb: 'Read a short passage in your target voice. See your speaking pitch, range and resonance.',
    meta: 'about 30 seconds', run: readAloud,
  },
];

export const PASSAGES = [
  {
    title: 'The lighthouse',
    text: 'On the far side of the bay stands an old lighthouse. Every evening, just before sunset, the keeper climbs the spiral stairs and lights the great lamp. Sailors say they can see its beam from miles away, sweeping slowly across the dark water. Nobody remembers who built it, but everyone agrees the harbour would feel empty without it.',
  },
  {
    title: 'Morning market',
    text: 'The market opens early on Saturday mornings. By seven o’clock the stalls are covered with ripe peaches, fresh bread, and bunches of bright flowers. A musician plays a cheerful tune by the fountain while children chase each other between the tables. I usually buy a coffee, find a quiet bench, and watch the whole town wake up.',
  },
  {
    title: 'A letter home',
    text: 'Dear Sam, the weather here has been wonderful all week. We walked along the river yesterday and found a tiny café that serves the best lemon cake I have ever tasted. Tomorrow we are taking the train up into the mountains. I will send you a photo of the view if the clouds stay away. See you very soon!',
  },
];

export default function practiceView(root, ctx) {
  let active = null;

  function showList() {
    active?.stop?.();
    active = null;
    root.replaceChildren(
      h('div', { class: 'view-head' },
        h('div', {}, h('h1', {}, 'Practice'),
          h('p', {}, 'Short, focused exercises. Warm up gently, stay hydrated, and stop if anything feels strained.'))),
      h('div', { class: 'grid grid-auto' }, EXERCISES.map((ex) =>
        h('button', { class: 'card exercise-card', onclick: () => start(ex) },
          h('div', { class: 'icon-wrap' }, icon(ex.icon)),
          h('h2', {}, ex.title),
          h('p', {}, ex.blurb),
          h('div', { class: 'meta' }, ex.meta)))),
      h('div', { class: 'callout' }, icon('info'),
        h('span', {}, `Your target range is ${state.settings.targetLow}–${state.settings.targetHigh} Hz (${noteName(state.settings.targetLow)}–${noteName(state.settings.targetHigh)}). Change it in `,
          h('a', { href: '#/settings' }, 'Settings'), '.')),
    );
  }

  function start(ex) {
    root.replaceChildren();
    const stage = h('div', { class: 'exercise-stage' });
    const back = h('button', { class: 'btn ghost small', onclick: showList }, '← All exercises');
    root.append(
      h('div', { class: 'view-head' },
        h('div', {}, back, h('h1', { style: { marginTop: '8px' } }, ex.title), h('p', {}, ex.blurb))),
      stage);
    active = ex.run(stage, { ...ctx, done: showList });
  }

  showList();
  return { unmount() { active?.stop?.(); } };
}

// ---------------------------------------------------------------------------
// Shared: microphone + live chart for an exercise.

function liveRig(container, { windowSeconds = 8, futureSeconds = 0 } = {}) {
  const box = h('div', { class: 'chart-live' });
  container.append(box);
  const chart = new LivePitchChart(box, { windowSeconds });
  chart.futureSeconds = futureSeconds;
  const t = target();
  chart.setTarget(t.low, t.high);
  chart.showNotes = state.settings.showNotes;
  const listeners = new Set();
  const off = praat.onLive((m) => {
    if (!audio.micRunning()) return;
    chart.push(m);
    for (const fn of listeners) fn(m);
  });
  return {
    chart,
    onFrame(fn) { listeners.add(fn); },
    async start() {
      await praat.warmUp();
      if (!audio.micRunning()) await audio.startMic({ deviceId: state.settings.deviceId, liveParams: liveParams() });
      chart.start();
    },
    stop() {
      off();
      chart.stop();
      if (audio.isRecording()) audio.stopRecording();
      audio.stopMic();
    },
    destroy() {
      this.stop();
      chart.destroy();
    },
  };
}

function micError(e) {
  toast(e.name === 'NotAllowedError' ? 'Microphone permission was denied.' : `Microphone error: ${e.message}`, { error: true, ms: 6000 });
}

function resultCard(title, tiles, extra = []) {
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, title)),
    h('div', { class: 'stats wide' }, tiles),
    extra);
}

// ---------------------------------------------------------------------------
// Pitch match

function pitchMatch(stage, { done }) {
  const ROUNDS = 8, HOLD = 1.0, TIMEOUT = 8, TOL = 35;
  const t = target();
  const lo = Math.ceil(hzToMidi(t.low)), hi = Math.floor(hzToMidi(t.high));
  const notes = [];
  for (let i = 0; i < ROUNDS; i++) {
    let m;
    do { m = lo + Math.floor(Math.random() * Math.max(1, hi - lo + 1)); } while (notes.length && m === notes[notes.length - 1] && hi > lo);
    notes.push(m);
  }

  const dots = h('div', { class: 'progress-dots' }, notes.map(() => h('i')));
  const targetBig = h('div', { class: 'big' }, '–');
  const targetSub = h('div', { class: 'muted' }, 'Press start. Headphones recommended.');
  const holdFill = h('div');
  const feedback = h('div', { class: 'muted small', style: { textAlign: 'center', minHeight: '1.5em' } });
  const startBtn = h('button', { class: 'btn primary big', onclick: begin }, icon('play'), 'Start');
  const replayBtn = h('button', { class: 'btn', onclick: () => playCurrent(), disabled: true }, icon('note'), 'Replay note');
  const skipBtn = h('button', { class: 'btn ghost', onclick: () => finishRound(false), disabled: true }, 'Skip');
  const card = h('div', { class: 'card stack' },
    dots,
    h('div', { class: 'target-display' }, targetBig, targetSub),
    h('div', { class: 'hold-bar', title: 'Hold the note to fill the bar' }, holdFill),
    feedback,
    h('div', { class: 'row', style: { justifyContent: 'center' } }, startBtn, replayBtn, skipBtn));
  stage.append(card);
  const chartCard = h('div', { class: 'card' });
  stage.append(chartCard);
  const rig = liveRig(chartCard, { windowSeconds: 6 });

  let round = -1, held = 0, roundStart = 0, lastTime = null, listening = false;
  const results = [];
  let errors = [];

  async function begin() {
    startBtn.disabled = true;
    try {
      await rig.start();
    } catch (e) {
      startBtn.disabled = false;
      return micError(e);
    }
    startBtn.hidden = true;
    replayBtn.disabled = false;
    skipBtn.disabled = false;
    nextRound();
  }

  async function playCurrent() {
    listening = false;
    const thisRound = round;
    const hz = midiToHz(notes[round]);
    feedback.textContent = 'Listen…';
    await audio.playTone(hz, 1.3);
    await new Promise((r) => setTimeout(r, 250));
    if (round !== thisRound) return; // skipped while the tone was playing
    listening = true;
    lastTime = null;
    roundStart = performance.now();
    feedback.textContent = 'Your turn: match the note and hold it.';
  }

  function nextRound() {
    round++;
    if (round >= ROUNDS) return finish();
    held = 0;
    errors = [];
    holdFill.style.width = '0';
    [...dots.children].forEach((d, i) => { d.className = i < round ? 'done' : i === round ? 'current' : ''; });
    const hz = midiToHz(notes[round]);
    targetBig.textContent = noteName(hz);
    targetSub.textContent = `${hz.toFixed(0)} Hz · note ${round + 1} of ${ROUNDS}`;
    rig.chart.guide = { hz, tolCents: TOL };
    playCurrent();
  }

  rig.onFrame((m) => {
    if (!listening || round < 0 || round >= ROUNDS) return;
    const dt = lastTime === null ? 0 : Math.min(0.1, m.time - lastTime);
    lastTime = m.time;
    const hz = midiToHz(notes[round]);
    if (Number.isFinite(m.f0)) {
      // Fold octave errors into the feedback, but only count the right octave.
      const c = 1200 * Math.log2(m.f0 / hz);
      if (Math.abs(c) <= TOL) {
        held += dt;
        errors.push(Math.abs(c));
        feedback.textContent = 'Great, hold it…';
      } else {
        const semis = Math.abs(c) / 100;
        feedback.textContent = Math.abs(c) > 900 ? 'That’s a different octave: try the same note higher or lower.'
          : semis >= 1.5 ? `${Math.round(semis)} semitones too ${c < 0 ? 'low: go up' : 'high: go down'}`
            : c < 0 ? `A little low (${Math.round(c)}¢): go up` : `A little high (+${Math.round(c)}¢): go down`;
      }
    }
    holdFill.style.width = `${Math.min(100, (held / HOLD) * 100)}%`;
    if (held >= HOLD) finishRound(true);
    else if ((performance.now() - roundStart) / 1000 > TIMEOUT) finishRound(false);
  });

  function finishRound(ok) {
    if (!listening && ok) return;
    listening = false;
    const secs = (performance.now() - roundStart) / 1000;
    results.push({ ok, secs, cents: errors.length ? stats(errors).mean : NaN });
    feedback.textContent = ok ? `Matched in ${secs.toFixed(1)} s!` : 'Moving on.';
    setTimeout(nextRound, ok ? 700 : 400);
  }

  async function finish() {
    rig.stop();
    rig.chart.guide = null;
    const matched = results.filter((r) => r.ok);
    const avgCents = stats(matched.map((r) => r.cents))?.mean;
    const avgSecs = stats(matched.map((r) => r.secs))?.mean;
    stage.replaceChildren(resultCard('Results', [
      statTile('Matched', `${matched.length}/${ROUNDS}`),
      statTile('Average accuracy', Number.isFinite(avgCents) ? avgCents.toFixed(0) : '–', '¢', 'while holding; 100¢ = 1 semitone'),
      statTile('Average time', Number.isFinite(avgSecs) ? avgSecs.toFixed(1) : '–', 's', 'to lock on'),
    ], h('div', { class: 'row', style: { marginTop: '16px' } },
      h('button', { class: 'btn primary', onclick: () => { stage.replaceChildren(); Object.assign(api, pitchMatch(stage, { done })); } }, icon('refresh'), 'Again'),
      h('button', { class: 'btn', onclick: done }, 'All exercises'))));
    await saveSession({
      type: 'match', title: 'Pitch match',
      summary: { score: matched.length / ROUNDS * 100, matched: matched.length, rounds: ROUNDS, avgCents, avgSecs, target: target() },
    });
  }

  const api = { stop: () => rig.destroy() };
  return api;
}

// ---------------------------------------------------------------------------
// Glide along a moving target

function glide(stage, { done }) {
  const DURATION = 30, PERIOD = 7.5, TOL = 100;
  const t = target();
  // Glide between points a little inside the target range, on a logarithmic (musical) scale.
  const a = Math.log(t.low * 1.03), b = Math.log(t.high / 1.03);
  let t0 = null;
  const fn = (time) => {
    if (t0 === null) return NaN;
    const x = time - t0;
    if (x < 0) return Math.exp(a);
    return Math.exp(a + (b - a) * (0.5 - 0.5 * Math.cos((2 * Math.PI * x) / PERIOD)));
  };

  const timeLeft = h('div', { class: 'big' }, `${DURATION}s`);
  const scoreNow = h('div', { class: 'muted' }, 'Press start, then follow the dashed curve with your voice (hum, “ng” or “oo”).');
  const startBtn = h('button', { class: 'btn primary big', onclick: begin }, icon('play'), 'Start');
  stage.append(h('div', { class: 'card stack' }, h('div', { class: 'target-display' }, timeLeft, scoreNow), h('div', { class: 'row', style: { justifyContent: 'center' } }, startBtn)));
  const chartCard = h('div', { class: 'card' });
  stage.append(chartCard);
  const rig = liveRig(chartCard, { windowSeconds: 6, futureSeconds: 3 });
  rig.chart.guide = { fn, tolCents: TOL };
  let frames = 0, voiced = 0, onTrack = 0, finished = false, timer = 0;
  const f0s = [];

  async function begin() {
    startBtn.disabled = true;
    try {
      await rig.start();
    } catch (e) {
      startBtn.disabled = false;
      return micError(e);
    }
    startBtn.hidden = true;
  }

  rig.onFrame((m) => {
    if (finished) return;
    if (t0 === null) t0 = m.time + 2; // two seconds to get ready
    const x = m.time - t0;
    if (x < 0) {
      timeLeft.textContent = `Get ready… ${Math.ceil(-x)}`;
      return;
    }
    frames++;
    if (Number.isFinite(m.f0)) {
      voiced++;
      f0s.push(m.f0);
      const c = Math.abs(1200 * Math.log2(m.f0 / fn(m.time)));
      if (c <= TOL) onTrack++;
    }
    timeLeft.textContent = `${Math.max(0, Math.ceil(DURATION - x))}s`;
    scoreNow.textContent = voiced ? `On track ${Math.round((100 * onTrack) / Math.max(1, frames))}% of the time` : 'Start humming…';
    if (x >= DURATION && !timer) timer = setTimeout(finish, 50);
  });

  async function finish() {
    finished = true;
    rig.stop();
    const score = (100 * onTrack) / Math.max(1, frames);
    const st = stats(f0s);
    stage.replaceChildren(resultCard('Results', [
      statTile('On track', score.toFixed(0), '%', 'within a semitone of the curve'),
      statTile('Voiced', ((100 * voiced) / Math.max(1, frames)).toFixed(0), '%', 'of the exercise'),
      statTile('Lowest · highest', st ? `${st.p05.toFixed(0)} · ${st.p95.toFixed(0)}` : '–', 'Hz', st ? `${noteName(st.p05)} – ${noteName(st.p95)}` : ''),
    ], h('div', { class: 'row', style: { marginTop: '16px' } },
      h('button', { class: 'btn primary', onclick: () => { stage.replaceChildren(); Object.assign(api, glide(stage, { done })); } }, icon('refresh'), 'Again'),
      h('button', { class: 'btn', onclick: done }, 'All exercises'))));
    await saveSession({ type: 'glide', title: 'Glide along', summary: { score, voicedPct: (100 * voiced) / Math.max(1, frames), p05: st?.p05, p95: st?.p95, medianF0: st?.median, target: target() } });
  }

  const api = { stop: () => { clearTimeout(timer); rig.destroy(); } };
  return api;
}

// ---------------------------------------------------------------------------
// Sustained vowel with a full Praat voice report

function sustain(stage, { navigate, done }) {
  const SECONDS = 5;
  const status = h('div', { class: 'countdown' }, '5');
  const hint = h('div', { class: 'muted', style: { textAlign: 'center' } }, 'Take a comfortable breath. When recording starts, say “aaah” at a steady, comfortable pitch and loudness.');
  const startBtn = h('button', { class: 'btn primary big', onclick: begin }, h('span', { class: 'dot' }), 'Start recording');
  stage.append(h('div', { class: 'card stack' }, status, hint, h('div', { class: 'row', style: { justifyContent: 'center' } }, startBtn)));
  const chartCard = h('div', { class: 'card' });
  stage.append(chartCard);
  const rig = liveRig(chartCard, { windowSeconds: 7 });
  let timers = [];
  let cancelled = false;

  async function begin() {
    startBtn.disabled = true;
    try {
      await rig.start();
    } catch (e) {
      startBtn.disabled = false;
      return micError(e);
    }
    startBtn.hidden = true;
    for (let i = 3; i >= 1; i--) {
      status.textContent = `${i}`;
      hint.textContent = 'Get ready…';
      await sleep(700);
      if (cancelled) return;
    }
    audio.startRecording();
    hint.textContent = 'Aaaaah… keep it steady';
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        const left = SECONDS - (performance.now() - t0) / 1000;
        status.textContent = left > 0 ? left.toFixed(1) : '0';
        if (left <= 0 || cancelled) return resolve();
        timers.push(requestAnimationFrame(tick));
      };
      tick();
    });
    if (cancelled) return;
    const rec = audio.stopRecording();
    rig.stop();
    status.textContent = '';
    hint.replaceChildren(h('span', { class: 'loading' }, h('span', { class: 'spinner' }), 'Analysing with Praat…'));
    analyse(rec);
  }

  async function analyse(rec) {
    try {
      const samples = audio.trimSilence(rec.samples, rec.sampleRate);
      const opts = analysisOptions();
      const res = await praat.analyze(samples, rec.sampleRate, opts);
      // Use the middle of the vowel for the voice measures, skipping onset and offset.
      const d = res.duration;
      const mid = d > 2 ? await praat.report(0.5, d - 0.5, opts) : res.report ?? await praat.report(0, 0, opts);
      const f0 = Array.from(res.pitch.f0);
      const st = stats(f0);
      const sdCents = pitchSdSemitones(f0) * 100;
      const fmed = [0, 1, 2].map((k) => stats(Array.from(res.formants.F[k]).filter((_, i) => Number.isFinite(res.pitch.f0[Math.round((res.formants.t1 + i * res.formants.dt - res.pitch.t1) / res.pitch.dt)])))?.median);
      const pct = (v) => (Number.isFinite(v) ? (v * 100).toFixed(2) : '–');
      stage.replaceChildren(
        resultCard('Steady vowel', [
          statTile('Mean pitch', st ? st.mean.toFixed(0) : '–', 'Hz', st ? noteName(st.mean) : ''),
          statTile('Stability', Number.isFinite(sdCents) ? sdCents.toFixed(0) : '–', '¢ SD', 'lower is steadier'),
          statTile('HNR', Number.isFinite(mid.hnr) ? mid.hnr.toFixed(1) : '–', 'dB', 'higher is clearer'),
          statTile('CPPS', Number.isFinite(mid.cpps) ? mid.cpps.toFixed(1) : '–', 'dB', 'lower can mean breathier'),
          statTile('Jitter', pct(mid.jitterLocal), '%', 'period variation'),
          statTile('Shimmer', pct(mid.shimmerLocal), '%', 'amplitude variation'),
          ...[0, 1, 2].map((k) => statTile(`F${k + 1}`, Number.isFinite(fmed[k]) ? fmed[k].toFixed(0) : '–', 'Hz')),
        ], [
          h('p', { class: 'small muted', style: { marginTop: '12px' } },
            'Measured by Praat over the middle of the vowel. These numbers vary a lot between microphones, rooms and days; compare with your own earlier results rather than with norms, and see a voice professional for any health concerns.'),
          h('div', { class: 'row', style: { marginTop: '16px' } },
            h('button', { class: 'btn primary', onclick: () => { stage.replaceChildren(); Object.assign(api, sustain(stage, { navigate, done })); } }, icon('refresh'), 'Again'),
            h('button', { class: 'btn', onclick: () => { state.pendingAnalysis = { samples, sampleRate: rec.sampleRate, title: 'Steady vowel' }; navigate('analyze'); } }, icon('spectrum'), 'Open in Analyze'),
            h('button', { class: 'btn ghost', onclick: done }, 'All exercises')),
        ]));
      await saveSession({
        type: 'sustain', title: 'Steady vowel',
        summary: { medianF0: st?.median, meanF0: st?.mean, sdCents, hnr: mid.hnr, cpps: mid.cpps, jitter: mid.jitterLocal, shimmer: mid.shimmerLocal, f1: fmed[0], f2: fmed[1], f3: fmed[2], seconds: res.duration },
      }, state.settings.keepAudio ? { samples, sampleRate: rec.sampleRate } : null);
    } catch (e) {
      toast(`Analysis failed: ${e.message}`, { error: true });
      done();
    }
  }

  const api = { stop: () => { cancelled = true; timers.forEach(cancelAnimationFrame); rig.destroy(); } };
  return api;
}

// ---------------------------------------------------------------------------
// Read a passage aloud

function readAloud(stage, { navigate, done }) {
  const MAX = 90;
  let which = Math.floor(Math.random() * PASSAGES.length);
  const passageTitle = h('h2', {}, PASSAGES[which].title);
  const passage = h('p', { class: 'passage' }, PASSAGES[which].text);
  const another = h('button', { class: 'btn small ghost', onclick: () => {
    which = (which + 1) % PASSAGES.length;
    passageTitle.textContent = PASSAGES[which].title;
    passage.textContent = PASSAGES[which].text;
  } }, icon('refresh'), 'Another passage');
  const recBtn = h('button', { class: 'btn primary big', onclick: toggle }, h('span', { class: 'dot' }), 'Start reading');
  const timer = h('span', { class: 'muted num' });
  const inTargetNow = h('span', { class: 'chip' }, '–');
  stage.append(h('div', { class: 'card stack' },
    h('div', { class: 'row spread' }, passageTitle, another),
    passage,
    h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '8px' } }, recBtn, timer, inTargetNow)));
  const chartCard = h('div', { class: 'card' });
  stage.append(chartCard);
  const rig = liveRig(chartCard, { windowSeconds: 10 });
  let voiced = 0, inT = 0, raf = 0, t0 = 0;
  rig.onFrame((m) => {
    if (!audio.isRecording() || !Number.isFinite(m.f0)) return;
    voiced++;
    const t = target();
    if (m.f0 >= t.low && m.f0 <= t.high) inT++;
    inTargetNow.textContent = `${Math.round((100 * inT) / voiced)}% in target`;
  });

  async function toggle() {
    if (audio.isRecording()) return stopAndAnalyse();
    recBtn.disabled = true;
    try {
      await rig.start();
    } catch (e) {
      recBtn.disabled = false;
      return micError(e);
    }
    recBtn.disabled = false;
    audio.startRecording();
    another.disabled = true;
    recBtn.classList.add('recording');
    recBtn.replaceChildren(h('span', { class: 'dot' }), 'Done');
    t0 = performance.now();
    const tick = () => {
      const s = (performance.now() - t0) / 1000;
      timer.textContent = formatDuration(s);
      if (s >= MAX) return stopAndAnalyse();
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

  async function stopAndAnalyse() {
    cancelAnimationFrame(raf);
    const rec = audio.stopRecording();
    rig.stop();
    recBtn.disabled = true;
    recBtn.classList.remove('recording');
    recBtn.replaceChildren(h('span', { class: 'spinner' }), 'Analysing…');
    const samples = audio.trimSilence(rec.samples, rec.sampleRate);
    if (samples.length < rec.sampleRate) {
      toast('That was very short; try reading the whole passage.');
      stage.replaceChildren();
      Object.assign(api, readAloud(stage, { navigate, done }));
      return;
    }
    try {
      const res = await praat.analyze(samples, rec.sampleRate, analysisOptions());
      const f0 = Array.from(res.pitch.f0);
      const st = stats(f0);
      const t = target();
      const v = f0.filter(Number.isFinite);
      const pct = v.length ? (100 * v.filter((f) => f >= t.low && f <= t.high).length) / v.length : NaN;
      const sd = pitchSdSemitones(f0);
      const fmed = [0, 1, 2].map((k) => stats(Array.from(res.formants.F[k]).filter((_, i) => Number.isFinite(res.pitch.f0[Math.round((res.formants.t1 + i * res.formants.dt - res.pitch.t1) / res.pitch.dt)])))?.median);
      stage.replaceChildren(resultCard(`Read aloud: ${PASSAGES[which].title}`, [
        statTile('Median pitch', st ? st.median.toFixed(0) : '–', 'Hz', st ? noteName(st.median) : ''),
        statTile('In target', Number.isFinite(pct) ? pct.toFixed(0) : '–', '%'),
        statTile('Range (5–95%)', st ? `${st.p05.toFixed(0)}–${st.p95.toFixed(0)}` : '–', 'Hz'),
        statTile('Intonation', Number.isFinite(sd) ? sd.toFixed(1) : '–', 'st SD', sd < 2 ? 'quite flat' : sd > 4 ? 'very lively' : 'natural variation'),
        statTile('Median F1', Number.isFinite(fmed[0]) ? fmed[0].toFixed(0) : '–', 'Hz'),
        statTile('Median F2', Number.isFinite(fmed[1]) ? fmed[1].toFixed(0) : '–', 'Hz'),
        statTile('Median F3', Number.isFinite(fmed[2]) ? fmed[2].toFixed(0) : '–', 'Hz'),
        statTile('Duration', formatDuration(res.duration)),
      ], h('div', { class: 'row', style: { marginTop: '16px' } },
        h('button', { class: 'btn primary', onclick: () => { stage.replaceChildren(); Object.assign(api, readAloud(stage, { navigate, done })); } }, icon('refresh'), 'Again'),
        h('button', { class: 'btn', onclick: () => { state.pendingAnalysis = { samples, sampleRate: rec.sampleRate, title: `Read aloud: ${PASSAGES[which].title}` }; navigate('analyze'); } }, icon('spectrum'), 'Open in Analyze'),
        h('button', { class: 'btn ghost', onclick: done }, 'All exercises'))));
      await saveSession({
        type: 'read', title: `Read aloud: ${PASSAGES[which].title}`,
        summary: { medianF0: st?.median, p05: st?.p05, p95: st?.p95, inTargetPct: pct, sdSemitones: sd, f1: fmed[0], f2: fmed[1], f3: fmed[2], seconds: res.duration, target: t },
      }, state.settings.keepAudio ? { samples, sampleRate: rec.sampleRate } : null);
    } catch (e) {
      toast(`Analysis failed: ${e.message}`, { error: true });
      done();
    }
  }

  const api = { stop: () => { cancelAnimationFrame(raf); rig.destroy(); } };
  return api;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
