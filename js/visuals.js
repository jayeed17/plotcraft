// HTML visuals: matrix with totals (Power BI style), KPI card with sparkline, and gauge.
import { esc, nf2, pct1, fmtNum } from './util.js';
import { field, col } from './store.js';
import { pillLabel, aliasOf, isTemporal, PARTS } from './pills.js';
import { runPlan } from './engine.js';
import { labelOf } from './chart.js';

const dedupe = list => { const seen = new Set(); return list.filter(p => { const a = pillLabel(p); if (seen.has(a)) return false; seen.add(a); return true; }); };
const mplan = ms => ms.map(p => ({ p, alias: pillLabel(p), shelf: 'label', fold: null }));
const dplan = (ds, shelf) => ds.map(p => ({ p, alias: aliasOf(p, shelf), shelf, fold: null }));

/* ---------------- matrix ---------------- */
export function matrixHTML(sh, extra, th) {
  const S = sh.shelves, filters = [...S.filters, ...extra];
  const rowDims = S.rows.filter(p => p.kind !== 'measure'), colDims = S.cols.filter(p => p.kind !== 'measure');
  const measures = dedupe([...S.rows, ...S.cols, ...S.label, ...S.size].filter(p => p.kind === 'measure'));
  if (!measures.length) return hint('Put a measure on Rows, Columns or Label to fill the matrix.');
  const heat = S.color[0] && S.color[0].kind === 'measure' ? S.color[0] : null;
  const all = heat && !measures.some(m => pillLabel(m) === pillLabel(heat)) ? [...measures, heat] : measures;
  const rd = dplan(rowDims, 'rows'), cd = dplan(colDims, 'cols');
  const full = runPlan({ dims: [...rd, ...cd], measures: mplan(all) }, filters);
  const rowT = runPlan({ dims: rd, measures: mplan(all) }, filters);
  const colT = runPlan({ dims: cd, measures: mplan(all) }, filters);
  const grand = runPlan({ dims: [], measures: mplan(all) }, filters);
  if (!full.rows.length) return hint('No rows match the filters.');
  const keyOf = (r, ds) => ds.map(d => String(r[d.alias])).join('\u0001');
  const rowKeys = rowT.rows.slice(0, 500), colKeys = colT.rows.slice(0, 40);
  const cells = new Map(full.rows.map(r => [keyOf(r, rd) + '\u0002' + keyOf(r, cd), r]));
  const rowTot = new Map(rowT.rows.map(r => [keyOf(r, rd), r])), colTot = new Map(colT.rows.map(r => [keyOf(r, cd), r]));
  const G = grand.rows[0] || {};
  let mn = Infinity, mx = -Infinity;
  const ha = heat && pillLabel(heat);
  if (heat) for (const r of full.rows) { const v = r[ha]; if (v == null) continue; mn = Math.min(mn, v); mx = Math.max(mx, v); }
  const shade = v => {
    if (!heat || v == null || !(mx > mn)) return '';
    const t = (v - mn) / (mx - mn), ramp = th.pal.seq, k = Math.min(ramp.length - 1, Math.floor(t * ramp.length));
    const dark = th.dark ? k <= 2 : k >= 4;
    return ` style="background:${ramp[k]};color:${dark ? (th.dark ? '#f0efec' : '#ffffff') : '#0b0b0b'}"`;
  };
  const fmt = v => v == null ? '' : nf2.format(v);
  const mNames = measures.map(pillLabel);
  // header
  let head = '';
  const leafCols = colKeys.length ? colKeys : [null];
  cd.forEach((d, L) => {
    head += '<tr>' + (L === 0 ? rd.map(r => `<th class="rh" rowspan="${cd.length + (mNames.length > 1 ? 1 : 0)}">${esc(r.alias)}</th>`).join('') || (L === 0 ? `<th class="rh" rowspan="${cd.length + (mNames.length > 1 ? 1 : 0)}"></th>` : '') : '');
    let i = 0;
    while (i < leafCols.length) {
      const pref = leafCols[i] ? cd.slice(0, L + 1).map(x => String(leafCols[i][x.alias])).join('\u0001') : '';
      let j = i + 1;
      while (j < leafCols.length && cd.slice(0, L + 1).map(x => String(leafCols[j][x.alias])).join('\u0001') === pref) j++;
      head += `<th class="ch" colspan="${(j - i) * mNames.length}">${esc(labelOf(d.p, leafCols[i][d.alias]))}</th>`;
      i = j;
    }
    if (L === 0) head += `<th class="ch tot" colspan="${mNames.length}" rowspan="${cd.length}">Total</th>`;
    head += '</tr>';
  });
  if (!cd.length) head += '<tr>' + (rd.map(r => `<th class="rh">${esc(r.alias)}</th>`).join('') || '<th class="rh"></th>') + mNames.map(n => `<th class="num">${esc(n)}</th>`).join('') + '</tr>';
  else if (mNames.length > 1) head += '<tr>' + leafCols.map(() => mNames.map(n => `<th class="num">${esc(n)}</th>`).join('')).join('') + mNames.map(n => `<th class="num tot">${esc(n)}</th>`).join('') + '</tr>';
  // body
  let body = '', prev = [];
  for (const rk of rowKeys.length && rd.length ? rowKeys : [{}]) {
    const k = keyOf(rk, rd);
    body += '<tr>' + (rd.length ? rd.map((d, L) => { const v = labelOf(d.p, rk[d.alias]); const same = prev.slice(0, L + 1).join('\u0001') === rd.slice(0, L + 1).map(x => labelOf(x.p, rk[x.alias])).join('\u0001'); return `<th class="rl">${same ? '' : esc(v)}</th>`; }).join('') : '<th class="rl">All</th>');
    prev = rd.map(x => labelOf(x.p, rk[x.alias]));
    if (cd.length) for (const ck of leafCols) { const r = cells.get(k + '\u0002' + keyOf(ck, cd)); for (const n of mNames) body += `<td class="num"${shade(r && r[ha])}>${fmt(r && r[n])}</td>`; }
    else { const r = cells.get(k + '\u0002'); for (const n of mNames) body += `<td class="num"${shade(r && r[ha])}>${fmt(r && r[n])}</td>`; }
    if (cd.length) { const r = rowTot.get(k); for (const n of mNames) body += `<td class="num tot">${fmt(r && r[n])}</td>`; }
    body += '</tr>';
  }
  if (rd.length) {
    body += `<tr class="total"><th class="rl" colspan="${rd.length}">Total</th>`;
    if (cd.length) for (const ck of leafCols) { const r = colTot.get(keyOf(ck, cd)); for (const n of mNames) body += `<td class="num">${fmt(r && r[n])}</td>`; }
    for (const n of mNames) body += `<td class="num tot">${fmt(G[n])}</td>`;
    body += '</tr>';
  }
  const note = rowT.rows.length > 500 || colT.rows.length > 40 ? `<div class="table-note">Showing the first ${Math.min(500, rowT.rows.length)} rows and ${Math.min(40, colT.rows.length)} columns. Filter to see the rest.</div>` : '';
  return `${note}<div class="table-wrap"><table class="grid matrix"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/* ---------------- KPI card ---------------- */
// cfg: { measure: pill, date: pill|null, label?: string }
export function kpiHTML(cfg, filters, th) {
  if (!cfg.measure || !field(cfg.measure.field)) return hint('Put a measure on Rows or Label to show it as a KPI.');
  const ma = pillLabel(cfg.measure);
  const total = runPlan({ dims: [], measures: mplan([cfg.measure]) }, filters).rows[0] || {};
  const value = total[ma];
  let spark = '', delta = '';
  if (cfg.date && field(cfg.date.field)) {
    const dp = { p: cfg.date, alias: pillLabel(cfg.date), shelf: 'cols', fold: null };
    const tr = runPlan({ dims: [dp], measures: mplan([cfg.measure]) }, filters).rows.filter(r => r[dp.alias] != null && r[ma] != null);
    if (tr.length >= 2) {
      const vals = tr.map(r => r[ma]);
      const last = vals[vals.length - 1], prevV = vals[vals.length - 2];
      const lastLabel = labelOf(cfg.date, tr[tr.length - 1][dp.alias]), prevLabel = labelOf(cfg.date, tr[tr.length - 2][dp.alias]);
      if (prevV) {
        const ch = (last - prevV) / Math.abs(prevV), up = ch >= 0;
        delta = `<div class="kpi-delta ${up ? 'up' : 'down'}" title="${esc(lastLabel)}: ${nf2.format(last)} · ${esc(prevLabel)}: ${nf2.format(prevV)}"><span aria-hidden="true">${up ? '▲' : '▼'}</span>${pct1.format(Math.abs(ch))} ${up ? 'up' : 'down'} in ${esc(lastLabel)} vs ${esc(prevLabel)}</div>`;
      }
      spark = sparkline(vals, th);
    }
  }
  return `<div class="kpi">${cfg.hideLabel ? '' : `<div class="kpi-label">${esc(cfg.label || ma)}</div>`}<div class="kpi-value">${value == null ? '—' : fmtNum(value)}</div>${delta}${spark}</div>`;
}
function sparkline(vals, th) {
  const w = 240, h = 44, n = vals.length, mn = Math.min(...vals), mx = Math.max(...vals), span = mx - mn || 1;
  const pts = vals.map((v, i) => [i / (n - 1) * (w - 8) + 4, h - 6 - (v - mn) / span * (h - 12)]);
  const line = pts.map(p => p.map(x => x.toFixed(1)).join(',')).join(' ');
  const area = `M${pts[0][0]},${h} L${line.replace(/ /g, ' L')} L${pts[n - 1][0]},${h} Z`;
  const [ex, ey] = pts[n - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${area}" fill="${th.pal.single}" opacity=".1"/><polyline points="${line}" fill="none" stroke="${th.pal.single}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/><circle cx="${ex}" cy="${ey}" r="3.5" fill="${th.pal.single}" stroke="${th.panel}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

/* ---------------- gauge ---------------- */
export function gaugeHTML(cfg, filters, th) {
  if (!cfg.measure) return hint('Put a measure on Rows or Label to show it on a gauge. Add a second measure on Size to mark a target.');
  const ms = [cfg.measure, cfg.target].filter(Boolean);
  const r = runPlan({ dims: [], measures: mplan(ms) }, filters).rows[0] || {};
  const v = r[pillLabel(cfg.measure)], target = cfg.target ? r[pillLabel(cfg.target)] : null;
  if (v == null) return hint('No value for this measure with the current filters.');
  const niceMax = x => { if (!(x > 0)) return 1; const p = Math.pow(10, Math.floor(Math.log10(x))); for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= x) return m * p; return 10 * p; };
  const max = niceMax(Math.max(v * 1.25, (target || 0) * 1.1));
  const frac = Math.max(0, Math.min(1, v / max));
  const R = 80, cx = 100, cy = 96;
  const pt = f => [cx - R * Math.cos(Math.PI * f), cy - R * Math.sin(Math.PI * f)];
  const arc = (f0, f1) => { const [x0, y0] = pt(f0), [x1, y1] = pt(f1); return `M${x0.toFixed(2)},${y0.toFixed(2)} A${R},${R} 0 ${f1 - f0 > 0.5 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`; };
  let tgt = '';
  if (target != null) {
    const f = Math.max(0, Math.min(1, target / max)), a = Math.PI * f;
    const x0 = cx - (R - 14) * Math.cos(a), y0 = cy - (R - 14) * Math.sin(a), x1 = cx - (R + 14) * Math.cos(a), y1 = cy - (R + 14) * Math.sin(a);
    tgt = `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="var(--ink)" stroke-width="2.5" stroke-linecap="round"/>`;
  }
  return `<div class="gauge"><div class="kpi-label">${esc(cfg.label || pillLabel(cfg.measure))}</div>
  <svg viewBox="0 0 200 118" role="img" aria-label="${esc(pillLabel(cfg.measure))} ${nf2.format(v)} of ${nf2.format(max)}">
    <path d="${arc(0, 1)}" fill="none" stroke="${th.pal.track}" stroke-width="18" stroke-linecap="butt"/>
    ${frac > 0 ? `<path d="${arc(0, Math.max(frac, 0.002))}" fill="none" stroke="${th.pal.single}" stroke-width="18" stroke-linecap="butt"/>` : ''}
    ${tgt}
    <text x="${cx}" y="${cy - 8}" text-anchor="middle" class="gauge-value">${fmtNum(v)}</text>
    <text x="${cx - R}" y="${cy + 16}" text-anchor="middle" class="gauge-axis">0</text>
    <text x="${cx + R}" y="${cy + 16}" text-anchor="middle" class="gauge-axis">${fmtNum(max)}</text>
  </svg>${target != null ? `<div class="gauge-target">Target ${fmtNum(target)} · ${pct1.format(v / target)} of target</div>` : ''}</div>`;
}

export function hint(msg) { return `<div class="empty-state small"><p>${esc(msg)}</p></div>`; }

// Pick KPI/gauge settings from a sheet's shelves.
export function sheetKpiConfig(sh) {
  const S = sh.shelves;
  const ms = [...S.rows, ...S.cols, ...S.label, ...S.size].filter(p => p.kind === 'measure');
  const date = [...S.cols, ...S.rows, ...S.detail].find(p => isTemporal(p)) || null;
  const target = S.size.find(p => p.kind === 'measure' && p !== ms[0]) || ms[1] || null;
  return { measure: ms[0] || null, date, target, label: null };
}
