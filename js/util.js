// Small shared helpers. No dependencies.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const nf0 = new Intl.NumberFormat('en-US');
export const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
export const pct1 = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
export const uid = () => Math.random().toString(36).slice(2, 10);
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export function mulberry32(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export const pad2 = n => String(n).padStart(2, '0');
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const DAY = 864e5;

export function isoDate(t, withTime) {
  const d = new Date(t);
  const s = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  return withTime ? `${s} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}` : s;
}
export function fmtDatePart(t, part) {
  if (t == null || Number.isNaN(t)) return 'Null';
  const d = new Date(t), y = d.getUTCFullYear(), m = d.getUTCMonth();
  switch (part) {
    case 'year': return String(y);
    case 'quarter': return `Q${Math.floor(m / 3) + 1} ${y}`;
    case 'month': return `${MONTHS[m]} ${y}`;
    case 'week': case 'day': return `${MONTHS[m]} ${d.getUTCDate()}, ${y}`;
    default: return isoDate(t, true);
  }
}
export function fmtNum(v) {
  if (v == null || Number.isNaN(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return nf2.format(v / 1e9) + 'B';
  if (a >= 1e6) return nf2.format(v / 1e6) + 'M';
  if (a >= 1e4) return nf2.format(v / 1e3) + 'K';
  return nf2.format(v);
}
export function niceStep(range, target = 20) {
  if (!(range > 0)) return 1;
  const raw = range / target, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
export function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

let toastTimer;
export function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}

// tiny event bus
const handlers = {};
export const on = (evt, fn) => { (handlers[evt] = handlers[evt] || []).push(fn); };
export const emit = (evt, ...a) => (handlers[evt] || []).forEach(fn => fn(...a));
