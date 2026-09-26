// Live view: real-time pitch trace, pitch readout and resonance (vowel) chart.

import { h, icon, statTile, toast, formatDuration, segmented } from '../ui.js';
import { state, liveParams, target, updateSettings } from '../state.js';
import { LivePitchChart, VowelChart } from '../charts.js';
import { noteName, centsOff, stats, pitchSdSemitones } from '../music.js';
import * as audio from '../audio.js';
import * as praat from '../praat-client.js';
import { saveSession } from '../store.js';
import { referenceVoice } from '../target.js';

export default function liveView(root, { navigate }) {
  const s = state.settings;

  // ---------- readout column
  const statusChip = h('span', { class: 'chip' }, 'Microphone off');
  const big = h('div', { class: 'hero-value idle', 'aria-live': 'off' }, '–', h('small', {}, 'Hz'));
  const note = h('div', { class: 'note' }, 'Press start and say “aaah”');
  const needle = h('div', { class: 'needle', style: { left: '50%', opacity: 0.3 } });
  const cents = h('div', { class: 'cents', title: 'Cents from the nearest note' },
    h('div', { class: 'scale' }), h('div', { class: 'center' }), needle);
  const meterFill = h('div');
  const meter = h('div', { class: 'meter', title: 'Input level' }, meterFill);

  const micBtn = h('button', { class: 'btn primary big', onclick: toggleMic }, icon('mic'), 'Start');
  const recBtn = h('button', { class: 'btn', onclick: toggleRecord, disabled: true, title: 'Record what you say (R)' }, h('span', { class: 'dot' }), 'Record');
  const recTime = h('span', { class: 'small muted num' });
  const toneBtn = h('button', { class: 'btn ghost small', onclick: playTargetTone, title: 'Play the middle of your target range' }, icon('note'), 'Target tone');

  const readout = h('div', { class: 'card readout' },
    h('div', { class: 'row spread' }, statusChip, toneBtn),
    h('div', {}, big, note),
    cents,
    h('div', { class: 'stack' },
      h('div', { class: 'row spread small muted' }, h('span', {}, 'Input level'), h('span', { class: 'tiny' }, 'Space: start/stop')),
      meter),
    h('div', { class: 'row' }, micBtn, recBtn, recTime));

  // ---------- pitch chart
  const chartBox = h('div', { class: 'chart-live' });
  const overlay = h('div', { class: 'overlay-msg' }, h('div', {},
    icon('mic'),
    h('p', {}, 'Start the microphone to see your pitch in real time. The shaded band is your target range.')));
  chartBox.append(overlay);
  const windowSeg = segmented([5, 10, 30].map((v) => ({ label: `${v}s`, value: v })), 10, (v) => {
    chart.windowSeconds = v;
    chart.dirty = true;
    chart.draw();
  });
  const pitchCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', { class: 'stack', style: { gap: '2px' } },
        h('h2', {}, 'Pitch'),
        h('div', { class: 'legend' },
          h('span', {}, h('i', { class: 'line', style: { background: 'var(--series-1)' } }), 'in target'),
          h('span', {}, h('i', { class: 'line', style: { background: 'var(--muted)' } }), 'outside'),
          h('span', {}, h('i', { class: 'band' }), 'target range'))),
      windowSeg),
    chartBox);

  // ---------- resonance
  const vowelBox = h('div', { class: 'chart-vowel' });
  const fTiles = [1, 2, 3].map((k) => statTile(`F${k}`, '–', 'Hz'));
  const resonanceCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', { class: 'stack', style: { gap: '2px' } },
        h('h2', {}, 'Resonance'),
        h('span', { class: 'hint' }, 'Where your vowels sit. Higher F1/F2 (towards the lower left) sounds brighter.')),
    ),
    h('div', { class: 'legend', style: { marginBottom: '8px' } },
      h('span', {}, h('i', { style: { background: 'var(--series-1)' } }), 'you'),
      h('span', {}, h('i', { style: { background: 'var(--series-3)' } }), 'higher-resonance average'),
      h('span', {}, h('i', { class: 'sq', style: { background: 'var(--series-2)' } }), 'lower-resonance average'),
      referenceVoice()?.points?.length
        ? h('span', {}, h('i', { style: { background: 'transparent', border: '1.5px solid var(--series-7)', borderRadius: '2px', transform: 'rotate(45deg) scale(0.8)' } }), `your reference: “${referenceVoice().title}”`)
        : null),
    vowelBox,
    h('div', { class: 'formant-values', style: { marginTop: '12px' } }, fTiles));

  // ---------- session stats
  const sessionStats = h('div', { class: 'stats' });
  const saveBtn = h('button', { class: 'btn small', onclick: saveLiveSession, disabled: true }, icon('save'), 'Save session');
  const resetBtn = h('button', { class: 'btn small ghost', onclick: resetSession }, icon('refresh'), 'Reset');
  const sessionCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'This session'), h('div', { class: 'row' }, resetBtn, saveBtn)),
    sessionStats,
    h('p', { class: 'small muted', style: { marginTop: '12px' } },
      'Speak naturally: count, read something aloud, or have a conversation. Statistics cover voiced speech since you pressed start.'));

  root.append(
    h('div', { class: 'grid grid-live' }, readout, pitchCard),
    h('div', { class: 'grid grid-2' }, resonanceCard, sessionCard));

  const chart = new LivePitchChart(chartBox);
  chart.setTarget(s.targetLow, s.targetHigh);
  chart.showNotes = s.showNotes;
  chart.draw();
  const vowel = new VowelChart(vowelBox);
  vowel.voiceCloud = referenceVoice()?.points || null;

  // ---------- session accumulation
  let session = newSession();
  function newSession() {
    return { start: null, frames: 0, voiced: 0, inTarget: 0, f0: [], F: [[], [], []] };
  }
  function resetSession() {
    session = newSession();
    chart.clear();
    vowel.clear();
    renderStats();
  }

  const recent = [];
  const recentF = [[], [], []];
  let pendingUi = null;

  const unsubscribe = praat.onLive((m) => {
    if (!audio.micRunning()) return;
    chart.push(m);
    session.frames++;
    if (session.start === null) session.start = m.time;
    if (Number.isFinite(m.f0)) {
      session.voiced++;
      session.f0.push(m.f0);
      const t = target();
      if (m.f0 >= t.low && m.f0 <= t.high) session.inTarget++;
      if (Number.isFinite(m.f1) && Number.isFinite(m.f2)) {
        vowel.push(m.time, m.f1, m.f2);
        [m.f1, m.f2, m.f3].forEach((f, k) => { if (Number.isFinite(f)) { session.F[k].push(f); recentF[k].push(f); if (recentF[k].length > 8) recentF[k].shift(); } });
      }
    }
    recent.push(m.f0);
    if (recent.length > 3) recent.shift();
    pendingUi = m;
  });

  // UI updates are batched to the display refresh rate.
  let raf = 0;
  let lastStats = 0;
  function uiLoop(now) {
    raf = requestAnimationFrame(uiLoop);
    if (audio.isRecording()) recTime.textContent = formatDuration(audio.recordingSeconds());
    if (!pendingUi) return;
    const m = pendingUi;
    pendingUi = null;
    const lvl = Math.max(0, Math.min(1, (m.level + 60) / 60));
    meterFill.style.width = `${lvl * 100}%`;
    meter.classList.toggle('hot', m.level > -3);
    const voiced = recent.filter(Number.isFinite);
    if (Number.isFinite(m.f0) && voiced.length) {
      const f = voiced.slice().sort((a, b) => a - b)[Math.floor(voiced.length / 2)];
      big.firstChild.textContent = f.toFixed(0);
      big.classList.remove('idle');
      const c = centsOff(f);
      note.textContent = `${noteName(f)}  ${c >= 0 ? '+' : '−'}${Math.abs(c)}¢`;
      needle.style.left = `${50 + c}%`;
      needle.style.opacity = 1;
      const t = target();
      if (f < t.low) setStatus('Below target', 'warn', 'down');
      else if (f > t.high) setStatus('Above target', 'warn', 'up');
      else setStatus('In target', 'good', 'check');
    } else {
      big.classList.add('idle');
      needle.style.opacity = 0.3;
      setStatus(m.level < state.settings.silenceDb ? 'Listening…' : 'Unvoiced', '', null);
    }
    fTiles.forEach((tile, k) => {
      const v = recentF[k].length ? recentF[k].slice().sort((a, b) => a - b)[Math.floor(recentF[k].length / 2)] : NaN;
      tile.querySelector('.value').firstChild.textContent = Number.isFinite(v) ? v.toFixed(0) : '–';
    });
    if (now - lastStats > 500) {
      lastStats = now;
      renderStats();
    }
  }
  raf = requestAnimationFrame(uiLoop);

  let lastStatus = '';
  function setStatus(text, kind, iconName) {
    const key = text + kind;
    if (key === lastStatus) return;
    lastStatus = key;
    statusChip.className = `chip ${kind}`;
    statusChip.replaceChildren(iconName ? icon(iconName) : '', text);
  }

  function renderStats() {
    const st = stats(session.f0);
    const hop = liveParams().hopSeconds;
    const voicedSec = session.voiced * hop;
    const pct = session.voiced ? (100 * session.inTarget) / session.voiced : NaN;
    const sd = pitchSdSemitones(session.f0);
    const fm = session.F.map((a) => stats(a)?.median);
    sessionStats.replaceChildren(
      statTile('Voiced time', formatDuration(voicedSec)),
      statTile('In target', Number.isFinite(pct) ? pct.toFixed(0) : '–', '%'),
      statTile('Median pitch', st ? st.median.toFixed(0) : '–', 'Hz', st ? noteName(st.median) : ''),
      statTile('Range (5–95%)', st ? `${st.p05.toFixed(0)}–${st.p95.toFixed(0)}` : '–', 'Hz'),
      statTile('Variability', Number.isFinite(sd) ? sd.toFixed(1) : '–', 'st', 'pitch SD in semitones'),
      statTile('Median F1 · F2', fm[0] ? `${fm[0].toFixed(0)} · ${fm[1]?.toFixed(0) ?? '–'}` : '–', 'Hz'),
    );
    saveBtn.disabled = session.voiced < 20;
  }
  renderStats();

  // ---------- actions

  async function toggleMic() {
    if (audio.micRunning()) {
      stopMic();
      return;
    }
    micBtn.disabled = true;
    setStatus('Starting…', '', null);
    try {
      await praat.warmUp();
      await audio.startMic({ deviceId: state.settings.deviceId, liveParams: liveParams() });
      overlay.hidden = true;
      micBtn.replaceChildren(icon('stop'), 'Stop');
      micBtn.classList.remove('primary');
      recBtn.disabled = false;
      chart.start();
      setStatus('Listening…', '', null);
    } catch (e) {
      setStatus('Microphone off', '', null);
      const msg = e.name === 'NotAllowedError'
        ? 'Microphone permission was denied. Allow it in your browser’s site settings.'
        : e.name === 'OverconstrainedError' || e.name === 'NotFoundError'
          ? 'That microphone is not available. Choose another in Settings.'
          : `Could not start the microphone: ${e.message}`;
      if (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') updateSettings({ deviceId: '' });
      toast(msg, { error: true, ms: 6000 });
    } finally {
      micBtn.disabled = false;
    }
  }

  function stopMic() {
    if (audio.isRecording()) finishRecording();
    audio.stopMic();
    chart.stop();
    micBtn.replaceChildren(icon('mic'), 'Start');
    micBtn.classList.add('primary');
    recBtn.disabled = true;
    meterFill.style.width = '0';
    setStatus('Microphone off', '', null);
  }

  function toggleRecord() {
    if (!audio.micRunning()) return;
    if (audio.isRecording()) finishRecording();
    else {
      audio.startRecording();
      recBtn.classList.add('recording');
      recBtn.replaceChildren(h('span', { class: 'dot' }), 'Stop recording');
    }
  }

  function finishRecording() {
    const rec = audio.stopRecording();
    recBtn.classList.remove('recording');
    recBtn.replaceChildren(h('span', { class: 'dot' }), 'Record');
    recTime.textContent = '';
    if (rec.samples.length < rec.sampleRate * 0.3) {
      toast('Recording too short.');
      return;
    }
    state.pendingAnalysis = { samples: rec.samples, sampleRate: rec.sampleRate, title: `Live recording, ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` };
    const open = h('button', { class: 'btn small primary', onclick: () => navigate('analyze') }, 'Analyze');
    const t = h('span', {}, `Recorded ${formatDuration(rec.samples.length / rec.sampleRate)}. `, open);
    toast(t, { ms: 7000 });
  }

  function playTargetTone() {
    const t = target();
    const mid = Math.sqrt(t.low * t.high);
    audio.playTone(mid, 1.5);
    toast(`Playing ${noteName(mid)} (${mid.toFixed(0)} Hz), the middle of your target range. Use headphones so the tone isn’t analysed as your voice.`);
  }

  async function saveLiveSession() {
    const st = stats(session.f0);
    const hop = liveParams().hopSeconds;
    await saveSession({
      type: 'live',
      title: 'Live session',
      summary: {
        seconds: session.voiced * hop,
        medianF0: st?.median,
        p05: st?.p05,
        p95: st?.p95,
        sdSemitones: pitchSdSemitones(session.f0),
        inTargetPct: session.voiced ? (100 * session.inTarget) / session.voiced : NaN,
        f1: stats(session.F[0])?.median, f2: stats(session.F[1])?.median, f3: stats(session.F[2])?.median,
        target: target(),
      },
    });
    toast('Session saved to Progress.');
    saveBtn.disabled = true;
  }

  function onKey(e) {
    if (e.target.closest('input, select, textarea, button') && e.key === ' ') return;
    if (e.key === ' ') { e.preventDefault(); toggleMic(); }
    if (e.key === 'r' || e.key === 'R') toggleRecord();
  }
  document.addEventListener('keydown', onKey);

  return {
    unmount() {
      cancelAnimationFrame(raf);
      unsubscribe();
      document.removeEventListener('keydown', onKey);
      if (audio.isRecording()) audio.stopRecording();
      chart.stop();
      chart.destroy();
      vowel.destroy();
    },
  };
}

