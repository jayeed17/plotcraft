// The query engine: filter rows, group by every dimension pill, aggregate every measure pill.
// Its results are checked against DuckDB running the SQL from sql.js (see tests/).
import { state, field, col } from './store.js';
import { PARTS, AGGS, aliasOf, colorFold } from './pills.js';
import { compileAggregate, newAccumulator, accumulate, finish } from './formula.js';
import { getterFor } from './data.js';

export function queryPlan(sh) {
  const dims = [], measures = [], seen = new Set();
  for (const shelf of ['cols', 'rows', 'color', 'size', 'label', 'detail']) {
    for (const p of sh.shelves[shelf]) {
      if (!field(p.field)) continue;
      const alias = aliasOf(p, shelf);
      if (seen.has(alias)) continue;
      seen.add(alias);
      (p.kind === 'measure' ? measures : dims).push({ p, alias, shelf, fold: shelf === 'color' ? colorFold(p) : null });
    }
  }
  return { dims, measures };
}

export function dimAccessor(d) {
  const p = d.p, c = col(p.field);
  if (c.type === 'string') {
    if (d.fold) { const fold = d.fold; return { key: i => { const k = c.codes[i]; return k < 0 ? -1 : fold.has(k) ? k : -2; }, out: k => k === -1 ? null : k === -2 ? 'Other' : c.dict[k] }; }
    return { key: i => c.codes[i], out: k => k < 0 ? null : c.dict[k] };
  }
  if (c.type === 'number') {
    if (p.bin) { const b = p.bin; return { key: i => { const v = c.v[i]; return Number.isNaN(v) ? NaN : Math.round(Math.floor(v / b) * b * 1e9) / 1e9; }, out: k => Number.isNaN(k) ? null : k }; }
    return { key: i => c.v[i], out: k => Number.isNaN(k) ? null : k };
  }
  const part = PARTS[p.part];
  return { key: i => { const t = c.v[i]; return Number.isNaN(t) ? NaN : part.f(t); }, out: k => Number.isNaN(k) ? null : (part.out ? part.out(k) : k) };
}

export function rowMask(filters) {
  const n = state.DS.n;
  let idx = null;
  for (const fp of filters) {
    const c = col(fp.field), ft = fp.filter;
    if (!c) continue;
    let test = null;
    if (ft.type === 'set' && ft.include) {
      if (c.type !== 'string') continue;
      const allowed = new Set(); let allowNull = false;
      for (const v of ft.include) { if (v === 'Null') allowNull = true; const k = c.map.get(v); if (k !== undefined) allowed.add(k); }
      test = i => { const k = c.codes[i]; return k < 0 ? allowNull : allowed.has(k); };
    } else if (ft.type === 'range' && (ft.min != null || ft.max != null)) {
      const lo = ft.min == null ? -Infinity : ft.min;
      const hi = ft.max == null ? Infinity : (c.type === 'date' ? ft.max + 864e5 : ft.max);
      test = c.type === 'date' ? i => { const v = c.v[i]; return v >= lo && v < hi; } : i => { const v = c.v[i]; return v >= lo && v <= hi; };
    } else if (ft.type === 'match') {
      const p = { field: fp.field, kind: 'dim', part: ft.part, bin: ft.bin };
      const acc = dimAccessor({ p, fold: ft.fold ? colorFold(p) : null });
      const want = new Set(ft.values);
      test = i => { const v = acc.out(acc.key(i)); return want.has(v); };
    }
    if (!test) continue;
    const next = [];
    if (idx === null) { for (let i = 0; i < n; i++) if (test(i)) next.push(i); }
    else for (const i of idx) if (test(i)) next.push(i);
    idx = next;
  }
  return idx;
}

function measureSpec(m) {
  const p = m.p, f = field(p.field);
  if (f.type === 'records') return { m, kind: 'records' };
  if (f.calc && f.calc.aggregate) {
    const { slots, final } = compileAggregate(f.calc.ast, getterFor(state.DS.cols), nm => state.DS.aggAsts.get(nm));
    return { m, kind: 'calc', slots, final };
  }
  const c = col(p.field), fn = AGGS[p.agg].fn;
  if (c.type === 'string') return { m, kind: 'field', fn, val: i => { const k = c.codes[i]; return k < 0 ? null : k; } };
  return { m, kind: 'field', fn, val: i => { const v = c.v[i]; return Number.isNaN(v) ? null : v; } };
}

export function runQuery(sh, extra = []) {
  const plan = queryPlan(sh);
  return runPlan(plan, [...(sh.shelves.filters || []), ...extra]);
}

export function runPlan(plan, filters) {
  const t0 = performance.now();
  const DS = state.DS;
  const idx = rowMask(filters);
  const matched = idx ? idx.length : DS.n;
  const acc = plan.dims.map(dimAccessor);
  const ms = plan.measures.map(measureSpec);
  const groups = new Map(), list = [];
  const keys = new Array(acc.length);
  const fresh = () => ms.map(x => x.kind === 'records' ? { n: 0 } : x.kind === 'calc' ? x.slots.map(s => newAccumulator(s.fn)) : newAccumulator(x.fn));
  const visit = i => {
    for (let j = 0; j < acc.length; j++) keys[j] = acc[j].key(i);
    const key = keys.join('\u0001');
    let g = groups.get(key);
    if (!g) { g = { k: keys.slice(), s: fresh() }; groups.set(key, g); list.push(g); }
    for (let j = 0; j < ms.length; j++) {
      const x = ms[j], st = g.s[j];
      if (x.kind === 'records') st.n++;
      else if (x.kind === 'field') accumulate(x.fn, st, x.val(i));
      else for (let s = 0; s < x.slots.length; s++) accumulate(x.slots[s].fn, st[s], x.slots[s].inner(i));
    }
  };
  if (idx) for (const i of idx) visit(i); else for (let i = 0; i < DS.n; i++) visit(i);
  if (!acc.length && !list.length && ms.length) list.push({ k: [], s: fresh() });

  const cmps = plan.dims.map((d, j) => {
    const c = col(d.p.field);
    if (c.type === 'string') return (a, b) => {
      const ka = a.k[j], kb = b.k[j];
      if (ka === kb) return 0; if (ka === -1) return 1; if (kb === -1) return -1;
      const sa = ka === -2 ? 'Other' : c.dict[ka], sb = kb === -2 ? 'Other' : c.dict[kb];
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    };
    return (a, b) => { const ka = a.k[j], kb = b.k[j]; const na = Number.isNaN(ka), nb = Number.isNaN(kb); if (na || nb) return na === nb ? 0 : na ? 1 : -1; return ka - kb; };
  });
  list.sort((a, b) => { for (const f of cmps) { const r = f(a, b); if (r) return r; } return 0; });

  const rows = list.map(g => {
    const r = {};
    plan.dims.forEach((d, j) => { r[d.alias] = acc[j].out(g.k[j]); });
    ms.forEach((x, j) => {
      const st = g.s[j], a = x.m.alias;
      if (x.kind === 'records') r[a] = st.n;
      else if (x.kind === 'field') r[a] = finish(x.fn, st);
      else { const v = x.final(x.slots.map((s, q) => finish(s.fn, st[q]))); r[a] = typeof v === 'number' && !Number.isFinite(v) ? null : v; }
    });
    return r;
  });
  return { rows, plan, matched, ms: performance.now() - t0, idx };
}
