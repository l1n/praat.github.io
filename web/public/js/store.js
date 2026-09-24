// Local persistence: settings in localStorage, sessions (with optional audio) in IndexedDB.
// Nothing ever leaves the device.

const DB_NAME = 'tessitura';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Save a session. `session` = { type, title, summary, ... }; `audio` = { samples: Float32Array, sampleRate } or null.
 * Audio is stored as 16-bit PCM to keep the database small.
 */
export async function saveSession(session, audio) {
  const id = session.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const record = { ...session, id, date: session.date || Date.now(), hasAudio: !!audio };
  await tx(['sessions', 'audio'], 'readwrite', (t) => {
    t.objectStore('sessions').put(record);
    if (audio) {
      const pcm = new Int16Array(audio.samples.length);
      for (let i = 0; i < pcm.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(audio.samples[i] * 32767)));
      t.objectStore('audio').put({ id, sampleRate: audio.sampleRate, pcm });
    }
  });
  return record;
}

export async function listSessions() {
  try {
    const all = await tx(['sessions'], 'readonly', (t) => reqPromise(t.objectStore('sessions').getAll()));
    return (all || []).sort((a, b) => b.date - a.date);
  } catch {
    return [];
  }
}

export async function getAudio(id) {
  const rec = await tx(['audio'], 'readonly', (t) => reqPromise(t.objectStore('audio').get(id)));
  if (!rec) return null;
  const samples = new Float32Array(rec.pcm.length);
  for (let i = 0; i < samples.length; i++) samples[i] = rec.pcm[i] / 32768;
  return { samples, sampleRate: rec.sampleRate };
}

export async function deleteSession(id) {
  await tx(['sessions', 'audio'], 'readwrite', (t) => {
    t.objectStore('sessions').delete(id);
    t.objectStore('audio').delete(id);
  });
}

export async function clearAll() {
  await tx(['sessions', 'audio'], 'readwrite', (t) => {
    t.objectStore('sessions').clear();
    t.objectStore('audio').clear();
  });
}

/** Import sessions (without audio) from an exported JSON file. */
export async function importSessions(sessions) {
  await tx(['sessions'], 'readwrite', (t) => {
    for (const s of sessions) if (s && s.id && s.date) t.objectStore('sessions').put({ ...s, hasAudio: false });
  });
}

// ---- settings ----

const SETTINGS_KEY = 'tessitura.settings.v1';

export const TARGET_PRESETS = [
  { id: 'higher', label: 'Higher speaking range', low: 165, high: 255, note: 'Typical of many adult women’s speech' },
  { id: 'middle', label: 'Middle / androgynous range', low: 145, high: 185, note: 'Where typical ranges overlap' },
  { id: 'lower', label: 'Lower speaking range', low: 85, high: 155, note: 'Typical of many adult men’s speech' },
  { id: 'custom', label: 'Custom range', low: 120, high: 200, note: 'Set your own' },
];

export const DEFAULT_SETTINGS = {
  targetPreset: 'higher',
  targetLow: 165,
  targetHigh: 255,
  pitchFloor: 60,
  pitchCeiling: 600,
  formantCeiling: 5500,
  silenceDb: -55,
  keepAudio: true,
  showNotes: true,
  theme: 'auto',
  deviceId: '',
  onboarded: false,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* private mode: settings last for this visit only */ }
}
