// Analyze view: record or open a file, then explore Praat's full analysis.

import { h, icon, statTile, toast, formatDuration, download, formatDate } from '../ui.js';
import { state, liveParams, target, analysisOptions } from '../state.js';
import { AnalysisChart } from '../charts.js';
import { noteName, stats, pitchSdSemitones } from '../music.js';
import * as audio from '../audio.js';
import * as praat from '../praat-client.js';
import { saveSession, listSessions, getAudio } from '../store.js';
import { offerTarget } from '../target.js';

export default function analyzeView(root, { param }) {
  // #/analyze/target comes from Settings: the user wants to derive a target from a recording.
  const findingTarget = param === 'target';
  let chart = null;
  let current = null; // { samples, sampleRate, title, result, sessionId }
  let selection = null;
  let reportToken = 0;
  let stopPlay = null;
  let recTimer = 0;

  root.append(h('div', { class: 'view-head' },
    h('div', {}, h('h1', {}, 'Analyze'),
      h('p', {}, 'Record yourself or open an audio file for a detailed Praat analysis: pitch, formants, spectrogram, intensity and voice quality.'))));
  const body = h('div', { class: 'grid' });
  root.append(body);

  // ------------------------------------------------------------------ start screen

  async function showStart() {
    stopPlayback();
    chart?.destroy();
    chart = null;
    current = null;
    const fileInput = h('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.m4a,.ogg,.flac,.webm', hidden: true, onchange: () => fileInput.files[0] && openFile(fileInput.files[0]) });
    const recBtn = h('button', { class: 'btn primary big', onclick: () => record(recBtn, recInfo) }, h('span', { class: 'dot' }), 'Record');
    const recInfo = h('span', { class: 'muted num' });
    const drop = h('div', { class: 'dropzone' },
      icon('upload'),
      h('div', {}, h('b', {}, 'Drop an audio file here'), h('div', { class: 'small' }, 'WAV, MP3, M4A, OGG, FLAC… any format your browser can play')),
      h('div', { class: 'row', style: { justifyContent: 'center' } },
        recBtn, recInfo,
        h('button', { class: 'btn big', onclick: () => fileInput.click() }, icon('upload'), 'Open file')),
      fileInput);
    for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
    for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
    drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) openFile(f); });

    const recentList = h('div', { class: 'session-list' }, h('span', { class: 'loading' }, h('span', { class: 'spinner' }), 'Loading…'));
    const targetTip = h('div', { class: 'callout' }, icon('target'),
      h('span', {}, h('b', {}, findingTarget ? 'Find a target from a recording. ' : 'Have a voice you’d like to aim for? '),
        'Open or record a clip of it (a minute of natural speech works well), select the part with that voice if there’s more than one speaker, and press ',
        h('b', {}, 'Use as target'), '. It suggests a pitch range and keeps that voice’s vowels on your resonance chart.'));
    body.replaceChildren(
      targetTip,
      h('div', { class: 'card' }, drop),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Saved recordings'), h('span', { class: 'hint' }, 'From your exercises and analyses')),
        recentList));
    const sessions = (await listSessions()).filter((s) => s.hasAudio).slice(0, 8);
    recentList.replaceChildren(...(sessions.length ? sessions.map((s) => h('div', { class: 'session' },
      h('div', { class: 'icon-wrap' }, icon('wave')),
      h('div', { style: { minWidth: 0 } }, h('div', { class: 'title' }, s.title), h('div', { class: 'meta' }, formatDate(s.date), s.summary?.seconds ? ` · ${formatDuration(s.summary.seconds)}` : '')),
      h('button', { class: 'btn small', onclick: () => openSession(s) }, icon('spectrum'), 'Analyze'))) : [h('p', { class: 'small muted' }, 'Recordings you save will appear here.')]));
  }

  async function record(btn, info) {
    if (audio.isRecording()) {
      cancelAnimationFrame(recTimer);
      const rec = audio.stopRecording();
      audio.stopMic();
      const samples = audio.trimSilence(rec.samples, rec.sampleRate);
      if (samples.length < rec.sampleRate * 0.3) {
        toast('Nothing recorded; check your microphone.');
        return showStart();
      }
      return load({ samples, sampleRate: rec.sampleRate, title: `Recording, ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` });
    }
    try {
      btn.disabled = true;
      await audio.startMic({ deviceId: state.settings.deviceId, liveParams: liveParams() });
      audio.startRecording();
      btn.classList.add('recording');
      btn.replaceChildren(h('span', { class: 'dot' }), 'Stop');
      const tick = () => { info.textContent = formatDuration(audio.recordingSeconds()); recTimer = requestAnimationFrame(tick); };
      tick();
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? 'Microphone permission was denied.' : `Microphone error: ${e.message}`, { error: true });
    } finally {
      btn.disabled = false;
    }
  }

  async function openFile(file) {
    try {
      const { samples, sampleRate } = await audio.decodeFile(file);
      load({ samples, sampleRate, title: file.name.replace(/\.[^.]+$/, '') });
    } catch (e) {
      toast(`Could not read ${file.name}: ${e.message || 'unsupported format'}`, { error: true });
    }
  }

  async function openSession(s) {
    const a = await getAudio(s.id);
    if (!a) return toast('That recording is no longer available.', { error: true });
    load({ ...a, title: s.title, sessionId: s.id });
  }

  // ------------------------------------------------------------------ analysis screen

  async function load(input) {
    const MAX_SECONDS = 180;
    if (input.samples.length / input.sampleRate > MAX_SECONDS) {
      toast(`Using the first ${MAX_SECONDS / 60} minutes of this recording.`);
      input.samples = input.samples.slice(0, MAX_SECONDS * input.sampleRate);
    }
    body.replaceChildren(h('div', { class: 'card' }, h('span', { class: 'loading' }, h('span', { class: 'spinner' }), `Analysing ${formatDuration(input.samples.length / input.sampleRate)} of audio with Praat…`)));
    let result;
    try {
      result = await praat.analyze(input.samples, input.sampleRate, analysisOptions());
    } catch (e) {
      toast(`Analysis failed: ${e.message}`, { error: true });
      return showStart();
    }
    current = { ...input, result };
    selection = null;
    render();
  }

  function render() {
    const { result, title } = current;
    const playBtn = h('button', { class: 'btn primary', onclick: togglePlay, title: 'Play / stop (Space)' }, icon('play'), 'Play');
    const zoomSelBtn = h('button', { class: 'btn small', onclick: () => selection && chart.setView(...selection), disabled: true }, 'Zoom to selection');
    const zoomAllBtn = h('button', { class: 'btn small ghost', onclick: () => chart.setView(0, result.duration) }, icon('zoomOut'), 'Show all');
    const formantToggle = h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { chart.show.formants = e.target.checked; chart.dirty = true; chart.draw(); } }), 'Formants');
    const saveBtn = h('button', { class: 'btn small', onclick: save, disabled: !!current.sessionId }, icon('save'), current.sessionId ? 'Saved' : 'Save');
    const wavBtn = h('button', { class: 'btn small ghost', onclick: () => download(audio.encodeWav(current.samples, current.sampleRate), `${title.replace(/[^\w\- ]+/g, '').trim() || 'recording'}.wav`) }, icon('download'), 'WAV');
    const newBtn = h('button', { class: 'btn small ghost', onclick: showStart }, 'New');
    const targetBtn = h('button', {
      class: `btn small${findingTarget ? ' primary' : ''}`,
      title: 'Suggest a target pitch range from this recording (or the selection)',
      onclick: async () => {
        if (await offerTarget(result, selection, title)) {
          chart.target = target();
          chart.dirty = true;
          chart.draw();
          updateSummary();
        }
      },
    }, icon('target'), 'Use as target');
    const selInfo = h('span', {}, 'Drag across the chart to select a part; click to play from a point. Pinch or ctrl + scroll to zoom.');

    const chartBox = h('div', { class: 'analysis-chart' });
    const summary = h('div', { class: 'stats wide' });
    const reportBody = h('div', { class: 'table-scroll' });

    body.replaceChildren(
      h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('div', { class: 'stack', style: { gap: '2px', minWidth: 0 } },
            h('h2', {}, title),
            h('span', { class: 'hint' }, `${formatDuration(result.duration)} · ${current.sampleRate} Hz · analysed in ${(result.elapsedMs / 1000).toFixed(1)} s`)),
          h('div', { class: 'row' }, playBtn, targetBtn, saveBtn, wavBtn, newBtn)),
        h('div', { class: 'row spread', style: { marginBottom: '8px' } },
          h('div', { class: 'legend' },
            h('span', {}, h('i', { class: 'line', style: { background: 'var(--series-1)' } }), 'pitch'),
            h('span', {}, h('i', { class: 'band' }), 'target'),
            h('span', {}, h('i', { style: { background: 'var(--series-2)' } }), 'F1'),
            h('span', {}, h('i', { style: { background: 'var(--series-3)' } }), 'F2'),
            h('span', {}, h('i', { style: { background: 'var(--series-5)' } }), 'F3')),
          h('div', { class: 'row' }, formantToggle, zoomSelBtn, zoomAllBtn)),
        chartBox,
        h('div', { class: 'selection-bar', style: { marginTop: '8px' } }, selInfo)),
      h('div', { class: 'grid grid-2' },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { class: 'sum-title' }, 'Summary'), h('span', { class: 'hint' }, 'Voiced parts only')), summary),
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', { class: 'rep-title' }, 'Voice quality'), h('span', { class: 'hint' }, 'Most meaningful on sustained vowels')),
          reportBody)));

    chart = new AnalysisChart(chartBox, {
      onSelect: (sel) => {
        selection = sel;
        zoomSelBtn.disabled = !sel;
        if (sel) {
          selInfo.replaceChildren(
            h('b', {}, `${sel[0].toFixed(2)}–${sel[1].toFixed(2)} s`), ` (${formatDuration(sel[1] - sel[0])})  `,
            h('button', { class: 'btn small', onclick: () => playRange(sel[0], sel[1]) }, icon('play'), 'Play selection'),
            h('button', { class: 'btn small ghost', onclick: () => { chart.selection = null; chart.dirty = true; chart.draw(); chart.onSelect(null); } }, 'Clear'));
        } else {
          selInfo.textContent = 'Drag across the chart to select a part; click to play from a point.';
        }
        updateSummary();
      },
      onSeek: (t) => playRange(t, result.duration),
    });
    chart.target = target();
    chart.showNotes = state.settings.showNotes;
    chart.setData(result, current.samples);

    function updateSummary() {
      const [t1, t2] = selection || [0, result.duration];
      root.querySelector('.sum-title').textContent = selection ? 'Summary of selection' : 'Summary';
      root.querySelector('.rep-title').textContent = selection ? 'Voice quality of selection' : 'Voice quality';
      const p = result.pitch;
      const f0 = [], voicedIdx = [];
      for (let i = 0; i < p.n; i++) {
        const t = p.t1 + i * p.dt;
        if (t < t1 || t > t2) continue;
        if (Number.isFinite(p.f0[i])) { f0.push(p.f0[i]); voicedIdx.push(t); }
      }
      const st = stats(f0);
      const tg = target();
      const pct = f0.length ? (100 * f0.filter((f) => f >= tg.low && f <= tg.high).length) / f0.length : NaN;
      const fm = result.formants;
      const F = [[], [], []];
      for (let i = 0; i < fm.n; i++) {
        const t = fm.t1 + i * fm.dt;
        if (t < t1 || t > t2) continue;
        const pi = Math.round((t - p.t1) / p.dt);
        if (!Number.isFinite(p.f0[pi])) continue;
        for (let k = 0; k < 3; k++) if (Number.isFinite(fm.F[k][i])) F[k].push(fm.F[k][i]);
      }
      const fmed = F.map((a) => stats(a)?.median);
      const voicedSec = f0.length * p.dt;
      const sd = pitchSdSemitones(f0);
      summary.replaceChildren(
        statTile('Median pitch', st ? st.median.toFixed(0) : '–', 'Hz', st ? noteName(st.median) : 'no voicing found'),
        statTile('Mean pitch', st ? st.mean.toFixed(0) : '–', 'Hz'),
        statTile('Range (5–95%)', st ? `${st.p05.toFixed(0)}–${st.p95.toFixed(0)}` : '–', 'Hz', st ? `${noteName(st.p05)}–${noteName(st.p95)}` : ''),
        statTile('Variability', Number.isFinite(sd) ? sd.toFixed(1) : '–', 'st', 'pitch SD in semitones'),
        statTile('In target', Number.isFinite(pct) ? pct.toFixed(0) : '–', '%', `${tg.low}–${tg.high} Hz`),
        statTile('Voiced', formatDuration(voicedSec), '', `of ${formatDuration(t2 - t1)}`),
        statTile('Median F1', Number.isFinite(fmed[0]) ? fmed[0].toFixed(0) : '–', 'Hz'),
        statTile('Median F2', Number.isFinite(fmed[1]) ? fmed[1].toFixed(0) : '–', 'Hz'),
        statTile('Median F3', Number.isFinite(fmed[2]) ? fmed[2].toFixed(0) : '–', 'Hz'),
      );
      current.summary = {
        seconds: result.duration, medianF0: st?.median, p05: st?.p05, p95: st?.p95, sdSemitones: sd,
        inTargetPct: pct, f1: fmed[0], f2: fmed[1], f3: fmed[2], target: tg,
      };
      loadReport(t1, t2);
    }

    async function loadReport(t1, t2) {
      const token = ++reportToken;
      let rep = !selection ? result.report : null;
      if (!rep) {
        reportBody.replaceChildren(h('span', { class: 'loading' }, h('span', { class: 'spinner' }), 'Measuring…'));
        try {
          rep = await praat.report(t1, t2, analysisOptions());
        } catch (e) {
          if (token === reportToken) reportBody.replaceChildren(h('p', { class: 'small muted' }, `Could not measure: ${e.message}`));
          return;
        }
      }
      if (token !== reportToken) return;
      const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(2)} %` : '–');
      const db = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} dB` : '–');
      const rows = [
        ['Jitter (local)', pct(rep.jitterLocal), 'Cycle-to-cycle variation in period. Praat’s manual cites 1.04 % as MDVP’s threshold for pathology.'],
        ['Jitter (rap)', pct(rep.jitterRap), 'Relative average perturbation over 3 periods.'],
        ['Shimmer (local)', pct(rep.shimmerLocal), 'Cycle-to-cycle variation in amplitude. MDVP’s threshold: 3.81 %.'],
        ['Shimmer (local, dB)', db(rep.shimmerLocalDb), ''],
        ['Harmonics-to-noise', db(rep.hnr), 'How much of the sound is periodic. Around 20 dB is typical for a clear sustained vowel; breathy or rough voices score lower.'],
        ['CPPS', db(rep.cpps), 'Smoothed cepstral peak prominence: how clearly the voice’s periodicity stands out. Lower values go with breathier voices.'],
        ['Unvoiced frames', Number.isFinite(rep.unvoicedFraction) ? `${(rep.unvoicedFraction * 100).toFixed(0)} %` : '–', ''],
        ['Glottal pulses', Number.isFinite(rep.pulses) ? String(rep.pulses) : '–', Number.isFinite(rep.meanPeriod) ? `mean period ${(rep.meanPeriod * 1000).toFixed(2)} ms` : ''],
      ];
      reportBody.replaceChildren(h('table', { class: 'report-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Measure'), h('th', { style: { textAlign: 'right' } }, 'Value'))),
        h('tbody', {}, rows.map(([k, v, note]) => h('tr', {},
          h('td', {}, k, note ? h('div', { class: 'ref' }, note) : null),
          h('td', { class: 'num' }, v))))),
      h('p', { class: 'small muted', style: { marginTop: '10px' } }, 'Recording conditions affect these numbers. Use them to follow your own voice over time, not as a diagnosis.'));
    }

    updateSummary();

    function togglePlay() {
      if (stopPlay) return stopPlayback();
      const [a, b] = selection || [0, result.duration];
      playRange(a, b);
    }

    function playRange(a, b) {
      stopPlayback();
      playBtn.replaceChildren(icon('stop'), 'Stop');
      stopPlay = audio.play(current.samples, current.sampleRate, {
        from: a, to: b,
        onTime: (t) => chart?.setPlayhead(t),
        onEnd: () => {
          stopPlay = null;
          chart?.setPlayhead(null);
          playBtn.replaceChildren(icon('play'), 'Play');
        },
      });
    }

    async function save() {
      const rec = await saveSession({ type: 'analysis', title: current.title, summary: current.summary },
        state.settings.keepAudio ? { samples: current.samples, sampleRate: current.sampleRate } : null);
      current.sessionId = rec.id;
      saveBtn.disabled = true;
      saveBtn.replaceChildren(icon('check'), 'Saved');
      toast('Saved to Progress.');
    }
  }

  function stopPlayback() {
    if (stopPlay) stopPlay();
    stopPlay = null;
  }

  function onKey(e) {
    if (e.key === ' ' && current && !e.target.closest('input, select, textarea, button')) {
      e.preventDefault();
      root.querySelector('.card-head .btn.primary')?.click();
    }
  }
  document.addEventListener('keydown', onKey);

  if (state.pendingAnalysis) {
    const p = state.pendingAnalysis;
    state.pendingAnalysis = null;
    load(p);
  } else if (param && !findingTarget) {
    listSessions().then((all) => {
      const s = all.find((x) => x.id === param);
      if (s?.hasAudio) openSession(s);
      else showStart();
    });
  } else {
    showStart();
  }

  return {
    unmount() {
      cancelAnimationFrame(recTimer);
      stopPlayback();
      document.removeEventListener('keydown', onKey);
      if (audio.isRecording()) audio.stopRecording();
      chart?.destroy();
    },
  };
}
