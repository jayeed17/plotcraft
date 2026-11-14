// Dashboards: a 12-column canvas of tiles (charts from sheets, KPI cards, slicers, text) that you drag and
// resize. Slicers filter every tile; clicking a mark cross-filters the other tiles, as in Power BI.
import { $, $$, esc, clamp, nf0, nf2, isoDate, toast, uid, emit } from './util.js';
import { state, field, col, persist, sheetById } from './store.js';
import { makePill, pillLabel, AGGS, PARTS, CONT_PARTS, isAggCalc, defaultFilter } from './pills.js';
import { renderSheetInto } from './render.js';
import { kpiHTML } from './visuals.js';
import { theme } from './chart.js';
import { openMenu, openModal } from './ui.js';

const COLS = 12, ROW_H = 30, GAP = 12;
const views = new Map();
export const dash = () => state.active.kind === 'dash' ? state.dashboards[state.active.i] : null;

/* ---------------- layout maths ---------------- */
const overlaps = (a, b) => a !== b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export function resolveLayout(tiles, moved) {
  let guard = 0, changed = true;
  while (changed && guard++ < 500) {
    changed = false;
    const sorted = tiles.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    for (const t of sorted) for (const o of sorted) {
      if (!overlaps(t, o)) continue;
      const mover = o === moved ? t : t === moved ? o : (o.y > t.y || (o.y === t.y && o.x > t.x) ? o : t);
      const fixed = mover === o ? t : o;
      mover.y = fixed.y + fixed.h; changed = true;
    }
  }
  for (const t of tiles.slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
    while (t.y > 0 && !tiles.some(o => o !== t && overlaps({ ...t, y: t.y - 1 }, o))) t.y--;
  }
}
const bottom = tiles => tiles.reduce((m, t) => Math.max(m, t.y + t.h), 0);

/* ---------------- filters for tiles ---------------- */
function slicerFilters(d) {
  return d.tiles.filter(t => t.kind === 'slicer' && field(t.slicer.field) && t.filter).map(t => ({ field: t.slicer.field, kind: 'filter', filter: t.filter }));
}
function selectionFilters(d) {
  const s = state.selection;
  if (!s || s.dashId !== d.id) return [];
  return s.items.map(it => ({ field: it.field, kind: 'filter', filter: { type: 'match', part: it.part, bin: it.bin, fold: it.fold, values: [it.value] } }));
}

/* ---------------- render ---------------- */
export function renderDashboard() {
  const d = dash(); if (!d) return;
  views.forEach(v => { try { v.finalize(); } catch (e) {} }); views.clear();
  const edit = state.ui.editLayout;
  const sel = state.selection && state.selection.dashId === d.id ? state.selection : null;
  $('#dashTitle').value = d.name;
  $('#editLayoutBtn').textContent = edit ? 'Done editing' : 'Edit layout';
  $('#editLayoutBtn').classList.toggle('primary', edit);
  $('#clearSelBtn').hidden = !sel;
  $('#selNote').innerHTML = sel ? `Filtered by <b>${esc(sel.items.map(i => `${i.alias} = ${i.label}`).join(', '))}</b>` : (d.tiles.length ? 'Click a bar, slice or point to filter the other tiles.' : '');
  const canvas = $('#canvas');
  canvas.classList.toggle('editing', edit);
  if (!d.tiles.length) {
    canvas.innerHTML = `<div class="empty-state"><h2>An empty dashboard</h2><p>Add charts from your sheets, KPI cards, slicers and text. Drag tiles to arrange them and pull the corner to resize.</p><div class="chips"><button class="chip" type="button" data-add="sheet">Add a chart</button><button class="chip" type="button" data-add="kpi">Add a KPI card</button><button class="chip" type="button" data-add="slicer">Add a slicer</button><button class="chip" type="button" data-add="text">Add text</button></div></div>`;
    return;
  }
  const order = d.tiles.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  canvas.innerHTML = order.map(t => tileHTML(t, edit)).join('');
  for (const t of order) renderTileBody(d, t);
}
function tileTitle(t) {
  if (t.kind === 'sheet') { const s = sheetById(t.sheetId); return s ? s.name : 'Missing sheet'; }
  if (t.kind === 'kpi') return t.label || (t.measure ? pillLabel(t.measure) : 'KPI');
  if (t.kind === 'slicer') return t.slicer.field;
  return '';
}
function tileHTML(t, edit) {
  const head = t.kind === 'text' ? '' : `<div class="tile-head"><h3>${esc(tileTitle(t))}</h3><button class="icon-btn" type="button" data-tilemenu="${t.id}" aria-label="Tile options">⋯</button></div>`;
  return `<section class="tile kind-${t.kind}${state.selection && state.selection.tileId === t.id ? ' is-source' : ''}" data-tile="${t.id}" style="grid-column:${t.x + 1} / span ${t.w};grid-row:${t.y + 1} / span ${t.h};--rows:${t.h}">` +
    (edit ? `<div class="drag-handle" data-drag="${t.id}" title="Drag to move" aria-hidden="true"></div>` : '') + head +
    `<div class="tile-body" id="tb-${t.id}"></div>` +
    (edit ? `<span class="resize" data-resize="${t.id}" title="Drag to resize" aria-hidden="true"></span>${t.kind === 'text' ? `<button class="icon-btn text-menu" type="button" data-tilemenu="${t.id}" aria-label="Tile options">⋯</button>` : ''}` : '') + '</section>';
}
async function renderTileBody(d, t) {
  const body = $('#tb-' + t.id); if (!body) return;
  const th = theme();
  if (t.kind === 'text') {
    body.innerHTML = state.ui.editLayout
      ? `<textarea class="text-edit" data-textedit="${t.id}" aria-label="Text">${esc(t.text)}</textarea>`
      : (() => { const [first, ...rest] = String(t.text || '').split('\n'); return `<div class="text-tile"><h2>${esc(first)}</h2>${rest.filter(Boolean).map(l => `<p>${esc(l)}</p>`).join('')}</div>`; })();
    return;
  }
  if (t.kind === 'slicer') { body.innerHTML = slicerHTML(t); return; }
  const extra = [...slicerFilters(d), ...(state.selection && state.selection.tileId !== t.id ? selectionFilters(d) : [])];
  if (t.kind === 'kpi') { body.innerHTML = field(t.measure.field) ? kpiHTML({ measure: t.measure, date: t.date, label: t.label, hideLabel: true }, extra, th) : '<div class="empty-state small"><p>This KPI uses a field that no longer exists.</p></div>'; return; }
  const sh = sheetById(t.sheetId);
  if (!sh) { body.innerHTML = '<div class="empty-state small"><p>The sheet for this tile was deleted.</p></div>'; return; }
  const r = body.getBoundingClientRect();
  const highlight = state.selection && state.selection.tileId === t.id ? state.selection.items.map(i => ({ alias: i.alias, value: i.value })) : null;
  const out = await renderSheetInto(body, sh, { extra, compact: true, highlight, W: Math.max(200, r.width - 8), H: Math.max(120, r.height - 10), onSelect: (datum, res) => onSelect(d, t, datum, res) });
  if (out.view) views.set(t.id, out.view);
}
function onSelect(d, t, datum, res) {
  if (state.ui.editLayout) return;
  const cur = state.selection;
  if (!datum || !res) { if (cur && cur.tileId === t.id) { state.selection = null; refreshBodies(d); } return; }
  const items = res.plan.dims.filter(x => Object.prototype.hasOwnProperty.call(datum, x.alias)).map(x => ({
    field: x.p.field, part: x.p.part, bin: x.p.bin, fold: !!x.fold, value: datum[x.alias], alias: x.alias,
    label: x.p.part && PARTS[x.p.part] && PARTS[x.p.part].cont && datum[x.alias] != null ? isoDate(datum[x.alias]) : String(datum[x.alias] ?? 'Null')
  }));
  if (!items.length) return;
  const same = cur && cur.tileId === t.id && cur.items.length === items.length && cur.items.every((it, i) => it.alias === items[i].alias && it.value === items[i].value);
  state.selection = same ? null : { dashId: d.id, tileId: t.id, items };
  refreshBodies(d);
}
function refreshBodies(d, skipId) {
  const sel = state.selection && state.selection.dashId === d.id ? state.selection : null;
  $('#clearSelBtn').hidden = !sel;
  $('#selNote').innerHTML = sel ? `Filtered by <b>${esc(sel.items.map(i => `${i.alias} = ${i.label}`).join(', '))}</b>` : 'Click a bar, slice or point to filter the other tiles.';
  for (const t of d.tiles) {
    if (t.id === skipId) continue;
    const el = $(`[data-tile="${t.id}"]`); if (el) el.classList.toggle('is-source', !!(sel && sel.tileId === t.id));
    if (t.kind === 'text') continue;
    const v = views.get(t.id); if (v) { try { v.finalize(); } catch (e) {} views.delete(t.id); }
    renderTileBody(d, t);
  }
}

/* ---------------- slicers ---------------- */
function slicerHTML(t) {
  const c = col(t.slicer.field);
  if (!c) return '<div class="empty-state small"><p>This slicer uses a field that no longer exists.</p></div>';
  const f = t.filter || defaultFilter(field(t.slicer.field));
  if (c.type === 'string') {
    const order = [...c.dict.keys()].sort((a, b) => c.counts[b] - c.counts[a]).slice(0, 300);
    const inc = f.include ? new Set(f.include) : null;
    return `<div class="slicer">${order.length > 8 ? `<input class="search" type="search" placeholder="Search" data-slsearch="${t.id}" aria-label="Search ${esc(t.slicer.field)}">` : ''}
      <label class="sl-all"><input type="checkbox" data-slall="${t.id}" ${!inc ? 'checked' : ''}>Select all</label>
      <div class="sl-list">${order.map(k => `<label data-v="${esc(c.dict[k].toLowerCase())}"><input type="checkbox" data-slval="${t.id}" value="${esc(c.dict[k])}" ${!inc || inc.has(c.dict[k]) ? 'checked' : ''}>${esc(c.dict[k])}<span class="count">${nf0.format(c.counts[k])}</span></label>`).join('')}</div></div>`;
  }
  const isD = c.type === 'date', v = x => x == null ? '' : isD ? isoDate(x) : x;
  return `<div class="slicer range-grid"><label>${isD ? 'From' : 'Min'}<input type="${isD ? 'date' : 'number'}" step="any" data-slmin="${t.id}" value="${v(f.min)}" placeholder="${isD ? '' : nf2.format(c.min)}"></label><label>${isD ? 'Through' : 'Max'}<input type="${isD ? 'date' : 'number'}" step="any" data-slmax="${t.id}" value="${v(f.max)}" placeholder="${isD ? '' : nf2.format(c.max)}"></label></div>`;
}
function readSlicer(t) {
  const c = col(t.slicer.field), root = $(`[data-tile="${t.id}"]`);
  if (c.type === 'string') {
    const boxes = $$(`[data-slval="${t.id}"]`, root), on = boxes.filter(b => b.checked).map(b => b.value);
    const all = on.length === boxes.length && c.dict.length <= 300;
    $(`[data-slall="${t.id}"]`, root).checked = all;
    t.filter = { type: 'set', include: all ? null : on };
  } else {
    const rd = s => { const x = s.value; if (x === '') return null; return c.type === 'date' ? Date.parse(x + 'T00:00:00Z') : Number(x); };
    t.filter = { type: 'range', min: rd($(`[data-slmin="${t.id}"]`, root)), max: rd($(`[data-slmax="${t.id}"]`, root)) };
  }
}

/* ---------------- adding and editing tiles ---------------- */
function place(d, t) { t.x = 0; t.y = bottom(d.tiles); d.tiles.push(t); resolveLayout(d.tiles, t); }
function addMenu(anchor) {
  const d = dash();
  openMenu(anchor, [
    { title: 'Chart from a sheet', items: state.sheets.map(s => ({ label: s.name, action: () => { place(d, { id: uid(), kind: 'sheet', sheetId: s.id, w: 6, h: 9 }); after(); } })) },
    { items: [
      { label: 'KPI card…', action: () => kpiEditor(null) },
      { label: 'Slicer…', action: () => slicerEditor() },
      { label: 'Text box', action: () => { place(d, { id: uid(), kind: 'text', text: 'Title\nA sentence about what this dashboard shows.', w: 12, h: 3 }); state.ui.editLayout = true; after(); } }
    ] }
  ]);
}
function after() { renderDashboard(); persist(); }
function measureOptions(sel) {
  return state.DS.fields.filter(f => f.role === 'measure' && f.type !== 'error' && !f.hidden).map(f => `<option value="${esc(f.name)}" ${sel === f.name ? 'selected' : ''}>${esc(f.type === 'records' ? 'Records (count)' : f.name)}</option>`).join('');
}
function kpiEditor(tile) {
  const d = dash();
  const dates = state.DS.fields.filter(f => f.type === 'date' && !f.hidden);
  const m = tile ? tile.measure : null;
  const body = `<label class="stack" for="kMeasure">Measure<select id="kMeasure" class="mark-select">${measureOptions(m ? m.field : (state.DS.fields.find(f => f.role === 'measure' && f.type === 'number') || {}).name)}</select></label>
    <label class="stack" for="kAgg">Aggregation<select id="kAgg" class="mark-select"></select></label>
    <label class="stack" for="kDate">Trend over<select id="kDate" class="mark-select"><option value="">No trend</option>${dates.map(f => `<option value="${esc(f.name)}" ${tile && tile.date && tile.date.field === f.name ? 'selected' : (!tile && f === dates[0] ? 'selected' : '')}>${esc(f.name)}</option>`).join('')}</select></label>
    <label class="stack" for="kPart">Compare each<select id="kPart" class="mark-select">${['year', 'quarter', 'month', 'week', 'day'].map(k => `<option value="${k}" ${(tile && tile.date ? tile.date.part : 'month') === k ? 'selected' : ''}>${PARTS[k].name}</option>`).join('')}</select></label>
    <label class="stack" for="kLabel">Label (optional)<input id="kLabel" class="search" value="${esc(tile && tile.label || '')}" placeholder="Total fares"></label>`;
  const { close } = openModal({ title: tile ? 'Edit KPI card' : 'Add a KPI card', desc: 'A big number for one measure, with its trend and the change from the previous period.', body, foot: '<button class="btn" type="button" id="kCancel">Cancel</button><button class="btn primary" type="button" id="kOk">' + (tile ? 'Save' : 'Add card') + '</button>' });
  const fillAgg = () => {
    const f = field($('#kMeasure').value);
    const aggs = isAggCalc(f) ? ['calc'] : f.type === 'records' ? ['count'] : f.type === 'number' ? ['sum', 'avg', 'median', 'min', 'max', 'count', 'countd'] : ['count', 'countd'];
    $('#kAgg').innerHTML = aggs.map(a => `<option value="${a}" ${m && m.agg === a ? 'selected' : ''}>${AGGS[a].name}</option>`).join('');
    $('#kAgg').disabled = aggs.length < 2;
  };
  $('#kMeasure').onchange = fillAgg; fillAgg();
  $('#kCancel').onclick = close;
  $('#kOk').onclick = () => {
    const fname = $('#kMeasure').value, dname = $('#kDate').value;
    const cfg = { measure: { field: fname, kind: 'measure', agg: $('#kAgg').value }, date: dname ? { field: dname, kind: 'dim', part: $('#kPart').value } : null, label: $('#kLabel').value.trim() || null };
    if (tile) Object.assign(tile, cfg); else place(d, { id: uid(), kind: 'kpi', w: 3, h: 5, ...cfg });
    close(); after();
  };
}
function slicerEditor() {
  const d = dash();
  const opts = state.DS.fields.filter(f => !f.hidden && f.type !== 'error' && f.type !== 'records' && !isAggCalc(f));
  const { close } = openModal({ title: 'Add a slicer', desc: 'A slicer filters every tile on this dashboard.', body: `<label class="stack" for="sField">Field<select id="sField" class="mark-select">${opts.map(f => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join('')}</select></label>`, foot: '<button class="btn" type="button" id="sCancel">Cancel</button><button class="btn primary" type="button" id="sOk">Add slicer</button>' });
  $('#sCancel').onclick = close;
  $('#sOk').onclick = () => {
    const fname = $('#sField').value, f = field(fname);
    place(d, { id: uid(), kind: 'slicer', slicer: { field: fname }, filter: defaultFilter(f), w: 3, h: f.type === 'string' ? 8 : 4 });
    close(); after();
  };
}
function tileMenu(anchor, id) {
  const d = dash(), t = d.tiles.find(x => x.id === id);
  const items = [];
  if (t.kind === 'sheet') items.push({ label: 'Open the sheet', action: () => { const i = state.sheets.findIndex(s => s.id === t.sheetId); if (i >= 0) emit('goto', { kind: 'sheet', i }); } });
  if (t.kind === 'kpi') items.push({ label: 'Edit KPI card…', action: () => kpiEditor(t) });
  if (t.kind === 'slicer') items.push({ label: 'Reset slicer', action: () => { t.filter = defaultFilter(field(t.slicer.field)); after(); } });
  if (t.kind === 'text' && !state.ui.editLayout) items.push({ label: 'Edit text', action: () => { state.ui.editLayout = true; after(); } });
  items.push({ label: 'Make wider', action: () => { t.w = Math.min(COLS - t.x, t.w + 2); resolveLayout(d.tiles, t); after(); }, disabled: t.x + t.w >= COLS });
  items.push({ label: 'Make taller', action: () => { t.h += 2; resolveLayout(d.tiles, t); after(); } });
  items.push({ label: 'Remove from dashboard', danger: true, action: () => { d.tiles = d.tiles.filter(x => x !== t); if (state.selection && state.selection.tileId === t.id) state.selection = null; resolveLayout(d.tiles, null); after(); } });
  openMenu(anchor, [{ items }]);
}

/* ---------------- pointer drag / resize ---------------- */
function startPointer(e, id, mode) {
  const d = dash(), t = d.tiles.find(x => x.id === id), canvas = $('#canvas');
  const cw = (canvas.clientWidth - GAP * (COLS - 1)) / COLS;
  const sx = e.clientX, sy = e.clientY, x0 = t.x, y0 = t.y, w0 = t.w, h0 = t.h;
  const el = $(`[data-tile="${id}"]`);
  el.classList.add('moving');
  e.preventDefault();
  const move = ev => {
    const dx = Math.round((ev.clientX - sx) / (cw + GAP)), dy = Math.round((ev.clientY - sy) / (ROW_H + GAP));
    if (mode === 'drag') { t.x = clamp(x0 + dx, 0, COLS - t.w); t.y = Math.max(0, y0 + dy); }
    else { t.w = clamp(w0 + dx, 2, COLS - t.x); t.h = Math.max(2, h0 + dy); }
    el.style.gridColumn = `${t.x + 1} / span ${t.w}`; el.style.gridRow = `${t.y + 1} / span ${t.h}`;
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    el.classList.remove('moving');
    if (t.x !== x0 || t.y !== y0 || t.w !== w0 || t.h !== h0) { resolveLayout(d.tiles, t); after(); }
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

export function initDashEvents() {
  const root = $('#dashView');
  root.addEventListener('pointerdown', e => {
    if (!state.ui.editLayout || matchMedia('(max-width: 720px)').matches) return;
    const dr = e.target.closest('[data-drag]'), rs = e.target.closest('[data-resize]');
    if (rs) startPointer(e, rs.dataset.resize, 'resize');
    else if (dr) startPointer(e, dr.dataset.drag, 'drag');
  });
  root.addEventListener('click', e => {
    const t = e.target, d = dash(); if (!d) return;
    if (t.closest('#editLayoutBtn')) { state.ui.editLayout = !state.ui.editLayout; renderDashboard(); return; }
    if (t.closest('#addTileBtn')) { addMenu(t.closest('#addTileBtn')); return; }
    if (t.closest('#clearSelBtn')) { state.selection = null; refreshBodies(d); return; }
    const add = t.closest('[data-add]');
    if (add) { const k = add.dataset.add; if (k === 'sheet') addMenu(add); else if (k === 'kpi') kpiEditor(null); else if (k === 'slicer') slicerEditor(); else { place(d, { id: uid(), kind: 'text', text: 'Title\nA sentence about what this dashboard shows.', w: 12, h: 3 }); state.ui.editLayout = true; after(); } return; }
    const tm = t.closest('[data-tilemenu]'); if (tm) { tileMenu(tm, tm.dataset.tilemenu); return; }
  });
  root.addEventListener('change', e => {
    const t = e.target, d = dash(); if (!d) return;
    const id = t.dataset.slval || t.dataset.slall || t.dataset.slmin || t.dataset.slmax;
    if (!id) return;
    const tile = d.tiles.find(x => x.id === id);
    if (t.dataset.slall) $$(`[data-slval="${id}"]`).forEach(b => { b.checked = t.checked; });
    readSlicer(tile);
    persist();
    refreshBodies(d, id);
  });
  root.addEventListener('input', e => {
    const t = e.target, d = dash(); if (!d) return;
    if (t.dataset.slsearch) { const q = t.value.toLowerCase(); $$(`[data-tile="${t.dataset.slsearch}"] .sl-list label`).forEach(l => { l.hidden = q && !l.dataset.v.includes(q); }); }
    if (t.dataset.textedit) { const tile = d.tiles.find(x => x.id === t.dataset.textedit); tile.text = t.value; persist(); }
  });
  $('#dashTitle').addEventListener('input', e => { const d = dash(); if (d) { d.name = e.target.value || 'Dashboard'; emit('tabs'); persist(); } });
  $('#dashTitle').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
}
