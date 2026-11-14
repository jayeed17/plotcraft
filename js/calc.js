// Calculated-field editor: live validation, preview, field and function pickers.
import { $, $$, esc, nf2, isoDate, debounce, uid, toast } from './util.js';
import { state, field, col } from './store.js';
import { parse, analyze, compileRow, compileAggregate, newAccumulator, accumulate, finish, FUNCTION_GROUPS } from './formula.js';
import { getterFor } from './data.js';
import { openModal } from './ui.js';
import { saveCalc } from './model.js';

const EXAMPLES = [
  ['Ratio of totals', 'SUM([fare_amount]) / SUM([trip_distance])'],
  ['Bucket a number', 'IF [trip_distance] >= 10 THEN "Long" ELSEIF [trip_distance] >= 3 THEN "Medium" ELSE "Short" END'],
  ['Days between dates', "DATEDIFF('day', [order_date], [ship_date])"]
];

function lookupFor(selfName) {
  return nm => {
    if (nm === selfName) return null;
    const f = field(nm);
    if (!f || f.type === 'error' || f.type === 'records') return null;
    if (f.calc && f.calc.aggregate) return { aggregate: true, type: 'number' };
    const c = col(nm); return c ? { type: c.type } : null;
  };
}
function fmtVal(v, type) {
  if (v == null) return 'Null';
  if (type === 'date') return isoDate(v, v % 864e5 !== 0);
  if (typeof v === 'number') return nf2.format(v);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return String(v);
}
export function checkFormula(formula, selfName) {
  const ast = parse(formula);
  const info = analyze(ast, lookupFor(selfName));
  if (info.aggregate && info.type !== 'number' && info.type !== 'null') throw Object.assign(new Error('A formula that aggregates must return a number.'), { pos: 0 });
  return { ast, info };
}
function preview(ast, info) {
  const DS = state.DS, get = getterFor(DS.cols);
  if (info.aggregate) {
    const { slots, final } = compileAggregate(ast, get, nm => DS.aggAsts.get(nm));
    const st = slots.map(s => newAccumulator(s.fn));
    for (let i = 0; i < DS.n; i++) for (let s = 0; s < slots.length; s++) accumulate(slots[s].fn, st[s], slots[s].inner(i));
    const v = final(slots.map((s, k) => finish(s.fn, st[k])));
    return `Aggregate formula: it is computed for every mark. Over all ${nf2.format(DS.n)} rows it is <b>${esc(fmtVal(v, info.type))}</b>.`;
  }
  const fn = compileRow(ast, get), out = [];
  for (let i = 0; i < DS.n && out.length < 6; i++) { const v = fn(i); out.push(v); }
  return `Row-level ${info.type === 'bool' ? 'true/false' : info.type === 'string' ? 'text' : info.type} formula. First rows: ${out.map(v => `<code>${esc(fmtVal(v, info.type))}</code>`).join(' ')}`;
}

export function openCalcEditor(id) {
  const existing = id ? state.model.calcs.find(c => c.id === id) : null;
  const fields = state.DS.fields.filter(f => f.type !== 'records' && f.type !== 'error' && (!existing || f.name !== existing.name));
  const body = `
  <div class="calc-grid">
    <div class="calc-main">
      <label class="stack" for="calcName">Name<input class="search" id="calcName" value="${esc(existing ? existing.name : 'New calculation')}"></label>
      <label class="stack" for="calcFormula">Formula<textarea id="calcFormula" class="formula" spellcheck="false" rows="6" placeholder="SUM([Sales]) / SUM([Units])">${esc(existing ? existing.formula : '')}</textarea></label>
      <div class="calc-status" id="calcStatus" role="status"></div>
      ${existing ? '' : `<div class="calc-examples"><span class="label-caps">Examples</span>${EXAMPLES.map(([l, f], i) => `<button class="chip" type="button" data-ex="${i}" title="${esc(f)}">${esc(l)}</button>`).join('')}</div>`}
    </div>
    <div class="calc-side">
      <input class="search" id="calcSearch" type="search" placeholder="Search fields and functions" aria-label="Search fields and functions">
      <div class="calc-ref" id="calcRef">
        <h4 class="label-caps">Fields</h4>
        ${fields.map(f => `<button type="button" class="ref" data-insert="[${esc(f.name.replace(/]/g, ']]'))}]" data-q="${esc(f.name.toLowerCase())}"><span>${esc(f.name)}</span><small>${f.calc ? 'calc' : f.type}</small></button>`).join('')}
        ${FUNCTION_GROUPS.map(g => `<h4 class="label-caps">${esc(g.name)}</h4>` + g.items.map(([k, sig, doc]) => `<button type="button" class="ref" data-insert="${esc(sig)}" data-q="${esc((k + ' ' + doc).toLowerCase())}" title="${esc(doc)}"><span>${esc(sig.length > 46 ? k + '(…)' : sig)}</span><small>${esc(doc.length > 30 ? '' : doc)}</small></button>`).join('')).join('')}
      </div>
    </div>
  </div>`;
  const { el, close } = openModal({
    title: existing ? `Edit ${existing.name}` : 'New calculated field', wide: true,
    desc: 'Refer to fields in [brackets]. Use SUM(), AVG() and friends for ratios of totals (like a Power BI measure); leave them out for a value per row.',
    body, foot: '<button class="btn" type="button" id="calcCancel">Cancel</button><button class="btn primary" type="button" id="calcSave">Save field</button>'
  });
  const ta = $('#calcFormula'), nameIn = $('#calcName'), status = $('#calcStatus');
  let ok = false;
  const validate = () => {
    const nm = nameIn.value.trim();
    try {
      if (!nm) throw Object.assign(new Error('Give the field a name.'), { pos: -1 });
      const other = field(nm);
      if (other && (!existing || nm !== existing.name)) throw Object.assign(new Error(`There is already a field named ${nm}.`), { pos: -1 });
      const { ast, info } = checkFormula(ta.value, existing ? existing.name : nm);
      status.className = 'calc-status ok';
      status.innerHTML = preview(ast, info);
      ok = true;
    } catch (e) {
      ok = false;
      status.className = 'calc-status bad';
      const where = e.pos >= 0 && ta.value ? ` <span class="muted">(at character ${e.pos + 1})</span>` : '';
      status.innerHTML = esc(e.message) + where;
    }
  };
  const v = debounce(validate, 140);
  ta.addEventListener('input', v); nameIn.addEventListener('input', v);
  validate();
  const insert = text => { const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s; ta.value = ta.value.slice(0, s) + text + ta.value.slice(e); ta.focus(); ta.selectionStart = ta.selectionEnd = s + text.length; validate(); };
  $('#calcRef').addEventListener('click', e => { const b = e.target.closest('[data-insert]'); if (b) insert(b.dataset.insert); });
  $('#calcSearch').addEventListener('input', e => { const q = e.target.value.toLowerCase(); $$('#calcRef .ref').forEach(b => { b.hidden = q && !b.dataset.q.includes(q); }); });
  el.addEventListener('click', e => { const b = e.target.closest('[data-ex]'); if (b) { ta.value = EXAMPLES[+b.dataset.ex][1]; validate(); } });
  $('#calcCancel').onclick = close;
  $('#calcSave').onclick = () => {
    validate();
    if (!ok) { toast('Fix the formula before saving.'); return; }
    const calc = { id: existing ? existing.id : uid(), name: nameIn.value.trim(), formula: ta.value };
    close();
    saveCalc(calc, existing ? existing.name : null);
  };
  (existing ? ta : nameIn).focus();
  if (!existing) nameIn.select();
}
