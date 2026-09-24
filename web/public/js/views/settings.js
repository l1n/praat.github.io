// Settings view: target range, analysis parameters, microphone, display, data and about.

import { h, icon, toast, confirmDialog, segmented } from '../ui.js';
import { state, updateSettings } from '../state.js';
import { TARGET_PRESETS, DEFAULT_SETTINGS, clearAll } from '../store.js';
import { RangeStrip } from '../charts.js';
import { noteName } from '../music.js';
import * as audio from '../audio.js';

export default function settingsView(root) {
  const s = state.settings;
  root.append(h('div', { class: 'view-head' }, h('div', {}, h('h1', {}, 'Settings'), h('p', {}, 'Saved in this browser.'))));

  // ---------------------------------------------------------------- target range
  const stripBox = h('div', { class: 'range-preview' });
  const lowInput = h('input', { type: 'number', min: 50, max: 800, step: 1, value: s.targetLow });
  const highInput = h('input', { type: 'number', min: 50, max: 900, step: 1, value: s.targetHigh });
  const lowNote = h('span', { class: 'help' }, noteName(s.targetLow));
  const highNote = h('span', { class: 'help' }, noteName(s.targetHigh));
  const presetButtons = TARGET_PRESETS.map((p) => h('button', {
    class: 'preset', type: 'button', 'aria-pressed': String(state.settings.targetPreset === p.id),
    onclick: () => {
      if (p.id === 'custom') setTarget(state.settings.targetLow, state.settings.targetHigh, 'custom');
      else setTarget(p.low, p.high, p.id);
    },
  }, h('b', {}, p.label), h('span', {}, p.id === 'custom' ? p.note : `${p.low}–${p.high} Hz · ${p.note}`)));

  function setTarget(low, high, preset) {
    low = Math.round(low);
    high = Math.round(high);
    if (!(low >= 50 && high <= 900 && high > low + 5)) {
      toast('The range should be between 50 and 900 Hz, with the top above the bottom.', { error: true });
      lowInput.value = state.settings.targetLow;
      highInput.value = state.settings.targetHigh;
      return;
    }
    updateSettings({ targetLow: low, targetHigh: high, targetPreset: preset });
    lowInput.value = low;
    highInput.value = high;
    lowNote.textContent = noteName(low);
    highNote.textContent = noteName(high);
    strip.set(low, high);
    presetButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(TARGET_PRESETS[i].id === preset)));
  }
  const onRangeInput = () => setTarget(+lowInput.value, +highInput.value, 'custom');
  lowInput.addEventListener('change', onRangeInput);
  highInput.addEventListener('change', onRangeInput);

  const targetCard = h('div', { class: 'card stack', style: { gap: '14px' } },
    h('div', { class: 'card-head', style: { marginBottom: 0 } }, h('h2', {}, 'Target pitch range'),
      h('span', { class: 'hint' }, 'Used for live feedback, exercises and statistics')),
    h('div', { class: 'preset-grid' }, presetButtons),
    h('div', { class: 'grid grid-2', style: { gap: '12px' } },
      h('label', { class: 'field' }, h('span', {}, 'Bottom (Hz)'), lowInput, lowNote),
      h('label', { class: 'field' }, h('span', {}, 'Top (Hz)'), highInput, highNote)),
    stripBox,
    h('p', { class: 'small muted' }, 'Average speaking pitch overlaps a lot between people, and pitch is only one part of how a voice is perceived: resonance, intonation and articulation matter as much. Choose a range that feels comfortable and sustainable.'));

  // ---------------------------------------------------------------- analysis
  const floorInput = h('input', { type: 'number', min: 40, max: 200, step: 5, value: s.pitchFloor, onchange: (e) => {
    const v = Math.max(40, Math.min(200, +e.target.value || DEFAULT_SETTINGS.pitchFloor));
    e.target.value = v;
    updateSettings({ pitchFloor: v });
  } });
  const ceilInput = h('input', { type: 'number', min: 200, max: 1200, step: 10, value: s.pitchCeiling, onchange: (e) => {
    const v = Math.max(200, Math.min(1200, +e.target.value || DEFAULT_SETTINGS.pitchCeiling));
    e.target.value = v;
    updateSettings({ pitchCeiling: v });
  } });
  const gateValue = h('span', { class: 'help num' }, `${s.silenceDb} dB`);
  const gate = h('input', { type: 'range', min: -75, max: -30, step: 1, value: s.silenceDb, oninput: (e) => {
    gateValue.textContent = `${e.target.value} dB`;
    updateSettings({ silenceDb: +e.target.value });
  } });
  const analysisCard = h('div', { class: 'card stack', style: { gap: '14px' } },
    h('div', { class: 'card-head', style: { marginBottom: 0 } }, h('h2', {}, 'Analysis'), h('span', { class: 'hint' }, 'Praat parameters')),
    h('div', { class: 'grid grid-2', style: { gap: '12px' } },
      h('label', { class: 'field' }, h('span', {}, 'Pitch floor (Hz)'), floorInput, h('span', { class: 'help' }, 'Lowest pitch looked for. Lower is slower but catches deep or creaky voice.')),
      h('label', { class: 'field' }, h('span', {}, 'Pitch ceiling (Hz)'), ceilInput, h('span', { class: 'help' }, 'Highest pitch looked for.'))),
    h('div', { class: 'field' }, h('span', {}, 'Formant ceiling'),
      segmented([{ label: '5000 Hz · longer vocal tract', value: 5000 }, { label: '5500 Hz · shorter vocal tract', value: 5500 }], s.formantCeiling, (v) => updateSettings({ formantCeiling: v })),
      h('span', { class: 'help' }, 'Praat’s standard advice: 5000 Hz for typical adult male voices, 5500 Hz for typical adult female voices. If formant tracks look wrong in Analyze, try the other.')),
    h('label', { class: 'field' }, h('span', {}, 'Noise gate'), gate, gateValue,
      h('span', { class: 'help' }, 'Live analysis ignores sound quieter than this. Raise it in noisy rooms.')));

  // ---------------------------------------------------------------- microphone & display
  const deviceSelect = h('select', { onchange: (e) => updateSettings({ deviceId: e.target.value }) }, h('option', { value: '' }, 'System default'));
  audio.listInputs().then((inputs) => {
    for (const d of inputs) {
      if (!d.deviceId || d.deviceId === 'default') continue;
      deviceSelect.append(h('option', { value: d.deviceId, selected: d.deviceId === state.settings.deviceId }, d.label || `Microphone ${deviceSelect.length}`));
    }
    if (inputs.length && !inputs.some((d) => d.label)) deviceSelect.append(h('option', { disabled: true }, 'Start the microphone once to see device names'));
  });
  const deviceCard = h('div', { class: 'card stack', style: { gap: '14px' } },
    h('div', { class: 'card-head', style: { marginBottom: 0 } }, h('h2', {}, 'Microphone & display')),
    h('label', { class: 'field' }, h('span', {}, 'Input device'), deviceSelect,
      h('span', { class: 'help' }, 'A headset or USB microphone gives steadier results than a laptop’s built-in one. Echo cancellation and noise suppression are switched off because they distort voice measurements.')),
    h('div', { class: 'field' }, h('span', {}, 'Theme'),
      segmented([{ label: 'Auto', value: 'auto' }, { label: 'Light', value: 'light' }, { label: 'Dark', value: 'dark' }], s.theme, (v) => updateSettings({ theme: v }))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.showNotes, onchange: (e) => updateSettings({ showNotes: e.target.checked }) }),
      h('span', {}, h('b', {}, 'Show note names'), h('div', { class: 'help small muted' }, 'Label pitch axes with musical notes (A3, C4…) as well as Hz.'))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.keepAudio, onchange: (e) => updateSettings({ keepAudio: e.target.checked }) }),
      h('span', {}, h('b', {}, 'Keep recordings with saved sessions'), h('div', { class: 'help small muted' }, 'Lets you replay and re-analyse old sessions. Stored only in this browser.'))),
    h('button', { class: 'btn small danger', style: { justifySelf: 'start' }, onclick: async () => {
      if (!(await confirmDialog('Delete all data?', 'All sessions, recordings and settings on this device will be removed.', 'Delete everything'))) return;
      await clearAll();
      try { localStorage.clear(); } catch { /* ignore */ }
      location.reload();
    } }, icon('trash'), 'Delete all data'));

  // ---------------------------------------------------------------- about
  const aboutCard = h('div', { class: 'card stack' },
    h('h2', {}, 'About'),
    h('p', {}, 'Tessitura runs ', h('a', { href: 'https://www.praat.org', target: '_blank', rel: 'noopener' }, 'Praat'),
      ', the speech analysis program by Paul Boersma and David Weenink (University of Amsterdam), compiled to WebAssembly. Pitch uses Praat’s autocorrelation methods, formants use the Burg LPC method, and the voice report computes jitter, shimmer, harmonics-to-noise ratio and CPPS, all on your device.'),
    h('p', { class: 'small muted' }, 'This is a training aid, not a medical device. If your voice feels tired, hoarse or painful, rest it and consider seeing a speech-language pathologist or voice teacher.'),
    h('p', { class: 'small muted' }, 'Reference vowels: Hillenbrand, Getty, Clark & Wheeler (1995), “Acoustic characteristics of American English vowels”, JASA 97(5).'),
    h('p', { class: 'small muted' }, 'Free software under the GNU General Public License v3. ',
      h('a', { href: 'https://github.com/l1n/praat.github.io/tree/master/web', target: '_blank', rel: 'noopener' }, 'Source code'), '.'));

  root.append(targetCard, h('div', { class: 'grid grid-2' }, analysisCard, deviceCard), aboutCard);
  const strip = new RangeStrip(stripBox);
  strip.set(s.targetLow, s.targetHigh);

  return { unmount() { strip.destroy(); } };
}

