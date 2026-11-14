// Loading files, inferring types, the sample project, and building the joined dataset (the "data model").
import { DAY, isoDate, mulberry32, clamp, uid } from './util.js';
import { parse, analyze, compileRow } from './formula.js';

/* ---------------- value parsing ---------------- */
const NUM_RE = /^\s*[-+]?\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?\s*%?\s*$/;
const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;
const US_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;
export function parseNum(s) {
  if (s == null) return NaN;
  if (typeof s === 'number') return s;
  const t = String(s).trim();
  if (!t || !NUM_RE.test(t) || !/\d/.test(t)) return NaN;
  return Number(t.replace(/[$,%\s]/g, ''));
}
export function parseDate(s) {
  if (s == null) return NaN;
  const t = String(s).trim();
  let m = ISO_RE.exec(t);
  if (m) {
    if (m[7]) return Date.parse(t.replace(' ', 'T'));
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }
  m = US_RE.exec(t);
  if (m) {
    let h = +(m[4] || 0);
    if (m[7]) { const pm = /p/i.test(m[7]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
    return Date.UTC(+m[3], +m[1] - 1, +m[2], h, +(m[5] || 0), +(m[6] || 0));
  }
  return NaN;
}
export function inferType(raw) {
  let seen = 0, num = 0, date = 0;
  const step = Math.max(1, Math.floor(raw.length / 3000));
  for (let i = 0; i < raw.length; i += step) {
    const v = raw[i];
    if (v == null || v === '') continue;
    seen++;
    if (typeof v === 'number' || !Number.isNaN(parseNum(v))) num++;
    else if (!Number.isNaN(parseDate(v))) date++;
  }
  if (!seen) return 'string';
  if (num / seen >= 0.98) return 'number';
  if (date / seen >= 0.98) return 'date';
  return 'string';
}

/* ---------------- columns ---------------- */
export function buildColumn(name, raw, type) {
  const n = raw.length;
  let col;
  if (type === 'number') {
    const v = new Float64Array(n); let min = Infinity, max = -Infinity, ints = true, nulls = 0, dirty = false;
    for (let i = 0; i < n; i++) {
      const r = raw[i], x = parseNum(r); v[i] = x;
      if (Number.isNaN(x)) { nulls++; continue; }
      if (!dirty && typeof r === 'string' && /[$,%]/.test(r)) dirty = true;
      if (x < min) min = x; if (x > max) max = x; if (ints && !Number.isInteger(x)) ints = false;
    }
    col = { type, v, min, max, ints, nulls, dirty };
  } else if (type === 'date') {
    const v = new Float64Array(n); let min = Infinity, max = -Infinity, hasTime = false, nulls = 0, us = false;
    for (let i = 0; i < n; i++) {
      const r = raw[i], x = parseDate(r); v[i] = x;
      if (Number.isNaN(x)) { nulls++; continue; }
      if (!us && typeof r === 'string' && r.includes('/')) us = true;
      if (x < min) min = x; if (x > max) max = x; if (!hasTime && x % DAY !== 0) hasTime = true;
    }
    col = { type, v, min, max, hasTime, nulls, dateFmt: us ? 'us' : 'iso' };
  } else {
    const codes = new Int32Array(n), map = new Map(), dict = []; let nulls = 0;
    for (let i = 0; i < n; i++) {
      const r = raw[i];
      if (r == null || r === '') { codes[i] = -1; nulls++; continue; }
      const s = String(r);
      let c = map.get(s);
      if (c === undefined) { c = dict.length; dict.push(s); map.set(s, c); }
      codes[i] = c;
    }
    col = { type: 'string', codes, dict, nulls, map };
  }
  col.name = name;
  if (col.type === 'string') { col.counts = new Int32Array(col.dict.length); for (let i = 0; i < n; i++) if (col.codes[i] >= 0) col.counts[col.codes[i]]++; }
  return col;
}
function columnFromValues(name, vals, type) {
  const n = vals.length;
  if (type === 'number' || type === 'date') {
    const v = new Float64Array(n); let min = Infinity, max = -Infinity, ints = true, nulls = 0, hasTime = false;
    for (let i = 0; i < n; i++) {
      const x = vals[i]; if (x == null || Number.isNaN(x)) { v[i] = NaN; nulls++; continue; }
      v[i] = x; if (x < min) min = x; if (x > max) max = x; if (ints && !Number.isInteger(x)) ints = false; if (type === 'date' && x % DAY !== 0) hasTime = true;
    }
    return { name, type, v, min, max, ints, nulls, hasTime, dateFmt: 'iso' };
  }
  return buildColumn(name, vals.map(x => x == null ? '' : x === true ? 'True' : x === false ? 'False' : String(x)), 'string');
}

/* ---------------- tables ---------------- */
export function tableBase(name) { return (name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^(\d)/, '_$1') || 'data'); }
export function tableFromRows(name, format, text, rows, names) {
  const raw = names.map(() => new Array(rows.length));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    for (let j = 0; j < names.length; j++) { const v = r[names[j]]; raw[j][i] = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : v); }
  }
  return { id: uid(), name, base: tableBase(name), format, text, names, raw, n: rows.length };
}
// Parse CSV/TSV/JSON text into a table. Papa is the global PapaParse.
export function parseTable(name, text) {
  if (/\.json$/i.test(name) || /^\s*[[{]/.test(text)) {
    let rows = JSON.parse(text);
    if (!Array.isArray(rows)) rows = rows.data || rows.rows || Object.values(rows).find(Array.isArray) || [];
    if (!rows.length || typeof rows[0] !== 'object') throw new Error('expected an array of objects, like [{"city": "NYC", "sales": 12}]');
    const names = [...new Set(rows.slice(0, 1000).flatMap(r => Object.keys(r)))];
    return tableFromRows(name, 'json', text, rows, names);
  }
  const res = Papa.parse(text, { header: true, skipEmptyLines: 'greedy', dynamicTyping: false });
  const names = (res.meta.fields || []).filter(n => n !== '' && n != null);
  if (!names.length || !res.data.length) throw new Error('it has no header row or no data rows');
  const t = tableFromRows(name, 'csv', text, res.data, names);
  t.parseErrors = res.errors.length;
  return t;
}

/* ---------------- sample project ---------------- */
export function sampleTables() {
  const n = 9000, rnd = mulberry32(20250101);
  const pickIdx = w => { const s = w.reduce((a, b) => a + b, 0); let r = rnd() * s; for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; } return w.length - 1; };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const boroughs = ['Manhattan', 'Queens', 'Brooklyn', 'Bronx', 'Staten Island'], bw = [63, 16, 13, 6, 2];
  const pays = ['Credit card', 'Cash', 'No charge', 'Dispute'], pw = [74, 21, 3, 2];
  const mw = [92, 90, 102, 100, 105, 100, 88, 86, 98, 106, 103, 110];
  const hw = [3.2, 2.2, 1.5, 1.0, 0.9, 1.3, 2.6, 4.2, 5.2, 5.0, 4.6, 4.6, 4.8, 4.8, 5.0, 5.2, 5.4, 5.8, 6.4, 6.6, 6.0, 5.4, 4.8, 4.0];
  const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const names = ['pickup_datetime', 'pickup_borough', 'payment_type', 'passenger_count', 'trip_distance', 'trip_minutes', 'fare_amount', 'tip_amount', 'total_amount'];
  const raw = names.map(() => new Array(n));
  const r2 = x => Math.round(x * 100) / 100;
  for (let i = 0; i < n; i++) {
    const m = pickIdx(mw), d = 1 + Math.floor(rnd() * dim[m]), h = pickIdx(hw);
    const t = Date.UTC(2025, m, d, h, Math.floor(rnd() * 60), Math.floor(rnd() * 60));
    const b = boroughs[pickIdx(bw)];
    const airport = b === 'Queens' && rnd() < 0.3;
    const base = b === 'Manhattan' ? 1.7 : b === 'Staten Island' ? 4.2 : 3.1;
    const dist = airport ? 11 + rnd() * 8 : clamp(Math.exp(Math.log(base) + gauss() * 0.55), 0.3, 24);
    const rush = (h >= 7 && h <= 9) || (h >= 16 && h <= 19), night = h <= 5;
    const speed = (rush ? 7.5 : night ? 17 : 10.5) * (0.8 + rnd() * 0.4);
    const minutes = Math.max(2, dist / speed * 60);
    const pay = pays[pickIdx(pw)];
    const fare = r2(airport && rnd() < 0.7 ? 70 : 3 + 3.5 * dist + 0.35 * minutes);
    const tip = pay === 'Credit card' && rnd() > 0.1 ? r2(fare * (0.14 + rnd() * 0.12)) : 0;
    const extras = 1 + 0.5 + (b === 'Manhattan' ? 2.5 : 0) + (airport ? 1.75 : 0);
    const row = [isoDate(t, true), b, pay, String(1 + pickIdx([71, 15, 5, 3, 4, 2])), String(r2(dist)), String(Math.round(minutes * 10) / 10), String(fare), String(tip), String(r2(fare + tip + extras))];
    for (let j = 0; j < names.length; j++) raw[j][i] = row[j];
  }
  const trips = { id: 'sample-trips', name: 'nyc_taxi_trips_2025_sample.csv', base: 'nyc_taxi_trips_2025_sample', format: 'sample', names, raw, n };
  // 2020 U.S. Census populations; land area in square miles, rounded
  const census = [['Manhattan', '1694251', '22.7'], ['Brooklyn', '2736074', '69.4'], ['Queens', '2405464', '108.7'], ['Bronx', '1472654', '42.2'], ['Staten Island', '495747', '57.5']];
  const cnames = ['borough', 'population_2020', 'land_sq_mi'];
  const boroughsT = { id: 'sample-census', name: 'borough_census_2020.csv', base: 'borough_census_2020', format: 'sample', names: cnames, raw: cnames.map((_, j) => census.map(r => r[j])), n: census.length };
  return [trips, boroughsT];
}
export function tablesToCSV(t) {
  const cell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const lines = [t.names.map(cell).join(',')];
  for (let i = 0; i < t.n; i++) lines.push(t.raw.map(c => cell(c[i] ?? '')).join(','));
  return lines.join('\n') + '\n';
}

/* ---------------- dataset (joined + typed + calculated) ---------------- */
const DIM_NAME_RE = /(^|[_\s-])(id|year|yr|zip|zipcode|postal|code|fips|key)$/i;
export const srcKey = (t, c) => `${t.id}::${c}`;
const normKey = v => { if (v == null) return null; const s = String(v).trim(); return s === '' ? null : s; };

export function buildDataset(model) {
  const tables = model.tables, prim = tables[0];
  let idx = [null], n = prim.n;
  const order = [prim], owner = new Map(), warnings = [];
  prim.names.forEach(c => owner.set(srcKey(prim, c), 0));
  const rawAt = (pos, ci) => { const t = order[pos], r = t.raw[ci], ix = idx[pos]; if (!ix) return r; const out = new Array(n); for (let i = 0; i < n; i++) out[i] = ix[i] < 0 ? '' : r[ix[i]]; return out; };

  for (const j of model.joins) {
    const t = tables.find(x => x.id === j.tableId);
    if (!t) continue;
    const lpos = owner.get(j.leftKey);
    const rci = t.names.indexOf(j.rightKey);
    if (lpos == null || rci < 0) { warnings.push(`Join to ${t.name} skipped: its key column is missing.`); continue; }
    const [, lcol] = j.leftKey.split('::');
    const lraw = order[lpos].raw[order[lpos].names.indexOf(lcol)];
    const map = new Map();
    for (let r = 0; r < t.n; r++) { const k = normKey(t.raw[rci][r]); if (k == null) continue; let a = map.get(k); if (!a) map.set(k, a = []); a.push(r); }
    const cur = idx.map(ix => ix || Int32Array.from({ length: n }, (_, i) => i));
    const out = cur.map(() => []), tIdx = [];
    let matched = 0;
    for (let i = 0; i < n; i++) {
      const li = cur[lpos][i];
      const k = li < 0 ? null : normKey(lraw[li]);
      const m = k == null ? null : map.get(k);
      if (m) { matched++; for (const r of m) { for (let qq = 0; qq < cur.length; qq++) out[qq].push(cur[qq][i]); tIdx.push(r); } }
      else if (j.type !== 'inner') { for (let qq = 0; qq < cur.length; qq++) out[qq].push(cur[qq][i]); tIdx.push(-1); }
    }
    j._stats = { matched, total: n, rowsAfter: tIdx.length };
    idx = out.map(a => Int32Array.from(a)); idx.push(Int32Array.from(tIdx));
    n = tIdx.length;
    order.push(t);
    t.names.forEach(c => owner.set(srcKey(t, c), order.length - 1));
  }

  const fields = [], cols = {}, used = new Set();
  order.forEach((t, pos) => {
    t.inferred = t.inferred || [];
    t.names.forEach((c, ci) => {
      const sk = srcKey(t, c), ov = model.fields[sk] || {};
      let name = ov.name || (used.has(c) ? `${t.base}.${c}` : c);
      while (used.has(name)) name += '_';
      used.add(name);
      if (!t.inferred[ci]) t.inferred[ci] = inferType(t.raw[ci]);
      const raw = rawAt(pos, ci);
      const col = buildColumn(name, raw, ov.type || t.inferred[ci]);
      const role = ov.role || (col.type === 'number' && !(DIM_NAME_RE.test(c) && col.ints) ? 'measure' : 'dim');
      cols[name] = col;
      fields.push({ name, key: sk, type: col.type, role, hidden: !!ov.hidden, table: t.name, tableBase: t.base, tableId: t.id, src: c, pos, inferred: t.inferred[ci] });
    });
  });

  // calculated fields, in order (a calc may use any field defined before it)
  const aggAsts = new Map();
  for (const calc of model.calcs) {
    const ov = model.fields['calc::' + calc.id] || {};
    const base = { name: calc.name, key: 'calc::' + calc.id, hidden: !!ov.hidden, table: 'Calculations', calc: { id: calc.id, formula: calc.formula } };
    if (used.has(calc.name)) { fields.push({ ...base, type: 'error', role: 'dim', calc: { ...base.calc, error: `Another field is already named ${calc.name}.` } }); continue; }
    try {
      const ast = parse(calc.formula);
      const info = analyze(ast, nm => {
        if (aggAsts.has(nm)) return { aggregate: true, type: 'number' };
        const c = cols[nm]; return c ? { type: c.type } : null;
      });
      used.add(calc.name);
      if (info.aggregate) {
        if (info.type !== 'number' && info.type !== 'null') throw new Error('A formula that aggregates must return a number. Wrap text results in a row-level formula instead.');
        aggAsts.set(calc.name, ast);
        fields.push({ ...base, type: info.type === 'date' ? 'date' : 'number', role: 'measure', calc: { ...base.calc, ast, aggregate: true, resultType: info.type } });
      } else {
        const fn = compileRow(ast, getterFor(cols));
        const vals = new Array(n);
        for (let i = 0; i < n; i++) vals[i] = fn(i);
        const type = info.type === 'number' ? 'number' : info.type === 'date' ? 'date' : 'string';
        const col = columnFromValues(calc.name, vals, type);
        cols[calc.name] = col;
        fields.push({ ...base, type, role: ov.role || (type === 'number' ? 'measure' : 'dim'), calc: { ...base.calc, ast, aggregate: false, resultType: info.type } });
      }
    } catch (e) {
      fields.push({ ...base, type: 'error', role: 'dim', calc: { ...base.calc, error: e.message, pos: e.pos } });
    }
  }
  fields.push({ name: 'Records', key: 'records', type: 'records', role: 'measure', table: '' });
  const fieldMap = new Map(fields.map(f => [f.name, f]));
  return { n, fields, fieldMap, cols, order, aggAsts, warnings, sig: order.map(t => t.name).join('+') };
}

export function getterFor(cols) {
  return name => {
    const c = cols[name];
    if (!c) return () => null;
    if (c.type === 'string') return i => { const k = c.codes[i]; return k < 0 ? null : c.dict[k]; };
    return i => { const v = c.v[i]; return Number.isNaN(v) ? null : v; };
  };
}

// Rewrite [old] references in a formula when a field is renamed.
export function renameInFormula(formula, oldName, newName) {
  const esc = s => s.replace(/]/g, ']]');
  return formula.split(`[${esc(oldName)}]`).join(`[${esc(newName)}]`);
}
