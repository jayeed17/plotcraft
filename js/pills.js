// Pills are the fields placed on shelves. Labels, roles, date parts, bins and colour folding live here.
import { MONTHS, DOW, DAY, nf2 } from './util.js';
import { field, col } from './store.js';

export const PARTS = {
  year: { name: 'Year', label: 'YEAR', cont: true, tu: 'utcyear', fmt: '%Y', sql: x => `date_trunc('year', ${x})`, f: t => Date.UTC(new Date(t).getUTCFullYear(), 0, 1) },
  quarter: { name: 'Quarter', label: 'QUARTER', cont: true, tu: 'utcyearquarter', fmt: 'Q%q %Y', sql: x => `date_trunc('quarter', ${x})`, f: t => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1); } },
  month: { name: 'Month', label: 'MONTH', cont: true, tu: 'utcyearmonth', fmt: '%b %Y', sql: x => `date_trunc('month', ${x})`, f: t => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); } },
  week: { name: 'Week', label: 'WEEK', cont: true, tu: 'utcyearmonthdate', fmt: '%b %d, %Y', sql: x => `date_trunc('week', ${x})`, f: t => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY; } },
  day: { name: 'Day', label: 'DAY', cont: true, tu: 'utcyearmonthdate', fmt: '%b %d, %Y', sql: x => `date_trunc('day', ${x})`, f: t => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); } },
  exact: { name: 'Exact date', label: '', cont: true, tu: null, fmt: '%b %d, %Y %H:%M', sql: x => x, f: t => t },
  monthname: { name: 'Month of year', label: 'MONTH_OF_YEAR', cont: false, order: MONTHS, sql: x => `month(${x})`, sqlNote: '1 = Jan … 12 = Dec', f: t => new Date(t).getUTCMonth(), out: k => MONTHS[k], back: v => MONTHS.indexOf(v) },
  weekday: { name: 'Day of week', label: 'WEEKDAY', cont: false, order: DOW, sql: x => `isodow(${x})`, sqlNote: '1 = Mon … 7 = Sun', f: t => (new Date(t).getUTCDay() + 6) % 7, out: k => DOW[k], back: v => DOW.indexOf(v) },
  hour: { name: 'Hour of day', label: 'HOUR', cont: false, sql: x => `hour(${x})`, f: t => new Date(t).getUTCHours(), out: k => k, back: v => v }
};
export const CONT_PARTS = ['year', 'quarter', 'month', 'week', 'day', 'exact'];
export const DISC_PARTS = ['monthname', 'weekday', 'hour'];
export const AGGS = {
  sum: { name: 'Sum', label: 'SUM', fn: 'SUM' }, avg: { name: 'Average', label: 'AVG', fn: 'AVG' },
  median: { name: 'Median', label: 'MEDIAN', fn: 'MEDIAN' }, min: { name: 'Minimum', label: 'MIN', fn: 'MIN' },
  max: { name: 'Maximum', label: 'MAX', fn: 'MAX' }, count: { name: 'Count', label: 'CNT', fn: 'COUNT' },
  countd: { name: 'Count distinct', label: 'CNTD', fn: 'COUNTD' }, calc: { name: 'As calculated', label: '', fn: null }
};
export const SHELF_NAMES = { cols: 'Columns', rows: 'Rows', color: 'Color', size: 'Size', label: 'Label', detail: 'Detail', filters: 'Filters' };
export const SINGLE = new Set(['color', 'size', 'label']);
export const MAX_COLORS = 8;

export function isAggCalc(f) { return !!(f && f.calc && f.calc.aggregate); }
export function defaultPart(f) {
  const c = col(f.name);
  const span = c.max - c.min;
  if (!Number.isFinite(span)) return 'year';
  if (span >= 3 * 365 * DAY) return 'year';
  if (span >= 62 * DAY) return 'month';
  return 'day';
}
export function defaultFilter(f) { return f.type === 'string' ? { type: 'set', include: null } : { type: 'range', min: null, max: null }; }
export function makePill(fname, shelf) {
  const f = field(fname);
  if (shelf === 'filters') return { field: fname, kind: 'filter', filter: defaultFilter(f) };
  if (f.type === 'records') return { field: fname, kind: 'measure', agg: 'count' };
  if (isAggCalc(f)) return { field: fname, kind: 'measure', agg: 'calc' };
  if (f.role === 'measure') return { field: fname, kind: 'measure', agg: 'sum' };
  if (f.type === 'date') return { field: fname, kind: 'dim', part: defaultPart(f), sort: null };
  return { field: fname, kind: 'dim', sort: null };
}
export function makeDim(fname) { const f = field(fname); return f.type === 'date' ? { field: fname, kind: 'dim', part: defaultPart(f), sort: null } : { field: fname, kind: 'dim', sort: null }; }

export function pillLabel(p) {
  if (p.kind === 'filter') return p.field;
  const f = field(p.field);
  if (p.kind === 'measure') {
    if (isAggCalc(f) || p.agg === 'calc') return p.field;
    return `${AGGS[p.agg].label}(${p.field})`;
  }
  if (f && f.type === 'date') return p.part === 'exact' ? p.field : `${PARTS[p.part].label}(${p.field})`;
  if (p.bin) return `${p.field} (bin ${nf2.format(p.bin)})`;
  return p.field;
}
export const isTemporal = p => { if (!p || p.kind !== 'dim') return false; const f = field(p.field); return !!(f && f.type === 'date' && PARTS[p.part].cont); };
export const isBinned = p => !!(p && p.kind === 'dim' && p.bin);
export function isCont(p) { if (!p) return false; return p.kind === 'measure' || isTemporal(p) || isBinned(p); }

export function colorFold(p) {
  if (!p || p.kind !== 'dim') return null;
  const c = col(p.field);
  if (!c || c.type !== 'string' || c.dict.length <= MAX_COLORS) return null;
  const order = [...c.dict.keys()].sort((a, b) => c.counts[b] - c.counts[a]);
  return new Set(order.slice(0, MAX_COLORS - 1));
}
export function aliasOf(p, shelf) {
  const base = pillLabel(p);
  if (shelf === 'color' && colorFold(p)) return base + ' (top 7)';
  return base;
}
export function colorDomain(p) {
  const c = col(p.field);
  const order = [...c.dict.keys()].sort((a, b) => c.counts[b] - c.counts[a]);
  const fold = colorFold(p);
  const labels = (fold ? order.filter(k => fold.has(k)) : order).map(k => c.dict[k]);
  if (fold) labels.push('Other');
  if (c.nulls) labels.push('Null');
  return labels;
}
export function filterSummary(p) {
  const f = p.filter, c = col(p.field);
  if (!c) return '';
  if (f.type === 'set') { const total = c.dict.length + (c.nulls ? 1 : 0); return f.include ? `${f.include.length} of ${total}` : 'all'; }
  if (f.type === 'match') return f.values.length === 1 ? String(f.label || f.values[0]) : `${f.values.length} values`;
  const fmt = v => c.type === 'date' ? new Date(v).toISOString().slice(0, 10) : nf2.format(v);
  if (f.min == null && f.max == null) return 'all';
  if (f.min != null && f.max != null) return `${fmt(f.min)} – ${fmt(f.max)}`;
  return f.min != null ? `≥ ${fmt(f.min)}` : `≤ ${fmt(f.max)}`;
}
