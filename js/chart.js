// Compiles a sheet + query result into a Vega-Lite spec. HTML visuals (matrix, KPI, gauge) live in visuals.js.
import { clamp, nf2 } from './util.js';
import { field, col } from './store.js';
import { PARTS, pillLabel, aliasOf, isCont, isTemporal, isBinned, colorDomain, MAX_COLORS } from './pills.js';

export const PAL = {
  light: {
    cat: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'], other: '#a3a29b',
    seq: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
    ord: ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281', '#0d366b'],
    div: ['#184f95', '#3987e5', '#9ec5f4', '#f0efec', '#f3b0af', '#e34948', '#a72e2e'], single: '#2a78d6', track: '#dce9fb'
  },
  dark: {
    cat: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'], other: '#6b6a64',
    seq: ['#104281', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'],
    ord: ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'],
    div: ['#9ec5f4', '#5598e7', '#1c5cab', '#383835', '#b13a3a', '#e66767', '#f4b9b8'], single: '#3987e5', track: '#1d3352'
  }
};
export const HTML_MARKS = new Set(['matrix', 'kpi', 'gauge']);
export const MARKS = [
  ['auto', 'Automatic'], ['bar', 'Bar'], ['line', 'Line'], ['area', 'Area'], ['circle', 'Circle'], ['square', 'Square / heatmap'],
  ['text', 'Text table'], ['tick', 'Tick'], ['pie', 'Pie'], ['donut', 'Donut'], ['treemap', 'Treemap'],
  ['matrix', 'Matrix with totals'], ['kpi', 'KPI card'], ['gauge', 'Gauge']
];

export function isDark() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}
export function theme() {
  const cs = getComputedStyle(document.documentElement);
  const v = k => cs.getPropertyValue(k).trim();
  const dark = isDark();
  return { dark, pal: dark ? PAL.dark : PAL.light, panel: v('--panel'), ink: v('--ink'), ink2: v('--ink-2'), muted: v('--muted'), grid: v('--grid'), axis: v('--axis'), font: getComputedStyle(document.body).fontFamily };
}
function vegaConfig(th) {
  const font = th.font;
  return {
    background: th.panel, padding: 6, font, view: { stroke: null },
    axis: { domainColor: th.axis, gridColor: th.grid, tickColor: th.axis, gridWidth: 1, domainWidth: 1, tickSize: 4, labelColor: th.ink2, titleColor: th.ink2, labelFont: font, titleFont: font, labelFontSize: 11, titleFontSize: 11.5, titleFontWeight: 600, labelPadding: 4, titlePadding: 8, labelOverlap: true },
    axisBand: { tickSize: 0 },
    header: { labelColor: th.ink, titleColor: th.ink2, labelFont: font, titleFont: font, labelFontSize: 11.5, labelFontWeight: 600, titleFontSize: 11.5, titleFontWeight: 600 },
    legend: { labelColor: th.ink2, titleColor: th.ink2, labelFont: font, titleFont: font, labelFontSize: 11.5, titleFontSize: 11.5, titleFontWeight: 600, symbolType: 'circle', symbolSize: 90, orient: 'right', labelLimit: 160, rowPadding: 5 },
    title: { color: th.ink, font },
    range: { category: th.pal.cat, ramp: th.pal.seq, diverging: th.pal.div, ordinal: th.pal.ord },
    line: { strokeWidth: 2, strokeCap: 'round', strokeJoin: 'round' }, point: { filled: true, size: 64 }, circle: { size: 64 },
    rect: { stroke: th.panel, strokeWidth: 2 }, text: { color: th.ink, font, fontSize: 11.5 }, tick: { thickness: 2 }, arc: { stroke: th.panel, strokeWidth: 2 },
    concat: { spacing: 22 }, facet: { spacing: 14 }
  };
}

const NUM_FMT = ',.12~g';
// Axis ticks are "nice" numbers, so 4 significant digits never collide; legends show raw extremes, so 3 keeps them short.
function axisNumberLabels(maxAbs, digits = 4) {
  const f = `',.${digits}~r'`;
  if (maxAbs >= 1e9) return `format(datum.value / 1e9, ${f}) + 'B'`;
  if (maxAbs >= 1e6) return `format(datum.value / 1e6, ${f}) + 'M'`;
  if (maxAbs >= 1e4) return `format(datum.value / 1e3, ${f}) + 'K'`;
  return null;
}
const nfCompact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 });

/* ---------- label text helpers ---------- */
let measureCtx = null;
function textWidth(str, th, size = 11, weight = 400) {
  if (!str) return 0;
  try {
    measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
    measureCtx.font = `${weight} ${size}px ${th.font}`;
    return Math.ceil(measureCtx.measureText(str).width);
  } catch (e) { return Math.ceil(str.length * size * 0.58); }
}
// full and short text for one label value
function labelTexts(p, v) {
  if (v == null || (typeof v === 'number' && Number.isNaN(v))) return ['', ''];
  if (p.kind === 'measure') return [nf2.format(v), nfCompact.format(v)];
  const t = labelOf(p, v); return [t, t];
}
function hexToRgb(hex) {
  const h = String(hex || '').trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(h) || /^#?([0-9a-f]{3})$/i.exec(h);
  if (!m) { const r = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(h); return r ? [+r[1], +r[2], +r[3]] : [128, 128, 128]; }
  let x = m[1]; if (x.length === 3) x = x.split('').map(c => c + c).join('');
  const n = parseInt(x, 16); return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function luminance(hex) {
  return hexToRgb(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
}
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// ink that reads on a filled mark: white, or near-black on light fills (yellow, light ramp steps)
// white unless near-black reads clearly better (white keeps a slight edge on mid-tone brand colours)
const inkOn = fill => { const cw = contrast(fill, '#ffffff'), cb = contrast(fill, '#0b0b0b'); return cw >= 4.5 || cw >= cb * 0.85 ? '#ffffff' : '#0b0b0b'; };
// per-row ink as a value condition: no scale, so it never touches the series legend
const inkEnc = f => ({ condition: { test: `datum[${JSON.stringify(f)}] === '#ffffff'`, value: '#ffffff' }, value: '#0b0b0b' });
// a series color nudged until text in it reads on the panel (WCAG 4.5:1)
function textSafe(hex, panel) {
  let [r, g, b] = hexToRgb(hex);
  const darkBg = luminance(panel) < 0.3;
  for (let i = 0; i < 12 && contrast('#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join(''), panel) < 4.5; i++) {
    if (darkBg) { r += (255 - r) * 0.18; g += (255 - g) * 0.18; b += (255 - b) * 0.18; } else { r *= 0.84; g *= 0.84; b *= 0.84; }
  }
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}
// d3/Vega's linear "nice": extend a domain to whole tick steps
function niceExtent(lo, hi, count) {
  for (let i = 0; i < 2; i++) {
    const step0 = (hi - lo) / count, p10 = Math.pow(10, Math.floor(Math.log10(step0))), err = step0 / p10;
    const step = p10 * (err >= Math.sqrt(50) ? 10 : err >= Math.sqrt(10) ? 5 : err >= Math.sqrt(2) ? 2 : 1);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  }
  return [lo, hi];
}
// pick full or short text for a whole set of labels at once, so one chart never mixes "9,492.69" with "19.1K"
function chooseTexts(p, a, rows, fits) {
  let nFull = 0, nShort = 0;
  for (const v of rows) { const [f, sh] = labelTexts(p, v[a]); if (f && fits(f, v)) nFull++; if (sh && fits(sh, v)) nShort++; }
  const useShort = nShort > nFull;
  return v => { const t = labelTexts(p, v[a])[useShort ? 1 : 0]; return t && fits(t, v) ? t : ''; };
}
// legend labels: each value gets its own unit (880, 11.1K), unlike axis ticks which share one
function legendNumberExpr() {
  const f = x => `format(${x}, ',.3~r')`;
  return `abs(datum.value) >= 1e9 ? ${f('datum.value / 1e9')} + 'B' : abs(datum.value) >= 1e6 ? ${f('datum.value / 1e6')} + 'M' : abs(datum.value) >= 1e4 ? ${f('datum.value / 1e3')} + 'K' : format(datum.value, ',.4~r')`;
}
// fill color a row gets from a color encoding (for picking label ink)
function fillResolver(ce, rows, th) {
  if (!ce || !ce.field) { const v = (ce && ce.value) || th.pal.single; return () => v; }
  if (ce.scale && ce.scale.domain && ce.type !== 'quantitative' && ce.type !== 'temporal') {
    const mp = new Map(ce.scale.domain.map((d, i) => [d, ce.scale.range[i % ce.scale.range.length]]));
    return r => mp.get(r[ce.field] === undefined ? null : r[ce.field]) || th.pal.other;
  }
  let mn = Infinity, mx = -Infinity;
  for (const r of rows) { const v = +r[ce.field]; if (r[ce.field] == null || Number.isNaN(v)) continue; if (v < mn) mn = v; if (v > mx) mx = v; }
  const ramp = (ce.scale && ce.scale.range) || th.pal.seq;
  if (ce.scale && ce.scale.domainMid === 0) {
    const ext = Math.max(Math.abs(mn), Math.abs(mx)) || 1;
    return r => ramp[Math.max(0, Math.min(ramp.length - 1, Math.round(((+r[ce.field] / ext) + 1) / 2 * (ramp.length - 1))))];
  }
  return r => ramp[Math.max(0, Math.min(ramp.length - 1, Math.floor(((+r[ce.field] - mn) / ((mx - mn) || 1)) * ramp.length)))];
}
// flat when names fit, slanted when slanting clears the neighbours, otherwise vertical (so no name is dropped)
function xLabelAngle(maxLen, step) {
  const w = Math.min(150, maxLen * 6.2);
  if (w <= step - 6) return 0;
  return step >= w * 0.77 + 8 ? -40 : -90;
}
export function splitShelf(list) {
  const cont = list.filter(isCont), disc = list.filter(p => !isCont(p));
  if (cont.length) return { axes: cont, facets: disc };
  if (disc.length) return { axes: [disc[disc.length - 1]], facets: disc.slice(0, -1) };
  return { axes: [], facets: [] };
}
export function labelOf(p, v) {
  if (v == null) return 'Null';
  if (isTemporal(p)) { const d = new Date(v); return PARTS[p.part].cont ? fmtTemporal(v, p.part) : String(v); }
  if (typeof v === 'number') return nf2.format(v);
  return String(v);
}
function fmtTemporal(v, part) {
  const d = new Date(v), M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (part === 'year') return String(d.getUTCFullYear());
  if (part === 'quarter') return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
  if (part === 'month') return `${M[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (part === 'week' || part === 'day') return `${M[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

export function autoMark(x, y, sh) {
  const xm = x && x.kind === 'measure', ym = y && y.kind === 'measure';
  const discDate = p => p && p.kind === 'dim' && field(p.field).type === 'date' && !PARTS[p.part].cont;
  if (x && y) {
    if (xm && ym) return 'circle';
    if ((isBinned(x) && ym) || (isBinned(y) && xm)) return 'bar';
    if (isTemporal(x) && ym) return 'line';
    if (isTemporal(y) && xm) return 'line';
    if (xm || ym) return discDate(x) || discDate(y) ? 'line' : 'bar';
    if (isCont(x) || isCont(y)) return 'circle';
    const colorP = sh.shelves.color[0];
    return colorP && colorP.kind === 'measure' ? 'square' : 'text';
  }
  const one = x || y;
  if (!one) return 'text';
  if (one.kind === 'measure') return 'bar';
  if (isCont(one)) return 'circle';
  return 'text';
}

function encPos(p, ch, other, mark, res, stepPx, lenPx, shelfOf) {
  const alias = aliasOf(p, shelfOf);
  if (p.kind === 'measure') {
    let maxAbs = 0;
    for (const r of res.rows) { const v = Math.abs(r[alias] || 0); if (v > maxAbs) maxAbs = v; }
    const labelExpr = axisNumberLabels(maxAbs);
    const e = { field: alias, type: 'quantitative', title: alias, axis: { grid: true, tickCount: clamp(Math.round((lenPx || 300) / (ch === 'y' ? 46 : 100)), 2, 8), ...(labelExpr ? { labelExpr } : { format: NUM_FMT }) } };
    if (mark === 'circle' || mark === 'line' || mark === 'tick') e.scale = { zero: false, nice: true };
    return e;
  }
  if (isBinned(p)) {
    return { field: alias, type: 'quantitative', bin: { binned: true, step: p.bin }, title: alias, axis: { grid: false, format: NUM_FMT, tickCount: clamp(Math.round((lenPx || 300) / 80), 3, 12) } };
  }
  if (isTemporal(p)) {
    const part = PARTS[p.part];
    const e = { field: alias, type: 'temporal', title: alias, axis: { grid: false, format: part.fmt, labelOverlap: true, tickCount: clamp(Math.round((lenPx || 600) / (ch === 'y' ? 40 : 110)), 2, 10) } };
    if (part.tu) e.timeUnit = part.tu; else e.scale = { type: 'utc' };
    return e;
  }
  const c = col(p.field);
  const e = { field: alias, type: c.type === 'string' ? 'nominal' : 'ordinal', title: alias, axis: { grid: false, ticks: false, labelLimit: 150, labelPadding: 6, labelExpr: "datum.value === null ? 'Null' : datum.label" } };
  const otherCh = ch === 'x' ? 'y' : 'x';
  if (p.sort && other && other.kind === 'measure') {
    const oa = aliasOf(other, otherCh === 'x' ? 'cols' : 'rows'), tot = new Map();
    for (const r of res.rows) tot.set(r[alias], (tot.get(r[alias]) || 0) + (r[oa] || 0));
    e.sort = [...tot.keys()].sort((a, b) => p.sort === 'desc' ? tot.get(b) - tot.get(a) : tot.get(a) - tot.get(b));
  } else if (c.type === 'date' && PARTS[p.part].order) e.sort = PARTS[p.part].order;
  else e.sort = 'ascending';
  if (ch === 'x') {
    let maxLen = 0;
    for (const r of res.rows) { const s = String(r[alias] ?? 'Null'); if (s.length > maxLen) maxLen = s.length; }
    e.axis.labelAngle = xLabelAngle(maxLen, stepPx || 40);
    if (mark === 'text') { e.axis.orient = 'top'; e.axis.domain = false; }
  }
  return e;
}

export function encColor(p, res, th) {
  const alias = aliasOf(p, 'color');
  if (p.kind === 'measure' || isTemporal(p) || isBinned(p)) {
    const e = { field: alias, type: isTemporal(p) ? 'temporal' : 'quantitative', title: alias };
    if (isTemporal(p)) {
      // values arrive already truncated to the date part, so a plain UTC scale over the real first..last value
      // (a timeUnit here would stretch the legend to the end of the last period, e.g. "Jan 2026")
      const part = PARTS[p.part];
      let lo = Infinity, hi = -Infinity;
      for (const r of res.rows) { const v = r[alias]; if (v == null) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
      e.scale = { type: 'utc', range: th.pal.seq, nice: false };
      const dt = t => { const d = new Date(t); return { utc: true, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, date: d.getUTCDate(), hours: d.getUTCHours(), minutes: d.getUTCMinutes(), seconds: d.getUTCSeconds() }; };
      if (lo <= hi) e.scale.domain = [dt(lo), dt(hi === lo ? lo + 1000 : hi)];
      e.legend = { labelExpr: `utcFormat(datum.value, ${JSON.stringify(part.fmt)})`, gradientLength: 140 };
      return e;
    }
    let mn = Infinity, mx = -Infinity;
    for (const r of res.rows) { const v = r[alias]; if (v == null) continue; if (v < mn) mn = v; if (v > mx) mx = v; }
    e.scale = (mn < 0 && mx > 0) ? { domainMid: 0, range: th.pal.div } : { range: th.pal.seq };
    e.legend = { labelExpr: legendNumberExpr(), gradientLength: 140 };
    return e;
  }
  const c = col(p.field);
  const present = new Set(res.rows.map(r => r[alias] == null ? 'Null' : r[alias]));
  if (c.type === 'string') {
    const dom = colorDomain(p), colorFor = {};
    let slot = 0;
    for (const v of dom) colorFor[v] = (v === 'Other' || v === 'Null') ? th.pal.other : th.pal.cat[slot++ % th.pal.cat.length];
    const domain = dom.filter(v => present.has(v));
    return { field: alias, type: 'nominal', title: alias, scale: { domain: domain.map(v => v === 'Null' ? null : v), range: domain.map(v => colorFor[v]) }, legend: { labelExpr: "datum.value === null ? 'Null' : datum.label" } };
  }
  const order = c.type === 'date' && PARTS[p.part].order ? PARTS[p.part].order.filter(v => present.has(v)) : [...present].filter(v => v !== 'Null').sort((a, b) => a - b);
  if (order.length <= MAX_COLORS) return { field: alias, type: 'ordinal', title: alias, scale: { domain: order, range: th.pal.cat.slice(0, order.length) } };
  return { field: alias, type: 'ordinal', title: alias, scale: { domain: order, range: th.pal.ord } };
}
// Vega-Lite formats dates in local time whenever a format string is given, so a UTC month shows as the month
// before for anyone west of Greenwich. Tooltips and text get a pre-formatted UTC string twin of each date field.
const dateKey = a => '\u00b7' + a;
function addDateStrings(rows, plan) {
  const ds = plan.dims.filter(d => isTemporal(d.p));
  if (!ds.length) return rows;
  for (const r of rows) for (const d of ds) r[dateKey(d.alias)] = r[d.alias] == null ? 'Null' : fmtTemporal(r[d.alias], d.p.part);
  return rows;
}
export function tooltipEnc(res) {
  const out = [];
  for (const d of res.plan.dims) {
    if (isTemporal(d.p)) { out.push({ field: dateKey(d.alias), type: 'nominal', title: d.alias }); continue; }
    else out.push({ field: d.alias, type: col(d.p.field).type === 'string' ? 'nominal' : 'ordinal', title: d.alias, ...(col(d.p.field).type === 'number' ? { format: NUM_FMT } : {}) });
  }
  for (const m of res.plan.measures) out.push({ field: m.alias, type: 'quantitative', title: m.alias, format: ',.2~f' });
  return out;
}
function textEnc(p) {
  const a = aliasOf(p, 'label');
  if (p.kind === 'measure') return { field: a, type: 'quantitative', format: ',.2~f' };
  if (isTemporal(p)) return { field: dateKey(a), type: 'nominal' };
  return { field: a, type: 'nominal' };
}
function highlightEnc(hl) {
  if (!hl || !hl.length) return null;
  const test = hl.map(h => `datum[${JSON.stringify(h.alias)}] === ${JSON.stringify(h.value)}`).join(' && ');
  return { condition: { test, value: 1 }, value: 0.22 };
}
const wrap = (body, values, th) => Object.assign({ $schema: 'https://vega.github.io/schema/vega-lite/v5.json', data: { values }, config: vegaConfig(th), autosize: { type: 'pad' } }, body);

/* ---------- pie / donut ---------- */
function compilePie(sh, res, W, H, th, donut, opts) {
  const S = sh.shelves, colorP = S.color[0];
  const m = (S.size[0] && S.size[0].kind === 'measure' && S.size[0]) || res.plan.measures[0] && res.plan.measures[0].p;
  if (!colorP || colorP.kind === 'measure') return { hint: 'A pie needs a dimension on Color for its slices.' };
  if (!m) return { hint: 'Put a measure on Size (or Rows) to size the slices.' };
  const ma = res.plan.measures.find(x => x.p === m)?.alias || pillLabel(m);
  const ca = aliasOf(colorP, 'color');
  const r = Math.min(200, Math.max(60, (W < 560 ? Math.min(W - 20, H - 90) : Math.min(W - 200, H)) / 2 - 10));
  const values = addDateStrings(res.rows.filter(v => v[ma] > 0).map(v => Object.assign({}, v)), res.plan);
  const enc = { theta: { field: ma, type: 'quantitative', stack: true }, color: encColor(colorP, { rows: values, plan: res.plan }, th), order: { field: ma, type: 'quantitative', sort: 'descending' }, tooltip: tooltipEnc(res) };
  const hl = highlightEnc(opts.highlight); if (hl) enc.opacity = hl;
  const narrowPie = W < 560;
  const arc = { mark: { type: 'arc', innerRadius: donut ? r * 0.58 : 0, outerRadius: r, stroke: th.panel, strokeWidth: 2 }, encoding: enc };
  const labelP = S.label[0];
  let body = Object.assign({ width: r * 2, height: r * 2 }, arc);
  if (labelP) {
    // labels sit in the slice; slices too thin for their text stay unlabelled (the tooltip still has the number)
    const la = aliasOf(labelP, 'label'), total = values.reduce((t, v) => t + v[ma], 0) || 1;
    const fillOf = fillResolver(enc.color, values, th);
    const ringR = donut ? r * 0.79 : r * 0.64, ringW = donut ? r * 0.42 : r * 0.72;
    const fits = (t, v) => { const arcLen = (v[ma] / total) * 2 * Math.PI * ringR; return textWidth(t, th, 11.5, 650) + 8 <= Math.min(arcLen, ringW * 1.6) && arcLen >= 15; };
    const textOf = chooseTexts(labelP, la, values, fits);
    for (const v of values) { v.__lb = textOf(v); v.__tc = inkOn(fillOf(v)); }
    const tEnc = { theta: { field: ma, type: 'quantitative', stack: true }, order: enc.order, text: { field: '__lb' }, color: inkEnc('__tc'), tooltip: enc.tooltip };
    if (hl) tEnc.opacity = hl;
    body = { width: r * 2, height: r * 2, layer: [arc, { mark: { type: 'text', radius: ringR, fontSize: 11.5, fontWeight: 650 }, encoding: tEnc }] };
  }
  const pieSpec = wrap(body, values, th);
  if (narrowPie) Object.assign(pieSpec.config.legend, { orient: 'bottom', direction: 'horizontal', columns: 2 });
  return pieSpec;
}

/* ---------- treemap (squarified) ---------- */
function squarify(items, x, y, w, h) {
  const out = [];
  const total = items.reduce((s, it) => s + it.v, 0);
  if (!total) return out;
  const scale = (w * h) / total;
  const nodes = items.map(it => ({ ...it, a: it.v * scale })).sort((a, b) => b.a - a.a);
  let rect = { x, y, w, h };
  let row = [];
  const worst = (r, side) => { const s = r.reduce((t, n) => t + n.a, 0); const mx = Math.max(...r.map(n => n.a)), mn = Math.min(...r.map(n => n.a)); return Math.max(side * side * mx / (s * s), (s * s) / (side * side * mn)); };
  const layoutRow = (r) => {
    const s = r.reduce((t, n) => t + n.a, 0);
    if (rect.w >= rect.h) { const cw = s / rect.h; let cy = rect.y; for (const n of r) { const ch = n.a / cw; out.push({ ...n, x0: rect.x, x1: rect.x + cw, y0: cy, y1: cy + ch }); cy += ch; } rect = { x: rect.x + cw, y: rect.y, w: rect.w - cw, h: rect.h }; }
    else { const ch = s / rect.w; let cx = rect.x; for (const n of r) { const cw = n.a / ch; out.push({ ...n, x0: cx, x1: cx + cw, y0: rect.y, y1: rect.y + ch }); cx += cw; } rect = { x: rect.x, y: rect.y + ch, w: rect.w, h: rect.h - ch }; }
  };
  for (const n of nodes) {
    const side = Math.min(rect.w, rect.h);
    if (!row.length || worst([...row, n], side) <= worst(row, side)) row.push(n);
    else { layoutRow(row); row = [n]; }
  }
  if (row.length) layoutRow(row);
  return out;
}
function compileTreemap(sh, res, W, H, th, opts) {
  const S = sh.shelves;
  const m = (S.size[0] && S.size[0].kind === 'measure' && S.size[0]) || res.plan.measures[0] && res.plan.measures[0].p;
  if (!m) return { hint: 'Put a measure on Size to size the boxes.' };
  const ma = res.plan.measures.find(x => x.p === m)?.alias;
  const dims = res.plan.dims;
  if (!dims.length) return { hint: 'Put a dimension on Color, Detail or Rows to split the boxes.' };
  const colorP = S.color[0];
  const w = Math.max(200, W - (colorP ? 180 : 0)), h = Math.max(160, H - 10);
  const items = res.rows.filter(r => r[ma] > 0).map(r => ({ v: r[ma], row: r }));
  const labelP = S.label[0], la = labelP ? aliasOf(labelP, 'label') : null;
  const vp = labelP || { kind: 'measure' }, va = labelP ? la : ma;
  const boxes = squarify(items, 0, 0, w, h);
  const valueOf = chooseTexts(vp, va, boxes.map(n => Object.assign({ __w: n.x1 - n.x0, __h: n.y1 - n.y0 }, n.row)), (t, r) => r.__h > 38 && r.__w >= textWidth(t, th, 11.5) + 14);
  const laid = boxes.map(n => {
    const seen = new Set();
    const label = dims.filter(d => d.shelf !== 'label' && !seen.has(d.alias) && seen.add(d.alias)).map(d => labelOf(d.p, n.row[d.alias])).join(' · ');
    const bw = n.x1 - n.x0, bh = n.y1 - n.y0;
    const fits = bw >= textWidth(label, th, 12, 650) + 14 && bh > 22;
    const value = valueOf(Object.assign({ __w: bw, __h: bh }, n.row));
    return { ...n.row, __x0: n.x0, __x1: n.x1, __y0: n.y0, __y1: n.y1, __label: fits ? label : '', __value: value };
  });
  addDateStrings(laid, res.plan);
  const enc = {
    x: { field: '__x0', type: 'quantitative', scale: { domain: [0, w] }, axis: null }, x2: { field: '__x1' },
    y: { field: '__y0', type: 'quantitative', scale: { domain: [0, h], reverse: true }, axis: null }, y2: { field: '__y1' },
    tooltip: tooltipEnc(res)
  };
  if (colorP) enc.color = encColor(colorP, { rows: laid, plan: res.plan }, th); else enc.color = { value: th.pal.single };
  const hl = highlightEnc(opts.highlight); if (hl) enc.opacity = hl;
  // label ink by the fill behind it: white, except near-black on light fills (yellow, light ramp steps)
  const fillOf = fillResolver(enc.color, laid, th);
  for (const r of laid) r.__tc = inkOn(fillOf(r));
  const tc = inkEnc('__tc');
  return wrap({
    width: w, height: h,
    layer: [
      { mark: { type: 'rect', stroke: th.panel, strokeWidth: 2, cornerRadius: 3 }, encoding: enc },
      { mark: { type: 'text', align: 'left', baseline: 'top', dx: 7, dy: 6, fontWeight: 650, fontSize: 12 }, encoding: { x: enc.x, y: enc.y, text: { field: '__label' }, color: tc } },
      { mark: { type: 'text', align: 'left', baseline: 'top', dx: 7, dy: 22, fontSize: 11.5, opacity: 0.9 }, encoding: { x: enc.x, y: enc.y, text: { field: '__value' }, color: tc } }
    ]
  }, laid, th);
}

/* ---------- main compiler ---------- */
export function compileSpec(sh, res, W, H, th, opts = {}) {
  const S = sh.shelves;
  if (sh.mark === 'pie' || sh.mark === 'donut') return compilePie(sh, res, W, H, th, sh.mark === 'donut', opts);
  if (sh.mark === 'treemap') return compileTreemap(sh, res, W, H, th, opts);
  const C = splitShelf(S.cols), R = splitShelf(S.rows);
  const colorP = S.color[0], sizeP = S.size[0], labelP = S.label[0];
  if (!C.axes.length && !R.axes.length) return null;
  const compact = !!opts.compact;

  const fcLabel = C.facets.map(pillLabel).join(' · '), frLabel = R.facets.map(pillLabel).join(' · ');
  const values = res.rows.map(r => {
    const o = Object.assign({}, r);
    if (C.facets.length) o.__fc = C.facets.map(p => labelOf(p, r[aliasOf(p, 'cols')])).join(' · ');
    if (R.facets.length) o.__fr = R.facets.map(p => labelOf(p, r[aliasOf(p, 'rows')])).join(' · ');
    for (const [list, sh2] of [[S.cols, 'cols'], [S.rows, 'rows']]) for (const p of list) if (isBinned(p)) { const a = aliasOf(p, sh2); o[a + ' end'] = r[a] == null ? null : r[a] + p.bin; }
    return o;
  });
  addDateStrings(values, res.plan);
  const uniq = k => { const s = [], seen = new Set(); for (const v of values) if (!seen.has(v[k])) { seen.add(v[k]); s.push(v[k]); } return s; };
  const fcVals = C.facets.length ? uniq('__fc') : [null], frVals = R.facets.length ? uniq('__fr') : [null];
  const xs = C.axes.length ? C.axes : [null], ys = R.axes.length ? R.axes : [null];
  const hasLegend = !!(colorP || (sizeP && sizeP !== labelP));
  const narrow = W < 560;
  let yAxisW = 70;
  for (const y of ys) {
    if (!y || isCont(y)) continue;
    const a = aliasOf(y, 'rows'); let maxLen = 0;
    for (const v of values) maxLen = Math.max(maxLen, String(v[a] ?? 'Null').length);
    yAxisW = Math.max(yAxisW, Math.min(150, maxLen * 6.2) + 34);
  }
  const legendW = hasLegend && !narrow ? 170 : 0, facetHead = 26;
  const nCols = xs.length * fcVals.length, nRows = ys.length * frVals.length;
  const unitW = Math.max(compact ? 90 : 110, (W - legendW - yAxisW * xs.length - 16 * (nCols - 1) - (R.facets.length ? 90 : 0)) / nCols);
  // room under each row of charts for the x axis; slanted category labels need more
  let xLabelExtra = 0;
  for (const x of xs) {
    if (!x || isCont(x)) continue;
    const a = aliasOf(x, 'cols'); let n = 0, maxLen = 0; const seen = new Set();
    for (const v of values) { const k = v[a]; if (!seen.has(k)) { seen.add(k); n++; maxLen = Math.max(maxLen, String(k ?? 'Null').length); } }
    const step = clamp(Math.floor(unitW / (n || 1)), compact ? 12 : 18, 200);
    const ang = xLabelAngle(maxLen, step), w = Math.min(150, maxLen * 6.2);
    if (ang) xLabelExtra = Math.max(xLabelExtra, (ang === -90 ? w : w * 0.64 + 8) - 14);
  }
  const xAxisH = 64 + xLabelExtra + (hasLegend && narrow ? 70 : 0);
  const unitH = Math.max(compact ? 70 : 90, (H - xAxisH * ys.length - (C.facets.length ? facetHead : 0) - 16 * (nRows - 1)) / nRows);
  const tip = tooltipEnc(res);
  const hl = highlightEnc(opts.highlight);

  // dimensions that split marks beyond the axes and facets (colour, detail, label, size)
  const dimKey = p => `${p.field}|${p.part || ''}|${p.bin || ''}`;
  const axisKeys = new Set([...S.cols, ...S.rows].filter(p => p.kind !== 'measure').map(dimKey));
  const extras = [];
  { const seen = new Set(); for (const d of res.plan.dims) if (d.shelf !== 'cols' && d.shelf !== 'rows' && !axisKeys.has(dimKey(d.p)) && !seen.has(d.alias)) { seen.add(d.alias); extras.push(d); } }
  const colorAlias = colorP ? aliasOf(colorP, 'color') : null;
  const labelA = labelP ? aliasOf(labelP, 'label') : null;
  let unitNo = 0;

  const unit = (x, y) => {
    const u = unitNo++;
    let mark = sh.mark === 'auto' || HTML_MARKS.has(sh.mark) ? autoMark(x, y, sh) : sh.mark;
    if (sh.mark === 'auto' && mark === 'line') {
      const tp = isTemporal(x) ? x : isTemporal(y) ? y : null;
      if (tp && new Set(values.map(v => v[aliasOf(tp, tp === x ? 'cols' : 'rows')])).size < 3) mark = 'bar';
    }
    const xA = x ? aliasOf(x, 'cols') : null, yA = y ? aliasOf(y, 'rows') : null;
    const xm = !!(x && x.kind === 'measure'), ym = !!(y && y.kind === 'measure');
    const nx = x && !isCont(x) ? new Set(values.map(v => v[xA])).size : 0;
    const ny = y && !isCont(y) ? new Set(values.map(v => v[yA])).size : 0;
    let stepX = nx ? clamp(Math.floor(unitW / nx), compact ? 12 : 18, 200) : 0;
    let stepY = ny ? clamp(Math.floor(unitH / ny), compact ? 9 : 20, 56) : 0;
    const enc = {};
    if (x) { enc.x = encPos(x, 'x', y, mark, res, stepX, unitW, 'cols'); if (isBinned(x)) enc.x2 = { field: xA + ' end' }; }
    if (y) { enc.y = encPos(y, 'y', x, mark, res, stepY, unitH, 'rows'); if (isBinned(y)) enc.y2 = { field: yA + ' end' }; }
    const colorMeasure = !!(colorP && (colorP.kind === 'measure' || isTemporal(colorP) || isBinned(colorP)));
    if (colorP) enc.color = encColor(colorP, res, th);
    else if (mark !== 'text') enc.color = { value: th.pal.single };
    // every extra dimension that is not the colour still has to split series/segments
    const det = extras.filter(d => d.alias !== colorAlias).map(d => ({ field: d.alias, type: isTemporal(d.p) ? 'temporal' : 'nominal' }));
    if (det.length) enc.detail = det;
    if (sizeP && ['circle', 'square', 'text', 'tick'].includes(mark)) {
      const sa = aliasOf(sizeP, 'size');
      enc.size = sizeP.kind === 'measure' ? { field: sa, type: 'quantitative', title: sa, scale: { range: mark === 'text' ? [9, 22] : [24, 640] } } : { field: sa, type: 'ordinal', title: sa };
    }
    enc.tooltip = tip;
    if (hl) enc.opacity = hl;

    let m;
    const binnedAxis = isBinned(x) || isBinned(y);
    const stacked = (mark === 'bar' || mark === 'area') && xm !== ym && extras.length > 0;
    const vertical = ym && !xm;
    const vA = vertical ? yA : xA, cA = vertical ? xA : yA, cP = vertical ? x : y;
    const cap = stacked && labelP ? 56 : 24;
    const thick = step => Math.max(2, Math.min(cap, Math.floor(step * 0.72)));
    let lineQuantColor = false;
    switch (mark) {
      case 'bar': {
        if (x && y && !xm && !ym) { m = { type: 'rect', stroke: th.panel, strokeWidth: 2, cornerRadius: 2 }; mark = 'square'; break; } // bars need a measure; two category axes make a grid of cells
        if (binnedAxis) { m = { type: 'bar', orient: isBinned(x) ? 'vertical' : 'horizontal', binSpacing: 2 }; if (stacked) Object.assign(m, { stroke: th.panel, strokeWidth: 1 }); break; }
        m = { type: 'bar', cornerRadiusEnd: stacked ? 1 : 4 };
        if (stacked) Object.assign(m, { stroke: th.panel, strokeWidth: 2 });
        if (vertical && x) {
          if (nx) m.width = thick(stepX);
          else if (isTemporal(x)) { const n = new Set(values.map(v => v[xA])).size || 1; m.width = Math.max(2, Math.min(cap, Math.floor(unitW / n * 0.72))); }
        } else if (y && !vertical) {
          if (ny) m.height = thick(stepY);
          else if (isTemporal(y)) { const n = new Set(values.map(v => v[yA])).size || 1; m.height = Math.max(2, Math.min(cap, Math.floor(unitH / n * 0.72))); }
        }
        if (!vertical && !y) m.height = 22;
        if (vertical && !x) m.width = 24;
        break;
      }
      case 'line': {
        const series = new Set(values.map(v => (colorP && !colorMeasure ? v[colorAlias] : '') + '|' + det.map(d => v[d.field]).join('|') + '|' + (v.__fc || '') + '|' + (v.__fr || ''))).size || 1;
        m = { type: 'line', strokeWidth: 2 };
        if (colorMeasure && colorP.kind === 'measure') { lineQuantColor = true; m.color = th.pal.single; }
        else if (values.length / series <= 32) m.point = { filled: true, size: 56, stroke: th.panel, strokeWidth: 2 };
        if (isTemporal(y) && !isTemporal(x)) enc.order = { field: yA, type: 'temporal' };
        break;
      }
      case 'area': m = { type: 'area', fillOpacity: stacked ? 0.55 : 0.12, line: { strokeWidth: stacked ? 1.5 : 2 } }; break;
      case 'circle': { const many = values.length > 900; m = { type: 'circle', opacity: many ? 0.62 : 0.9, stroke: th.panel, strokeWidth: many ? 0.6 : 1.5 }; if (!sizeP) m.size = many ? 34 : 70; break; }
      case 'square':
        m = { type: 'rect', stroke: th.panel, strokeWidth: 2, cornerRadius: 2 };
        if ((x && isCont(x)) || (y && isCont(y))) m = { type: 'square', size: 120, stroke: th.panel, strokeWidth: 1 };
        break;
      case 'tick': m = { type: 'tick', thickness: 2 }; break;
      default:
        m = { type: 'text', fontSize: 12 };
        delete enc.color;
        if (colorP) {
          enc.color = encColor(colorP, res, th);
          // text in a series colour must still read on the background
          if (enc.color.scale && enc.color.scale.range) enc.color.scale.range = enc.color.scale.range.map(c => textSafe(c, th.panel));
        }
        enc.text = labelP ? textEnc(labelP) : { value: 'Abc' };
        mark = 'text';
    }
    for (const ch of ['x', 'y']) if (enc[ch] && enc[ch].type === 'quantitative' && !stacked && mark !== 'bar' && mark !== 'area') enc[ch].stack = null;

    // binned axes: bars and cells span bin start..end; every other mark (and every label) sits at the bin centre
    const binCenter = {};
    for (const [ch, p, a] of [['x', x, xA], ['y', y, yA]]) {
      if (!isBinned(p)) continue;
      const f = `__bin_${ch}${u}`;
      for (const v of values) v[f] = v[a] == null ? null : v[a] + p.bin / 2;
      binCenter[ch] = { field: f, type: 'quantitative', title: enc[ch].title, axis: enc[ch].axis };
      if (!(m.type === 'bar' || m.type === 'rect')) { enc[ch] = binCenter[ch]; delete enc[ch + '2']; }
    }
    // labels sit where their mark sits: bin centre, or the middle of a bar's time period
    const textPos = ch => binCenter[ch] || (m.type === 'bar' && enc[ch] && enc[ch].timeUnit ? Object.assign({}, enc[ch], { bandPosition: 0.5 }) : enc[ch]);

    // a table cell holding several rows (extra fields on Label/Detail/Colour): one line per row instead of a pile
    const cellish = (m.type === 'text' || m.type === 'rect' || (m.type === 'bar' && !xm && !ym)) && (x || y) && (!x || !isCont(x)) && (!y || !isCont(y)) && extras.length;
    const offsetEnc = {}, subStep = {};
    if (cellish) {
      const kF = '__k' + u, by = new Map();
      // sub-rows follow the legend order, then the other fields
      const cd = enc.color && enc.color.scale && enc.color.scale.domain && !colorMeasure ? new Map(enc.color.scale.domain.map((d, i) => [d, i])) : null;
      const keyOf = v => [cd ? String(cd.has(v[colorAlias] ?? null) ? cd.get(v[colorAlias] ?? null) : 999).padStart(4, '0') : '', ...det.map(d => String(v[d.field]))].join('\u0001');
      for (const v of values) { const k = [v.__fc || '', v.__fr || '', xA ? v[xA] : '', yA ? v[yA] : ''].join('\u0001'); if (!by.has(k)) by.set(k, []); by.get(k).push(v); }
      let most = 0;
      for (const g of by.values()) { g.sort((a, b) => keyOf(a).localeCompare(keyOf(b))); g.forEach((v, i) => { v[kF] = i; }); most = Math.max(most, g.length); }
      if (most > 1) {
        // with an offset channel, Vega-Lite's width/height "step" is the size of one sub-row
        // text needs every line legible (the table grows instead); filled cells cap their height and drop labels that can't fit
        if (y) { offsetEnc.yOffset = { field: kF, type: 'ordinal' }; enc.y.scale = Object.assign({}, enc.y.scale, { type: 'band' }); stepY = Math.max(stepY, m.type === 'text' ? most * 15 : Math.min(most * 16, 520)); subStep.y = stepY / most; }
        else { offsetEnc.xOffset = { field: kF, type: 'ordinal' }; enc.x.scale = Object.assign({}, enc.x.scale, { type: 'band' }); stepX = Math.max(stepX, Math.min(most * 70, 900)); subStep.x = stepX / most; }
        Object.assign(enc, offsetEnc);
        if (m.type === 'text' && stepX) m.limit = Math.max(24, (offsetEnc.xOffset ? stepX / most : stepX) - 8);
      }
    }

    const fillOf = fillResolver(enc.color, values, th);
    // stack order follows the legend: first legend entry sits on the baseline
    let maxPos = 0, minNeg = 0;
    if (stacked) {
      const ce = enc.color;
      const idx = ce && ce.field && ce.scale && ce.scale.domain && ce.type !== 'quantitative' && ce.type !== 'temporal' ? new Map(ce.scale.domain.map((d, i) => [d, i])) : null;
      const segOf = v => {
        const c = colorAlias != null && extras.some(d => d.alias === colorAlias) ? (idx ? (idx.has(v[colorAlias] ?? null) ? idx.get(v[colorAlias] ?? null) : 1e6) : +v[colorAlias]) : 0;
        return [Number.isFinite(c) ? c : 1e6, ...det.map(d => v[d.field])];
      };
      const keys = new Map();
      for (const v of values) { const sk = segOf(v); const k = JSON.stringify(sk); if (!keys.has(k)) keys.set(k, sk); }
      const cmp = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] === b[i]) continue; if (a[i] == null) return 1; if (b[i] == null) return -1; return typeof a[i] === 'number' && typeof b[i] === 'number' ? a[i] - b[i] : String(a[i]).localeCompare(String(b[i])); } return 0; };
      const rank = new Map([...keys.entries()].sort((a, b) => cmp(a[1], b[1])).map(([k], i) => [k, i]));
      for (const v of values) v.__rank = rank.get(JSON.stringify(segOf(v)));
      enc.order = { field: '__rank', type: 'quantitative' };
      const groups = new Map();
      for (const v of values) {
        if (v[vA] == null) continue;
        const k = (v.__fc || '') + '\u0001' + (v.__fr || '') + '\u0001' + (cA ? String(v[cA]) : '');
        if (!groups.has(k)) groups.set(k, []); groups.get(k).push(v);
      }
      for (const g of groups.values()) {
        g.sort((a, b) => a.__rank - b.__rank);
        let pos = 0, neg = 0;
        for (const v of g) { const q = +v[vA]; if (q >= 0) { v['__s' + u] = pos + q / 2; pos += q; } else { v['__s' + u] = neg + q / 2; neg += q; } }
        maxPos = Math.max(maxPos, pos); minNeg = Math.min(minNeg, neg);
      }
      // axis units from the stacked totals, not single segments
      const vEnc = enc[vertical ? 'y' : 'x'];
      if (vEnc && vEnc.axis) {
        const le = axisNumberLabels(Math.max(maxPos, -minNeg));
        delete vEnc.axis.labelExpr; delete vEnc.axis.format;
        if (le) vEnc.axis.labelExpr = le; else vEnc.axis.format = NUM_FMT;
      }
    }

    // approximate pixel positions ("up" = larger), used to keep labels from colliding
    const posFn = (ch, p, a, len, step) => {
      if (!p) return () => len / 2;
      if (isCont(p)) {
        const f = binCenter[ch] ? binCenter[ch].field : a;
        let lo = Infinity, hi = -Infinity;
        for (const v of values) { const q = +v[f]; if (v[f] == null || Number.isNaN(q)) continue; lo = Math.min(lo, q); hi = Math.max(hi, q); }
        // mirror Vega's domain: measures start at zero unless the mark opted out, and linear domains are "niced"
        if (p.kind === 'measure' && !['circle', 'line', 'tick'].includes(mark)) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
        if (!isTemporal(p) && hi > lo) [lo, hi] = niceExtent(lo, hi, 10);
        return v => ((+v[f] - lo) / ((hi - lo) || 1)) * len;
      }
      const e = enc[ch];
      let order = Array.isArray(e && e.sort) ? e.sort.slice() : [...new Set(values.map(v => v[a]))].sort((m1, m2) => (typeof m1 === 'number' && typeof m2 === 'number' ? m1 - m2 : String(m1) < String(m2) ? -1 : String(m1) > String(m2) ? 1 : 0));
      const at = new Map(order.map((k, i) => [k, i])), n = order.length;
      return ch === 'x' ? v => ((at.get(v[a]) ?? 0) + 0.5) * step : v => (n - (at.get(v[a]) ?? 0) - 0.5) * step;
    };
    // greedy: keep a label only if its box clears every label already kept (per facet cell)
    const placeAll = (cands, textOfRow, boxOf, sideAlign = false) => {
      const px = posFn('x', x, xA, unitW, stepX), py = posFn('y', y, yA, unitH, stepY);
      const run = which => {
        const placed = new Map(), got = new Map(), aligns = new Map();
        got.aligns = aligns;
        for (const v of cands) {
          const t = textOfRow(v, which); if (!t) continue;
          const g = (v.__fc || '') + '\u0001' + (v.__fr || '');
          const boxes = placed.get(g) || [];
          const cx = px(v), w = textWidth(t, th, 11) + 6;
          const b = boxOf(cx, py(v), w);
          // near the plot's left/right edge a label hangs inward instead of past the edge
          let al = 'center';
          if (sideAlign && b.x1 > unitW) { al = 'right'; b.x0 = cx - w; b.x1 = cx; }
          else if (sideAlign && b.x0 < 0) { al = 'left'; b.x0 = cx; b.x1 = cx + w; }
          b.y0 -= 1; b.y1 += 1;
          if (boxes.some(o => b.x0 < o.x1 && o.x0 < b.x1 && b.y0 < o.y1 && o.y0 < b.y1)) continue;
          boxes.push(b); placed.set(g, boxes); got.set(v, t); aligns.set(v, al);
        }
        return got;
      };
      const full = run(0), short = run(1);
      return short.size > full.size ? short : full;
    };

    let textAligns = null;
    if (mark === 'text') {
      if ((x && isCont(x)) || (y && isCont(y))) {
        // text at positions: drop the ones that would print on top of each other
        const txF = '__tx' + u;
        const cands = values.filter(v => (!x || v[xA] != null) && (!y || v[yA] != null));
        const textOfRow = (v, which) => labelP ? labelTexts(labelP, v[labelA])[which] : 'Abc';
        const got = placeAll(cands, textOfRow, (cx, cy, w) => ({ x0: cx - w / 2, x1: cx + w / 2, y0: cy - 7, y1: cy + 7 }), true);
        for (const v of values) { v[txF] = got.get(v) || ''; v[txF + 'a'] = got.aligns.get(v) || 'center'; }
        enc.text = { field: txF };
        textAligns = txF + 'a';
      } else if (stepX) m.limit = Math.max(24, stepX - 8); // text table: long values are cut with an ellipsis, never spill into the next cell
    }

    const layers = [{ mark: m, encoding: enc }];
    if (textAligns && values.some(v => v[textAligns] !== 'center')) {
      // text near the plot's edges hangs inward: one text layer per alignment
      layers.length = 0;
      for (const al of ['center', 'left', 'right']) if (values.some(v => v[textAligns] === al)) layers.push({ transform: [{ filter: `datum[${JSON.stringify(textAligns)}] === '${al}'` }], mark: Object.assign({}, m, { align: al }), encoding: enc });
    }
    if (lineQuantColor) {
      const pEnc = { x: enc.x, y: enc.y, color: enc.color, tooltip: tip };
      if (enc.detail) pEnc.detail = enc.detail; if (hl) pEnc.opacity = hl;
      delete enc.color;
      layers.push({ mark: { type: 'point', filled: true, size: 64, stroke: th.panel, strokeWidth: 1.5, opacity: 1 }, encoding: pEnc });
    }

    if (labelP && mark !== 'text') {
      const lbF = '__lb' + u, tcF = '__tc' + u;
      const ink = inkEnc(tcF);
      const tBase = { text: { field: lbF }, tooltip: tip };
      if (hl) tBase.opacity = hl;
      const notEmpty = f => [{ filter: `datum[${JSON.stringify(f)}] !== ''` }];
      const halo = { stroke: th.panel, strokeWidth: 3.5, strokeOpacity: 0.95, paintOrder: 'stroke' };
      const barLike = mark === 'bar' && xm !== ym;
      if (stacked && mark === 'bar') {
        // value labels inside each segment: across when the bar is wide enough, upright when only the segment is long enough
        const len = vertical ? unitH : unitW, span = (maxPos - minNeg) || 1;
        let thickPx = vertical ? m.width : m.height;
        if (!thickPx && binnedAxis) {
          const bp = vertical ? x : y; let lo = Infinity, hi = -Infinity;
          for (const v of values) { const q = v[cA]; if (q == null) continue; lo = Math.min(lo, q); hi = Math.max(hi, q + bp.bin); }
          thickPx = Math.max(4, (bp.bin / ((hi - lo) || bp.bin)) * (vertical ? unitW : unitH) - 2);
        }
        thickPx = thickPx || 22;
        const segPx = v => Math.abs(+v[vA]) / span * len;
        const across = (t, v) => vertical ? segPx(v) >= 15 && textWidth(t, th, 11, 600) <= thickPx - 6 : segPx(v) >= textWidth(t, th, 11, 600) + 10 && thickPx >= 14;
        const upright = (t, v) => vertical && thickPx >= 13 && segPx(v) >= textWidth(t, th, 11, 600) + 8;
        const roomAlong = vertical ? (stepX ? stepX - 6 : thickPx) : Infinity;
        const over = (t, v) => vertical && segPx(v) >= 15 && textWidth(t, th, 11, 600) <= roomAlong;
        const rows = values.filter(v => v[vA] != null);
        // one orientation and one number style for the whole chart: whichever shows the most labels
        let best = null;
        for (const [fit, which, name] of [[across, 0, 'across'], [across, 1, 'across'], [upright, 0, 'upright'], [upright, 1, 'upright']]) {
          let n = 0; for (const v of rows) { const t = labelTexts(labelP, v[labelA])[which]; if (t && fit(t, v)) n++; }
          if (!best || n > best.n) best = { n, fit, which, name };
        }
        const pickOver = labelP.kind === 'measure' || best.name === 'upright' ? () => '' : chooseTexts(labelP, labelA, rows, over);
        const upF = '__up' + u, ovF = '__ov' + u;
        for (const v of values) {
          v[lbF] = ''; v[upF] = ''; v[ovF] = '';
          if (v[vA] == null) continue;
          v[tcF] = inkOn(fillOf(v));
          const t = labelTexts(labelP, v[labelA])[best.which];
          if (t && best.fit(t, v)) { if (best.name === 'across') v[lbF] = t; else v[upF] = t; }
          else v[ovF] = pickOver(v); // a category name wider than the bar: dark text with a halo
        }
        const midEnc = Object.assign({}, enc[vertical ? 'y' : 'x'], { field: '__s' + u, stack: null });
        const tEnc = Object.assign({}, tBase, { color: ink });
        if (vertical) { if (enc.x) tEnc.x = textPos('x'); tEnc.y = midEnc; } else { if (enc.y) tEnc.y = textPos('y'); tEnc.x = midEnc; }
        const tm = { type: 'text', fontSize: 11, fontWeight: 600, align: 'center', baseline: 'middle' };
        layers.push({ transform: notEmpty(lbF), mark: tm, encoding: tEnc });
        if (rows.some(v => v[upF])) layers.push({ transform: notEmpty(upF), mark: Object.assign({}, tm, { angle: 270 }), encoding: Object.assign({}, tEnc, { text: { field: upF } }) });
        if (rows.some(v => v[ovF])) {
          const oEnc = Object.assign({}, tEnc, { text: { field: ovF }, color: { value: th.ink } });
          layers.push({ transform: notEmpty(ovF), mark: Object.assign({}, tm, halo), encoding: oEnc });
          layers.push({ transform: notEmpty(ovF), mark: tm, encoding: oEnc });
        }
      } else if (stacked && mark === 'area') {
        // one label per band, at the point where the band is thickest
        const len = vertical ? unitH : unitW, span = (maxPos - minNeg) || 1;
        const best = new Map();
        for (const v of values) {
          v[lbF] = '';
          if (v[vA] == null) continue;
          const k = v.__rank + '\u0001' + (v.__fc || '') + '\u0001' + (v.__fr || '');
          if (!best.has(k) || Math.abs(+v[vA]) > Math.abs(+best.get(k)[vA])) best.set(k, v);
        }
        const peaks = [...best.values()].sort((a, b) => Math.abs(+b[vA]) - Math.abs(+a[vA]));
        const along = posFn(vertical ? 'x' : 'y', cP, cA, vertical ? unitW : unitH, vertical ? stepX : stepY);
        const valPx = v => ((+v['__s' + u] - minNeg) / span) * len;
        const textOf = chooseTexts(labelP, labelA, peaks, (t, v) => Math.abs(+v[vA]) / span * len >= 15);
        const kept = [];
        for (const v of peaks) {
          const t = textOf(v); if (!t) continue;
          const w = textWidth(t, th, 11.5, 650) + 6, h = 15;
          const cx = vertical ? along(v) : valPx(v), cy = vertical ? valPx(v) : along(v);
          const b = { x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2, g: (v.__fc || '') + '\u0001' + (v.__fr || '') };
          if (kept.some(o => o.g === b.g && b.x0 < o.x1 && o.x0 < b.x1 && b.y0 < o.y1 && o.y0 < b.y1)) continue;
          kept.push(b); v[lbF] = t;
        }
        const tEnc = Object.assign({}, tBase, { color: { value: th.ink } });
        const midEnc = Object.assign({}, enc[vertical ? 'y' : 'x'], { field: '__s' + u, stack: null });
        if (vertical) { tEnc.x = textPos('x'); tEnc.y = midEnc; } else { tEnc.y = textPos('y'); tEnc.x = midEnc; }
        const tm = { type: 'text', fontSize: 11.5, fontWeight: 650, align: 'center', baseline: 'middle' };
        layers.push({ transform: notEmpty(lbF), mark: Object.assign({}, tm, halo), encoding: tEnc });
        layers.push({ transform: notEmpty(lbF), mark: tm, encoding: tEnc });
      } else if (barLike) {
        // value labels just past the end of each bar; upright when the bars are too close for flat text
        const rows = values.filter(v => v[vA] != null);
        const room = vertical ? (stepX ? stepX - 4 : (m.width ? m.width * 1.9 : 80)) : Infinity;
        const rowH = vertical ? Infinity : (stepY || m.height || 22);
        const flatOk = t => textWidth(t, th, 11) <= room && rowH >= 12;
        let maxAbs = 0; for (const v of rows) maxAbs = Math.max(maxAbs, Math.abs(+v[vA]));
        const barPx = v => Math.abs(+v[vA]) / (maxAbs || 1) * unitH;
        const thickPx = m.width || (stepX ? stepX * 0.72 : 20);
        const outside = (t, v) => unitH - barPx(v) >= textWidth(t, th, 11) + 10;
        const inside = (t, v) => barPx(v) >= textWidth(t, th, 11, 600) + 12;
        const flatCount = rows.filter(v => { const [f, sh2] = labelTexts(labelP, v[labelA]); return (f && flatOk(f)) || (sh2 && flatOk(sh2)); }).length;
        const goUpright = vertical && flatCount < rows.length && thickPx >= 11;
        const pos = `datum[${JSON.stringify(vA)}] >= 0`;
        const tEnc = Object.assign({}, tBase, { color: { value: th.ink2 } });
        if (enc.x) tEnc.x = textPos('x'); if (enc.y) tEnc.y = textPos('y');
        if (!goUpright) {
          const textOf = chooseTexts(labelP, labelA, rows, t => flatOk(t));
          for (const v of values) v[lbF] = v[vA] == null ? '' : textOf(v);
          if (!vertical && enc.x && enc.x.type === 'quantitative') {
            // leave room past the longest bar on each side for its label
            let lo = 0, hi = 0, wPos = 0, wNeg = 0;
            for (const v of rows) { const q = +v[vA]; lo = Math.min(lo, q); hi = Math.max(hi, q); const w = textWidth(v[lbF], th, 11) + 10; if (q >= 0) wPos = Math.max(wPos, w); else wNeg = Math.max(wNeg, w); }
            const plot = Math.max(60, unitW - wPos - wNeg), span = (hi - lo) || 1;
            enc.x.scale = Object.assign({}, enc.x.scale, { domain: [lo - (wNeg ? wNeg / plot * span : 0), hi + (wPos ? wPos / plot * span : 0)] });
          }
          layers.push({ transform: [{ filter: pos }, ...notEmpty(lbF)], mark: Object.assign({ type: 'text', fontSize: 11 }, vertical ? { dy: -7, baseline: 'bottom' } : { dx: 5, align: 'left' }), encoding: tEnc });
          layers.push({ transform: [{ filter: `!(${pos})` }, ...notEmpty(lbF)], mark: Object.assign({ type: 'text', fontSize: 11 }, vertical ? { dy: 7, baseline: 'top' } : { dx: -5, align: 'right' }), encoding: tEnc });
        } else {
          // upright text: above the bar when there is headroom, inside the bar (inked for its fill) when there is not
          const textOf = chooseTexts(labelP, labelA, rows, (t, v) => outside(t, v) || inside(t, v));
          const inF = '__in' + u;
          for (const v of values) {
            v[lbF] = ''; v[inF] = '';
            if (v[vA] == null) continue;
            const t = textOf(v); if (!t) continue;
            if (outside(t, v)) v[lbF] = t; else { v[inF] = t; v[tcF] = inkOn(fillOf(v)); }
          }
          const up = { type: 'text', fontSize: 11, angle: 270, baseline: 'middle' };
          layers.push({ transform: [{ filter: pos }, ...notEmpty(lbF)], mark: Object.assign({}, up, { align: 'left', dx: 6 }), encoding: tEnc });
          layers.push({ transform: [{ filter: `!(${pos})` }, ...notEmpty(lbF)], mark: Object.assign({}, up, { align: 'right', dx: -6 }), encoding: tEnc });
          const iEnc = Object.assign({}, tEnc, { text: { field: inF }, color: ink });
          layers.push({ transform: [{ filter: pos }, ...notEmpty(inF)], mark: Object.assign({}, up, { align: 'right', dx: -6, fontWeight: 600 }), encoding: iEnc });
          layers.push({ transform: [{ filter: `!(${pos})` }, ...notEmpty(inF)], mark: Object.assign({}, up, { align: 'left', dx: 6, fontWeight: 600 }), encoding: iEnc });
        }
      } else if ((mark === 'square' && m.type === 'rect') || (mark === 'bar' && !xm && !ym)) {
        // inside cells, inked for the cell colour
        const nSub = offsetEnc.yOffset || offsetEnc.xOffset ? Math.max(...values.map(v => v['__k' + u] + 1)) : 1;
        const cw = (offsetEnc.xOffset ? (stepX || unitW) / nSub : (stepX || unitW)) - 6, chh = offsetEnc.yOffset ? (stepY || unitH) / nSub : (stepY || unitH);
        const textOf = chooseTexts(labelP, labelA, values, t => textWidth(t, th, 11, 600) <= cw && chh >= 14);
        for (const v of values) { v[lbF] = textOf(v); v[tcF] = inkOn(colorP ? fillOf(v) : th.pal.single); }
        const tEnc = Object.assign({}, tBase, { color: ink }, offsetEnc);
        if (enc.x) tEnc.x = textPos('x'); if (enc.y) tEnc.y = textPos('y');
        layers.push({ transform: notEmpty(lbF), mark: { type: 'text', fontSize: 11, fontWeight: 600 }, encoding: tEnc });
      } else {
        // points (line, circle, tick, square, unstacked area, bars on two measures): keep the labels that don't collide
        const seriesOf = v => [colorP && !colorMeasure ? v[colorAlias] : '', ...det.map(d => v[d.field]), v.__fc || '', v.__fr || ''].join('\u0001');
        let cands = values.filter(v => (!x || v[xA] != null) && (!y || v[yA] != null) && v[labelA] != null);
        if (mark === 'line' || mark === 'area') {
          const by = new Map();
          for (const v of cands) { const k = seriesOf(v); if (!by.has(k)) by.set(k, []); by.get(k).push(v); }
          const along = isCont(x) && !xm ? (binCenter.x ? binCenter.x.field : xA) : isCont(y) && !ym ? (binCenter.y ? binCenter.y.field : yA) : xA;
          const maxPts = Math.max(0, ...[...by.values()].map(g => g.length));
          if (by.size > 3 || maxPts > 12) {
            // too many points to label them all: label where each series ends
            cands = [...by.values()].map(g => g.reduce((a, b) => (+b[along] > +a[along] ? b : a)));
          }
        }
        const py = posFn('y', y, yA, unitH, stepY);
        cands.sort((a, b) => py(b) - py(a));
        const got = placeAll(cands, (v, which) => labelTexts(labelP, v[labelA])[which], (cx, cy, w) => ({ x0: cx - w / 2, x1: cx + w / 2, y0: cy + 4, y1: cy + 18 }), true);
        const alF = '__al' + u;
        for (const v of values) { v[lbF] = got.get(v) || ''; v[alF] = got.aligns.get(v) || 'center'; }
        const tEnc = Object.assign({}, tBase, { color: { value: th.ink2 } });
        if (enc.x) tEnc.x = textPos('x'); if (enc.y) tEnc.y = textPos('y');
        for (const al of ['center', 'left', 'right']) {
          if (!values.some(v => v[lbF] && v[alF] === al)) continue;
          const flt = [{ filter: `datum[${JSON.stringify(lbF)}] !== '' && datum[${JSON.stringify(alF)}] === '${al}'` }];
          const tm = { type: 'text', fontSize: 11, dy: -11, align: al, dx: al === 'left' ? -4 : al === 'right' ? 4 : 0 };
          layers.push({ transform: flt, mark: Object.assign({}, tm, halo), encoding: tEnc });
          layers.push({ transform: flt, mark: tm, encoding: tEnc });
        }
      }
    }
    let spec = layers.length > 1 ? { layer: layers } : layers[0];
    spec.width = nx ? { step: subStep.x || stepX } : (x ? unitW : 40);
    spec.height = ny ? { step: subStep.y || stepY } : (y ? unitH : 30);
    if (C.facets.length || R.facets.length) {
      const facet = {};
      if (C.facets.length) facet.column = { field: '__fc', type: 'nominal', title: fcLabel, sort: fcVals, header: { labelOrient: 'top', titleOrient: 'top' } };
      if (R.facets.length) facet.row = { field: '__fr', type: 'nominal', title: frLabel, sort: frVals, header: { labelAngle: 0, labelAlign: 'left', labelLimit: 120 } };
      return { facet, spec, resolve: { axis: { x: 'shared', y: 'shared' } } };
    }
    return spec;
  };
  const grid = ys.map(y => xs.map(x => unit(x, y)));
  let body;
  if (grid.length === 1 && grid[0].length === 1) body = grid[0][0];
  else if (grid.length === 1) body = { hconcat: grid[0] };
  else if (grid[0].length === 1) body = { vconcat: grid.map(r => r[0]) };
  else body = { vconcat: grid.map(r => ({ hconcat: r })) };
  const spec = wrap(body, values, th);
  if (narrow) Object.assign(spec.config.legend, { orient: 'bottom', direction: 'horizontal', columns: 2, labelLimit: 120 });
  return spec;
}

export function embedOpts(n) { return { actions: false, renderer: n > 2500 ? 'canvas' : 'svg', ast: true, tooltip: { theme: 'custom' }, logLevel: 0 }; }
