// Opening data and workbooks, saving files: native Save dialog in the desktop app, the claude.ai downloads
// capability inside an artifact, or a plain download link in a browser.
import { toast, nf0, emit } from './util.js';
import { state, newSheet, newDashboard, projectJSON, persist } from './store.js';
import { parseTable, sampleTables } from './data.js';
import { rebuild } from './model.js';

let downloadsCap = null;
export let exportMode = 'none';   // 'tauri' | 'cap' | 'anchor' | 'none'
export const isDesktop = !!(window.__TAURI__ && window.__TAURI__.dialog && window.__TAURI__.fs);
function setMode(m, cap) { exportMode = m; downloadsCap = cap || null; emit('exportmode', m); }
export function initExports() {
  const c = window.claude;
  if (c && typeof c.use === 'function') { c.use('downloads').then(d => setMode(d ? 'cap' : 'none', d)).catch(() => setMode('none')); return true; }
  return false;
}
export function startExports() {
  if (isDesktop) { setMode('tauri'); return; }
  if (!initExports()) setTimeout(() => { if (!initExports()) setMode(window.top === window ? 'anchor' : 'none'); }, 1200);
}
const EXT_NAMES = { png: 'PNG image', svg: 'SVG image', csv: 'CSV table', json: 'Vizora workbook' };
async function saveNative(filename, data) {
  const ext = filename.split('.').pop().toLowerCase();
  const path = await window.__TAURI__.dialog.save({ defaultPath: filename, filters: [{ name: EXT_NAMES[ext] || ext.toUpperCase(), extensions: [ext] }] });
  if (!path) return;
  if (data instanceof Uint8Array) await window.__TAURI__.fs.writeFile(path, data);
  else await window.__TAURI__.fs.writeTextFile(path, String(data));
  toast(`Saved ${path.split(/[\\/]/).pop()}`);
}
export async function offerFile(filename, data) {
  if (exportMode === 'tauri') {
    try { await saveNative(filename, data); } catch (e) { toast(`Could not save ${filename}${e && e.message ? ': ' + e.message : e ? ': ' + e : ''}`); }
    return;
  }
  if (exportMode === 'cap' && downloadsCap) {
    try { await downloadsCap.save({ filename, data }); toast(`Saved ${filename}`); }
    catch (e) {
      if (e && e.code === 'declined') return;
      if (e && e.code === 'rate_limited') { toast('A save prompt is already open. Finish it, then try again.'); return; }
      toast(`Could not save ${filename}${e && e.message ? ': ' + e.message : ''}`);
    }
    return;
  }
  if (exportMode === 'anchor') {
    const blob = data instanceof Uint8Array ? new Blob([data]) : new Blob([data], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return;
  }
  toast('Saving files is not available in this view.');
}
export const readFileText = file => file.text();

export async function openDataFile(file) {
  toast(`Reading ${file.name}…`);
  let t;
  try { t = parseTable(file.name, await readFileText(file)); }
  catch (e) { toast(`Could not read ${file.name}: ${e.message}`); return; }
  state.model = { tables: [t], joins: [], fields: {}, calcs: [] };
  state.sheets = [newSheet('Sheet 1')];
  state.dashboards = [newDashboard('Dashboard 1')];
  state.active = { kind: 'sheet', i: 0 };
  rebuild();
  toast(`Loaded ${file.name}: ${nf0.format(t.n)} rows, ${t.names.length} columns.${t.parseErrors ? ` ${t.parseErrors} lines had problems.` : ''}`);
}

export function saveWorkbook(withData) {
  const json = JSON.stringify(projectJSON(withData), null, withData ? 0 : 2);
  const base = state.model.tables[0].base || 'workbook';
  offerFile(`${base}${withData ? '' : '.layout'}.vizora.json`, json);
}
export async function openWorkbook(file) {
  try {
    const wb = JSON.parse(await readFileText(file));
    if (!['vizora','plotcraft'].includes(wb.app) || !Array.isArray(wb.sheets)) throw new Error('this is not a Vizora workbook');
    const tables = [];
    for (const t of wb.tables) {
      if (t.format === 'sample') { const s = sampleTables().find(x => x.id === t.id); if (s) { tables.push(s); continue; } }
      if (t.text != null) { const p = parseTable(t.name, t.text); p.id = t.id; tables.push(p); continue; }
      const cur = state.model.tables.find(x => x.name === t.name);
      if (!cur) throw new Error(`it needs ${t.name}. Open that file first, then open the workbook again.`);
      tables.push({ ...cur, id: t.id });
    }
    applyProject(wb, tables);
    toast(`Opened ${wb.sheets.length} sheets and ${state.dashboards.length} dashboards`);
  } catch (e) { toast(`Could not open the workbook: ${e.message}`); }
}
export function applyProject(p, tables) {
  state.model = { tables, joins: p.joins || [], fields: p.fields || {}, calcs: p.calcs || [] };
  state.sheets = p.sheets; state.dashboards = p.dashboards || [];
  state.active = p.active || { kind: 'sheet', i: 0 };
  if (state.active.kind === 'sheet' && !state.sheets[state.active.i]) state.active = { kind: 'sheet', i: 0 };
  if (state.active.kind === 'dash' && !state.dashboards[state.active.i]) state.active = { kind: 'sheet', i: 0 };
  rebuild();
}
export function restoreSaved(p) {
  const tables = [];
  for (const t of p.tables) {
    if (t.format === 'sample') { const s = sampleTables().find(x => x.id === t.id); if (!s) return false; tables.push(s); }
    else if (t.text != null) { const x = parseTable(t.name, t.text); x.id = t.id; tables.push(x); }
    else return false;
  }
  applyProject(p, tables);
  return true;
}
export { persist };
