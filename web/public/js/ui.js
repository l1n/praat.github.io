// Small DOM helpers, icons, toasts and modals.

/**
 * Create an element. `attrs` may contain `class`, `style` (object or string), `dataset`,
 * event handlers (`onclick` ...), `html` (innerHTML) and any other attribute.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** An icon from the set below, as an SVG element. */
export function icon(name) {
  const span = document.createElement('span');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return span.firstChild;
}

const ICONS = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  micOff: '<path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 5.1 2.1M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.4 2.2M12 18v3M3 3l18 18"/>',
  wave: '<path d="M2 12h3l2-6 4 12 3-9 2 5 2-2h4"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  spectrum: '<path d="M4 20V10M8 20V4M12 20v-8M16 20V7M20 20v-5"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 6-6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  note: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  headphones: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  glide: '<path d="M2 18c4 0 5-12 10-12s6 12 10 12"/>',
  vowel: '<path d="M4 12c2-6 4-6 6 0s4 6 6 0 3-5 4-3"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  stairs: '<path d="M3 20h5v-5h5v-5h5V5h3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M8 11h6"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  resonance: '<circle cx="12" cy="12" r="3"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4M3.5 3.5a12 12 0 0 0 0 17M20.5 3.5a12 12 0 0 1 0 17"/>',
};

// ---------------------------------------------------------------------------

let toastBox = null;

export function toast(message, { error = false, ms = 3200 } = {}) {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const t = h('div', { class: `toast${error ? ' error' : ''}` }, message);
  // Clicking an action button inside the toast dismisses it.
  t.addEventListener('click', (e) => { if (e.target.closest('button')) t.remove(); });
  toastBox.append(t);
  setTimeout(() => t.remove(), ms);
}

/** Remove toasts that belong to the previous view. */
export function clearToasts() {
  toastBox?.replaceChildren();
}

/**
 * Show a modal dialog. `content` is a node or array of nodes; `actions` is an array of
 * { label, primary, danger, value }. Resolves with the chosen action's value (or null when dismissed).
 */
export function modal({ title, content, actions = [{ label: 'OK', primary: true, value: true }], dismissible = true }) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const close = (value) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissible) close(null);
    };
    const buttons = actions.map((a) => h('button', {
      class: `btn${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}`,
      onclick: () => close(a.value),
    }, a.label));
    const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', {}, title),
      content,
      h('div', { class: 'actions' }, buttons));
    const backdrop = h('div', {
      class: 'modal-backdrop',
      onclick: (e) => { if (e.target === backdrop && dismissible) close(null); },
    }, dialog);
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey);
    (buttons.find((b) => b.classList.contains('primary')) || buttons[0])?.focus();
  });
}

export function confirmDialog(title, text, confirmLabel = 'Delete') {
  return modal({
    title,
    content: h('p', { class: 'muted' }, text),
    actions: [{ label: 'Cancel', value: false }, { label: confirmLabel, danger: true, primary: true, value: true }],
  });
}

/** A segmented control. Returns the element; calls onChange(value). */
export function segmented(options, initial, onChange) {
  const el = h('div', { class: 'segmented', role: 'group' });
  const buttons = options.map((o) => h('button', {
    type: 'button', 'aria-pressed': String(o.value === initial),
    onclick: (e) => {
      for (const b of buttons) b.setAttribute('aria-pressed', String(b === e.currentTarget));
      onChange(o.value);
    },
  }, o.label));
  el.append(...buttons);
  return el;
}

/** A labelled statistic tile. */
export function statTile(label, value, unit = '', sub = '') {
  return h('div', { class: 'stat' },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value, unit ? h('small', {}, unit) : null),
    sub ? h('div', { class: 'sub' }, sub) : null);
}

export function formatDate(ms) {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const yesterday = new Date(today - 864e5).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  if (yesterday) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })}, ${time}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '–';
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Read a CSS custom property from :root. */
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
