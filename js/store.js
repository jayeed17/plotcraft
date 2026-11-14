// App state, persistence (IndexedDB for the project, including uploaded data) and workbook files.
import { debounce, uid } from './util.js';

export const state = {
  DS: null,          // built dataset (see data.js buildDataset)
  model: null,       // { tables, joins, fields, calcs }
  sheets: [],
  dashboards: [],
  active: { kind: 'sheet', i: 0 },  // kind: 'source' | 'sheet' | 'dash'
  ui: { showSource: false, editLayout: false },
  selection: null    // dashboard cross-filter: { dashId, tileId, items: [{field, part, bin, fold, value, alias}] }
};

export const field = name => state.DS && state.DS.fieldMap.get(name);
export const col = name => state.DS && state.DS.cols[name];
export const sheetById = id => state.sheets.find(s => s.id === id);

export function newSheet(name, shelves = {}, mark = 'auto') {
  return { id: uid(), name, mark, view: 'chart', shelves: Object.assign({ cols: [], rows: [], color: [], size: [], label: [], detail: [], filters: [] }, shelves) };
}
export function newDashboard(name, tiles = []) { return { id: uid(), name, tiles }; }

/* ---------- project (de)serialisation ---------- */
export function projectJSON(withData = true) {
  const m = state.model;
  return {
    app: 'vizora', version: 2,
    tables: m.tables.map(t => ({ id: t.id, name: t.name, format: t.format, ...(withData && t.format !== 'sample' ? { text: t.text } : {}), names: t.names })),
    joins: m.joins, fields: m.fields, calcs: m.calcs,
    sheets: state.sheets, dashboards: state.dashboards, active: state.active
  };
}

/* ---------- IndexedDB ---------- */
const DB = 'vizora', STORE = 'project', KEY = 'current';
function idb() {
  return new Promise((res, rej) => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch (e) { rej(e); return; }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
export async function loadSaved() {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      r.onsuccess = () => res(r.result || null); r.onerror = () => res(null);
    });
  } catch (e) { return null; }
}
async function writeSaved(obj) {
  try {
    const db = await idb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(obj, KEY);
  } catch (e) { /* storage unavailable: the app still works for this visit */ }
}
export async function clearSaved() {
  try { const db = await idb(); db.transaction(STORE, 'readwrite').objectStore(STORE).delete(KEY); } catch (e) {}
}
export const persist = debounce(() => { if (state.model) writeSaved(projectJSON(true)); }, 500);
