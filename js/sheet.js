// Worksheet: data pane, shelves, marks card, filters, drag and drop, chart / data / SQL views.
import { $, $$, esc, clamp, nf0, nf2, isoDate, toast, emit, csvCell } from './util.js';
import { state, field, col, persist, newSheet } from './store.js';
import { PARTS, CONT_PARTS, DISC_PARTS, AGGS, SHELF_NAMES, SINGLE, makePill, makeDim, pillLabel, isCont, isTemporal, isAggCalc, filterSummary, defaultFilter, aliasOf } from './pills.js';
import { runQuery } from './engine.js';
import { buildSQL, highlightSQL } from './sql.js';
import { MARKS, HTML_MARKS, labelOf } from './chart.js';
import { renderSheetInto } from './render.js';
import { openMenu, closeMenu, openModal } from './ui.js';
import { openCalcEditor } from './calc.js';
import { renameField, setFieldProp, deleteCalc } from './model.js';
import { offerFile } from './files.js';
import { niceStep } from './util.js';

export const sheet = () => state.active.kind === 'sheet' ? state.sheets[state.active.i] : null;
let embedView = null, lastRes = null;
export const currentView = () => embedView;

/* ---------------- data pane ---------------- */
export function renderDataPane() {
  const q = $('#fieldSearch').value.trim().toLowerCase();
  const DS = state.DS, multi = DS.order.length > 1;
  const tag = f => f.type === 'error' ? '!' : f.calc ? '=' + (f.type === 'number' ? '#' : f.type === 'date' ? 'D' : 'A') : f.type === 'number' || f.type === 'records' ? '#' : f.type === 'date' ? 'Date' : 'Abc';
  const item = f => `<button class="field${f.type === 'error' ? ' err' : ''}" type="button" draggable="${f.type !== 'error'}" data-field="${esc(f.name)}" title="${esc(f.type === 'error' ? f.calc.error : f.calc ? f.calc.formula : f.name)}">` +
    `<span class="ftype ${f.type === 'error' ? 'e' : f.role === 'measure' ? 'm' : 'd'}">${tag(f)}</span><span class="fname">${esc(f.type === 'records' ? 'Records (count)' : f.name)}</span>` +
    (multi && f.table && f.pos > 0 ? `<span class="ftable">${esc(f.tableBase)}</span>` : '') + '</button>';
  const match = f => !f.hidden && (!q || f.name.toLowerCase().includes(q));
  const dims = DS.fields.filter(f => (f.role === 'dim' || f.type === 'error') && match(f));
  const meas = DS.fields.filter(f => f.role === 'measure' && f.type !== 'error' && match(f));
  const hidden = DS.fields.filter(f => f.hidden).length;
  $('#fieldList').innerHTML =
    `<div class="field-group"><h3 class="label-caps">Dimensions</h3>${dims.map(item).join('') || '<p class="pane-foot">No matches</p>'}</div>` +
    `<div class="field-group"><h3 class="label-caps">Measures</h3>${meas.map(item).join('') || '<p class="pane-foot">No matches</p>'}</div>` +
    (hidden ? `<p class="pane-foot">${hidden} hidden field${hidden > 1 ? 's' : ''}. Unhide them in Data source.</p>` : '');
}

/* ---------------- shelves ---------------- */
const CH_ICONS = {
  color: '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><circle cx="4" cy="4" r="3" fill="#2a78d6"/><circle cx="8" cy="4" r="3" fill="#eb6834" opacity=".9"/><circle cx="6" cy="8" r="3" fill="#1baf7a" opacity=".9"/></svg>',
  size: '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><circle cx="3" cy="8" r="2" fill="currentColor"/><circle cx="8" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  label: '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 3h8M6 3v7" stroke="currentColor" stroke-width="1.6"/></svg>',
  detail: '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><circle cx="3" cy="3" r="1.4" fill="currentColor"/><circle cx="9" cy="3" r="1.4" fill="currentColor"/><circle cx="3" cy="9" r="1.4" fill="currentColor"/><circle cx="9" cy="9" r="1.4" fill="currentColor"/></svg>'
};
export function pillHTML(p, shelf, i) {
  const f = field(p.field);
  const missing = !f || f.type === 'error';
  const cls = missing ? 'bad' : p.kind === 'filter' ? (f.type === 'string' ? 'disc' : 'cont') : (isCont(p) ? 'cont' : 'disc');
  let sub = '';
  if (missing) sub = 'missing';
  else if (p.kind === 'filter') sub = filterSummary(p);
  else if (p.kind === 'dim' && p.sort) sub = p.sort === 'desc' ? '↓' : '↑';
  const label = missing ? p.field : pillLabel(p);
  return `<span class="pill ${cls}" role="button" tabindex="0" draggable="true" data-shelf="${shelf}" data-idx="${i}" aria-label="${esc(label)} on ${SHELF_NAMES[shelf]}. Enter for options, Delete to remove.">` +
    `<span class="plabel">${esc(label)}</span>${sub ? `<span class="psub">${esc(sub)}</span>` : ''}<span class="x" data-remove="1" aria-hidden="true">×</span></span>`;
}
export function renderShelves() {
  const sh = sheet(); if (!sh) return;
  const S = sh.shelves;
  for (const shelf of ['cols', 'rows']) $('#shelf-' + shelf).innerHTML = S[shelf].map((p, i) => pillHTML(p, shelf, i)).join('') || '<span class="empty">Drop fields here</span>';
  for (const shelf of ['color', 'size', 'label', 'detail']) $('#shelf-' + shelf).innerHTML = `<span class="label-caps">${CH_ICONS[shelf]}${SHELF_NAMES[shelf]}</span>` + (S[shelf].map((p, i) => pillHTML(p, shelf, i)).join('') || '<span class="empty">Drop here</span>');
  $('#shelf-filters').innerHTML = S.filters.map((p, i) => pillHTML(p, 'filters', i)).join('') || '<span class="empty">Drop a field to filter</span>';
  const sel = $('#markSelect');
  if (!sel.options.length) sel.innerHTML = MARKS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  sel.value = sh.mark;
  $('#titleInput').value = sh.name;
  $$('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === sh.view)));
}

/* ---------------- view ---------------- */
function viewSize() { const r = $('#viewport').getBoundingClientRect(); return { W: Math.max(280, r.width - 34), H: Math.max(220, r.height - 26) }; }
let token = 0;
export async function renderSheetView() {
  const sh = sheet(); if (!sh) return;
  const my = ++token;
  const host = $('#chart');
  if (embedView) { try { embedView.finalize(); } catch (e) {} embedView = null; }
  let res;
  try { res = runQuery(sh); } catch (e) { res = null; }
  lastRes = res;
  if (res) updateStatus(res);
  if (sh.view === 'sql') {
    let sql = null; try { sql = buildSQL(sh); } catch (e) { sql = '-- ' + e.message; }
    host.innerHTML = sql ? `<div class="sql-wrap"><div class="table-note">This query returns the same table in DuckDB. <button class="btn" type="button" id="copySql">Copy SQL</button></div><pre class="sql"><code>${highlightSQL(sql)}</code></pre></div>` : emptyStateHTML();
    return;
  }
  if (sh.view === 'data') { host.innerHTML = res ? dataTableHTML(res) : ''; return; }
  const S = sh.shelves;
  const empty = !['cols', 'rows', 'color', 'size', 'label', 'detail'].some(k => S[k].length);
  if (empty) { host.innerHTML = emptyStateHTML(); return; }
  const { W, H } = viewSize();
  const out = await renderSheetInto(host, sh, { W, H });
  if (my !== token) { if (out.view) out.view.finalize(); return; }
  embedView = out.view || null;
  $('#exportBtn').dataset.hasView = embedView ? '1' : '';
}
function emptyStateHTML() {
  const ex = examples();
  return `<div class="empty-state"><h2>Build a view</h2><p>Drag a field from the Data pane onto Columns or Rows. Text fields split the view into categories; number fields become axes.</p>` +
    (ex.length ? `<div class="chips">${ex.map((e, i) => `<button class="chip" type="button" data-example="${i}">${esc(e.label)}</button>`).join('')}</div>` : '') + '</div>';
}
function examples() {
  const F = state.DS.fields.filter(f => !f.hidden && f.type !== 'error');
  const dims = F.filter(f => f.role === 'dim' && f.type === 'string');
  const dates = F.filter(f => f.type === 'date');
  const score = f => (/amount|sales|revenue|price|total|fare|cost|profit|value|spend|income|budget|score/i.test(f.name) ? 0 : /count|_id$|^id$|num|qty/i.test(f.name) ? 2 : 1);
  const meas = F.filter(f => f.role === 'measure' && f.type === 'number' && !isAggCalc(f)).sort((a, b) => score(a) - score(b));
  const out = [];
  if (dims[0] && meas[0]) out.push({ label: `${meas[0].name} by ${dims[0].name}`, cols: [dims[0].name], rows: [meas[0].name] });
  if (dates[0] && meas[0]) out.push({ label: `${meas[0].name} over time`, cols: [dates[0].name], rows: [meas[0].name] });
  if (meas[1]) out.push({ label: `${meas[0].name} vs ${meas[1].name}`, cols: [meas[0].name], rows: [meas[1].name], detail: dims[0] ? [dims[0].name] : [] });
  return out;
}
function dataTableHTML(res) {
  if (state.ui.showSource) {
    const idx = res.idx, n = idx ? idx.length : state.DS.n, lim = Math.min(n, 500);
    const names = state.DS.fields.filter(f => f.type !== 'records' && f.type !== 'error' && !f.hidden && !isAggCalc(f)).map(f => f.name);
    let body = '';
    for (let r = 0; r < lim; r++) {
      const i = idx ? idx[r] : r;
      body += '<tr>' + names.map(nm => {
        const c = col(nm);
        if (c.type === 'number') return `<td class="num">${Number.isNaN(c.v[i]) ? '' : nf2.format(c.v[i])}</td>`;
        if (c.type === 'date') return `<td>${Number.isNaN(c.v[i]) ? '' : isoDate(c.v[i], c.hasTime)}</td>`;
        return `<td>${c.codes[i] < 0 ? '' : esc(c.dict[c.codes[i]])}</td>`;
      }).join('') + '</tr>';
    }
    return `<div class="table-note"><span>Source rows that pass the filters: showing ${nf0.format(lim)} of ${nf0.format(n)}.</span><button class="btn" type="button" id="toggleSource">Show the view's summary table</button></div>` +
      `<div class="table-wrap"><table class="grid"><thead><tr>${names.map(nm => `<th class="${col(nm).type === 'number' ? 'num' : ''}">${esc(nm)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
  }
  const plan = res.plan, lim = Math.min(res.rows.length, 2000);
  const head = plan.dims.map(d => `<th>${esc(d.alias)}</th>`).join('') + plan.measures.map(m => `<th class="num">${esc(m.alias)}</th>`).join('');
  let body = '';
  for (let r = 0; r < lim; r++) {
    const row = res.rows[r];
    body += '<tr>' + plan.dims.map(d => `<td>${esc(labelOf(d.p, row[d.alias]))}</td>`).join('') + plan.measures.map(m => `<td class="num">${row[m.alias] == null ? '—' : nf2.format(row[m.alias])}</td>`).join('') + '</tr>';
  }
  const note = plan.dims.length || plan.measures.length ? `<span>${nf0.format(res.rows.length)} rows in this view${res.rows.length > lim ? `, showing the first ${nf0.format(lim)}` : ''}.</span>` : '<span>Put fields on the shelves to summarise them here.</span>';
  return `<div class="table-note">${note}<button class="btn" type="button" id="toggleSource">Show source rows</button></div>` + (head ? `<div class="table-wrap"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` : '');
}
export function updateStatus(res) {
  const el = $('#status'); if (!el || !res) return;
  el.innerHTML = `<span>${nf0.format(res.matched)} of ${nf0.format(state.DS.n)} rows</span><span>${nf0.format(res.rows.length)} marks</span><span>${res.ms < 1 ? '<1' : Math.round(res.ms)} ms</span>`;
}

/* ---------------- changes ---------------- */
export function commit() { renderShelves(); renderSheetView(); persist(); }
export function addPill(shelf, pill, index) {
  const sh = sheet(); if (!sh) return;
  const S = sh.shelves, f = field(pill.field);
  if (!f || f.type === 'error') { toast(`${pill.field} has an error. Fix its formula first.`); return; }
  if (shelf === 'filters' && (f.type === 'records' || isAggCalc(f))) { toast(`${pill.field} is an aggregate, so it can't filter rows. Filter the fields it uses instead.`); return; }
  if (shelf === 'filters' && pill.kind !== 'filter') pill = makePill(pill.field, 'filters');
  if (shelf !== 'filters' && pill.kind === 'filter') pill = makePill(pill.field, shelf);
  if (SINGLE.has(shelf)) S[shelf] = [pill];
  else S[shelf].splice(index == null ? S[shelf].length : clamp(index, 0, S[shelf].length), 0, pill);
  commit();
  if (shelf === 'filters') openFilterEditor(S.filters.indexOf(pill));
}
export function removePill(shelf, i) { sheet().shelves[shelf].splice(i, 1); commit(); }
export function autoAdd(fname) {
  const S = sheet().shelves, f = field(fname);
  const hasCont = l => l.some(isCont), hasDisc = l => l.some(p => !isCont(p));
  let shelf;
  if (f.role === 'measure') shelf = !hasCont(S.rows) ? 'rows' : !hasCont(S.cols) ? 'cols' : 'rows';
  else if (f.type === 'date') shelf = !S.cols.length ? 'cols' : !hasDisc(S.rows) ? 'rows' : 'detail';
  else shelf = !S.cols.length && hasCont(S.rows) ? 'cols' : !hasDisc(S.rows) && !hasDisc(S.cols) ? 'cols' : !S.color.length ? 'color' : 'detail';
  addPill(shelf, makePill(fname, shelf));
}

/* ---------------- menus ---------------- */
function fieldMenu(anchor, fname) {
  const f = field(fname);
  const inSheet = !!sheet();
  const to = shelf => ({ label: `Add to ${SHELF_NAMES[shelf]}`, action: () => addPill(shelf, makePill(fname, shelf)), disabled: !inSheet || f.type === 'error' || (shelf === 'filters' && (f.type === 'records' || isAggCalc(f))) });
  const sections = [
    { title: f.type === 'records' ? 'Records (count of rows)' : fname, items: [{ label: 'Add where it fits best', action: () => autoAdd(fname), disabled: !inSheet || f.type === 'error' }] },
    { items: ['cols', 'rows', 'color', 'size', 'label', 'detail', 'filters'].map(to) }
  ];
  const edit = [];
  if (f.calc) {
    edit.push({ label: 'Edit calculation…', action: () => openCalcEditor(f.calc.id) });
    edit.push({ label: 'Delete calculation', danger: true, action: () => deleteCalc(f.calc.id) });
  }
  if (f.type !== 'records') {
    edit.push({ label: 'Rename…', action: () => renamePrompt(fname) });
    if (f.type !== 'error' && !isAggCalc(f)) edit.push({ label: f.role === 'measure' ? 'Treat as dimension' : 'Treat as measure', action: () => setFieldProp(fname, 'role', f.role === 'measure' ? 'dim' : 'measure'), disabled: f.type !== 'number' && f.role !== 'measure' });
    edit.push({ label: 'Hide', action: () => setFieldProp(fname, 'hidden', true) });
  }
  if (!f.calc && f.type !== 'records') sections.push({ title: 'Data type', items: [['string', 'Text'], ['number', 'Number'], ['date', 'Date']].map(([t, l]) => ({ label: l, checked: f.type === t, action: () => setFieldProp(fname, 'type', t) })) });
  if (edit.length) sections.push({ items: edit });
  openMenu(anchor, sections);
}
export function renamePrompt(fname) {
  const { el, close } = openModal({ title: `Rename ${fname}`, body: `<label class="stack" for="renameInput">New name<input class="search" id="renameInput" value="${esc(fname)}"></label><p class="pane-foot">Charts, filters and formulas that use this field update automatically.</p>`, foot: '<button class="btn" type="button" id="rnCancel">Cancel</button><button class="btn primary" type="button" id="rnOk">Rename</button>' });
  const inp = $('#renameInput'); inp.focus(); inp.select();
  const ok = () => { const v = inp.value.trim(); if (!v || v === fname) { close(); return; } if (field(v)) { toast(`There is already a field named ${v}.`); return; } close(); renameField(fname, v); };
  $('#rnOk').onclick = ok; $('#rnCancel').onclick = close; inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
}
function pillMenu(anchor, shelf, i) {
  const S = sheet().shelves, p = S[shelf][i], f = field(p.field);
  const redo = fn => () => { fn(); commit(); };
  const sections = [];
  if (!f || f.type === 'error') {
    sections.push({ items: [{ label: `${p.field} is missing or has an error`, disabled: true }] });
  } else if (p.kind === 'filter') {
    sections.push({ items: [{ label: 'Edit filter…', action: () => openFilterEditor(i) }] });
  } else if (p.kind === 'measure') {
    if (!isAggCalc(f)) {
      const aggs = f.type === 'number' ? ['sum', 'avg', 'median', 'min', 'max', 'count', 'countd'] : f.type === 'records' ? ['count'] : ['count', 'countd'];
      sections.push({ title: 'Aggregation', items: aggs.map(a => ({ label: AGGS[a].name, checked: p.agg === a, action: redo(() => { p.agg = a; }) })) });
      if (f.type !== 'records') sections.push({ items: [{ label: 'Use as dimension (one mark per value)', action: redo(() => { S[shelf][i] = makeDim(p.field); }) }] });
      if (f.type === 'number') sections.push({ items: [{ label: 'Show distribution (histogram)', action: redo(() => { const c = col(p.field); const bin = niceStep(c.max - c.min, 24); S.cols = [{ field: p.field, kind: 'dim', bin, sort: null }]; S.rows = [makePill('Records', 'rows')]; S.color = []; S.size = []; S.label = []; S.detail = []; sheet().mark = 'auto'; }) }] });
    } else sections.push({ items: [{ label: 'Edit calculation…', action: () => openCalcEditor(f.calc.id) }] });
  } else {
    if (f.type === 'date') {
      sections.push({ title: 'Date as a timeline', items: CONT_PARTS.map(k => ({ label: PARTS[k].name, checked: p.part === k, action: redo(() => { p.part = k; }) })) });
      sections.push({ title: 'Date as categories', items: DISC_PARTS.map(k => ({ label: PARTS[k].name, checked: p.part === k, action: redo(() => { p.part = k; }) })) });
    }
    if (f.type === 'number') {
      const c = col(p.field), auto = niceStep(c.max - c.min, 20);
      sections.push({ title: 'Bins', items: [
        { label: 'No bins (one value each)', checked: !p.bin, action: redo(() => { delete p.bin; }) },
        ...[auto / 2, auto, auto * 2].map(b => ({ label: `Bins of ${nf2.format(b)}`, checked: p.bin === b, action: redo(() => { p.bin = b; }) }))
      ] });
    }
    if (shelf === 'cols' || shelf === 'rows') sections.push({ title: 'Sort', items: [
      { label: f.type === 'string' ? 'A to Z' : 'Natural order', checked: !p.sort, action: redo(() => { p.sort = null; }) },
      { label: 'By value, high to low', checked: p.sort === 'desc', action: redo(() => { p.sort = 'desc'; }) },
      { label: 'By value, low to high', checked: p.sort === 'asc', action: redo(() => { p.sort = 'asc'; }) }
    ] });
    sections.push({ items: [{ label: f.type === 'number' ? 'Use as measure (sum)' : 'Use as measure (count distinct)', action: redo(() => { S[shelf][i] = { field: p.field, kind: 'measure', agg: f.type === 'number' ? 'sum' : 'countd' }; }) }] });
  }
  const moves = ['cols', 'rows', 'color', 'size', 'label', 'detail', 'filters'].filter(s => s !== shelf);
  sections.push({ title: 'Move to', items: moves.map(s => ({ label: SHELF_NAMES[s], action: () => { const [pp] = S[shelf].splice(i, 1); addPill(s, pp); } })) });
  sections.push({ items: [{ label: 'Remove', danger: true, action: () => removePill(shelf, i) }] });
  openMenu(anchor, sections);
}

/* ---------------- filter editor (also used by dashboard slicers) ---------------- */
export function filterEditorBody(fname, filter) {
  const c = col(fname);
  if (c.type === 'string') {
    const order = [...c.dict.keys()].sort((a, b) => c.counts[b] - c.counts[a]);
    const inc = filter.include ? new Set(filter.include) : null;
    const items = order.slice(0, 1500).map(k => ({ v: c.dict[k], n: c.counts[k] }));
    if (c.nulls) items.push({ v: 'Null', n: c.nulls });
    return {
      desc: `Keep rows whose ${fname} is checked.${c.dict.length > 1500 ? ' Showing the 1,500 most common values.' : ''}`,
      html: `<input class="search" id="fsearch" type="search" placeholder="Search values" aria-label="Search values"><div class="row-actions"><button class="btn" type="button" id="fall">Select all</button><button class="btn" type="button" id="fnone">Select none</button></div>` +
        `<div class="checklist" id="flist">${items.map((it, j) => `<label data-v="${esc(it.v.toLowerCase())}"><input type="checkbox" id="fv-${j}" value="${esc(it.v)}" ${!inc || inc.has(it.v) ? 'checked' : ''}>${esc(it.v)}<span class="count">${nf0.format(it.n)}</span></label>`).join('')}</div>`
    };
  }
  const isD = c.type === 'date', v = x => x == null ? '' : isD ? isoDate(x) : x;
  return {
    desc: isD ? `Keep rows from the first date through the last date (inclusive). Data runs ${isoDate(c.min)} to ${isoDate(c.max)}.` : `Keep rows where ${fname} is in this range (each row, before aggregation). Data runs ${nf2.format(c.min)} to ${nf2.format(c.max)}.`,
    html: `<div class="range-grid"><label for="fmin">${isD ? 'From' : 'At least'}<input id="fmin" type="${isD ? 'date' : 'number'}" step="any" value="${v(filter.min)}" placeholder="${isD ? '' : nf2.format(c.min)}"></label><label for="fmax">${isD ? 'Through' : 'At most'}<input id="fmax" type="${isD ? 'date' : 'number'}" step="any" value="${v(filter.max)}" placeholder="${isD ? '' : nf2.format(c.max)}"></label></div>`
  };
}
export function wireFilterEditor(root, fname) {
  const c = col(fname);
  if (c.type === 'string') {
    $('#fsearch', root).oninput = e => { const q = e.target.value.toLowerCase(); $$('#flist label', root).forEach(l => { l.hidden = q && !l.dataset.v.includes(q); }); };
    $('#fall', root).onclick = () => $$('#flist label:not([hidden]) input', root).forEach(x => { x.checked = true; });
    $('#fnone', root).onclick = () => $$('#flist label:not([hidden]) input', root).forEach(x => { x.checked = false; });
  }
  return () => {
    if (c.type === 'string') {
      const boxes = $$('#flist input', root), on = boxes.filter(b => b.checked).map(b => b.value);
      return { type: 'set', include: on.length === boxes.length && c.dict.length <= 1500 ? null : on };
    }
    const rd = id => { const s = $(id, root).value; if (s === '') return null; return c.type === 'date' ? Date.parse(s + 'T00:00:00Z') : Number(s); };
    return { type: 'range', min: rd('#fmin'), max: rd('#fmax') };
  };
}
export function openFilterEditor(i) {
  const S = sheet().shelves, p = S.filters[i];
  if (!p || !col(p.field)) return;
  const { desc, html } = filterEditorBody(p.field, p.filter);
  const { el, close } = openModal({ title: `Filter: ${p.field}`, desc, body: html, foot: '<button class="btn" type="button" id="fcancel">Cancel</button><button class="btn primary" type="button" id="fapply">Apply filter</button>' });
  const read = wireFilterEditor(el, p.field);
  $('#fcancel').onclick = close;
  const first = $('#fsearch') || $('#fmin'); if (first) first.focus();
  $('#fapply').onclick = () => { p.filter = read(); close(); commit(); };
}

/* ---------------- drag and drop ---------------- */
let drag = null, dropped = false;
function clearDropMarks() { $$('.drop.over').forEach(d => d.classList.remove('over')); $$('.caret').forEach(c => c.remove()); }
function insertIndex(zone, x, y) {
  const pills = $$('.pill:not(.dragging)', zone), horizontal = zone.classList.contains('shelf-drop');
  for (let i = 0; i < pills.length; i++) {
    const r = pills[i].getBoundingClientRect();
    if (horizontal ? (y < r.bottom && x < r.left + r.width / 2) || y < r.top : y < r.top + r.height / 2) return { i: +pills[i].dataset.idx, el: pills[i] };
  }
  return { i: pills.length ? +pills[pills.length - 1].dataset.idx + 1 : 0, el: null };
}
export function initSheetEvents() {
  document.addEventListener('dragstart', e => {
    const fEl = e.target.closest && e.target.closest('.field'), pEl = e.target.closest && e.target.closest('.pill');
    if (fEl) drag = { src: 'field', field: fEl.dataset.field };
    else if (pEl && sheet()) { drag = { src: 'pill', shelf: pEl.dataset.shelf, idx: +pEl.dataset.idx }; pEl.classList.add('dragging'); }
    else return;
    dropped = false;
    e.dataTransfer.effectAllowed = 'copyMove';
    try { e.dataTransfer.setData('text/plain', drag.field || 'pill'); } catch (err) {}
    emit('dragfield', drag);
  });
  document.addEventListener('dragend', e => {
    const pEl = e.target.closest && e.target.closest('.pill');
    if (pEl) pEl.classList.remove('dragging');
    if (drag && drag.src === 'pill' && !dropped && e.dataTransfer.dropEffect === 'none' && sheet()) {
      const S = sheet().shelves;
      if (S[drag.shelf] && S[drag.shelf][drag.idx]) { S[drag.shelf].splice(drag.idx, 1); commit(); }
    }
    drag = null; clearDropMarks();
  });
  document.addEventListener('dragover', e => {
    const zone = e.target.closest && e.target.closest('.drop');
    if (!drag || !zone || !sheet()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    $$('.drop.over').forEach(d => { if (d !== zone) d.classList.remove('over'); });
    zone.classList.add('over');
    if (zone.classList.contains('shelf-drop')) {
      const { el } = insertIndex(zone, e.clientX, e.clientY);
      let caret = zone.querySelector('.caret');
      if (!caret) { caret = document.createElement('span'); caret.className = 'caret'; zone.appendChild(caret); }
      const zr = zone.getBoundingClientRect();
      const ref = el || $$('.pill:not(.dragging)', zone).pop();
      if (ref) { const r = ref.getBoundingClientRect(); caret.style.left = (el ? r.left - zr.left - 4 : r.right - zr.left + 3) + 'px'; caret.style.top = (r.top - zr.top) + 'px'; caret.style.bottom = 'auto'; caret.style.height = r.height + 'px'; }
      else { caret.style.left = '10px'; caret.style.top = '8px'; caret.style.height = '26px'; }
    }
  });
  document.addEventListener('dragleave', e => {
    const zone = e.target.closest && e.target.closest('.drop');
    if (zone && !zone.contains(e.relatedTarget)) { zone.classList.remove('over'); const c = zone.querySelector('.caret'); if (c) c.remove(); }
  });
  document.addEventListener('drop', e => {
    const zone = e.target.closest && e.target.closest('.drop');
    if (!drag || !zone || !sheet()) return;
    e.preventDefault();
    dropped = true;
    const shelf = zone.dataset.shelf, { i } = insertIndex(zone, e.clientX, e.clientY);
    const d = drag; drag = null; clearDropMarks();
    if (d.src === 'field') addPill(shelf, makePill(d.field, shelf), i);
    else {
      const S = sheet().shelves, [p] = S[d.shelf].splice(d.idx, 1);
      addPill(shelf, p, d.shelf === shelf && i > d.idx ? i - 1 : i);
    }
  });

  document.addEventListener('click', e => {
    const t = e.target;
    const pill = t.closest('.pill[data-shelf]');
    if (pill && sheet() && pill.closest('#workSheet')) {
      const shelf = pill.dataset.shelf, i = +pill.dataset.idx;
      if (t.closest('[data-remove]')) removePill(shelf, i); else pillMenu(pill, shelf, i);
      return;
    }
    const fEl = t.closest('.field');
    if (fEl && fEl.closest('#dataPane')) { fieldMenu(fEl, fEl.dataset.field); return; }
    const ex = t.closest('[data-example]');
    if (ex && sheet()) { const x = examples()[+ex.dataset.example]; const S = sheet().shelves; S.cols = x.cols.map(n => makePill(n, 'cols')); S.rows = x.rows.map(n => makePill(n, 'rows')); S.detail = (x.detail || []).map(n => makePill(n, 'detail')); commit(); return; }
    const seg = t.closest('.seg button[data-view]');
    if (seg && sheet()) { sheet().view = seg.dataset.view; renderShelves(); renderSheetView(); persist(); return; }
    if (t.closest('#toggleSource')) { state.ui.showSource = !state.ui.showSource; renderSheetView(); return; }
    if (t.closest('#copySql')) {
      navigator.clipboard.writeText(buildSQL(sheet())).then(() => toast('SQL copied')).catch(() => toast('Copy was blocked here. Select the SQL and copy it by hand.'));
    }
  });
  document.addEventListener('dblclick', e => {
    const fEl = e.target.closest('.field');
    if (fEl && sheet() && field(fEl.dataset.field).type !== 'error') { closeMenu(false); autoAdd(fEl.dataset.field); }
  });
  document.addEventListener('keydown', e => {
    const pill = e.target.closest && e.target.closest('#workSheet .pill');
    if (pill && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pillMenu(pill, pill.dataset.shelf, +pill.dataset.idx); }
    if (pill && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); removePill(pill.dataset.shelf, +pill.dataset.idx); }
  });
  $('#fieldSearch').addEventListener('input', renderDataPane);
  $('#newCalcBtn').addEventListener('click', () => openCalcEditor(null));
  $('#markSelect').addEventListener('change', e => { sheet().mark = e.target.value; commit(); });
  $('#titleInput').addEventListener('input', e => { sheet().name = e.target.value || 'Untitled'; emit('tabs'); persist(); });
  $('#titleInput').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  $('#swapBtn').addEventListener('click', () => { const S = sheet().shelves; [S.cols, S.rows] = [S.rows, S.cols]; commit(); });
  $('#clearBtn').addEventListener('click', () => { const s = sheet(); s.shelves = newSheet('').shelves; s.mark = 'auto'; commit(); });
  $('#exportBtn').addEventListener('click', e => {
    const s = sheet(), base = (s.name || 'view').replace(/[^\w\- ]+/g, '').trim() || 'view';
    openMenu(e.currentTarget, [{ title: 'Export this view', items: [
      { label: 'Image (.png)', action: () => exportImage('png', base), disabled: !embedView },
      { label: 'Vector image (.svg)', action: () => exportImage('svg', base), disabled: !embedView },
      { label: 'Summary table (.csv)', action: () => offerFile(base + '.csv', toCSV(lastRes)), disabled: !lastRes }
    ] }]);
  });
}
function toCSV(res) {
  if (!res) return '';
  const cols = [...res.plan.dims.map(d => d.alias), ...res.plan.measures.map(m => m.alias)];
  const lines = [cols.map(csvCell).join(',')];
  for (const r of res.rows) lines.push([...res.plan.dims.map(d => csvCell(isTemporal(d.p) ? isoDate(r[d.alias], d.p.part === 'exact') : r[d.alias])), ...res.plan.measures.map(m => csvCell(r[m.alias]))].join(','));
  return lines.join('\n') + '\n';
}
async function exportImage(kind, base) {
  if (!embedView) return;
  try {
    if (kind === 'svg') { await offerFile(base + '.svg', await embedView.toSVG()); return; }
    const url = await embedView.toImageURL('png', 2);
    const bin = atob(url.split(',')[1]), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await offerFile(base + '.png', bytes);
  } catch (e) { toast('Export failed: ' + e.message); }
}
