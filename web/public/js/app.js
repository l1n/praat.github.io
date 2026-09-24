// Entry point: navigation, theme, onboarding and service worker.

import { h, icon, modal, toast, clearToasts } from './ui.js';
import { state, updateSettings, onSettings } from './state.js';
import { TARGET_PRESETS } from './store.js';
import { invalidateTheme } from './charts.js';
import * as audio from './audio.js';
import * as praat from './praat-client.js';
import liveView from './views/live.js';
import practiceView from './views/practice.js';
import analyzeView from './views/analyze.js';
import progressView from './views/progress.js';
import settingsView from './views/settings.js';

const ROUTES = {
  live: { label: 'Live', icon: 'wave', view: liveView },
  practice: { label: 'Practice', icon: 'target', view: practiceView },
  analyze: { label: 'Analyze', icon: 'spectrum', view: analyzeView },
  progress: { label: 'Progress', icon: 'chart', view: progressView },
  settings: { label: 'Settings', icon: 'gear', view: settingsView },
};

const main = document.getElementById('view');
let current = null;

function setupNav() {
  for (const a of document.querySelectorAll('.tab')) {
    const r = ROUTES[a.dataset.route];
    a.append(icon(r.icon), h('span', {}, r.label));
  }
}

function route() {
  const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const key = ROUTES[name] ? name : 'live';
  if (current?.unmount) current.unmount();
  audio.stopPlayback();
  if (audio.micRunning()) audio.stopMic();
  if (!state.pendingAnalysis) clearToasts();
  main.replaceChildren();
  for (const a of document.querySelectorAll('.tab')) {
    if (a.dataset.route === key) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const container = h('div', { class: 'view' });
  main.append(container);
  current = ROUTES[key].view(container, { param: rest.join('/'), navigate });
  document.title = `${ROUTES[key].label} · Tessitura`;
  window.scrollTo(0, 0);
}

export function navigate(path) {
  if (location.hash === `#/${path}`) route();
  else location.hash = `#/${path}`;
}

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  invalidateTheme();
  window.dispatchEvent(new Event('themechange'));
}

async function onboarding() {
  if (state.settings.onboarded) return;
  let choice = state.settings.targetPreset;
  const presetButtons = TARGET_PRESETS.filter((p) => p.id !== 'custom').map((p) => {
    const b = h('button', {
      class: 'preset', type: 'button', 'aria-pressed': String(p.id === choice),
      onclick: () => {
        choice = p.id;
        for (const x of presetButtons) x.setAttribute('aria-pressed', String(x === b));
      },
    }, h('b', {}, p.label), h('span', {}, `${p.low}–${p.high} Hz · ${p.note}`));
    return b;
  });
  await modal({
    title: 'Welcome to Tessitura',
    dismissible: false,
    content: h('div', { class: 'stack' },
      h('p', {}, 'A voice trainer that shows your pitch and resonance as you speak, with guided exercises and detailed analysis by Praat, the phonetics software used by speech scientists.'),
      h('div', { class: 'callout' }, icon('lock'), h('span', {}, h('b', {}, 'Private by design. '), 'All analysis runs in your browser. Recordings stay on this device unless you export them.')),
      h('p', { class: 'small muted' }, 'Pick a target pitch range to start with. You can change it, or set your own, any time in Settings.'),
      h('div', { class: 'preset-grid' }, presetButtons),
      h('div', { class: 'callout' }, icon('headphones'), h('span', {}, 'Use headphones for reference tones, and a quiet room. Pitch and resonance targets are starting points, not rules: aim for a voice that feels healthy and sounds like you.')),
    ),
    actions: [{ label: 'Get started', primary: true, value: true }],
  });
  const p = TARGET_PRESETS.find((x) => x.id === choice);
  updateSettings({ onboarded: true, targetPreset: p.id, targetLow: p.low, targetHigh: p.high });
}

function checkSupport() {
  const missing = [];
  if (!('WebAssembly' in window)) missing.push('WebAssembly');
  if (!window.AudioWorkletNode) missing.push('AudioWorklet');
  if (!navigator.mediaDevices?.getUserMedia) missing.push('microphone access (needs HTTPS)');
  if (missing.length) toast(`This browser lacks ${missing.join(', ')}. Some features won’t work.`, { error: true, ms: 8000 });
}

setupNav();
applyTheme();
onSettings((_, patch) => { if ('theme' in patch) applyTheme(); });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { invalidateTheme(); window.dispatchEvent(new Event('themechange')); });
window.addEventListener('hashchange', route);
route();
checkSupport();
onboarding();
// Load the analysis engine in the background so it is ready when needed.
praat.warmUp().catch((e) => toast(`Could not load the analysis engine: ${e.message}`, { error: true, ms: 8000 }));

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
