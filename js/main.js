// Plotcraft: boot, tabs, top bar and the sample project.
import { $, $$, esc, nf0, debounce, toast, on, emit } from './util.js';
import { state, newSheet, newDashboard, persist, loadSaved, clearSaved } from './store.js';
import { sampleTables, buildDataset } from './data.js';
import { makePill } from './pills.js';
import { rebuild, renderSourceView, initSourceEvents, addTableFromFile } from './model.js';
import { renderDataPane, renderShelves, renderSheetView, initSheetEvents, sheet } from './sheet.js';
import { renderDashboard, initDashEvents, dash } from './dashboard.js';
import { openCalcEditor } from './calc.js';
import { initMenus, openMenu } from './ui.js';
import { startExports, offerFile, openDataFile, saveWorkbook, openWorkbook, restoreSaved, exportMode } from './files.js';

/* ---------------- sample project ---------------- */
function sampleProject() {
  state.model = {
    tables: sampleTables(),
    joins: [{ id: 'j-census', tableId: 'sample-census', leftKey: 'sample-trips::pickup_borough', rightKey: 'borough', type: 'left' }],
    fields: {},
    calcs: [
      { id: 'c-tiprate', name: 'Tip rate %', formula: 'SUM([tip_amount]) / SUM([fare_amount]) * 100' },
      { id: 'c-per100k', name: 'Trips per 100k residents', formula: 'COUNT([fare_amount]) / MIN([population_2020]) * 100000' },
      { id: 'c-permile', name: 'Fare per mile', formula: 'IF [trip_distance] > 0 THEN [fare_amount] / [trip_distance] END' },
      { id: 'c-length', name: 'Trip length', formula: 'IF [trip_distance] >= 10 THEN "Long, 10+ mi" ELSEIF [trip_distance] >= 3 THEN "Medium, 3–10 mi" ELSE "Short, under 3 mi" END' }
    ]
  };
  state.DS = buildDataset(state.model);
  const P = (f, shelf, extra) => Object.assign(makePill(f, shelf), extra || {});
  const s = [
    newSheet('Fares by month and borough', { cols: [P('pickup_datetime', 'cols')], rows: [P('fare_amount', 'rows')], color: [P('pickup_borough', 'color')] }),
    newSheet('When riders ride', { cols: [P('pickup_datetime', 'cols', { part: 'weekday' })], rows: [P('pickup_datetime', 'rows', { part: 'hour' })], color: [P('Records', 'color')] }),
    newSheet('Average fare by pickup borough', { cols: [P('pickup_borough', 'cols', { sort: 'desc' })], rows: [P('fare_amount', 'rows', { agg: 'avg' })], label: [P('fare_amount', 'label', { agg: 'avg' })] }),
    newSheet('Trips per 100k residents', { cols: [P('pickup_borough', 'cols', { sort: 'desc' })], rows: [P('Trips per 100k residents', 'rows')], label: [P('Trips per 100k residents', 'label')] }),
    newSheet('Payment mix', { color: [P('payment_type', 'color')], size: [P('Records', 'size')] }, 'donut'),
    newSheet('Trip length distribution', { cols: [{ field: 'trip_distance', kind: 'dim', bin: 1, sort: null }], rows: [P('Records', 'rows')], color: [P('Trip length', 'color')] }),
    newSheet('Fares by borough and payment', { rows: [P('pickup_borough', 'rows')], cols: [P('payment_type', 'cols')], label: [P('fare_amount', 'label')], color: [P('fare_amount', 'color')] }, 'matrix'),
    newSheet('Distance vs fare, one dot per borough-day', { cols: [P('trip_distance', 'cols', { agg: 'avg' })], rows: [P('fare_amount', 'rows', { agg: 'avg' })], color: [P('pickup_borough', 'color')], detail: [P('pickup_datetime', 'detail', { part: 'day' })] }),
    newSheet('Where the fare money goes', { color: [P('pickup_borough', 'color')], detail: [P('payment_type', 'detail')], size: [P('fare_amount', 'size')] }, 'treemap')
  ];
  state.sheets = s;
  const T = (kind, x, y, w, h, extra) => Object.assign({ id: kind + x + '-' + y, kind, x, y, w, h }, extra);
  const month = { field: 'pickup_datetime', kind: 'dim', part: 'month' };
  state.dashboards = [newDashboard('NYC taxi overview', [
    T('text', 0, 0, 12, 3, { text: 'NYC taxi trips, 2025\nA synthetic sample of 9,000 yellow-cab trips, joined to 2020 census populations. Click a bar, slice or cell to filter everything else.' }),
    T('kpi', 0, 3, 3, 5, { measure: P('Records', 'rows'), date: month, label: 'Trips' }),
    T('kpi', 3, 3, 3, 5, { measure: P('fare_amount', 'rows'), date: month, label: 'Fares collected ($)' }),
    T('kpi', 6, 3, 3, 5, { measure: P('Tip rate %', 'rows'), date: month, label: 'Tip rate, % of fares' }),
    T('kpi', 9, 3, 3, 5, { measure: P('trip_minutes', 'rows', { agg: 'avg' }), date: month, label: 'Average trip, minutes' }),
    T('slicer', 0, 8, 3, 9, { slicer: { field: 'pickup_borough' }, filter: { type: 'set', include: null } }),
    T('sheet', 3, 8, 9, 9, { sheetId: s[0].id }),
    T('sheet', 0, 17, 4, 9, { sheetId: s[4].id }),
    T('sheet', 4, 17, 4, 9, { sheetId: s[3].id }),
    T('sheet', 8, 17, 4, 9, { sheetId: s[1].id }),
    T('sheet', 0, 26, 6, 8, { sheetId: s[6].id }),
    T('sheet', 6, 26, 6, 8, { sheetId: s[5].id })
  ])];
  state.active = { kind: 'dash', i: 0 };
  rebuild();
}

/* ---------------- tabs and modes ---------------- */
function renderTabs() {
  const a = state.active;
  const t = (kind, i, label, name) => `<button class="tab" role="tab" type="button" data-kind="${kind}" data-i="${i}" aria-selected="${a.kind === kind && (kind === 'source' || a.i === i)}"><span class="kind">${label}</span>${esc(name)}</button>`;
  $('#tabs').innerHTML = t('source', 0, 'Data', 'Data source') +
    state.sheets.map((s, i) => t('sheet', i, 'Sheet', s.name)).join('') +
    state.dashboards.map((d, i) => t('dash', i, 'Board', d.name)).join('') +
    `<button class="tab-add" type="button" id="addSheet" title="New sheet">+ Sheet</button><button class="tab-add" type="button" id="addDash" title="New dashboard">+ Dashboard</button><span class="status" id="status"></span>`;
  const sel = $('#tabs [aria-selected="true"]'); if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function renderDatasetChip() {
  const DS = state.DS, t0 = DS.order[0];
  const sample = DS.order.some(t => t.format === 'sample');
  $('#datasetChip').innerHTML = `<b title="${esc(t0.name)}">${esc(t0.name)}${DS.order.length > 1 ? ` + ${DS.order.length - 1} joined` : ''}</b><span>${nf0.format(DS.n)} rows · ${DS.fields.filter(f => f.type !== 'records').length} fields</span>${sample ? '<span class="tag">Synthetic sample</span>' : ''}`;
}
function setActive(a) {
  state.active = a;
  if (a.kind === 'dash') state.ui.editLayout = state.ui.editLayout && true;
  render();
  persist();
}
function render() {
  if (!state.DS) return;
  const a = state.active;
  if (a.kind === 'sheet' && !state.sheets[a.i]) state.active = { kind: 'sheet', i: 0 };
  if (a.kind === 'dash' && !state.dashboards[a.i]) state.active = state.dashboards.length ? { kind: 'dash', i: 0 } : { kind: 'sheet', i: 0 };
  const k = state.active.kind;
  document.body.dataset.mode = k;
  $('#workSheet').hidden = k !== 'sheet';
  $('#dashView').hidden = k !== 'dash';
  $('#sourceView').hidden = k !== 'source';
  renderDatasetChip();
  renderTabs();
  renderDataPane();
  if (k === 'sheet') { renderShelves(); renderSheetView(); }
  else if (k === 'dash') { renderDashboard(); $('#status').innerHTML = `<span>${dash().tiles.length} tiles</span>`; }
  else { renderSourceView(); $('#status').innerHTML = `<span>${nf0.format(state.DS.n)} rows</span>`; }
}

/* ---------------- wiring ---------------- */
on('refresh', render);
on('tabs', renderTabs);
on('goto', setActive);
on('exportmode', m => { $('#exportBtn').hidden = m === 'none'; });

document.addEventListener('click', e => {
  const t = e.target;
  const tab = t.closest('#tabs [data-kind]');
  if (tab) { setActive({ kind: tab.dataset.kind, i: +tab.dataset.i }); return; }
  if (t.closest('#addSheet')) { state.sheets.push(newSheet(`Sheet ${state.sheets.length + 1}`)); setActive({ kind: 'sheet', i: state.sheets.length - 1 }); return; }
  if (t.closest('#addDash')) { state.dashboards.push(newDashboard(`Dashboard ${state.dashboards.length + 1}`)); state.ui.editLayout = true; setActive({ kind: 'dash', i: state.dashboards.length - 1 }); return; }
});
$('#openDataBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) openDataFile(f); e.target.value = ''; });
$('#wbInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) openWorkbook(f); e.target.value = ''; });
$('#themeBtn').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.getAttribute('data-theme') ? root.getAttribute('data-theme') === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.setAttribute('data-theme', dark ? 'light' : 'dark');
  try { localStorage.setItem('plotcraft:theme', dark ? 'light' : 'dark'); } catch (err) {}
});
$('#projectBtn').addEventListener('click', e => {
  const a = state.active, canSave = exportMode !== 'none';
  const items = [
    { label: 'Open a workbook file…', action: () => $('#wbInput').click() },
    { label: 'Save workbook with data (.json)', action: () => saveWorkbook(true), disabled: !canSave },
    { label: 'Save layout only (.json)', action: () => saveWorkbook(false), disabled: !canSave },
    { label: 'New calculated field…', action: () => openCalcEditor(null) },
    { label: 'Add a table to join…', action: () => $('#addTableInput').click() }
  ];
  const sec2 = [];
  if (a.kind === 'sheet') {
    sec2.push({ label: 'Duplicate this sheet', action: () => { const c = JSON.parse(JSON.stringify(sheet())); c.id = Math.random().toString(36).slice(2); c.name += ' (copy)'; state.sheets.splice(a.i + 1, 0, c); setActive({ kind: 'sheet', i: a.i + 1 }); } });
    sec2.push({ label: 'Delete this sheet', danger: true, action: () => { if (state.sheets.length < 2) { toast('A workbook needs at least one sheet.'); return; } const [gone] = state.sheets.splice(a.i, 1); state.dashboards.forEach(d => { d.tiles = d.tiles.filter(t => t.sheetId !== gone.id); }); setActive({ kind: 'sheet', i: Math.max(0, a.i - 1) }); } });
  }
  if (a.kind === 'dash') sec2.push({ label: 'Delete this dashboard', danger: true, action: () => { state.dashboards.splice(a.i, 1); setActive(state.dashboards.length ? { kind: 'dash', i: 0 } : { kind: 'sheet', i: 0 }); } });
  sec2.push({ label: 'Start over with the sample', danger: true, action: async () => { await clearSaved(); sampleProject(); toast('Loaded the sample project'); } });
  openMenu(e.currentTarget, [{ title: 'Project', items }, { items: sec2 }]);
});

// drop a file anywhere: opens it (or adds it as a joined table on the Data source tab)
document.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); $('#dropzone').hidden = false; $('#dropzone').textContent = state.active.kind === 'source' ? 'Drop to join this table' : 'Drop to open this file'; } });
document.addEventListener('dragleave', e => { if (e.relatedTarget == null) $('#dropzone').hidden = true; });
document.addEventListener('drop', e => {
  $('#dropzone').hidden = true;
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (state.active.kind === 'source') addTableFromFile(f); else openDataFile(f);
  }
});

const rerender = debounce(() => { if (!state.DS) return; if (state.active.kind === 'sheet') renderSheetView(); else if (state.active.kind === 'dash') renderDashboard(); }, 160);
new ResizeObserver(rerender).observe($('#viewport'));
let lastCanvasW = 0;
new ResizeObserver(entries => { const w = Math.round(entries[0].contentRect.width); if (Math.abs(w - lastCanvasW) > 4) { lastCanvasW = w; rerender(); } }).observe($('#canvas'));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rerender);
new MutationObserver(rerender).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

(async function boot() {
  try { const t = localStorage.getItem('plotcraft:theme'); if (t && !document.documentElement.getAttribute('data-theme')) document.documentElement.setAttribute('data-theme', t); } catch (e) {}
  initMenus(); initSheetEvents(); initDashEvents(); initSourceEvents(openCalcEditor); startExports();
  if (typeof vegaEmbed === 'undefined' || typeof Papa === 'undefined') {
    $('#chart').innerHTML = '<div class="error-box"><strong>The chart engine did not load.</strong><p>Check your connection and reload the page.</p></div>';
    return;
  }
  try { await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 1500))]); } catch (e) {}
  const saved = await loadSaved();
  let ok = false;
  if (saved) { try { ok = restoreSaved(saved); } catch (e) { ok = false; } }
  if (!ok) sampleProject();
})();

// test hook
window.__plotcraft = { state, emit, sampleProject };
