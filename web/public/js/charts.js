// Canvas charts: live pitch trace, vowel (F1/F2) chart, multi-panel analysis view and trend charts.
// Colors come from CSS custom properties so light and dark themes both work.

import { noteName, hzToMidi } from './music.js';
import { h } from './ui.js';

// ---------------------------------------------------------------------------
// Theme

let themeCache = null;
export function theme() {
  if (themeCache) return themeCache;
  const s = getComputedStyle(document.documentElement);
  const v = (n) => s.getPropertyValue(n).trim();
  themeCache = {
    surface: v('--surface'), surface2: v('--surface-2'), surface3: v('--surface-3'),
    ink: v('--ink'), ink2: v('--ink-2'), muted: v('--muted'),
    grid: v('--grid'), axis: v('--axis'),
    accent: v('--accent'), band: v('--band'), bandEdge: v('--band-edge'),
    s1: v('--series-1'), s2: v('--series-2'), s3: v('--series-3'), s5: v('--series-5'), s7: v('--series-7'),
    good: v('--good'), serious: v('--serious'), record: v('--record'),
    specLo: v('--spec-lo').split(',').map(Number), specHi: v('--spec-hi').split(',').map(Number),
    font: v('--font') || 'system-ui, sans-serif',
  };
  return themeCache;
}
export function invalidateTheme() {
  themeCache = null;
}

// ---------------------------------------------------------------------------
// Base class: a canvas that tracks its CSS size and device pixel ratio.

class CanvasChart {
  constructor(container) {
    this.container = container;
    this.container.classList.add('chart');
    this.canvas = h('canvas');
    this.container.append(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.w = 0;
    this.h = 0;
    this.dirty = true;
    this.tooltip = h('div', { class: 'tooltip', hidden: true });
    this.container.append(this.tooltip);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.onThemeChange = () => { this.dirty = true; this.draw(); };
    window.addEventListener('themechange', this.onThemeChange);
    // The ResizeObserver fires once right away (asynchronously), after subclass constructors have run.
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
    this.draw();
  }

  destroy() {
    this.resizeObserver.disconnect();
    window.removeEventListener('themechange', this.onThemeChange);
  }

  showTooltip(x, y, html) {
    const tip = this.tooltip;
    tip.innerHTML = html;
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = x + 14, top = y - th - 10;
    if (left + tw > this.w) left = x - tw - 14;
    if (left < 0) left = 4;
    if (top < 0) top = y + 14;
    if (top + th > this.h) top = Math.max(0, this.h - th);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  hideTooltip() {
    this.tooltip.hidden = true;
  }

  draw() {}
}

// Helpers

function logScale(lo, hi, px0, px1) {
  const a = Math.log(lo), b = Math.log(hi);
  const f = (v) => px0 + (Math.log(v) - a) / (b - a) * (px1 - px0);
  f.invert = (p) => Math.exp(a + (p - px0) / (px1 - px0) * (b - a));
  return f;
}

function linScale(lo, hi, px0, px1) {
  const f = (v) => px0 + (v - lo) / (hi - lo) * (px1 - px0);
  f.invert = (p) => lo + (p - px0) / (px1 - px0) * (hi - lo);
  return f;
}

const HZ_TICKS = [50, 60, 70, 80, 100, 125, 150, 175, 200, 250, 300, 350, 400, 500, 600, 800, 1000];

function hzTicks(lo, hi, maxTicks) {
  let ticks = HZ_TICKS.filter((t) => t >= lo && t <= hi);
  while (ticks.length > maxTicks) ticks = ticks.filter((_, i) => i % 2 === 0);
  return ticks;
}

function niceStep(range, targetCount) {
  const raw = range / Math.max(1, targetCount);
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

function roundRect(ctx, x, y, w, hgt, r) {
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, hgt, r) : ctx.rect(x, y, w, hgt);
}

// ---------------------------------------------------------------------------
// Live pitch trace

export class LivePitchChart extends CanvasChart {
  constructor(container, { windowSeconds = 10 } = {}) {
    super(container);
    this.points = []; // { t, f0 }
    this.windowSeconds = windowSeconds;
    this.futureSeconds = 0; // extra room to the right of "now", for guides that run ahead
    this.target = { low: 165, high: 255 };
    this.guide = null; // { hz, tolCents } | { fn(t) -> hz, tolSemis }
    this.showNotes = true;
    this.now = 0;
    this.clockBase = null; // { audioTime, perf }
    this.running = false;
    this.canvas.addEventListener('pointermove', (e) => this.hover(e));
    this.canvas.addEventListener('pointerleave', () => this.hideTooltip());
    this.loop = this.loop.bind(this);
  }

  setTarget(low, high) {
    this.target = { low, high };
    this.dirty = true;
  }

  clear() {
    this.points = [];
    this.clockBase = null;
    this.now = 0;
    this.dirty = true;
    this.draw();
  }

  push(msg) {
    this.points.push({ t: msg.time, f0: msg.f0 });
    this.clockBase = { audioTime: msg.time, perf: performance.now() };
    const cutoff = msg.time - 70;
    if (this.points.length > 4000 || (this.points[0] && this.points[0].t < cutoff)) {
      const i = this.points.findIndex((p) => p.t >= cutoff);
      this.points.splice(0, Math.max(0, i));
    }
    this.dirty = true;
  }

  start() {
    this.running = true;
    requestAnimationFrame(this.loop);
  }

  stop() {
    this.running = false;
  }

  loop() {
    if (!this.running) return;
    if (this.clockBase) {
      // Scroll smoothly between analysis updates, but never run ahead of the data by more than 150 ms.
      const ahead = Math.min(0.15, (performance.now() - this.clockBase.perf) / 1000);
      this.now = this.clockBase.audioTime + ahead;
      this.dirty = true;
    }
    this.draw();
    requestAnimationFrame(this.loop);
  }

  yRange() {
    let lo = this.target.low / 1.5, hi = this.target.high * 1.5;
    if (this.guide?.hz) { lo = Math.min(lo, this.guide.hz / 1.3); hi = Math.max(hi, this.guide.hz * 1.3); }
    for (const p of this.points) {
      if (p.t < this.now - this.windowSeconds || !Number.isFinite(p.f0)) continue;
      lo = Math.min(lo, p.f0 / 1.1);
      hi = Math.max(hi, p.f0 * 1.1);
    }
    return [Math.max(40, lo), Math.min(1200, hi)];
  }

  layout() {
    const left = 58, right = 12, top = 12, bottom = 28;
    const [lo, hi] = this.yRange();
    const y = logScale(lo, hi, this.h - bottom, top);
    const x = linScale(this.now - this.windowSeconds, this.now + this.futureSeconds, left, this.w - right);
    return { left, right, top, bottom, lo, hi, x, y };
  }

  draw() {
    if (!this.dirty || !this.w) return;
    this.dirty = false;
    const { ctx, w, h: H } = this;
    const T = theme();
    const L = this.layout();
    this.L = L;
    ctx.clearRect(0, 0, w, H);
    ctx.font = `11px ${T.font}`;

    // Target band
    const yb1 = L.y(Math.min(L.hi, this.target.high)), yb2 = L.y(Math.max(L.lo, this.target.low));
    if (yb2 > yb1) {
      ctx.fillStyle = T.band;
      ctx.fillRect(L.left, yb1, w - L.left - L.right, yb2 - yb1);
      ctx.strokeStyle = T.bandEdge;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      for (const yy of [yb1, yb2]) {
        ctx.beginPath();
        ctx.moveTo(L.left, Math.round(yy) + 0.5);
        ctx.lineTo(w - L.right, Math.round(yy) + 0.5);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = T.ink2;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(`target ${Math.round(this.target.low)}–${Math.round(this.target.high)} Hz`, w - L.right - 6, yb1 + 4);
    }

    // Grid & y labels
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const hz of hzTicks(L.lo, L.hi, Math.max(3, Math.floor((H - 40) / 34)))) {
      const yy = Math.round(L.y(hz)) + 0.5;
      ctx.strokeStyle = T.grid;
      ctx.beginPath();
      ctx.moveTo(L.left, yy);
      ctx.lineTo(w - L.right, yy);
      ctx.stroke();
      ctx.fillStyle = T.muted;
      ctx.fillText(`${hz}`, L.left - 8, yy - (this.showNotes ? 6 : 0));
      if (this.showNotes) {
        ctx.fillStyle = T.muted;
        ctx.font = `10px ${T.font}`;
        ctx.fillText(noteName(hz), L.left - 8, yy + 7);
        ctx.font = `11px ${T.font}`;
      }
    }
    ctx.save();
    ctx.translate(12, (L.top + H - L.bottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = T.muted;
    ctx.fillText('pitch (Hz)', 0, 0);
    ctx.restore();

    // Time axis
    ctx.strokeStyle = T.axis;
    ctx.beginPath();
    ctx.moveTo(L.left, H - L.bottom + 0.5);
    ctx.lineTo(w - L.right, H - L.bottom + 0.5);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = T.muted;
    const step = this.windowSeconds > 12 ? 5 : this.windowSeconds > 6 ? 2 : 1;
    for (let s = 0; s <= this.windowSeconds; s += step) {
      const xx = L.x(this.now - s);
      ctx.fillText(s === 0 ? 'now' : `−${s}s`, xx, H - L.bottom + 8);
    }

    // Guide (exercises)
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.left, L.top, w - L.left - L.right, H - L.top - L.bottom);
    ctx.clip();
    if (this.guide) this.drawGuide(L, T);
    if (this.futureSeconds > 0) {
      ctx.strokeStyle = T.axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(L.x(this.now)) + 0.5, L.top);
      ctx.lineTo(Math.round(L.x(this.now)) + 0.5, H - L.bottom);
      ctx.stroke();
    }

    // Pitch trace
    const t0 = this.now - this.windowSeconds - 0.5;
    const pts = this.points.filter((p) => p.t >= t0);
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const inTarget = (f) => this.guide ? this.onGuide(f, 0) : f >= this.target.low && f <= this.target.high;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (!Number.isFinite(a.f0) || !Number.isFinite(b.f0) || b.t - a.t > 0.12) continue;
      const ok = this.guide ? this.onGuide(b.f0, b.t) : inTarget(b.f0);
      ctx.strokeStyle = ok ? T.s1 : T.muted;
      ctx.beginPath();
      ctx.moveTo(L.x(a.t), L.y(a.f0));
      ctx.lineTo(L.x(b.t), L.y(b.f0));
      ctx.stroke();
    }
    // Isolated points
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!Number.isFinite(p.f0)) continue;
      const prev = pts[i - 1], next = pts[i + 1];
      const connected = (prev && Number.isFinite(prev.f0) && p.t - prev.t <= 0.12) || (next && Number.isFinite(next.f0) && next.t - p.t <= 0.12);
      if (connected) continue;
      ctx.fillStyle = (this.guide ? this.onGuide(p.f0, p.t) : inTarget(p.f0)) ? T.s1 : T.muted;
      ctx.beginPath();
      ctx.arc(L.x(p.t), L.y(p.f0), 2, 0, Math.PI * 2);
      ctx.fill();
    }
    // Latest point
    const last = pts[pts.length - 1];
    if (last && Number.isFinite(last.f0) && this.now - last.t < 0.3) {
      const xx = L.x(last.t), yy = L.y(last.f0);
      ctx.fillStyle = T.surface;
      ctx.beginPath();
      ctx.arc(xx, yy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = T.s1;
      ctx.beginPath();
      ctx.arc(xx, yy, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  onGuide(f0, t) {
    const g = this.guide;
    if (!g) return false;
    const hz = g.hz ?? g.fn(t);
    const cents = Math.abs(1200 * Math.log2(f0 / hz));
    return cents <= (g.tolCents ?? 100);
  }

  drawGuide(L, T) {
    const { ctx } = this;
    const g = this.guide;
    const tol = (g.tolCents ?? 100) / 1200;
    if (g.hz) {
      const y1 = L.y(g.hz * 2 ** tol), y2 = L.y(g.hz / 2 ** tol);
      ctx.fillStyle = T.band;
      ctx.fillRect(L.left, y1, this.w - L.left - L.right, y2 - y1);
      ctx.strokeStyle = T.s1;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(L.left, L.y(g.hz));
      ctx.lineTo(this.w - L.right, L.y(g.hz));
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (g.fn) {
      // A moving target curve, drawn slightly into the future so the singer can anticipate it.
      const tStart = this.now - this.windowSeconds, tEnd = this.now + this.futureSeconds;
      const upper = [], lower = [], center = [];
      for (let t = tStart; t <= tEnd; t += 0.03) {
        const hz = g.fn(t);
        if (!Number.isFinite(hz)) continue;
        upper.push([L.x(t), L.y(hz * 2 ** tol)]);
        lower.push([L.x(t), L.y(hz / 2 ** tol)]);
        center.push([L.x(t), L.y(hz)]);
      }
      if (center.length > 1) {
        ctx.fillStyle = T.band;
        ctx.beginPath();
        upper.forEach(([xx, yy], i) => (i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy)));
        lower.reverse().forEach(([xx, yy]) => ctx.lineTo(xx, yy));
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = T.bandEdge;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        center.forEach(([xx, yy], i) => (i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy)));
        ctx.stroke();
        ctx.setLineDash([]);
        const [cx, cy] = center.find(([xx]) => xx >= L.x(this.now)) || center[center.length - 1];
        ctx.strokeStyle = T.s1;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  hover(e) {
    if (!this.L || !this.points.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const t = this.L.x.invert(px);
    let best = null;
    for (const p of this.points) {
      if (!Number.isFinite(p.f0)) continue;
      if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    }
    if (!best || Math.abs(best.t - t) > 0.25) return this.hideTooltip();
    const ago = this.now - best.t;
    this.showTooltip(px, py, `<b>${best.f0.toFixed(0)} Hz</b> · ${noteName(best.f0)}<br><span class="k">${ago < 0.05 ? 'now' : `${ago.toFixed(1)} s ago`}</span>`);
  }
}

// ---------------------------------------------------------------------------
// Vowel chart (F2 horizontally, reversed; F1 vertically, increasing downwards), as phoneticians draw it.

// Average formants of American English vowels (Hillenbrand et al. 1995, J. Acoust. Soc. Am. 97: 3099–3111).
export const VOWEL_REFERENCE = [
  { ipa: 'i', word: 'heed', lower: [342, 2322], higher: [437, 2761] },
  { ipa: 'ɪ', word: 'hid', lower: [427, 2034], higher: [483, 2365] },
  { ipa: 'ɛ', word: 'head', lower: [580, 1799], higher: [731, 2058] },
  { ipa: 'æ', word: 'had', lower: [588, 1952], higher: [669, 2349] },
  { ipa: 'ɑ', word: 'hod', lower: [768, 1333], higher: [936, 1551] },
  { ipa: 'ɔ', word: 'hawed', lower: [652, 997], higher: [781, 1136] },
  { ipa: 'ʊ', word: 'hood', lower: [469, 1122], higher: [519, 1225] },
  { ipa: 'u', word: 'who’d', lower: [378, 997], higher: [459, 1105] },
  { ipa: 'ʌ', word: 'hud', lower: [623, 1200], higher: [753, 1426] },
];

export class VowelChart extends CanvasChart {
  constructor(container) {
    super(container);
    this.trail = []; // { t, f1, f2 }
    this.showReference = { lower: true, higher: true };
    this.canvas.addEventListener('pointermove', (e) => this.hover(e));
    this.canvas.addEventListener('pointerleave', () => this.hideTooltip());
  }

  push(t, f1, f2) {
    if (!Number.isFinite(f1) || !Number.isFinite(f2)) return;
    this.trail.push({ t, f1, f2 });
    if (this.trail.length > 400) this.trail.shift();
    this.lastT = t;
    this.dirty = true;
    this.draw();
  }

  setPoints(points) {
    this.trail = points.filter((p) => Number.isFinite(p.f1) && Number.isFinite(p.f2));
    this.lastT = this.trail.length ? this.trail[this.trail.length - 1].t : 0;
    this.static = true;
    this.dirty = true;
    this.draw();
  }

  clear() {
    this.trail = [];
    this.dirty = true;
    this.draw();
  }

  layout() {
    const left = 48, right = 14, top = 26, bottom = 30;
    const x = logScale(3200, 650, left, this.w - right); // F2, reversed
    const y = logScale(200, 1150, top, this.h - bottom); // F1, downwards
    return { left, right, top, bottom, x, y };
  }

  draw() {
    if (!this.dirty || !this.w) return;
    this.dirty = false;
    const { ctx, w, h: H } = this;
    const T = theme();
    const L = this.layout();
    this.L = L;
    ctx.clearRect(0, 0, w, H);
    ctx.font = `11px ${T.font}`;

    // grid
    ctx.strokeStyle = T.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const f2 of [3000, 2500, 2000, 1500, 1000, 700]) {
      const xx = Math.round(L.x(f2)) + 0.5;
      ctx.beginPath(); ctx.moveTo(xx, L.top); ctx.lineTo(xx, H - L.bottom); ctx.stroke();
      ctx.fillText(f2 >= 1000 ? `${f2 / 1000}k` : f2, xx, H - L.bottom + 6);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const f1 of [250, 300, 400, 500, 600, 800, 1000]) {
      const yy = Math.round(L.y(f1)) + 0.5;
      ctx.beginPath(); ctx.moveTo(L.left, yy); ctx.lineTo(w - L.right, yy); ctx.stroke();
      ctx.fillText(f1, L.left - 6, yy);
    }
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('← F2 (Hz)   front · back', w - L.right, L.top - 8);
    ctx.textAlign = 'left';
    ctx.fillText('F1 (Hz) ↓ open', 4, L.top - 8);

    // reference vowels
    const drawRef = (key, color, shape) => {
      for (const v of VOWEL_REFERENCE) {
        const [f1, f2] = v[key];
        const xx = L.x(f2), yy = L.y(f1);
        ctx.fillStyle = color;
        ctx.strokeStyle = T.surface;
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (shape === 'square') ctx.rect(xx - 4.5, yy - 4.5, 9, 9);
        else ctx.arc(xx, yy, 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fill();
        ctx.fillStyle = T.ink2;
        ctx.font = `13px ${T.font}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(v.ipa, xx + 7, yy - 1);
        ctx.font = `11px ${T.font}`;
      }
    };
    if (this.showReference.lower) drawRef('lower', T.s2, 'square');
    if (this.showReference.higher) drawRef('higher', T.s3, 'circle');

    // trail
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.left, L.top, w - L.left - L.right, H - L.top - L.bottom);
    ctx.clip();
    const n = this.trail.length;
    const lastT = this.lastT ?? 0;
    for (let i = 0; i < n; i++) {
      const p = this.trail[i];
      const age = this.static ? 0 : lastT - p.t;
      if (age > 3) continue;
      const alpha = this.static ? 0.35 : Math.max(0.08, 1 - age / 3) * 0.6;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = T.s1;
      ctx.beginPath();
      ctx.arc(L.x(p.f2), L.y(p.f1), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const last = this.trail[n - 1];
    if (last && !this.static && (performance.now() - (this._lastPerf ?? 0) < 1e9)) {
      ctx.fillStyle = T.surface;
      ctx.beginPath();
      ctx.arc(L.x(last.f2), L.y(last.f1), 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = T.s1;
      ctx.beginPath();
      ctx.arc(L.x(last.f2), L.y(last.f1), 7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  hover(e) {
    if (!this.L) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    let best = null, bestD = 14;
    for (const v of VOWEL_REFERENCE) {
      for (const key of ['lower', 'higher']) {
        if (!this.showReference[key]) continue;
        const [f1, f2] = v[key];
        const d = Math.hypot(this.L.x(f2) - px, this.L.y(f1) - py);
        if (d < bestD) { bestD = d; best = { v, key, f1, f2 }; }
      }
    }
    if (best) {
      const label = best.key === 'lower' ? 'Lower-resonance average (adult men)' : 'Higher-resonance average (adult women)';
      this.showTooltip(px, py, `<b>[${best.v.ipa}]</b> as in “${best.v.word}”<br><span class="k">${label}</span><br>F1 ${best.f1} Hz · F2 ${best.f2} Hz`);
    } else {
      const f2 = this.L.x.invert(px), f1 = this.L.y.invert(py);
      if (px < this.L.left || py > this.h - this.L.bottom) return this.hideTooltip();
      this.showTooltip(px, py, `<span class="k">F1</span> ${f1.toFixed(0)} Hz · <span class="k">F2</span> ${f2.toFixed(0)} Hz`);
    }
  }
}

// ---------------------------------------------------------------------------
// Analysis view: waveform, pitch, spectrogram with formants, intensity; shared time axis.

export class AnalysisChart extends CanvasChart {
  constructor(container, { onSelect, onSeek } = {}) {
    super(container);
    this.data = null;
    this.samples = null;
    this.view = [0, 1];
    this.selection = null; // [t1, t2]
    this.cursor = null;
    this.playhead = null;
    this.show = { formants: true, pitch: true };
    this.target = null;
    this.showNotes = true;
    this.onSelect = onSelect;
    this.onSeek = onSeek;
    this.canvas.style.cursor = 'crosshair';
    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerup', (e) => this.up(e));
    this.canvas.addEventListener('pointerleave', () => { this.cursor = null; this.hideTooltip(); this.dirty = true; this.draw(); });
    this.canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
  }

  setData(data, samples) {
    this.data = data;
    this.samples = samples;
    this.view = [0, data.duration];
    this.selection = null;
    this.specImage = null;
    this.buildEnvelope();
    this.dirty = true;
    this.draw();
  }

  setView(t1, t2) {
    const d = this.data.duration;
    const minSpan = 0.05;
    if (t2 - t1 < minSpan) { const c = (t1 + t2) / 2; t1 = c - minSpan / 2; t2 = c + minSpan / 2; }
    if (t1 < 0) { t2 -= t1; t1 = 0; }
    if (t2 > d) { t1 -= t2 - d; t2 = d; }
    this.view = [Math.max(0, t1), Math.min(d, t2)];
    this.dirty = true;
    this.draw();
  }

  setPlayhead(t) {
    this.playhead = t;
    this.dirty = true;
    this.draw();
  }

  buildEnvelope() {
    // Peak envelope at 2 ms resolution, for fast waveform drawing at any zoom.
    const s = this.samples, sr = this.data.sampleRate;
    const block = Math.max(1, Math.round(sr * 0.002));
    const n = Math.ceil(s.length / block);
    const mn = new Float32Array(n), mx = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let lo = 1, hi = -1;
      for (let j = i * block, e = Math.min(s.length, j + block); j < e; j++) {
        const v = s[j];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      mn[i] = lo; mx[i] = hi;
    }
    let peak = 0.01;
    for (let i = 0; i < n; i++) peak = Math.max(peak, -mn[i], mx[i]);
    this.env = { mn, mx, block, sr, peak };
  }

  buildSpectrogramImage() {
    const sp = this.data.spectrogram;
    const T = theme();
    const img = new ImageData(sp.nt, sp.nf);
    const [r0, g0, b0] = T.specLo, [r1, g1, b1] = T.specHi;
    const range = 60;
    for (let it = 0; it < sp.nt; it++) {
      for (let jf = 0; jf < sp.nf; jf++) {
        const db = sp.db[it * sp.nf + jf];
        const v = Math.max(0, Math.min(1, (db + range) / range)) ** 1.2;
        const o = ((sp.nf - 1 - jf) * sp.nt + it) * 4;
        img.data[o] = r0 + (r1 - r0) * v;
        img.data[o + 1] = g0 + (g1 - g0) * v;
        img.data[o + 2] = b0 + (b1 - b0) * v;
        img.data[o + 3] = 255;
      }
    }
    const c = document.createElement('canvas');
    c.width = sp.nt;
    c.height = sp.nf;
    c.getContext('2d').putImageData(img, 0, 0);
    this.specImage = c;
    this.specThemeKey = T.specLo.join() + T.specHi.join();
  }

  panels() {
    const top = 6, bottom = 24, gap = 10;
    const avail = this.h - top - bottom - 3 * gap;
    const heights = { wave: 0.14, pitch: 0.3, spec: 0.42, intensity: 0.14 };
    let y = top;
    const out = {};
    for (const k of ['wave', 'pitch', 'spec', 'intensity']) {
      const ph = Math.round(avail * heights[k]);
      out[k] = { y0: y, y1: y + ph };
      y += ph + gap;
    }
    return out;
  }

  pitchRange() {
    const f0 = this.data.pitch.f0;
    let lo = Infinity, hi = -Infinity;
    for (const f of f0) if (Number.isFinite(f)) { lo = Math.min(lo, f); hi = Math.max(hi, f); }
    if (this.target) { lo = Math.min(lo, this.target.low); hi = Math.max(hi, this.target.high); }
    if (!Number.isFinite(lo)) { lo = 75; hi = 400; }
    return [Math.max(40, lo / 1.15), Math.min(1200, hi * 1.15)];
  }

  draw() {
    if (!this.dirty || !this.w) return;
    this.dirty = false;
    const { ctx, w, h: H } = this;
    ctx.clearRect(0, 0, w, H);
    if (!this.data) return;
    const T = theme();
    const d = this.data;
    const left = this.showNotes ? 78 : 58, right = 12;
    const x = linScale(this.view[0], this.view[1], left, w - right);
    const P = this.panels();
    this.layoutInfo = { left, right, x, P };
    ctx.font = `11px ${T.font}`;
    ctx.lineWidth = 1;

    const panelFrame = (p, label) => {
      ctx.fillStyle = T.surface2;
      ctx.fillRect(left, p.y0, w - left - right, p.y1 - p.y0);
      ctx.save();
      ctx.translate(8, (p.y0 + p.y1) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = T.muted;
      ctx.fillText(label, 0, 0);
      ctx.restore();
    };
    const clip = (p) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, p.y0, w - left - right, p.y1 - p.y0);
      ctx.clip();
    };

    // --- waveform
    {
      const p = P.wave;
      panelFrame(p, 'wave');
      clip(p);
      const env = this.env, mid = (p.y0 + p.y1) / 2, amp = (p.y1 - p.y0) / 2 / env.peak * 0.95;
      ctx.fillStyle = T.ink2;
      for (let px = left; px < w - right; px++) {
        const ta = x.invert(px), tb = x.invert(px + 1);
        const ia = Math.max(0, Math.floor(ta * env.sr / env.block)), ib = Math.min(env.mn.length, Math.ceil(tb * env.sr / env.block));
        let lo = 0, hi = 0;
        for (let i = ia; i < ib; i++) { if (env.mn[i] < lo) lo = env.mn[i]; if (env.mx[i] > hi) hi = env.mx[i]; }
        ctx.fillRect(px, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
      }
      ctx.restore();
    }

    // --- pitch
    const [plo, phi] = this.pitchRange();
    const py = logScale(plo, phi, P.pitch.y1 - 4, P.pitch.y0 + 4);
    {
      const p = P.pitch;
      panelFrame(p, 'pitch');
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const hz of hzTicks(plo, phi, Math.max(2, Math.floor((p.y1 - p.y0) / 26)))) {
        const yy = Math.round(py(hz)) + 0.5;
        ctx.strokeStyle = T.grid;
        ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(w - right, yy); ctx.stroke();
        ctx.fillStyle = T.muted;
        ctx.fillText(this.showNotes ? `${hz} ${noteName(hz)}` : `${hz}`, left - 6, yy);
      }
      clip(p);
      if (this.target) {
        const y1 = py(this.target.high), y2 = py(this.target.low);
        ctx.fillStyle = T.band;
        ctx.fillRect(left, y1, w - left - right, y2 - y1);
      }
      const pt = d.pitch;
      ctx.strokeStyle = T.s1;
      ctx.fillStyle = T.s1;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      const i0 = Math.max(0, Math.floor((this.view[0] - pt.t1) / pt.dt) - 1);
      const i1 = Math.min(pt.n - 1, Math.ceil((this.view[1] - pt.t1) / pt.dt) + 1);
      for (let i = i0; i <= i1; i++) {
        const f = pt.f0[i];
        if (!Number.isFinite(f)) { pen = false; continue; }
        const xx = x(pt.t1 + i * pt.dt), yy = py(f);
        if (pen) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy);
        pen = true;
      }
      ctx.stroke();
      // lone voiced frames as dots
      for (let i = i0; i <= i1; i++) {
        const f = pt.f0[i];
        if (Number.isFinite(f) && !Number.isFinite(pt.f0[i - 1]) && !Number.isFinite(pt.f0[i + 1])) {
          ctx.beginPath(); ctx.arc(x(pt.t1 + i * pt.dt), py(f), 2, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.restore();
    }

    // --- spectrogram + formants
    const sp = d.spectrogram;
    const fmax = sp.f1 + sp.df * (sp.nf - 0.5);
    const fy = linScale(0, fmax, P.spec.y1, P.spec.y0);
    {
      const p = P.spec;
      panelFrame(p, 'spectrogram');
      const T2 = theme();
      if (!this.specImage || this.specThemeKey !== T2.specLo.join() + T2.specHi.join()) this.buildSpectrogramImage();
      clip(p);
      const sx0 = (this.view[0] - (sp.t1 - sp.dt / 2)) / sp.dt;
      const sx1 = (this.view[1] - (sp.t1 - sp.dt / 2)) / sp.dt;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.specImage, sx0, 0, sx1 - sx0, sp.nf, left, p.y0, w - left - right, p.y1 - p.y0);
      if (this.show.formants) {
        const fm = d.formants;
        const colors = [T.s2, T.s3, T.s5];
        const i0 = Math.max(0, Math.floor((this.view[0] - fm.t1) / fm.dt));
        const i1 = Math.min(fm.n - 1, Math.ceil((this.view[1] - fm.t1) / fm.dt));
        const stride = Math.max(1, Math.floor((i1 - i0) / (w - left - right) * 2));
        for (let k = 0; k < 3; k++) {
          ctx.fillStyle = colors[k];
          for (let i = i0; i <= i1; i += stride) {
            // Only show formants where there is voicing, as Praat's Formant display does by default with "dot size".
            const f = fm.F[k][i];
            if (!Number.isFinite(f) || f > fmax) continue;
            const tt = fm.t1 + i * fm.dt;
            if (!this.voicedAt(tt)) continue;
            ctx.beginPath();
            ctx.arc(x(tt), fy(f), 1.8, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.restore();
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = T.muted;
      for (let f = 0; f <= fmax; f += 1000) {
        const yy = fy(f);
        if (yy < p.y0 + 4) continue;
        ctx.fillText(f === 0 ? '0' : `${f / 1000}k`, left - 6, Math.min(yy, p.y1 - 6));
      }
    }

    // --- intensity
    {
      const p = P.intensity;
      panelFrame(p, 'dB');
      const it = d.intensity;
      let lo = Infinity, hi = -Infinity;
      for (const v of it.values) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      if (!Number.isFinite(lo)) { lo = -60; hi = 0; }
      lo = Math.max(lo, hi - 50);
      const iy = linScale(lo, hi + 2, p.y1 - 3, p.y0 + 3);
      ctx.textAlign = 'right';
      ctx.fillStyle = T.muted;
      ctx.fillText(`${Math.round(hi)}`, left - 6, iy(hi));
      ctx.fillText(`${Math.round(lo)}`, left - 6, iy(lo));
      clip(p);
      ctx.strokeStyle = T.ink2;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < it.values.length; i++) {
        const t = it.t1 + i * it.dt;
        if (t < this.view[0] - it.dt || t > this.view[1] + it.dt) continue;
        const v = Math.max(lo, it.values[i]);
        if (!Number.isFinite(v)) { pen = false; continue; }
        if (pen) ctx.lineTo(x(t), iy(v)); else ctx.moveTo(x(t), iy(v));
        pen = true;
      }
      ctx.stroke();
      ctx.restore();
    }

    // --- time axis
    const span = this.view[1] - this.view[0];
    const step = niceStep(span, Math.max(2, Math.floor((w - left - right) / 90)));
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const yAxis = P.intensity.y1 + 6;
    for (let t = Math.ceil(this.view[0] / step) * step; t <= this.view[1] + 1e-9; t += step) {
      const xx = x(t);
      ctx.fillText(`${+t.toFixed(3)}s`, xx, yAxis);
    }

    // --- selection, cursor, playhead (across all panels)
    const yTop = P.wave.y0, yBot = P.intensity.y1;
    if (this.selection) {
      const [s1, s2] = this.selection;
      ctx.fillStyle = T.band;
      ctx.fillRect(x(s1), yTop, x(s2) - x(s1), yBot - yTop);
      ctx.strokeStyle = T.bandEdge;
      ctx.lineWidth = 1;
      for (const s of [s1, s2]) {
        ctx.beginPath(); ctx.moveTo(Math.round(x(s)) + 0.5, yTop); ctx.lineTo(Math.round(x(s)) + 0.5, yBot); ctx.stroke();
      }
    }
    if (this.playhead !== null && this.playhead >= this.view[0] && this.playhead <= this.view[1]) {
      ctx.strokeStyle = T.record;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x(this.playhead), yTop); ctx.lineTo(x(this.playhead), yBot); ctx.stroke();
    }
    if (this.cursor !== null) {
      ctx.strokeStyle = T.ink2;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      const xx = Math.round(x(this.cursor)) + 0.5;
      ctx.beginPath(); ctx.moveTo(xx, yTop); ctx.lineTo(xx, yBot); ctx.stroke();
      ctx.setLineDash([]);
    }
    this.scales = { x, py, fy };
  }

  voicedAt(t) {
    const pt = this.data.pitch;
    const i = Math.round((t - pt.t1) / pt.dt);
    return i >= 0 && i < pt.n && Number.isFinite(pt.f0[i]);
  }

  valuesAt(t) {
    const d = this.data;
    const at = (track, arr) => {
      const i = Math.round((t - track.t1) / track.dt);
      return i >= 0 && i < arr.length ? arr[i] : NaN;
    };
    return {
      f0: at(d.pitch, d.pitch.f0),
      F: [0, 1, 2, 3].map((k) => at(d.formants, d.formants.F[k])),
      db: at(d.intensity, d.intensity.values),
      hnr: at(d.harmonicity, d.harmonicity.values),
    };
  }

  timeAt(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const { x, left, right } = this.layoutInfo;
    return { t: Math.max(this.view[0], Math.min(this.view[1], x.invert(Math.max(left, Math.min(this.w - right, px))))), px, py: e.clientY - rect.top };
  }

  down(e) {
    if (!this.data) return;
    this.canvas.setPointerCapture(e.pointerId);
    const { t } = this.timeAt(e);
    this.dragStart = t;
    this.dragging = false;
  }

  move(e) {
    if (!this.data || !this.layoutInfo) return;
    const { t, px, py } = this.timeAt(e);
    this.cursor = t;
    if (this.dragStart !== undefined && this.dragStart !== null) {
      if (Math.abs(this.scales.x(t) - this.scales.x(this.dragStart)) > 4) this.dragging = true;
      if (this.dragging) this.selection = [Math.min(t, this.dragStart), Math.max(t, this.dragStart)];
    }
    const v = this.valuesAt(t);
    const T = theme();
    const fmt = (f) => (Number.isFinite(f) ? `${Math.round(f)} Hz` : '–');
    const pitchLine = Number.isFinite(v.f0) ? `<b>${v.f0.toFixed(0)} Hz</b> ${noteName(v.f0)}` : '<span class="k">unvoiced</span>';
    const fLines = Number.isFinite(v.f0)
      ? [0, 1, 2].map((k) => `<span class="sw" style="background:${[T.s2, T.s3, T.s5][k]}"></span><span class="k">F${k + 1}</span> ${fmt(v.F[k])}`).join('<br>')
      : '';
    this.showTooltip(px, py, `<span class="k">${t.toFixed(3)} s</span><br>${pitchLine}${fLines ? `<br>${fLines}` : ''}<br><span class="k">level</span> ${Number.isFinite(v.db) ? v.db.toFixed(0) : '–'} dB`);
    this.dirty = true;
    this.draw();
  }

  up(e) {
    if (!this.data) return;
    const { t } = this.timeAt(e);
    if (this.dragging && this.selection) {
      this.onSelect?.(this.selection);
    } else if (this.dragStart !== null && this.dragStart !== undefined) {
      this.selection = null;
      this.onSelect?.(null);
      this.onSeek?.(t);
    }
    this.dragStart = null;
    this.dragging = false;
    this.dirty = true;
    this.draw();
  }

  wheel(e) {
    if (!this.data) return;
    // Zoom with ctrl/⌘ + wheel or trackpad pinch; scroll sideways with shift + wheel or horizontal swipes.
    const { t } = this.timeAt(e);
    const span = this.view[1] - this.view[0];
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const f = Math.exp(e.deltaY * 0.01);
      const n1 = t - (t - this.view[0]) * f, n2 = t + (this.view[1] - t) * f;
      this.setView(n1, n2);
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      e.preventDefault();
      const dx = (e.shiftKey ? e.deltaY : e.deltaX) / (this.w - 70) * span;
      this.setView(this.view[0] + dx, this.view[1] + dx);
    }
  }
}

// ---------------------------------------------------------------------------
// Trend chart for progress over days.

export class TrendChart extends CanvasChart {
  constructor(container, { unit = '', format = (v) => v.toFixed(0), band = null, yMin = null, yMax = null, label = '' } = {}) {
    super(container);
    this.points = [];
    this.opts = { unit, format, band, yMin, yMax, label };
    this.canvas.addEventListener('pointermove', (e) => this.hover(e));
    this.canvas.addEventListener('pointerleave', () => { this.hideTooltip(); this.hi = null; this.dirty = true; this.draw(); });
  }

  setPoints(points, band) {
    this.points = points.filter((p) => Number.isFinite(p.value)).sort((a, b) => a.date - b.date);
    if (band !== undefined) this.opts.band = band;
    this.dirty = true;
    this.draw();
  }

  draw() {
    if (!this.dirty || !this.w) return;
    this.dirty = false;
    const { ctx, w, h: H } = this;
    const T = theme();
    ctx.clearRect(0, 0, w, H);
    ctx.font = `11px ${T.font}`;
    const left = 48, right = 14, top = 12, bottom = 26;
    if (this.points.length === 0) {
      ctx.fillStyle = T.muted;
      ctx.textAlign = 'center';
      ctx.fillText('No sessions yet', w / 2, H / 2);
      return;
    }
    const vals = this.points.map((p) => p.value);
    let lo = this.opts.yMin ?? Math.min(...vals), hi = this.opts.yMax ?? Math.max(...vals);
    if (this.opts.band && this.opts.yMin === null) { lo = Math.min(lo, this.opts.band[0]); hi = Math.max(hi, this.opts.band[1]); }
    const pad = this.opts.yMin === null ? Math.max((hi - lo) * 0.12, Math.abs(hi) * 0.04, 1) : 0;
    lo -= pad; hi += pad;
    const d0 = this.points[0].date, d1 = this.points[this.points.length - 1].date;
    // Centre the data; a short history gets at least an hour of room on either side.
    const half = Math.max((d1 - d0) * 0.54, 3600e3);
    const mid = (d0 + d1) / 2;
    const span = 2 * half;
    const x = linScale(mid - half, mid + half, left, w - right);
    const y = linScale(lo, hi, H - bottom, top);
    this.sc = { x, y };

    // grid
    const step = niceStep(hi - lo, Math.max(2, Math.floor((H - 40) / 40)));
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = T.grid;
      ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(w - right, yy); ctx.stroke();
      ctx.fillStyle = T.muted;
      ctx.fillText(this.opts.format(v), left - 6, yy);
    }
    if (this.opts.band) {
      const [b1, b2] = this.opts.band;
      ctx.fillStyle = T.band;
      ctx.fillRect(left, y(b2), w - left - right, y(b1) - y(b2));
    }
    // x labels: a few dates
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = T.muted;
    const nLabels = Math.max(2, Math.floor((w - left - right) / 90));
    const short = d1 - d0 < 1.5 * 864e5;
    let previous = '';
    for (let i = 0; i < nLabels; i++) {
      const t = mid - half + span * (i / (nLabels - 1));
      const text = short
        ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
      ctx.textAlign = i === 0 ? 'left' : i === nLabels - 1 ? 'right' : 'center';
      if (text !== previous) ctx.fillText(text, Math.max(left, Math.min(w - right, x(t))), H - bottom + 8);
      previous = text;
    }
    // line + dots
    ctx.strokeStyle = T.s1;
    ctx.lineWidth = 2;
    ctx.beginPath();
    this.points.forEach((p, i) => (i ? ctx.lineTo(x(p.date), y(p.value)) : ctx.moveTo(x(p.date), y(p.value))));
    ctx.stroke();
    for (const p of this.points) {
      const r = p === this.hi ? 6 : 4;
      ctx.fillStyle = T.surface;
      ctx.beginPath(); ctx.arc(x(p.date), y(p.value), r + 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = T.s1;
      ctx.beginPath(); ctx.arc(x(p.date), y(p.value), r, 0, Math.PI * 2); ctx.fill();
    }
  }

  hover(e) {
    if (!this.sc || !this.points.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    let best = null, bd = 30;
    for (const p of this.points) {
      const d = Math.abs(this.sc.x(p.date) - px);
      if (d < bd) { bd = d; best = p; }
    }
    this.hi = best;
    this.dirty = true;
    this.draw();
    if (!best) return this.hideTooltip();
    this.showTooltip(this.sc.x(best.date), this.sc.y(best.value), `<b>${this.opts.format(best.value)}${this.opts.unit}</b><br><span class="k">${best.label || ''}</span><br><span class="k">${new Date(best.date).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>`);
  }
}

// ---------------------------------------------------------------------------
// Range strip for settings: shows a target range on a logarithmic frequency axis.

export class RangeStrip extends CanvasChart {
  constructor(container) {
    super(container);
    this.range = [165, 255];
  }

  set(low, high) {
    this.range = [low, high];
    this.dirty = true;
    this.draw();
  }

  draw() {
    if (!this.dirty || !this.w) return;
    this.dirty = false;
    const { ctx, w, h: H } = this;
    const T = theme();
    ctx.clearRect(0, 0, w, H);
    ctx.font = `11px ${T.font}`;
    const x = logScale(60, 520, 8, w - 8);
    const yMid = 30;
    // piano-ish background of semitones
    for (let m = Math.ceil(hzToMidi(60)); m <= hzToMidi(520); m++) {
      const xx = x(440 * 2 ** ((m - 69) / 12));
      const black = [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
      ctx.fillStyle = black ? T.surface3 : T.grid;
      ctx.fillRect(xx - 0.5, yMid - 10, 1, 20);
    }
    const [lo, hi] = this.range;
    ctx.fillStyle = T.band;
    ctx.strokeStyle = T.s1;
    ctx.lineWidth = 2;
    roundRect(ctx, x(lo), yMid - 12, x(hi) - x(lo), 24, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const hz of [80, 100, 150, 200, 300, 400, 500]) ctx.fillText(`${hz}`, x(hz), yMid + 18);
    ctx.fillStyle = T.ink;
    ctx.textBaseline = 'bottom';
    ctx.font = `600 11px ${T.font}`;
    ctx.fillText(`${noteName(lo)}–${noteName(hi)}`, (x(lo) + x(hi)) / 2, yMid - 13);
  }
}
