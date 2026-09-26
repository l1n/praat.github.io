// Progress view: trends over time and the list of saved sessions.

import { h, icon, statTile, toast, formatDate, formatDuration, confirmDialog, download } from '../ui.js';
import { state, target } from '../state.js';
import { TrendChart } from '../charts.js';
import { noteName } from '../music.js';
import * as audio from '../audio.js';
import { listSessions, deleteSession, getAudio, clearAll, importSessions } from '../store.js';

const TYPE_INFO = {
  live: { icon: 'wave', label: 'Live session' },
  match: { icon: 'note', label: 'Pitch match' },
  glide: { icon: 'glide', label: 'Glide along' },
  sustain: { icon: 'vowel', label: 'Steady vowel' },
  read: { icon: 'book', label: 'Read aloud' },
  analysis: { icon: 'spectrum', label: 'Analysis' },
};

export default function progressView(root, { navigate }) {
  const charts = [];
  let stopPlay = null;

  const importInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: doImport });
  root.append(h('div', { class: 'view-head' },
    h('div', {}, h('h1', {}, 'Progress'), h('p', {}, 'Every saved session, on this device only. Small, steady changes add up.')),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: doExport }, icon('download'), 'Export'),
      h('button', { class: 'btn small', onclick: () => importInput.click() }, icon('upload'), 'Import'),
      importInput)));
  const body = h('div', { class: 'grid' });
  root.append(body);

  async function render() {
    for (const c of charts) c.destroy();
    charts.length = 0;
    const sessions = await listSessions();
    if (!sessions.length) {
      body.replaceChildren(h('div', { class: 'card empty' },
        icon('chart'),
        h('h2', {}, 'No sessions yet'),
        h('p', {}, 'Save a live session, finish an exercise or save an analysis, and your progress will show up here.'),
        h('div', { class: 'row', style: { justifyContent: 'center' } },
          h('a', { class: 'btn primary', href: '#/live' }, icon('wave'), 'Go live'),
          h('a', { class: 'btn', href: '#/practice' }, icon('target'), 'Practice'))));
      return;
    }

    // Headline numbers
    const days = new Set(sessions.map((s) => new Date(s.date).toDateString()));
    let streak = 0;
    for (let d = new Date(); days.has(d.toDateString()); d = new Date(d - 864e5)) streak++;
    const totalSec = sessions.reduce((a, s) => a + (s.summary?.seconds || 0), 0);
    const withPitch = sessions.filter((s) => Number.isFinite(s.summary?.medianF0));
    const latest = withPitch[0];
    const tiles = h('div', { class: 'stats wide' },
      statTile('Sessions', String(sessions.length), '', `${days.size} day${days.size === 1 ? '' : 's'} of practice`),
      statTile('Streak', String(streak), streak === 1 ? 'day' : 'days', streak ? 'keep it going!' : 'practise today to start one'),
      statTile('Voice time', formatDuration(totalSec), '', 'recorded or analysed'),
      statTile('Latest median pitch', latest ? latest.summary.medianF0.toFixed(0) : '–', 'Hz', latest ? `${noteName(latest.summary.medianF0)} · ${formatDate(latest.date)}` : ''));

    // Trend charts
    const t = target();
    const pitchBox = h('div', { class: 'chart-trend' });
    const targetBox = h('div', { class: 'chart-trend' });
    const f2Box = h('div', { class: 'chart-trend' });
    const scoreBox = h('div', { class: 'chart-trend' });
    const card = (title, hint, box) => h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'stack', style: { gap: '2px' } }, h('h2', {}, title), h('span', { class: 'hint' }, hint))), box);

    const point = (s, value) => ({ date: s.date, value, label: s.title });
    const trends = [
      { title: 'Median speaking pitch', hint: 'Per session; shaded band is your current target', box: pitchBox, opts: { unit: ' Hz', band: [t.low, t.high] },
        points: withPitch.filter((s) => s.type !== 'sustain').map((s) => point(s, s.summary.medianF0)) },
      { title: 'Time in target range', hint: 'Share of voiced speech inside your target', box: targetBox, opts: { unit: '%', yMin: 0, yMax: 100 },
        points: sessions.filter((s) => Number.isFinite(s.summary?.inTargetPct)).map((s) => point(s, s.summary.inTargetPct)) },
      { title: 'Resonance (median F2)', hint: 'Read-aloud and live sessions; higher is brighter', box: f2Box, opts: { unit: ' Hz' },
        points: sessions.filter((s) => (s.type === 'read' || s.type === 'live') && Number.isFinite(s.summary?.f2)).map((s) => point(s, s.summary.f2)) },
      { title: 'Exercise scores', hint: 'Pitch match and glide, % on target', box: scoreBox, opts: { unit: '%', yMin: 0, yMax: 100 },
        points: sessions.filter((s) => Number.isFinite(s.summary?.score)).map((s) => point(s, s.summary.score)) },
      { title: 'Steady-vowel clarity (HNR)', hint: 'Harmonics-to-noise ratio of your steady vowels', box: h('div', { class: 'chart-trend' }), opts: { unit: ' dB', format: (v) => v.toFixed(1) },
        points: sessions.filter((s) => s.type === 'sustain' && Number.isFinite(s.summary?.hnr)).map((s) => point(s, s.summary.hnr)) },
    ].filter((tr) => tr.points.length > 0);

    body.replaceChildren(
      tiles,
      trends.length
        ? h('div', { class: 'grid grid-2' }, trends.map((tr) => card(tr.title, tr.hint, tr.box)))
        : null,
      sessionList(sessions));

    for (const tr of trends) {
      const c = new TrendChart(tr.box, tr.opts);
      c.setPoints(tr.points);
      charts.push(c);
    }
  }

  function sessionList(sessions) {
    const list = h('div', { class: 'session-list' });
    for (const s of sessions) {
      const info = TYPE_INFO[s.type] || TYPE_INFO.analysis;
      const sm = s.summary || {};
      const bits = [];
      if (Number.isFinite(sm.medianF0)) bits.push(`${sm.medianF0.toFixed(0)} Hz median`);
      if (Number.isFinite(sm.inTargetPct)) bits.push(`${sm.inTargetPct.toFixed(0)}% in target`);
      if (Number.isFinite(sm.score) && s.type === 'match') bits.push(`${sm.matched}/${sm.rounds} matched`);
      else if (Number.isFinite(sm.score)) bits.push(`${sm.score.toFixed(0)}% on track`);
      if (Number.isFinite(sm.hnr)) bits.push(`HNR ${sm.hnr.toFixed(1)} dB`);
      if (Number.isFinite(sm.sdCents)) bits.push(`±${sm.sdCents.toFixed(0)}¢`);
      const playBtn = s.hasAudio ? h('button', { class: 'btn small icon ghost', title: 'Play', 'aria-label': 'Play', onclick: () => play(s, playBtn) }, icon('play')) : null;
      list.append(h('div', { class: 'session' },
        h('div', { class: 'icon-wrap' }, icon(info.icon)),
        h('div', { style: { minWidth: 0 } },
          h('div', { class: 'title' }, s.title || info.label),
          h('div', { class: 'meta' }, [formatDate(s.date), ...bits].join(' · '))),
        h('div', { class: 'row', style: { flexWrap: 'nowrap', gap: '4px' } },
          playBtn,
          s.hasAudio ? h('button', { class: 'btn small icon ghost', title: 'Analyze', 'aria-label': 'Analyze', onclick: () => navigate(`analyze/${s.id}`) }, icon('spectrum')) : null,
          h('button', { class: 'btn small icon ghost', title: 'Delete', 'aria-label': 'Delete', onclick: () => remove(s) }, icon('trash')))));
    }
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Sessions'),
        h('button', { class: 'btn small ghost danger', onclick: removeAll }, 'Delete all')),
      list);
  }

  async function play(s, btn) {
    if (stopPlay) {
      stopPlay();
      stopPlay = null;
      return;
    }
    const a = await getAudio(s.id);
    if (!a) return toast('Recording not found.', { error: true });
    btn.replaceChildren(icon('stop'));
    stopPlay = audio.play(a.samples, a.sampleRate, { onEnd: () => { stopPlay = null; btn.replaceChildren(icon('play')); } });
  }

  async function remove(s) {
    if (!(await confirmDialog('Delete session?', `“${s.title}” from ${formatDate(s.date)} will be removed from this device.`))) return;
    await deleteSession(s.id);
    render();
  }

  async function removeAll() {
    if (!(await confirmDialog('Delete all sessions?', 'Every saved session and recording on this device will be removed. Export first if you want a backup.', 'Delete everything'))) return;
    await clearAll();
    render();
  }

  async function doExport() {
    const sessions = await listSessions();
    const blob = new Blob([JSON.stringify({ app: 'tessitura', version: 1, exported: new Date().toISOString(), settings: state.settings, sessions }, null, 2)], { type: 'application/json' });
    download(blob, `tessitura-progress-${new Date().toISOString().slice(0, 10)}.json`);
    toast('Exported session summaries (recordings are not included).');
  }

  async function doImport() {
    const file = importInput.files[0];
    importInput.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'tessitura' || !Array.isArray(data.sessions)) throw new Error('not a Tessitura export');
      await importSessions(data.sessions);
      toast(`Imported ${data.sessions.length} sessions.`);
      render();
    } catch (e) {
      toast(`Import failed: ${e.message}`, { error: true });
    }
  }

  render();
  return {
    unmount() {
      if (stopPlay) stopPlay();
      for (const c of charts) c.destroy();
    },
  };
}
