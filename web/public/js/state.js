// Shared application state: settings (persisted) and small cross-view handoffs.

import { loadSettings, saveSettings } from './store.js';

const listeners = new Set();

export const state = {
  settings: loadSettings(),
  /** A recording handed from one view to the Analyze view: { samples, sampleRate, title, sessionId? } */
  pendingAnalysis: null,
};

export function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  saveSettings(state.settings);
  for (const fn of listeners) fn(state.settings, patch);
}

export function onSettings(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Parameters for Praat's analyses derived from the settings. */
export function analysisOptions() {
  const s = state.settings;
  return {
    pitchFloor: s.pitchFloor,
    pitchCeiling: s.pitchCeiling,
    formantCeiling: s.formantCeiling,
    spectrogramMax: 5500,
  };
}

export function liveParams() {
  const s = state.settings;
  return {
    pitchFloor: Math.max(50, s.pitchFloor),
    pitchCeiling: s.pitchCeiling,
    formantCeiling: s.formantCeiling,
    silenceDb: s.silenceDb,
    windowSeconds: 0.16,
    hopSeconds: 0.025,
  };
}

export function target() {
  return { low: state.settings.targetLow, high: state.settings.targetHigh };
}
