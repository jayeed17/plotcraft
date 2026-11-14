// Calculated-field language: a Tableau-style formula syntax with a parser, a type checker,
// a row-level compiler, an aggregate compiler and a DuckDB SQL translator. No eval anywhere.
import { DAY } from './util.js';

export class FormulaError extends Error { constructor(msg, pos) { super(msg); this.pos = pos; } }

const N = 'number', S = 'string', D = 'date', B = 'bool', NUL = 'null';
const KEYWORDS = new Set(['IF', 'THEN', 'ELSEIF', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'TRUE', 'FALSE', 'NULL']);
const DATE_PARTS = ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second'];

/* ---------------- tokenizer ---------------- */
function tokenize(src) {
  const toks = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    const start = i;
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      i += m[0].length; toks.push({ t: 'num', v: Number(m[0]), pos: start }); continue;
    }
    if (c === '"' || c === "'") {
      let s = ''; i++;
      for (;;) {
        if (i >= src.length) throw new FormulaError('This text is missing its closing quote.', start);
        if (src[i] === c) { if (src[i + 1] === c) { s += c; i += 2; continue; } i++; break; }
        s += src[i++];
      }
      toks.push({ t: 'str', v: s, pos: start }); continue;
    }
    if (c === '[') {
      let s = ''; i++;
      for (;;) {
        if (i >= src.length) throw new FormulaError('A field name is missing its closing ].', start);
        if (src[i] === ']') { if (src[i + 1] === ']') { s += ']'; i += 2; continue; } i++; break; }
        s += src[i++];
      }
      toks.push({ t: 'field', v: s, pos: start }); continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '<>', '!=', '=='].includes(two)) { toks.push({ t: 'op', v: two === '==' ? '=' : two === '!=' ? '<>' : two, pos: start }); i += 2; continue; }
    if ('+-*/%^(),=<>'.includes(c)) { toks.push({ t: 'op', v: c, pos: start }); i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)); i += m[0].length;
      const up = m[0].toUpperCase();
      toks.push(KEYWORDS.has(up) ? { t: 'kw', v: up, pos: start } : { t: 'id', v: up, raw: m[0], pos: start }); continue;
    }
    throw new FormulaError(`Unexpected character "${c}".`, start);
  }
  toks.push({ t: 'eof', pos: src.length });
  return toks;
}

/* ---------------- parser ---------------- */
export function parse(src) {
  if (!String(src).trim()) throw new FormulaError('Write a formula, for example SUM([Sales]) / SUM([Units]).', 0);
  const toks = tokenize(src); let k = 0;
  const peek = () => toks[k], next = () => toks[k++];
  const isOp = v => peek().t === 'op' && peek().v === v;
  const isKw = v => peek().t === 'kw' && peek().v === v;
  const expect = (t, v, msg) => { const x = peek(); if (x.t !== t || (v && x.v !== v)) throw new FormulaError(msg, x.pos); return next(); };
  const expr = () => or();
  function or() { let a = and(); while (isKw('OR')) { const p = next().pos; a = { t: 'bin', op: 'OR', a, b: and(), pos: p }; } return a; }
  function and() { let a = not(); while (isKw('AND')) { const p = next().pos; a = { t: 'bin', op: 'AND', a, b: not(), pos: p }; } return a; }
  function not() { if (isKw('NOT')) { const p = next().pos; return { t: 'un', op: 'NOT', a: not(), pos: p }; } return cmp(); }
  function cmp() {
    const a = add(), x = peek();
    if (x.t === 'op' && ['=', '<>', '<', '<=', '>', '>='].includes(x.v)) { next(); return { t: 'bin', op: x.v, a, b: add(), pos: x.pos }; }
    return a;
  }
  function add() { let a = mul(); while (isOp('+') || isOp('-')) { const x = next(); a = { t: 'bin', op: x.v, a, b: mul(), pos: x.pos }; } return a; }
  function mul() { let a = unary(); while (isOp('*') || isOp('/') || isOp('%')) { const x = next(); a = { t: 'bin', op: x.v, a, b: unary(), pos: x.pos }; } return a; }
  function unary() { if (isOp('-')) { const p = next().pos; return { t: 'un', op: '-', a: unary(), pos: p }; } if (isOp('+')) { next(); return unary(); } return pow(); }
  function pow() { const a = primary(); if (isOp('^')) { const x = next(); return { t: 'bin', op: '^', a, b: unary(), pos: x.pos }; } return a; }
  function primary() {
    const x = peek();
    if (x.t === 'num') { next(); return { t: 'num', v: x.v, pos: x.pos }; }
    if (x.t === 'str') { next(); return { t: 'str', v: x.v, pos: x.pos }; }
    if (x.t === 'field') { next(); return { t: 'field', name: x.v, pos: x.pos }; }
    if (x.t === 'kw') {
      if (x.v === 'TRUE' || x.v === 'FALSE') { next(); return { t: 'bool', v: x.v === 'TRUE', pos: x.pos }; }
      if (x.v === 'NULL') { next(); return { t: 'null', pos: x.pos }; }
      if (x.v === 'IF') {
        next();
        const branches = [];
        let cond = expr(); expect('kw', 'THEN', 'Add THEN after the IF condition.'); branches.push([cond, expr()]);
        while (isKw('ELSEIF')) { next(); cond = expr(); expect('kw', 'THEN', 'Add THEN after the ELSEIF condition.'); branches.push([cond, expr()]); }
        let els = null; if (isKw('ELSE')) { next(); els = expr(); }
        expect('kw', 'END', 'Close the IF with END.');
        return { t: 'if', branches, els, pos: x.pos };
      }
    }
    if (x.t === 'id') {
      next();
      expect('op', '(', `Add ( after ${x.raw}.`);
      const args = [];
      if (!isOp(')')) { args.push(expr()); while (isOp(',')) { next(); args.push(expr()); } }
      expect('op', ')', `Close ${x.raw}( with ).`);
      return { t: 'call', fn: x.v, raw: x.raw, args, pos: x.pos };
    }
    if (isOp('(')) { next(); const e = expr(); expect('op', ')', 'A ( is missing its closing ).'); return e; }
    throw new FormulaError(x.t === 'eof' ? 'The formula ends too early.' : `Unexpected "${x.v}".`, x.pos);
  }
  const ast = expr();
  if (peek().t !== 'eof') throw new FormulaError(`Unexpected "${peek().v}". Check for a missing operator or comma.`, peek().pos);
  return ast;
}

/* ---------------- helpers for dates ---------------- */
const ymd = t => { const d = new Date(t); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]; };
function truncDate(part, t) {
  const [y, m, d, h, mi, s] = ymd(t);
  switch (part) {
    case 'year': return Date.UTC(y, 0, 1);
    case 'quarter': return Date.UTC(y, Math.floor(m / 3) * 3, 1);
    case 'month': return Date.UTC(y, m, 1);
    case 'week': { const day0 = Date.UTC(y, m, d); return day0 - ((new Date(t).getUTCDay() + 6) % 7) * DAY; }
    case 'day': return Date.UTC(y, m, d);
    case 'hour': return Date.UTC(y, m, d, h);
    case 'minute': return Date.UTC(y, m, d, h, mi);
    case 'second': return Date.UTC(y, m, d, h, mi, s);
  }
  return t;
}
function isoWeek(t) {
  const d = new Date(Date.UTC(...ymd(t).slice(0, 3)));
  const dn = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dn + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - firstThu) / DAY - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
}
function datePart(part, t) {
  const [y, m, d, h, mi, s] = ymd(t);
  switch (part) {
    case 'year': return y; case 'quarter': return Math.floor(m / 3) + 1; case 'month': return m + 1;
    case 'week': return isoWeek(t); case 'day': return d; case 'hour': return h; case 'minute': return mi; case 'second': return s;
    case 'weekday': return ((new Date(t).getUTCDay() + 6) % 7) + 1;
  }
  return null;
}
function dateDiff(part, a, b) {
  const [ya, ma] = ymd(a), [yb, mb] = ymd(b);
  switch (part) {
    case 'year': return yb - ya;
    case 'quarter': return (yb * 4 + Math.floor(mb / 3)) - (ya * 4 + Math.floor(ma / 3));
    case 'month': return (yb * 12 + mb) - (ya * 12 + ma);
    case 'week': return Math.round((truncDate('week', b) - truncDate('week', a)) / (7 * DAY));
    case 'day': return Math.round((truncDate('day', b) - truncDate('day', a)) / DAY);
    case 'hour': return Math.floor(b / 36e5) - Math.floor(a / 36e5);
    case 'minute': return Math.floor(b / 6e4) - Math.floor(a / 6e4);
    case 'second': return Math.floor(b / 1e3) - Math.floor(a / 1e3);
  }
  return null;
}
function addMonths(t, n) {
  const [y, m, d, h, mi, s] = ymd(t);
  const target = y * 12 + m + n, ty = Math.floor(target / 12), tm = target - ty * 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return Date.UTC(ty, tm, Math.min(d, last), h, mi, s) + (t % 1000);
}
function dateAdd(part, n, t) {
  n = Math.trunc(n);
  switch (part) {
    case 'year': return addMonths(t, 12 * n); case 'quarter': return addMonths(t, 3 * n); case 'month': return addMonths(t, n);
    case 'week': return t + 7 * n * DAY; case 'day': return t + n * DAY; case 'hour': return t + n * 36e5;
    case 'minute': return t + n * 6e4; case 'second': return t + n * 1e3;
  }
  return null;
}
export function parseDateLoose(s) {
  if (s == null) return null;
  const t = String(s).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(t);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2]);
  return null;
}
const strOf = v => typeof v === 'number' ? String(v) : String(v);
const numOf = v => { if (typeof v === 'number') return v; const x = Number(String(v).replace(/[$,%\s]/g, '')); return String(v).trim() === '' || Number.isNaN(x) ? null : x; };

/* ---------------- function table ---------------- */
// sig: argument types (N, S, D, B, 'any', 'part'); opt: count of optional trailing args.
// js: implementation on non-null args (nulls return null unless nullSafe); sql: translator.
const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const lit = n => n.t === 'str' ? n.v.toLowerCase() : null;
export const FUNCS = {
  ABS: { sig: [N], ret: N, js: x => Math.abs(x), sql: ([a]) => `abs(${a})`, doc: 'Absolute value' },
  ROUND: { sig: [N, N], opt: 1, ret: N, js: (x, d = 0) => { const f = Math.pow(10, Math.trunc(d)); return Math.sign(x) * Math.round(Math.abs(x) * f) / f; }, sql: ([a, d]) => `round(${a}, ${d === undefined ? 0 : `CAST(${d} AS INTEGER)`})`, doc: 'Round to d decimals' },
  FLOOR: { sig: [N], ret: N, js: x => Math.floor(x), sql: ([a]) => `floor(${a})`, doc: 'Round down' },
  CEILING: { sig: [N], ret: N, js: x => Math.ceil(x), sql: ([a]) => `ceil(${a})`, doc: 'Round up' },
  SQRT: { sig: [N], ret: N, js: x => x < 0 ? null : Math.sqrt(x), sql: ([a]) => `CASE WHEN ${a} >= 0 THEN sqrt(${a}) END`, doc: 'Square root' },
  POWER: { sig: [N, N], ret: N, js: (a, b) => Math.pow(a, b), sql: ([a, b]) => `pow(${a}, ${b})`, doc: 'a to the power b' },
  EXP: { sig: [N], ret: N, js: x => Math.exp(x), sql: ([a]) => `exp(${a})`, doc: 'e to the power x' },
  LN: { sig: [N], ret: N, js: x => x > 0 ? Math.log(x) : null, sql: ([a]) => `CASE WHEN ${a} > 0 THEN ln(${a}) END`, doc: 'Natural log' },
  LOG: { sig: [N, N], opt: 1, ret: N, js: (x, b = 10) => x > 0 && b > 0 && b !== 1 ? Math.log(x) / Math.log(b) : null, sql: ([a, b]) => b === undefined ? `CASE WHEN ${a} > 0 THEN log10(${a}) END` : `CASE WHEN ${a} > 0 AND ${b} > 0 AND ${b} <> 1 THEN ln(${a}) / ln(${b}) END`, doc: 'Log, base 10 by default' },
  SIGN: { sig: [N], ret: N, js: x => Math.sign(x), sql: ([a]) => `sign(${a})`, doc: '-1, 0 or 1' },
  DIV: { sig: [N, N], ret: N, js: (a, b) => b === 0 ? null : Math.trunc(a / b), sql: ([a, b]) => `trunc(${a} / NULLIF(${b}, 0))`, doc: 'Whole-number division' },
  ZN: { sig: [N], ret: N, nullSafe: true, js: x => x == null ? 0 : x, sql: ([a]) => `COALESCE(${a}, 0)`, doc: 'Null becomes 0' },
  IFNULL: { sig: ['any', 'any'], ret: 'same', nullSafe: true, js: (a, b) => a == null ? b : a, sql: ([a, b]) => `COALESCE(${a}, ${b})`, doc: 'First value unless it is null' },
  ISNULL: { sig: ['any'], ret: B, nullSafe: true, js: a => a == null, sql: ([a]) => `(${a} IS NULL)`, doc: 'True when the value is null' },
  IIF: { sig: [B, 'any', 'any'], ret: 'same2', nullSafe: true, js: (c, a, b) => c === true ? a : b, sql: ([c, a, b]) => `CASE WHEN ${c} THEN ${a} ELSE ${b} END`, doc: 'IIF(test, then, else)' },
  LEN: { sig: [S], ret: N, js: s => s.length, sql: ([a]) => `length(${a})`, doc: 'Number of characters' },
  UPPER: { sig: [S], ret: S, js: s => s.toUpperCase(), sql: ([a]) => `upper(${a})`, doc: 'Uppercase' },
  LOWER: { sig: [S], ret: S, js: s => s.toLowerCase(), sql: ([a]) => `lower(${a})`, doc: 'Lowercase' },
  TRIM: { sig: [S], ret: S, js: s => s.trim(), sql: ([a]) => `trim(${a})`, doc: 'Remove leading and trailing spaces' },
  LEFT: { sig: [S, N], ret: S, js: (s, n) => n <= 0 ? '' : s.slice(0, n), sql: ([a, n]) => `left(${a}, CAST(${n} AS INTEGER))`, doc: 'First n characters' },
  RIGHT: { sig: [S, N], ret: S, js: (s, n) => n <= 0 ? '' : s.slice(-n), sql: ([a, n]) => `right(${a}, CAST(${n} AS INTEGER))`, doc: 'Last n characters' },
  MID: { sig: [S, N, N], opt: 1, ret: S, js: (s, st, len) => len === undefined ? s.slice(Math.max(0, st - 1)) : s.substr(Math.max(0, st - 1), Math.max(0, len)), sql: ([a, st, len]) => len === undefined ? `substring(${a}, CAST(${st} AS INTEGER))` : `substring(${a}, CAST(${st} AS INTEGER), CAST(${len} AS INTEGER))`, doc: 'MID(text, start, length), start at 1' },
  CONTAINS: { sig: [S, S], ret: B, js: (s, x) => s.includes(x), sql: ([a, b]) => `contains(${a}, ${b})`, doc: 'True when text contains a substring' },
  STARTSWITH: { sig: [S, S], ret: B, js: (s, x) => s.startsWith(x), sql: ([a, b]) => `starts_with(${a}, ${b})`, doc: 'True when text starts with a substring' },
  ENDSWITH: { sig: [S, S], ret: B, js: (s, x) => s.endsWith(x), sql: ([a, b]) => `ends_with(${a}, ${b})`, doc: 'True when text ends with a substring' },
  REPLACE: { sig: [S, S, S], ret: S, js: (s, a, b) => a === '' ? s : s.split(a).join(b), sql: ([s, a, b]) => `replace(${s}, ${a}, ${b})`, doc: 'Replace every match' },
  STR: { sig: ['any'], ret: S, js: v => v === true ? 'true' : v === false ? 'false' : strOf(v), sql: ([a], [t]) => t === N ? `regexp_replace(CAST(${a} AS VARCHAR), '\\.0$', '')` : `CAST(${a} AS VARCHAR)`, doc: 'Convert to text' },
  FLOAT: { sig: ['any'], ret: N, js: v => numOf(v), sql: ([a], [t]) => t === N ? a : `TRY_CAST(regexp_replace(CAST(${a} AS VARCHAR), '[$,%\\s]', '', 'g') AS DOUBLE)`, doc: 'Convert to a number' },
  INT: { sig: ['any'], ret: N, js: v => { const x = numOf(v); return x == null ? null : Math.trunc(x); }, sql: ([a], [t]) => `trunc(${t === N ? a : `TRY_CAST(regexp_replace(CAST(${a} AS VARCHAR), '[$,%\\s]', '', 'g') AS DOUBLE)`})`, doc: 'Convert to a whole number' },
  YEAR: { sig: [D], ret: N, js: t => datePart('year', t), sql: ([a]) => `year(${a})`, doc: 'Year of a date' },
  QUARTER: { sig: [D], ret: N, js: t => datePart('quarter', t), sql: ([a]) => `quarter(${a})`, doc: 'Quarter 1–4' },
  MONTH: { sig: [D], ret: N, js: t => datePart('month', t), sql: ([a]) => `month(${a})`, doc: 'Month 1–12' },
  DAY: { sig: [D], ret: N, js: t => datePart('day', t), sql: ([a]) => `day(${a})`, doc: 'Day of month' },
  WEEKDAY: { sig: [D], ret: N, js: t => datePart('weekday', t), sql: ([a]) => `isodow(${a})`, doc: '1 = Monday … 7 = Sunday' },
  HOUR: { sig: [D], ret: N, js: t => datePart('hour', t), sql: ([a]) => `hour(${a})`, doc: 'Hour 0–23' },
  DATEPART: { sig: ['part', D], ret: N, js: (p, t) => datePart(p, t), sql: ([p, a], _, n) => { const part = lit(n.args[0]); return part === 'weekday' ? `isodow(${a})` : part === 'week' ? `week(${a})` : `date_part(${q(part)}, ${a})`; }, doc: "DATEPART('month', [date])" },
  DATETRUNC: { sig: ['part', D], ret: D, js: (p, t) => truncDate(p, t), sql: ([p, a], _, n) => `CAST(date_trunc(${q(lit(n.args[0]))}, ${a}) AS TIMESTAMP)`, doc: "DATETRUNC('month', [date])" },
  DATEDIFF: { sig: ['part', D, D], ret: N, js: (p, a, b) => dateDiff(p, a, b), sql: ([p, a, b], _, n) => `date_diff(${q(lit(n.args[0]))}, ${a}, ${b})`, doc: "DATEDIFF('day', [start], [end])" },
  DATEADD: { sig: ['part', N, D], ret: D, js: (p, k, t) => dateAdd(p, k, t), sql: ([p, k, a], _, n) => {
    const part = lit(n.args[0]), kk = `CAST(trunc(${k}) AS INTEGER)`;
    const iv = { year: `to_years(${kk})`, quarter: `to_months(3 * ${kk})`, month: `to_months(${kk})`, week: `to_days(7 * ${kk})`, day: `to_days(${kk})`, hour: `to_hours(${kk})`, minute: `to_minutes(${kk})`, second: `to_seconds(${kk})` }[part];
    return `CAST(${a} + ${iv} AS TIMESTAMP)`;
  }, doc: "DATEADD('month', 3, [date])" },
  MAKEDATE: { sig: [N, N, N], ret: D, js: (y, m, d) => Date.UTC(y, m - 1, d), sql: ([y, m, d]) => `CAST(make_date(CAST(${y} AS INTEGER), CAST(${m} AS INTEGER), CAST(${d} AS INTEGER)) AS TIMESTAMP)`, doc: 'MAKEDATE(year, month, day)' },
  DATE: { sig: ['any'], ret: D, js: v => typeof v === 'number' ? truncDate('day', v) : parseDateLoose(v), sql: ([a], [t]) => t === D ? `CAST(date_trunc('day', ${a}) AS TIMESTAMP)` : `TRY_CAST(${a} AS TIMESTAMP)`, doc: 'Text or date-time to a date' },
  MIN: { sig: [N, N], ret: N, nullSafe: true, js: (a, b) => a == null ? b : b == null ? a : Math.min(a, b), sql: ([a, b]) => `least(${a}, ${b})`, doc: 'MIN([x]) aggregates; MIN(a, b) is the smaller of two' },
  MAX: { sig: [N, N], ret: N, nullSafe: true, js: (a, b) => a == null ? b : b == null ? a : Math.max(a, b), sql: ([a, b]) => `greatest(${a}, ${b})`, doc: 'MAX([x]) aggregates; MAX(a, b) is the larger of two' }
};
export const AGG_FUNCS = {
  SUM: { arg: [N], doc: 'Total' }, AVG: { arg: [N], doc: 'Average' }, MEDIAN: { arg: [N], doc: 'Median' },
  COUNT: { arg: ['any'], doc: 'Count of non-null values' }, COUNTD: { arg: ['any'], doc: 'Count of distinct values' },
  MIN: { arg: [N, D], doc: 'Smallest value' }, MAX: { arg: [N, D], doc: 'Largest value' }
};
const isAggCall = n => n.t === 'call' && AGG_FUNCS[n.fn] && ((n.fn !== 'MIN' && n.fn !== 'MAX') || n.args.length === 1);

/* ---------------- type checker ---------------- */
// lookup(name) -> { type: 'number'|'string'|'date'|'bool', aggregateAst?, ok }
export function analyze(ast, lookup) {
  let hasAgg = false, rowRefOutside = null;
  const deps = new Set();
  const typeName = t => ({ number: 'a number', string: 'text', date: 'a date', bool: 'true/false' }[t] || t);
  const need = (t, want, node, what) => {
    if (t === NUL || want === 'any' || t === want) return;
    throw new FormulaError(`${what} needs ${typeName(want)}, but this is ${typeName(t)}.`, node.pos);
  };
  function unify(types, node) {
    const real = types.filter(t => t !== NUL);
    if (!real.length) return NUL;
    if (real.some(t => t !== real[0])) throw new FormulaError(`Every result must be the same type (got ${[...new Set(real)].map(typeName).join(' and ')}).`, node.pos);
    return real[0];
  }
  function t(n, inAgg) {
    switch (n.t) {
      case 'num': return (n._type = N);
      case 'str': return (n._type = S);
      case 'bool': return (n._type = B);
      case 'null': return (n._type = NUL);
      case 'field': {
        const f = lookup(n.name);
        if (!f) throw new FormulaError(`There is no field named [${n.name}].`, n.pos);
        deps.add(n.name);
        if (f.aggregate) { if (inAgg) throw new FormulaError(`[${n.name}] is already aggregated, so it cannot go inside ${inAgg}().`, n.pos); hasAgg = true; n._agg = true; return (n._type = N); }
        if (!inAgg && !rowRefOutside) rowRefOutside = n;
        return (n._type = f.type);
      }
      case 'un': {
        const a = t(n.a, inAgg);
        if (n.op === '-') { need(a, N, n, 'A minus sign'); return (n._type = N); }
        need(a, B, n, 'NOT'); return (n._type = B);
      }
      case 'bin': {
        const a = t(n.a, inAgg), b = t(n.b, inAgg), op = n.op;
        if (op === 'AND' || op === 'OR') { need(a, B, n.a, op); need(b, B, n.b, op); return (n._type = B); }
        if (['=', '<>', '<', '<=', '>', '>='].includes(op)) {
          if (a !== NUL && b !== NUL && a !== b) throw new FormulaError(`Can't compare ${typeName(a)} with ${typeName(b)}. Convert one side with STR(), FLOAT() or DATE().`, n.pos);
          return (n._type = B);
        }
        if (op === '+') {
          if ((a === S || b === S)) { if ((a !== S && a !== NUL) || (b !== S && b !== NUL)) throw new FormulaError('To join text with a number, wrap the number in STR().', n.pos); return (n._type = S); }
          if (a === D || b === D) throw new FormulaError("To add days to a date, use DATEADD('day', n, [date]).", n.pos);
          need(a, N, n.a, '+'); need(b, N, n.b, '+'); return (n._type = N);
        }
        if (op === '-' && (a === D || b === D)) {
          if (a === D && (b === D || b === NUL)) return (n._type = N);
          throw new FormulaError("Subtracting two dates gives days between them. To move a date, use DATEADD('day', -n, [date]).", n.pos);
        }
        need(a, N, n.a, op); need(b, N, n.b, op); return (n._type = N);
      }
      case 'if': {
        const outs = [];
        for (const [c, v] of n.branches) { need(t(c, inAgg), B, c, 'An IF condition'); outs.push(t(v, inAgg)); }
        if (n.els) outs.push(t(n.els, inAgg));
        return (n._type = unify(outs, n));
      }
      case 'call': {
        if (isAggCall(n)) {
          if (inAgg) throw new FormulaError(`${n.fn}() cannot go inside ${inAgg}().`, n.pos);
          if (n.args.length !== 1) throw new FormulaError(`${n.fn}() takes one value.`, n.pos);
          hasAgg = true;
          const at = t(n.args[0], n.fn);
          const allowed = AGG_FUNCS[n.fn].arg;
          if (at !== NUL && !allowed.includes('any') && !allowed.includes(at)) throw new FormulaError(`${n.fn}() needs ${allowed.map(typeName).join(' or ')}, but this is ${typeName(at)}.`, n.pos);
          n._agg = true;
          return (n._type = (n.fn === 'MIN' || n.fn === 'MAX') && at === D ? D : N);
        }
        const fn = FUNCS[n.fn];
        if (!fn) throw new FormulaError(`Unknown function ${n.raw}().`, n.pos);
        const min = fn.sig.length - (fn.opt || 0);
        if (n.args.length < min || n.args.length > fn.sig.length) throw new FormulaError(`${n.fn}() takes ${min === fn.sig.length ? min : `${min} to ${fn.sig.length}`} values.`, n.pos);
        const ats = n.args.map((a, i) => {
          if (fn.sig[i] === 'part') {
            const p = lit(a);
            const ok = n.fn === 'DATEPART' ? [...DATE_PARTS, 'weekday'] : DATE_PARTS;
            if (!p || !ok.includes(p)) throw new FormulaError(`${n.fn}() starts with a date part in quotes: ${ok.map(x => `'${x}'`).join(', ')}.`, a.pos);
            a._type = S; return S;
          }
          const at = t(a, inAgg);
          need(at, fn.sig[i], a, `${n.fn}()`);
          return at;
        });
        n._argTypes = ats;
        if (fn.ret === 'same') return (n._type = unify(ats, n));
        if (fn.ret === 'same2') return (n._type = unify(ats.slice(1), n));
        return (n._type = fn.ret);
      }
    }
    throw new FormulaError('Unrecognised formula.', n.pos);
  }
  const type = t(ast, null);
  if (hasAgg && rowRefOutside) throw new FormulaError(`[${rowRefOutside.name}] must be inside an aggregation such as SUM([${rowRefOutside.name}]), because this formula aggregates elsewhere.`, rowRefOutside.pos);
  return { type, aggregate: hasAgg, deps };
}

/* ---------------- row-level compiler ---------------- */
// getter(name) -> (i) => value | null ; aggregate field refs never reach here
export function compileRow(ast, getter) {
  function c(n) {
    switch (n.t) {
      case 'num': case 'str': case 'bool': { const v = n.v; return () => v; }
      case 'null': return () => null;
      case 'field': return getter(n.name);
      case 'un': { const a = c(n.a); return n.op === '-' ? i => { const x = a(i); return x == null ? null : -x; } : i => { const x = a(i); return x == null ? null : !x; }; }
      case 'bin': return binOp(n, c(n.a), c(n.b));
      case 'if': {
        const bs = n.branches.map(([qq, v]) => [c(qq), c(v)]), e = n.els ? c(n.els) : () => null;
        return i => { for (const [qq, v] of bs) if (qq(i) === true) return v(i); return e(i); };
      }
      case 'call': {
        const fn = FUNCS[n.fn];
        const args = n.args.map((a, k) => fn.sig[k] === 'part' ? (() => { const p = lit(a); return () => p; })() : c(a));
        if (fn.nullSafe) return i => fn.js(...args.map(f => f(i)));
        return i => { const v = args.map(f => f(i)); for (const x of v) if (x == null) return null; const r = fn.js(...v); return typeof r === 'number' && !Number.isFinite(r) ? null : r; };
      }
    }
    throw new FormulaError('Unrecognised formula.', n.pos);
  }
  return c(ast);
}
function binOp(n, a, b) {
  const op = n.op, ta = n.a._type, tb = n.b._type;
  switch (op) {
    case 'AND': return i => { const x = a(i), y = b(i); if (x === false || y === false) return false; if (x === true && y === true) return true; return null; };
    case 'OR': return i => { const x = a(i), y = b(i); if (x === true || y === true) return true; if (x === false && y === false) return false; return null; };
  }
  const f = {
    '+': (ta === S || tb === S) ? (x, y) => x + y : (x, y) => x + y,
    '-': ta === D ? (x, y) => (x - y) / DAY : (x, y) => x - y,
    '*': (x, y) => x * y,
    '/': (x, y) => y === 0 ? null : x / y,
    '%': (x, y) => y === 0 ? null : x % y,
    '^': (x, y) => { const r = Math.pow(x, y); return Number.isFinite(r) ? r : null; },
    '=': (x, y) => x === y, '<>': (x, y) => x !== y, '<': (x, y) => x < y, '<=': (x, y) => x <= y, '>': (x, y) => x > y, '>=': (x, y) => x >= y
  }[op];
  return i => { const x = a(i), y = b(i); if (x == null || y == null) return null; return f(x, y); };
}

/* ---------------- aggregate compiler ---------------- */
// Returns { slots: [{fn, inner(i)}], final(vals) }. Aggregate field refs are expanded via aggAst(name).
export function compileAggregate(ast, getter, aggAst) {
  const slots = [];
  function c(n) {
    switch (n.t) {
      case 'num': case 'str': case 'bool': { const v = n.v; return () => v; }
      case 'null': return () => null;
      case 'field': if (n._agg) return c(aggAst(n.name)); throw new FormulaError(`[${n.name}] needs an aggregation.`, n.pos);
      case 'un': { const a = c(n.a); return n.op === '-' ? v => { const x = a(v); return x == null ? null : -x; } : v => { const x = a(v); return x == null ? null : !x; }; }
      case 'bin': return binOp(n, c(n.a), c(n.b));
      case 'if': { const bs = n.branches.map(([qq, x]) => [c(qq), c(x)]), e = n.els ? c(n.els) : () => null; return v => { for (const [qq, x] of bs) if (qq(v) === true) return x(v); return e(v); }; }
      case 'call': {
        if (n._agg) { const s = slots.length; slots.push({ fn: n.fn, inner: compileRow(n.args[0], getter) }); return v => v[s]; }
        const fn = FUNCS[n.fn];
        const args = n.args.map((a, k) => fn.sig[k] === 'part' ? (() => { const p = lit(a); return () => p; })() : c(a));
        if (fn.nullSafe) return v => fn.js(...args.map(f => f(v)));
        return v => { const xs = args.map(f => f(v)); for (const x of xs) if (x == null) return null; const r = fn.js(...xs); return typeof r === 'number' && !Number.isFinite(r) ? null : r; };
      }
    }
    throw new FormulaError('Unrecognised formula.', n.pos);
  }
  const final = c(ast);
  return { slots, final };
}
export function newAccumulator(fn) {
  if (fn === 'MEDIAN') return { vals: [] };
  if (fn === 'COUNTD') return { set: new Set() };
  return { sum: 0, n: 0, min: Infinity, max: -Infinity };
}
export function accumulate(fn, st, v) {
  if (v == null) return;
  if (fn === 'MEDIAN') st.vals.push(v);
  else if (fn === 'COUNTD') st.set.add(v);
  else { st.n++; if (fn === 'SUM' || fn === 'AVG') st.sum += v; else if (fn === 'MIN') { if (v < st.min) st.min = v; } else if (fn === 'MAX') { if (v > st.max) st.max = v; } }
}
export function finish(fn, st) {
  switch (fn) {
    case 'SUM': return st.n ? st.sum : null;
    case 'AVG': return st.n ? st.sum / st.n : null;
    case 'COUNT': return st.n;
    case 'COUNTD': return st.set.size;
    case 'MIN': return st.n ? st.min : null;
    case 'MAX': return st.n ? st.max : null;
    case 'MEDIAN': { const v = st.vals; if (!v.length) return null; v.sort((a, b) => a - b); const h = v.length >> 1; return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2; }
  }
  return null;
}

/* ---------------- SQL translator (DuckDB) ---------------- */
// fieldSQL(name, node) -> SQL text for a field reference (inline calc expansion is the caller's job)
export function toSQL(ast, fieldSQL) {
  function s(n) {
    switch (n.t) {
      case 'num': return String(n.v);
      case 'str': return q(n.v);
      case 'bool': return n.v ? 'TRUE' : 'FALSE';
      case 'null': return 'NULL';
      case 'field': return fieldSQL(n.name, n);
      case 'un': return n.op === '-' ? `(-${s(n.a)})` : `(NOT ${s(n.a)})`;
      case 'bin': {
        const a = s(n.a), b = s(n.b);
        switch (n.op) {
          case '+': return (n.a._type === S || n.b._type === S) ? `(${a} || ${b})` : `(${a} + ${b})`;
          case '-': return n.a._type === D ? `((epoch_ms(${a}) - epoch_ms(${b})) / 86400000.0)` : `(${a} - ${b})`;
          case '*': return `(${a} * ${b})`;
          case '/': return `(${a} / NULLIF(${b}, 0))`;
          case '%': return `(${a} % NULLIF(${b}, 0))`;
          case '^': return `pow(${a}, ${b})`;
          case 'AND': return `(${a} AND ${b})`;
          case 'OR': return `(${a} OR ${b})`;
          default: return `(${a} ${n.op} ${b})`;
        }
      }
      case 'if': return `CASE ${n.branches.map(([c, v]) => `WHEN ${s(c)} THEN ${s(v)}`).join(' ')}${n.els ? ` ELSE ${s(n.els)}` : ''} END`;
      case 'call': {
        if (n._agg) {
          const a = s(n.args[0]);
          return n.fn === 'COUNTD' ? `COUNT(DISTINCT ${a})` : `${n.fn}(${a})`;
        }
        const fn = FUNCS[n.fn];
        return fn.sql(n.args.map(s), n._argTypes || [], n);
      }
    }
    return 'NULL';
  }
  return s(ast);
}

/* ---------------- reference for the editor ---------------- */
export const FUNCTION_GROUPS = [
  { name: 'Aggregate', items: [['SUM', 'SUM([x])', 'Total'], ['AVG', 'AVG([x])', 'Average'], ['MEDIAN', 'MEDIAN([x])', 'Median'], ['COUNT', 'COUNT([x])', 'Count of non-null values'], ['COUNTD', 'COUNTD([x])', 'Distinct values'], ['MIN', 'MIN([x])', 'Smallest'], ['MAX', 'MAX([x])', 'Largest']] },
  { name: 'Logic', items: [['IF', 'IF [x] > 10 THEN "High" ELSEIF [x] > 5 THEN "Mid" ELSE "Low" END', 'Branch on a condition'], ['IIF', 'IIF([x] > 0, "Up", "Down")', 'One-line IF'], ['IFNULL', 'IFNULL([x], 0)', 'Replace null'], ['ZN', 'ZN([x])', 'Null becomes 0'], ['ISNULL', 'ISNULL([x])', 'True when null'], ['AND', '[a] > 1 AND [b] < 5', 'Both true'], ['OR', '[a] = "x" OR [a] = "y"', 'Either true'], ['NOT', 'NOT [flag]', 'Negate']] },
  { name: 'Number', items: Object.entries(FUNCS).filter(([k, f]) => f.sig.every(x => x === N) && f.ret === N).map(([k, f]) => [k, `${k}(${f.sig.map((_, i) => i === 0 ? '[x]' : 'n').join(', ')})`, f.doc]) },
  { name: 'Text', items: ['LEN', 'UPPER', 'LOWER', 'TRIM', 'LEFT', 'RIGHT', 'MID', 'CONTAINS', 'STARTSWITH', 'ENDSWITH', 'REPLACE', 'STR', 'FLOAT', 'INT'].map(k => [k, `${k}(${FUNCS[k].sig.map((t, i) => t === S ? (i ? '"text"' : '[text]') : t === N ? 'n' : '[x]').join(', ')})`, FUNCS[k].doc]) },
  { name: 'Date', items: ['YEAR', 'QUARTER', 'MONTH', 'DAY', 'WEEKDAY', 'HOUR', 'DATEPART', 'DATETRUNC', 'DATEDIFF', 'DATEADD', 'MAKEDATE', 'DATE'].map(k => [k, FUNCS[k].doc.includes('(') ? FUNCS[k].doc : `${k}([date])`, FUNCS[k].doc]) }
];
