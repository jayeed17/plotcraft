// Turns a sheet into DuckDB SQL that returns the same table as the engine (joins, type fixes,
// calculated fields and filters included). tests/duckdb_parity.py runs it against DuckDB.
import { state, field, col } from './store.js';
import { PARTS, AGGS, colorFold } from './pills.js';
import { queryPlan } from './engine.js';
import { toSQL } from './formula.js';
import { isoDate } from './util.js';

export const qid = s => '"' + String(s).replace(/"/g, '""') + '"';
export const qstr = s => "'" + String(s).replace(/'/g, "''") + "'";

function baseExpr(f, alias) {
  const c = col(f.name), x = `${alias}${qid(f.src)}`;
  if (f.type === 'number' && (c.dirty || f.inferred !== 'number')) return `TRY_CAST(regexp_replace(CAST(${x} AS VARCHAR), '[$,%\\s]', '', 'g') AS DOUBLE)`;
  if (f.type === 'date' && (c.dateFmt === 'us' || f.inferred !== 'date')) {
    const v = `CAST(${x} AS VARCHAR)`;
    return `COALESCE(TRY_CAST(${x} AS TIMESTAMP), try_strptime(${v}, '%m/%d/%Y %H:%M:%S'), try_strptime(${v}, '%m/%d/%Y %H:%M'), try_strptime(${v}, '%m/%d/%Y'))`;
  }
  if (f.type === 'string' && f.inferred !== 'string') return `CAST(${x} AS VARCHAR)`;
  return x;
}

// Collect the source fields a query touches (calc dependencies included).
function collectDeps(names) {
  const out = new Set(), seen = new Set();
  const visit = nm => {
    if (seen.has(nm)) return; seen.add(nm);
    const f = field(nm);
    if (!f || f.type === 'records') return;
    if (f.calc) { if (f.calc.ast) walk(f.calc.ast); return; }
    out.add(nm);
  };
  const walk = n => {
    if (!n) return;
    if (n.t === 'field') visit(n.name);
    if (n.a) walk(n.a); if (n.b) walk(n.b);
    if (n.args) n.args.forEach(walk);
    if (n.branches) n.branches.forEach(([c, v]) => { walk(c); walk(v); });
    if (n.els) walk(n.els);
  };
  names.forEach(visit);
  return out;
}

export function sourceContext(names) {
  const DS = state.DS;
  const used = collectDeps(names);
  const multi = DS.order.length > 1;
  const needsCTE = multi || [...used].some(nm => { const f = field(nm); return f.name !== f.src || baseExpr(f, '') !== qid(f.src); });
  const ref = nm => {
    const f = field(nm);
    if (f.calc) return calcSQL(f);
    return needsCTE ? qid(nm) : qid(f.src);
  };
  function calcSQL(f) {
    const body = toSQL(f.calc.ast, name => { const g = field(name); return g && g.calc ? calcSQL(g) : ref(name); });
    if (f.calc.resultType === 'bool') return `(CASE WHEN ${body} THEN 'True' WHEN NOT ${body} THEN 'False' END)`;
    return `(${body})`;
  }
  let cte = null, from;
  if (needsCTE) {
    const sel = [...used].map(nm => { const f = field(nm); return `${baseExpr(f, `t${f.pos}.`)} AS ${qid(nm)}`; });
    let fromT = `${qid(DS.order[0].base)} AS t0`;
    state.model.joins.forEach(j => {
      const pos = DS.order.findIndex(t => t.id === j.tableId);
      if (pos < 1) return;
      const [lid, lcol] = j.leftKey.split('::');
      const lpos = DS.order.findIndex(t => t.id === lid);
      fromT += `\n  ${j.type === 'inner' ? 'INNER' : 'LEFT'} JOIN ${qid(DS.order[pos].base)} AS t${pos}\n    ON trim(CAST(t${lpos}.${qid(lcol)} AS VARCHAR)) = trim(CAST(t${pos}.${qid(j.rightKey)} AS VARCHAR))`;
    });
    cte = `WITH src AS (\n  SELECT\n    ${sel.length ? sel.join(',\n    ') : '1 AS one'}\n  FROM ${fromT}\n)`;
    from = 'src';
  } else from = qid(DS.order[0].base);
  return { cte, from, ref, calcSQL };
}

function aggSQL(ast, ctx) {
  const walk = (n) => toSQL(n, (name, node) => {
    const g = field(name);
    if (node && node._agg) return `(${walk(state.DS.aggAsts.get(name))})`;
    return g && g.calc ? ctx.calcSQL(g) : ctx.ref(name);
  });
  return walk(ast);
}

export function dimSQL(d, ctx) {
  const p = d.p, c = col(p.field), x = ctx.ref(p.field);
  if (c.type === 'date') return PARTS[p.part].sql(`${x}::TIMESTAMP`);
  if (c.type === 'number' && p.bin) return `round(floor(${x} / ${p.bin}) * ${p.bin}, 9)`;
  if (c.type === 'string' && d.fold) {
    const keep = [...d.fold].map(k => qstr(c.dict[k])).join(', ');
    return `CASE WHEN ${x} IN (${keep}) THEN ${x} WHEN ${x} IS NULL THEN NULL ELSE 'Other' END`;
  }
  return x;
}
function measureSQL(p, ctx) {
  const f = field(p.field);
  if (f.type === 'records') return 'COUNT(*)';
  if (f.calc && f.calc.aggregate) return `(${aggSQL(f.calc.ast, ctx)})`;
  const x = ctx.ref(p.field);
  if (p.agg === 'countd') return `COUNT(DISTINCT ${x})`;
  return `${AGGS[p.agg].fn}(${x})`;
}
function literal(v, c, part) {
  if (v == null) return null;
  if (c.type === 'date') {
    const P = PARTS[part];
    if (P.cont) return `TIMESTAMP '${isoDate(v, true)}'`;
    return String(P.back(v) + (part === 'hour' ? 0 : 1));
  }
  return typeof v === 'number' ? String(v) : qstr(v);
}
function filterSQL(fp, ctx) {
  const c = col(fp.field), x = ctx.ref(fp.field), ft = fp.filter;
  if (!c) return '';
  if (ft.type === 'set' && ft.include) {
    const vals = ft.include.filter(v => v !== 'Null'), parts = [];
    if (vals.length) parts.push(`${x} IN (${vals.map(qstr).join(', ')})`);
    if (ft.include.includes('Null')) parts.push(`${x} IS NULL`);
    if (!parts.length) return 'FALSE';
    return parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0];
  }
  if (ft.type === 'range') {
    const out = [];
    if (c.type === 'date') {
      if (ft.min != null) out.push(`${x}::TIMESTAMP >= TIMESTAMP '${isoDate(ft.min, true)}'`);
      if (ft.max != null) out.push(`${x}::TIMESTAMP < TIMESTAMP '${isoDate(ft.max + 864e5, true)}'`);
    } else {
      if (ft.min != null) out.push(`${x} >= ${ft.min}`);
      if (ft.max != null) out.push(`${x} <= ${ft.max}`);
    }
    return out.join(' AND ');
  }
  if (ft.type === 'match') {
    const p = { field: fp.field, kind: 'dim', part: ft.part, bin: ft.bin };
    const e = dimSQL({ p, fold: ft.fold ? colorFold(p) : null }, ctx);
    const lits = ft.values.filter(v => v != null).map(v => literal(v, c, ft.part));
    const parts = [];
    if (lits.length) parts.push(lits.length === 1 ? `${e} = ${lits[0]}` : `${e} IN (${lits.join(', ')})`);
    if (ft.values.some(v => v == null)) parts.push(`${e} IS NULL`);
    return parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0] || 'FALSE';
  }
  return '';
}

export function buildSQL(sh, extra = []) {
  const plan = queryPlan(sh);
  const filters = [...sh.shelves.filters, ...extra].filter(fp => col(fp.field));
  if (!plan.dims.length && !plan.measures.length) return null;
  const ctx = sourceContext([...plan.dims.map(d => d.p.field), ...plan.measures.map(m => m.p.field), ...filters.map(f => f.field)]);
  const sel = [];
  plan.dims.forEach(d => {
    const note = col(d.p.field).type === 'date' && PARTS[d.p.part].sqlNote;
    sel.push([`${dimSQL(d, ctx)} AS ${qid(d.alias)}`, note]);
  });
  plan.measures.forEach(m => sel.push([`${measureSQL(m.p, ctx)} AS ${qid(m.alias)}`, null]));
  const where = filters.map(f => filterSQL(f, ctx)).filter(Boolean);
  const DS = state.DS;
  let s = DS.order.map(t => `-- load once: CREATE TABLE ${qid(t.base)} AS SELECT * FROM read_csv('${t.name.replace(/'/g, "''")}');`).join('\n') + '\n';
  if (ctx.cte) s += ctx.cte + '\n';
  s += 'SELECT\n' + sel.map(([x, note], i) => `  ${x}${i < sel.length - 1 ? ',' : ''}${note ? `  -- ${note}` : ''}`).join('\n');
  s += `\nFROM ${ctx.from}`;
  if (where.length) s += '\nWHERE ' + where.join('\n  AND ');
  if (plan.dims.length) s += '\nGROUP BY ALL\nORDER BY ' + plan.dims.map((_, i) => i + 1).join(', ');
  return s + ';';
}

export function highlightSQL(s) {
  const esc = t => t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return s.split('\n').map(line => {
    const ci = line.indexOf('--');
    const code = ci >= 0 ? line.slice(0, ci) : line, cm = ci >= 0 ? line.slice(ci) : '';
    const h = esc(code)
      .replace(/('(?:[^']|'')*')/g, '<span class="str">$1</span>')
      .replace(/\b(WITH|SELECT|FROM|WHERE|AND|OR|GROUP BY ALL|ORDER BY|AS|CASE|WHEN|THEN|ELSE|END|IN|IS|NULL|NOT|COUNT|DISTINCT|SUM|AVG|MEDIAN|MIN|MAX|TIMESTAMP|FALSE|TRUE|LEFT JOIN|INNER JOIN|JOIN|ON|CAST|TRY_CAST|COALESCE|NULLIF)\b/g, '<span class="kw">$1</span>');
    return h + (cm ? `<span class="cm">${esc(cm)}</span>` : '');
  }).join('\n');
}
