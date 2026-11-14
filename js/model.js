// Data model: joins between tables, field renames/types/roles/visibility, calculated fields,
// plus the "Data source" view (Tableau's data source tab / Power BI's model + Power Query, simplified).
import { $, $$, esc, nf0, nf2, isoDate, toast, emit } from './util.js';
import { state, field, col, persist } from './store.js';
import { buildDataset, renameInFormula, parseTable, srcKey } from './data.js';
import { parse, analyze } from './formula.js';
import { PARTS, defaultPart, defaultFilter, isAggCalc } from './pills.js';
import { openModal } from './ui.js';
import { readFileText } from './files.js';

/* ---------------- rebuild + keep pills valid ---------------- */
export function rebuild() {
  state.DS = buildDataset(state.model);
  sanitizePills();
  state.selection = null;
  emit('refresh');
  persist();
}
function eachPill(fn) {
  for (const s of state.sheets) for (const k of Object.keys(s.shelves)) s.shelves[k].forEach(fn);
  for (const d of state.dashboards) for (const t of d.tiles) { if (t.measure) fn(t.measure); if (t.date) fn(t.date); if (t.slicer) fn(t.slicer); }
}
function sanitizePills() {
  eachPill(p => {
    const f = field(p.field);
    if (!f || f.type === 'error') return;
    if (p.kind === 'filter') {
      const want = f.type === 'string' ? 'set' : 'range';
      if (p.filter.type !== want && p.filter.type !== 'match') p.filter = defaultFilter(f);
      return;
    }
    if (p.kind === 'measure') {
      if (isAggCalc(f)) p.agg = 'calc';
      else if (p.agg === 'calc' || (f.type !== 'number' && f.type !== 'records' && !['count', 'countd'].includes(p.agg))) p.agg = f.type === 'number' ? 'sum' : 'countd';
      return;
    }
    if (f.type === 'date' && !PARTS[p.part]) p.part = defaultPart(f);
    if (f.type !== 'date') delete p.part;
    if (f.type !== 'number') delete p.bin;
  });
}
const keyOf = name => field(name) && field(name).key;

/* ---------------- field operations ---------------- */
export function renameField(oldName, newName) {
  const f = field(oldName);
  if (!f) return;
  if (f.calc) { const c = state.model.calcs.find(x => x.id === f.calc.id); if (c) c.name = newName; }
  else state.model.fields[f.key] = Object.assign(state.model.fields[f.key] || {}, { name: newName });
  for (const c of state.model.calcs) c.formula = renameInFormula(c.formula, oldName, newName);
  eachPill(p => { if (p.field === oldName) p.field = newName; });
  rebuild();
  toast(`Renamed to ${newName}`);
}
export function setFieldProp(name, prop, value) {
  const k = keyOf(name); if (!k) return;
  state.model.fields[k] = Object.assign(state.model.fields[k] || {}, { [prop]: value });
  if (prop === 'type' && value === field(name).inferred && !field(name).calc) delete state.model.fields[k].type;
  rebuild();
}
export function saveCalc(calc, oldName) {
  const list = state.model.calcs, i = list.findIndex(c => c.id === calc.id);
  if (i >= 0) list[i] = calc; else list.push(calc);
  if (oldName && oldName !== calc.name) {
    for (const c of list) if (c.id !== calc.id) c.formula = renameInFormula(c.formula, oldName, calc.name);
    eachPill(p => { if (p.field === oldName) p.field = calc.name; });
  }
  orderCalcs();
  rebuild();
  const f = field(calc.name);
  toast(f && f.type === 'error' ? `Saved ${calc.name}, but it has an error: ${f.calc.error}` : `Saved ${calc.name}. Find it in the Data pane.`);
}
export function deleteCalc(id) {
  const c = state.model.calcs.find(x => x.id === id); if (!c) return;
  state.model.calcs = state.model.calcs.filter(x => x.id !== id);
  rebuild();
  toast(`Deleted ${c.name}. Pills that used it are marked missing.`);
}
// calcs may reference each other: order them so every dependency comes first
function orderCalcs() {
  const list = state.model.calcs, byName = new Map(list.map(c => [c.name, c])), deps = new Map();
  for (const c of list) {
    const d = new Set();
    try { const re = /\[((?:[^\]]|\]\])*)\]/g; let m; while ((m = re.exec(c.formula))) { const nm = m[1].replace(/]]/g, ']'); if (byName.has(nm)) d.add(nm); } } catch (e) {}
    deps.set(c.name, d);
  }
  const out = [], mark = new Set(), temp = new Set();
  const visit = c => { if (mark.has(c.name) || temp.has(c.name)) return; temp.add(c.name); for (const d of deps.get(c.name)) visit(byName.get(d)); temp.delete(c.name); mark.add(c.name); out.push(c); };
  list.forEach(visit);
  state.model.calcs = out;
}

/* ---------------- joins ---------------- */
function suggestJoin(t) {
  const DS = state.DS;
  const left = DS.fields.filter(f => !f.calc && f.type !== 'records' && f.type !== 'error');
  let best = null;
  for (const lf of left) for (let ci = 0; ci < t.names.length; ci++) {
    const rc = t.names[ci];
    const sameName = lf.src.toLowerCase() === rc.toLowerCase() || lf.name.toLowerCase() === rc.toLowerCase();
    const rset = new Set(t.raw[ci].slice(0, 5000).map(v => String(v).trim()).filter(Boolean));
    const lc = col(lf.name); let hit = 0, seen = 0;
    const step = Math.max(1, Math.floor(DS.n / 2000));
    for (let i = 0; i < DS.n; i += step) {
      const v = lc.type === 'string' ? (lc.codes[i] < 0 ? null : lc.dict[lc.codes[i]]) : (Number.isNaN(lc.v[i]) ? null : (lc.type === 'date' ? null : String(lc.v[i])));
      if (v == null) continue; seen++; if (rset.has(String(v).trim())) hit++;
    }
    const score = (seen ? hit / seen : 0) + (sameName ? 0.25 : 0);
    if (!best || score > best.score) best = { score, leftKey: lf.key, rightKey: rc, overlap: seen ? hit / seen : 0 };
  }
  return best;
}
export async function addTableFromFile(file) {
  let t;
  try { t = parseTable(file.name, await readFileText(file)); } catch (e) { toast(`Could not read ${file.name}: ${e.message}`); return; }
  if (state.model.tables.some(x => x.base === t.base)) t.base += '_2';
  const g = suggestJoin(t) || { leftKey: state.DS.fields[0].key, rightKey: t.names[0], overlap: 0 };
  openJoinEditor({ table: t, join: { id: t.id, tableId: t.id, leftKey: g.leftKey, rightKey: g.rightKey, type: 'left' }, isNew: true });
}
function openJoinEditor({ table, join, isNew }) {
  const lefts = state.DS.fields.filter(f => !f.calc && f.type !== 'records' && f.type !== 'error' && (isNew || f.tableId !== table.id));
  const body = `<div class="join-row">
    <label class="stack" for="jLeft">Field in your data<select id="jLeft" class="mark-select">${lefts.map(f => `<option value="${esc(f.key)}" ${f.key === join.leftKey ? 'selected' : ''}>${esc(f.name)}${state.DS.order.length > 1 ? ` · ${esc(f.tableBase)}` : ''}</option>`).join('')}</select></label>
    <span class="join-eq" aria-hidden="true">=</span>
    <label class="stack" for="jRight">Column in ${esc(table.name)}<select id="jRight" class="mark-select">${table.names.map(c => `<option ${c === join.rightKey ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
  </div>
  <label class="stack" for="jType">Keep<select id="jType" class="mark-select"><option value="left" ${join.type !== 'inner' ? 'selected' : ''}>Every row of your data (left join)</option><option value="inner" ${join.type === 'inner' ? 'selected' : ''}>Only rows with a match (inner join)</option></select></label>
  <p class="join-stats" id="jStats"></p>`;
  const { close } = openModal({ title: isNew ? `Join ${table.name}` : `Edit join to ${table.name}`, desc: 'Pick the column that links each row of your data to a row of the new table, like a Power BI relationship.', body, foot: '<button class="btn" type="button" id="jCancel">Cancel</button><button class="btn primary" type="button" id="jOk">' + (isNew ? 'Add table' : 'Save join') + '</button>' });
  const stats = () => {
    const lk = $('#jLeft').value, rk = $('#jRight').value;
    const lf = state.DS.fields.find(f => f.key === lk), lc = col(lf.name);
    const rset = new Map(); table.raw[table.names.indexOf(rk)].forEach(v => { const s = String(v).trim(); if (s) rset.set(s, (rset.get(s) || 0) + 1); });
    let hit = 0, seen = 0, dup = 0;
    for (const [v] of rset) if (rset.get(v) > 1) dup++;
    for (let i = 0; i < state.DS.n; i++) {
      const v = lc.type === 'string' ? (lc.codes[i] < 0 ? null : lc.dict[lc.codes[i]]) : (Number.isNaN(lc.v[i]) ? null : String(lc.v[i]));
      if (v == null) continue; seen++; if (rset.has(String(v).trim())) hit++;
    }
    $('#jStats').innerHTML = `<b>${nf0.format(hit)}</b> of ${nf0.format(state.DS.n)} rows find a match.` + (dup ? ` ${nf0.format(dup)} key values appear more than once in ${esc(table.name)}, so matching rows will repeat.` : '');
  };
  $('#jLeft').onchange = stats; $('#jRight').onchange = stats; stats();
  $('#jCancel').onclick = close;
  $('#jOk').onclick = () => {
    const j = { ...join, leftKey: $('#jLeft').value, rightKey: $('#jRight').value, type: $('#jType').value };
    if (isNew) { state.model.tables.push(table); state.model.joins.push(j); }
    else state.model.joins = state.model.joins.map(x => x.id === j.id ? j : x);
    close(); rebuild();
    toast(isNew ? `Added ${table.name}. Its fields are in the Data pane.` : 'Join updated');
  };
}
export function removeTable(tableId) {
  const t = state.model.tables.find(x => x.id === tableId);
  state.model.joins = state.model.joins.filter(j => j.tableId !== tableId && !j.leftKey.startsWith(tableId + '::'));
  state.model.tables = state.model.tables.filter(x => x.id === state.model.tables[0].id || state.model.joins.some(j => j.tableId === x.id));
  rebuild();
  toast(`Removed ${t ? t.name : 'table'}`);
}

/* ---------------- Data source view ---------------- */
export function renderSourceView() {
  const DS = state.DS, m = state.model, root = $('#sourceView');
  const tableCard = (t, j) => {
    const lf = j && DS.fields.find(f => f.key === j.leftKey);
    const st = j && j._stats;
    return `<article class="tcard"><div class="tcard-head"><h3>${esc(t.name)}</h3><span class="muted">${nf0.format(t.n)} rows · ${t.names.length} columns${t.format === 'sample' ? ' · sample' : ''}</span></div>` +
      (j ? `<p class="join-desc"><span class="jtag">${j.type === 'inner' ? 'Inner join' : 'Left join'}</span> ${esc(lf ? lf.name : '?')} = ${esc(t.name)}.${esc(j.rightKey)}${st ? ` · ${nf0.format(st.matched)} of ${nf0.format(st.total)} rows matched` : ''}</p><div class="row-actions"><button class="btn" type="button" data-editjoin="${esc(j.id)}">Edit join</button><button class="btn quiet danger" type="button" data-rmtable="${esc(t.id)}">Remove</button></div>`
        : '<p class="join-desc">Main table. Every chart starts from its rows.</p>') + '</article>';
  };
  const typeSel = f => `<select class="cell-select" data-ftype="${esc(f.name)}" aria-label="Type of ${esc(f.name)}">${[['string', 'Text'], ['number', 'Number'], ['date', 'Date']].map(([v, l]) => `<option value="${v}" ${f.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const sample = f => {
    const c = col(f.name); if (!c) return '';
    const out = [];
    for (let i = 0; i < DS.n && out.length < 3; i++) {
      if (c.type === 'string') { if (c.codes[i] >= 0 && !out.includes(c.dict[c.codes[i]])) out.push(c.dict[c.codes[i]]); }
      else if (!Number.isNaN(c.v[i])) out.push(c.type === 'date' ? isoDate(c.v[i], c.hasTime) : nf2.format(c.v[i]));
    }
    return out.map(esc).join(', ');
  };
  const rows = DS.fields.filter(f => f.type !== 'records').map(f => `<tr class="${f.hidden ? 'is-hidden' : ''}">
      <td><input class="cell-input" data-fname="${esc(f.name)}" value="${esc(f.name)}" aria-label="Name of ${esc(f.name)}"></td>
      <td>${f.calc ? `<span class="muted">${f.type === 'error' ? 'Error' : 'Calculated'}</span>` : typeSel(f)}</td>
      <td>${f.type === 'number' && !isAggCalc(f) ? `<select class="cell-select" data-frole="${esc(f.name)}" aria-label="Role of ${esc(f.name)}"><option value="dim" ${f.role === 'dim' ? 'selected' : ''}>Dimension</option><option value="measure" ${f.role === 'measure' ? 'selected' : ''}>Measure</option></select>` : `<span class="muted">${f.role === 'measure' ? 'Measure' : 'Dimension'}</span>`}</td>
      <td class="center"><input type="checkbox" data-fshow="${esc(f.name)}" ${f.hidden ? '' : 'checked'} aria-label="Show ${esc(f.name)}"></td>
      <td class="muted">${f.calc ? `<code title="${esc(f.calc.formula)}">${esc(f.calc.formula.length > 46 ? f.calc.formula.slice(0, 44) + '…' : f.calc.formula)}</code>${f.type === 'error' ? `<div class="err-text">${esc(f.calc.error)}</div>` : ''}` : esc(f.table)}</td>
      <td class="muted sample">${f.calc && f.type === 'error' ? '' : isAggCalc(f) ? 'computed per mark' : sample(f)}</td>
      <td>${f.calc ? `<button class="btn quiet" type="button" data-editcalc="${esc(f.calc.id)}">Edit</button>` : ''}</td></tr>`).join('');
  const prevNames = DS.fields.filter(f => f.type !== 'records' && f.type !== 'error' && !f.hidden && !isAggCalc(f)).map(f => f.name).slice(0, 14);
  let prev = '';
  for (let i = 0; i < Math.min(DS.n, 40); i++) prev += '<tr>' + prevNames.map(nm => { const c = col(nm); if (c.type === 'string') return `<td>${c.codes[i] < 0 ? '' : esc(c.dict[c.codes[i]])}</td>`; const v = c.v[i]; return `<td class="${c.type === 'number' ? 'num' : ''}">${Number.isNaN(v) ? '' : c.type === 'date' ? isoDate(v, c.hasTime) : nf2.format(v)}</td>`; }).join('') + '</tr>';
  root.innerHTML = `<div class="source">
    <section class="src-block"><div class="src-head"><h2>Tables</h2><div class="row-actions"><button class="btn primary" type="button" id="addTableBtn">Add a table</button><button class="btn" type="button" id="newCalcBtn2">New calculated field</button></div></div>
      <div class="tcards">${DS.order.map((t, pos) => tableCard(t, pos ? m.joins.find(j => j.tableId === t.id) : null)).join('')}</div>
      ${DS.warnings.length ? `<p class="err-text">${DS.warnings.map(esc).join('<br>')}</p>` : ''}
      <p class="muted">Joined result: ${nf0.format(DS.n)} rows. Add a lookup table (for example regions, targets or census figures) and join it on a shared column.</p></section>
    <section class="src-block"><div class="src-head"><h2>Fields</h2><span class="muted">Rename, retype or hide fields. Changes apply to every sheet and dashboard.</span></div>
      <div class="table-wrap"><table class="grid fields-grid"><thead><tr><th>Name</th><th>Type</th><th>Role</th><th class="center">Show</th><th>Source</th><th>Sample values</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>
    <section class="src-block"><div class="src-head"><h2>Preview</h2><span class="muted">First 40 rows after joins and calculations</span></div>
      <div class="table-wrap"><table class="grid"><thead><tr>${prevNames.map(n => `<th>${esc(n)}</th>`).join('')}</tr></thead><tbody>${prev}</tbody></table></div></section>
  </div>`;
}
export function initSourceEvents(openCalcEditor) {
  const root = $('#sourceView');
  root.addEventListener('click', e => {
    const t = e.target;
    if (t.closest('#addTableBtn')) $('#addTableInput').click();
    if (t.closest('#newCalcBtn2')) openCalcEditor(null);
    const ec = t.closest('[data-editcalc]'); if (ec) openCalcEditor(ec.dataset.editcalc);
    const rm = t.closest('[data-rmtable]'); if (rm) removeTable(rm.dataset.rmtable);
    const ej = t.closest('[data-editjoin]');
    if (ej) { const j = state.model.joins.find(x => x.id === ej.dataset.editjoin); const tb = state.model.tables.find(x => x.id === j.tableId); openJoinEditor({ table: tb, join: j, isNew: false }); }
  });
  root.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.ftype) setFieldProp(t.dataset.ftype, 'type', t.value);
    if (t.dataset.frole) setFieldProp(t.dataset.frole, 'role', t.value);
    if (t.dataset.fshow) setFieldProp(t.dataset.fshow, 'hidden', !t.checked);
    if (t.dataset.fname) {
      const v = t.value.trim(), old = t.dataset.fname;
      if (!v || v === old) { t.value = old; return; }
      if (field(v)) { toast(`There is already a field named ${v}.`); t.value = old; return; }
      renameField(old, v);
    }
  });
  root.addEventListener('keydown', e => { if (e.target.dataset && e.target.dataset.fname && e.key === 'Enter') e.target.blur(); });
  $('#addTableInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) addTableFromFile(f); e.target.value = ''; });
}
export { srcKey };
