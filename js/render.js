// Draws one sheet into any element: used by the worksheet view and by dashboard tiles.
import { esc, nf2, fmtNum } from './util.js';
import { runQuery } from './engine.js';
import { compileSpec, embedOpts, theme } from './chart.js';
import { matrixHTML, kpiHTML, gaugeHTML, sheetKpiConfig, hint } from './visuals.js';
import { aliasOf } from './pills.js';

export function errorHTML(e) {
  return `<div class="error-box"><strong>This combination can't be drawn.</strong><p>${esc(e && e.message ? e.message : e)}</p><p>Try a different mark type, or move a field to another shelf.</p></div>`;
}

// o: { extra: filters[], compact, highlight: [{alias,value}], W, H, onSelect(datum, res) }
export async function renderSheetInto(el, sh, o = {}) {
  const extra = o.extra || [];
  const th = theme();
  const S = sh.shelves;
  const filters = [...S.filters, ...extra];
  if (sh.mark === 'matrix') { el.innerHTML = matrixHTML(sh, extra, th); return { res: null }; }
  if (sh.mark === 'kpi') { const c = sheetKpiConfig(sh); el.innerHTML = kpiHTML(c, filters, th); return { res: null }; }
  if (sh.mark === 'gauge') { const c = sheetKpiConfig(sh); el.innerHTML = gaugeHTML(c, filters, th); return { res: null }; }

  let res;
  try { res = runQuery(sh, extra); } catch (e) { el.innerHTML = errorHTML(e); return { res: null }; }
  const anyAxis = S.cols.length || S.rows.length;
  if (!anyAxis && !['pie', 'donut', 'treemap'].includes(sh.mark)) {
    const m = [...S.label, ...S.color, ...S.size].find(p => p.kind === 'measure');
    if (m && res.rows.length === 1) {
      const a = aliasOf(m, S.label.includes(m) ? 'label' : S.color.includes(m) ? 'color' : 'size');
      el.innerHTML = `<div class="hero"><div class="hero-value">${res.rows[0][a] == null ? '—' : nf2.format(res.rows[0][a])}</div><div class="hero-label">${esc(a)}</div></div>`;
    } else el.innerHTML = hint('Put fields on Columns or Rows to draw a chart.');
    return { res };
  }
  if (!res.rows.length) { el.innerHTML = `<div class="empty-state small"><h2>No rows match the filters</h2><p>Edit or remove a filter to bring data back.</p></div>`; return { res }; }
  let spec;
  try { spec = compileSpec(sh, res, o.W || 600, o.H || 400, th, { compact: o.compact, highlight: o.highlight }); }
  catch (e) { el.innerHTML = errorHTML(e); return { res }; }
  if (!spec) { el.innerHTML = hint('Put fields on Columns or Rows to draw a chart.'); return { res }; }
  if (spec.hint) { el.innerHTML = hint(spec.hint); return { res }; }
  if (o.onSelect) spec.config.mark = Object.assign(spec.config.mark || {}, { cursor: 'pointer' });
  try {
    el.innerHTML = '';
    const out = await vegaEmbed(el, spec, embedOpts(res.rows.length));
    if (o.onSelect) out.view.addEventListener('click', (ev, item) => o.onSelect(item && item.datum ? item.datum : null, res));
    return { view: out.view, res };
  } catch (e) { el.innerHTML = errorHTML(e); return { res }; }
}

export { fmtNum };
