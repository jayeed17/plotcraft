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
function axisNumberLabels(maxAbs) {
  if (maxAbs >= 1e9) return "format(datum.value / 1e9, ',.12~g') + 'B'";
  if (maxAbs >= 1e6) return "format(datum.value / 1e6, ',.12~g') + 'M'";
  if (maxAbs >= 1e4) return "format(datum.value / 1e3, ',.12~g') + 'K'";
  return null;
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
  const e = { field: alias, type: c.type === 'string' ? 'nominal' : 'ordinal', title: alias, axis: { grid: false, ticks: false, labelLimit: 150, labelPadding: 6 } };
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
    e.axis.labelAngle = (maxLen * 6.2 > (stepPx || 40) - 6) ? -40 : 0;
    if (mark === 'text') { e.axis.orient = 'top'; e.axis.domain = false; }
  }
  return e;
}

export function encColor(p, res, th) {
  const alias = aliasOf(p, 'color');
  if (p.kind === 'measure' || isTemporal(p) || isBinned(p)) {
    const e = { field: alias, type: isTemporal(p) ? 'temporal' : 'quantitative', title: alias };
    if (isTemporal(p)) { if (PARTS[p.part].tu) e.timeUnit = PARTS[p.part].tu; e.scale = { range: th.pal.seq }; e.legend = { format: PARTS[p.part].fmt, gradientLength: 140 }; return e; }
    let mn = Infinity, mx = -Infinity;
    for (const r of res.rows) { const v = r[alias]; if (v == null) continue; if (v < mn) mn = v; if (v > mx) mx = v; }
    e.scale = (mn < 0 && mx > 0) ? { domainMid: 0, range: th.pal.div } : { range: th.pal.seq };
    const le = axisNumberLabels(Math.max(Math.abs(mn), Math.abs(mx)));
    e.legend = le ? { labelExpr: le, gradientLength: 140 } : { format: NUM_FMT, gradientLength: 140 };
    return e;
  }
  const c = col(p.field);
  const present = new Set(res.rows.map(r => r[alias] == null ? 'Null' : r[alias]));
  if (c.type === 'string') {
    const dom = colorDomain(p), colorFor = {};
    let slot = 0;
    for (const v of dom) colorFor[v] = (v === 'Other' || v === 'Null') ? th.pal.other : th.pal.cat[slot++ % th.pal.cat.length];
    const domain = dom.filter(v => present.has(v));
    return { field: alias, type: 'nominal', title: alias, scale: { domain: domain.map(v => v === 'Null' ? null : v), range: domain.map(v => colorFor[v]) } };
  }
  const order = c.type === 'date' && PARTS[p.part].order ? PARTS[p.part].order.filter(v => present.has(v)) : [...present].filter(v => v !== 'Null').sort((a, b) => a - b);
  if (order.length <= MAX_COLORS) return { field: alias, type: 'ordinal', title: alias, scale: { domain: order, range: th.pal.cat.slice(0, order.length) } };
  return { field: alias, type: 'ordinal', title: alias, scale: { domain: order, range: th.pal.ord } };
}
export function tooltipEnc(res) {
  const out = [];
  for (const d of res.plan.dims) {
    if (isTemporal(d.p)) { const part = PARTS[d.p.part]; out.push(Object.assign({ field: d.alias, type: 'temporal', title: d.alias, format: part.fmt }, part.tu ? { timeUnit: part.tu } : { formatType: 'utc' })); }
    else out.push({ field: d.alias, type: col(d.p.field).type === 'string' ? 'nominal' : 'ordinal', title: d.alias, ...(col(d.p.field).type === 'number' ? { format: NUM_FMT } : {}) });
  }
  for (const m of res.plan.measures) out.push({ field: m.alias, type: 'quantitative', title: m.alias, format: ',.2~f' });
  return out;
}
function textEnc(p) {
  const a = aliasOf(p, 'label');
  if (p.kind === 'measure') return { field: a, type: 'quantitative', format: ',.2~f' };
  if (isTemporal(p)) { const part = PARTS[p.part]; return Object.assign({ field: a, type: 'temporal', format: part.fmt }, part.tu ? { timeUnit: part.tu } : { formatType: 'utc' }); }
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
  const values = res.rows.filter(v => v[ma] > 0);
  const enc = { theta: { field: ma, type: 'quantitative', stack: true }, color: encColor(colorP, { rows: values, plan: res.plan }, th), order: { field: ma, type: 'quantitative', sort: 'descending' }, tooltip: tooltipEnc(res) };
  const hl = highlightEnc(opts.highlight); if (hl) enc.opacity = hl;
  const narrowPie = W < 560;
  const pieSpec = wrap({ width: r * 2, height: r * 2, mark: { type: 'arc', innerRadius: donut ? r * 0.58 : 0, outerRadius: r, stroke: th.panel, strokeWidth: 2 }, encoding: enc }, values, th);
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
  const laid = squarify(items, 0, 0, w, h).map(n => {
    const label = dims.map(d => labelOf(d.p, n.row[d.alias])).join(' · ');
    const bw = n.x1 - n.x0, bh = n.y1 - n.y0;
    const fits = bw > Math.min(160, label.length * 6.6 + 12) && bh > 22;
    return { ...n.row, __x0: n.x0, __x1: n.x1, __y0: n.y0, __y1: n.y1, __label: fits ? label : '', __value: bw > 50 && bh > 38 ? nf2.format(n.row[ma]) : '' };
  });
  const enc = {
    x: { field: '__x0', type: 'quantitative', scale: { domain: [0, w] }, axis: null }, x2: { field: '__x1' },
    y: { field: '__y0', type: 'quantitative', scale: { domain: [0, h], reverse: true }, axis: null }, y2: { field: '__y1' },
    tooltip: tooltipEnc(res)
  };
  if (colorP) enc.color = encColor(colorP, { rows: laid, plan: res.plan }, th); else enc.color = { value: th.pal.single };
  const hl = highlightEnc(opts.highlight); if (hl) enc.opacity = hl;
  // label ink by the fill behind it: white, except near-black on light fills (yellow, light ramp steps)
  let fillOf = () => th.pal.single;
  const ce = enc.color;
  if (ce.field && ce.type !== 'quantitative' && ce.scale && ce.scale.domain) { const mp = new Map(ce.scale.domain.map((d, i) => [d, ce.scale.range[i % ce.scale.range.length]])); fillOf = r => mp.get(r[ce.field]) || th.pal.other; }
  else if (ce.field) { let mn = Infinity, mx = -Infinity; for (const r of laid) { const v = r[ce.field]; if (v == null) continue; mn = Math.min(mn, v); mx = Math.max(mx, v); } const ramp = (ce.scale && ce.scale.range) || th.pal.seq; fillOf = r => ramp[Math.min(ramp.length - 1, Math.floor(((r[ce.field] - mn) / ((mx - mn) || 1)) * ramp.length))]; }
  const lum = hex => { const n = parseInt(String(hex).slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0); };
  for (const r of laid) r.__tc = lum(fillOf(r)) > 0.4 ? '#0b0b0b' : '#ffffff';
  const tc = { field: '__tc', type: 'nominal', scale: null, legend: null };
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
  const uniq = k => { const s = [], seen = new Set(); for (const v of values) if (!seen.has(v[k])) { seen.add(v[k]); s.push(v[k]); } return s; };
  const fcVals = C.facets.length ? uniq('__fc') : [null], frVals = R.facets.length ? uniq('__fr') : [null];
  const xs = C.axes.length ? C.axes : [null], ys = R.axes.length ? R.axes : [null];
  const hasLegend = !!(colorP || (sizeP && sizeP !== labelP));
  const narrow = W < 560;
  const legendW = hasLegend && !narrow ? 170 : 0, yAxisW = 70, xAxisH = 64 + (hasLegend && narrow ? 70 : 0), facetHead = 26;
  const nCols = xs.length * fcVals.length, nRows = ys.length * frVals.length;
  const unitW = Math.max(compact ? 90 : 110, (W - legendW - yAxisW * xs.length - 16 * (nCols - 1) - (R.facets.length ? 90 : 0)) / nCols);
  const unitH = Math.max(compact ? 70 : 90, (H - xAxisH * ys.length - (C.facets.length ? facetHead : 0) - 16 * (nRows - 1)) / nRows);
  const tip = tooltipEnc(res);
  const hl = highlightEnc(opts.highlight);

  const unit = (x, y) => {
    let mark = sh.mark === 'auto' || HTML_MARKS.has(sh.mark) ? autoMark(x, y, sh) : sh.mark;
    if (sh.mark === 'auto' && mark === 'line') {
      const tp = isTemporal(x) ? x : isTemporal(y) ? y : null;
      if (tp && new Set(values.map(v => v[aliasOf(tp, tp === x ? 'cols' : 'rows')])).size < 3) mark = 'bar';
    }
    const xA = x ? aliasOf(x, 'cols') : null, yA = y ? aliasOf(y, 'rows') : null;
    const nx = x && !isCont(x) ? new Set(values.map(v => v[xA])).size : 0;
    const ny = y && !isCont(y) ? new Set(values.map(v => v[yA])).size : 0;
    const stepX = nx ? clamp(Math.floor(unitW / nx), compact ? 12 : 18, 200) : 0;
    const stepY = ny ? clamp(Math.floor(unitH / ny), compact ? 9 : 20, 56) : 0;
    const enc = {};
    if (x) { enc.x = encPos(x, 'x', y, mark, res, stepX, unitW, 'cols'); if (isBinned(x)) enc.x2 = { field: xA + ' end' }; }
    if (y) { enc.y = encPos(y, 'y', x, mark, res, stepY, unitH, 'rows'); if (isBinned(y)) enc.y2 = { field: yA + ' end' }; }
    const colorMeasure = colorP && (colorP.kind === 'measure' || isTemporal(colorP) || isBinned(colorP));
    if (colorP) enc.color = encColor(colorP, res, th);
    else if (mark !== 'text') enc.color = { value: th.pal.single };
    const det = S.detail.filter(p => p.kind !== 'measure').map(p => ({ field: aliasOf(p, 'detail'), type: isTemporal(p) ? 'temporal' : 'nominal' }));
    if (det.length) enc.detail = det;
    if (sizeP && ['circle', 'square', 'text', 'tick'].includes(mark)) {
      const sa = aliasOf(sizeP, 'size');
      enc.size = sizeP.kind === 'measure' ? { field: sa, type: 'quantitative', title: sa, scale: { range: mark === 'text' ? [9, 22] : [24, 640] } } : { field: sa, type: 'ordinal', title: sa };
    }
    enc.tooltip = tip;
    if (hl) enc.opacity = hl;

    let m;
    const binnedAxis = isBinned(x) || isBinned(y);
    const stacked = (mark === 'bar' || mark === 'area') && colorP && !colorMeasure && ((x && x.kind === 'measure') !== (y && y.kind === 'measure'));
    const thick = step => Math.max(2, Math.min(24, Math.floor(step * 0.72)));
    switch (mark) {
      case 'bar': {
        if (binnedAxis) { m = { type: 'bar', orient: isBinned(x) ? 'vertical' : 'horizontal', binSpacing: 2 }; if (stacked) Object.assign(m, { stroke: th.panel, strokeWidth: 1 }); break; }
        m = { type: 'bar', cornerRadiusEnd: stacked ? 1 : 4 };
        if (stacked) Object.assign(m, { stroke: th.panel, strokeWidth: 2 });
        const vertical = y && y.kind === 'measure' && !(x && x.kind === 'measure');
        if (vertical && x) {
          if (nx) m.width = thick(stepX);
          else if (isTemporal(x)) { const n = new Set(values.map(v => v[xA])).size || 1; m.width = Math.max(2, Math.min(24, Math.floor(unitW / n * 0.72))); }
        } else if (y && !vertical) {
          if (ny) m.height = thick(stepY);
          else if (isTemporal(y)) { const n = new Set(values.map(v => v[yA])).size || 1; m.height = Math.max(2, Math.min(24, Math.floor(unitH / n * 0.72))); }
        }
        if (!vertical && !y) m.height = 22;
        if (vertical && !x) m.width = 24;
        break;
      }
      case 'line': {
        const series = new Set(values.map(v => (colorP ? v[aliasOf(colorP, 'color')] : '') + '|' + (v.__fc || '') + '|' + (v.__fr || ''))).size || 1;
        m = { type: 'line', strokeWidth: 2 };
        if (values.length / series <= 32) m.point = { filled: true, size: 56, stroke: th.panel, strokeWidth: 2 };
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
        if (colorP) enc.color = encColor(colorP, res, th);
        enc.text = labelP ? textEnc(labelP) : { value: 'Abc' };
        mark = 'text';
    }
    for (const ch of ['x', 'y']) if (enc[ch] && enc[ch].type === 'quantitative' && !stacked && mark !== 'bar' && mark !== 'area') enc[ch].stack = null;

    let spec = { mark: m, encoding: enc };
    if (labelP && mark !== 'text' && !stacked && !binnedAxis) {
      const tEnc = { text: textEnc(labelP), tooltip: tip };
      if (enc.x) tEnc.x = enc.x; if (enc.y) tEnc.y = enc.y; if (enc.detail) tEnc.detail = enc.detail;
      if (enc.color && enc.color.field) tEnc.detail = [].concat(tEnc.detail || [], [{ field: enc.color.field, type: enc.color.type }]);
      const vertical = y && y.kind === 'measure' && !(x && x.kind === 'measure');
      const tm = { type: 'text', fontSize: 11, color: th.ink2 };
      if (mark === 'bar') Object.assign(tm, vertical ? { dy: -7, baseline: 'bottom' } : { dx: 5, align: 'left' });
      else if (mark === 'square' && m.type === 'rect') {
        tm.fontWeight = 600;
        if (colorP && colorP.kind === 'measure') {
          const ca = aliasOf(colorP, 'color');
          let mn = Infinity, mx = -Infinity; for (const v of values) { const qq = v[ca]; if (qq == null) continue; mn = Math.min(mn, qq); mx = Math.max(mx, qq); }
          const thr = mn + (mx - mn) * (th.dark ? 0.5 : 0.55);
          tEnc.color = th.dark ? { condition: { test: `datum[${JSON.stringify(ca)}] < ${thr}`, value: '#f0efec' }, value: '#0b0b0b' }
            : { condition: { test: `datum[${JSON.stringify(ca)}] > ${thr}`, value: '#ffffff' }, value: '#0b0b0b' };
          delete tm.color;
        }
      } else tm.dy = -10;
      spec = { layer: [{ mark: m, encoding: enc }, { mark: tm, encoding: tEnc }] };
    }
    spec.width = nx ? { step: stepX } : (x ? unitW : 40);
    spec.height = ny ? { step: stepY } : (y ? unitH : 30);
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
