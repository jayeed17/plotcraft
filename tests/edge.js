// Edge-case data for Color and Label: many categories (top-7 + Other fold), negatives, empty values,
// a one-row result, exact timestamps and long names. Same checks as labels.js, plus:
//   - folded colour legends show 7 named entries + "Other"
//   - negative bars get their labels on the negative side
//   - date tooltips/labels are UTC (no "previous month" shift)
// Run: node tests/edge.js
const { open } = require('./harness');
const fs = require('fs');

const rows = ['Store,Region,Category,Profit,Units,Sold at'];
const regions = ['North', 'South', 'East', 'West'];
const cats = ['Apples', 'Bananas', 'Cherries', 'Dates', 'Elderberries', 'Figs', 'Grapes', 'Honeydew melons from the valley', 'Kiwis', 'Limes', 'Mangoes', 'Nectarines'];
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (let i = 0; i < 600; i++) {
  const c = cats[Math.floor(Math.pow(rnd(), 1.6) * cats.length)];
  const r = regions[i % 4];
  const loss = c === 'Kiwis' || c === 'Limes' || c === 'Figs';
  const profit = i % 37 === 0 ? '' : (rnd() * 200 - (loss ? 160 : 70)).toFixed(2); // loss-making categories, some empty
  const units = i % 41 === 0 ? '' : String(1 + Math.floor(rnd() * 20));
  const m = 1 + (i % 12), d = 1 + (i % 27);
  rows.push(`S${i % 9},${i % 53 === 0 ? '' : r},${c},${profit},${units},2024-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(i % 24).padStart(2, '0')}:15`);
}
const csv = '/tmp/claude-0/edge_sales.csv';
fs.mkdirSync('/tmp/claude-0', { recursive: true });
fs.writeFileSync(csv, rows.join('\n') + '\n');

const C = (name, o) => Object.assign({ name, mark: 'auto' }, o);
const cases = [
  C('fold-stacked', { cols: ['Region'], rows: ['Profit'], color: ['Category'], label: ['Profit'], mark: 'bar', expectFold: true }),
  C('fold-line', { cols: ['Sold at'], rows: ['Units'], color: ['Category'], label: ['Units'], expectFold: true }),
  C('fold-pie', { mark: 'pie', color: ['Category'], size: ['Units'], label: ['Units'], expectFold: true }),
  C('fold-donut-dim-label', { mark: 'donut', color: ['Category'], size: ['Units'], label: ['Category'], expectFold: true }),
  C('fold-treemap', { mark: 'treemap', color: ['Category'], size: ['Units'], label: ['Units'], expectFold: true }),
  C('fold-scatter', { mark: 'circle', cols: ['Units'], rows: ['Profit'], detail: ['Store'], color: ['Category'], label: ['Category'], expectFold: true }),
  C('fold-heatmap', { mark: 'square', cols: ['Region'], rows: ['Store'], color: ['Category'], label: ['Units'], expectFold: true }),
  C('fold-texttable', { mark: 'text', cols: ['Region'], rows: ['Store'], color: ['Category'], label: ['Profit'], expectFold: true }),
  C('negative-bars', { cols: ['Category'], rows: ['Profit'], label: ['Profit'], mark: 'bar', negatives: true }),
  C('negative-hbars', { rows: ['Category'], cols: ['Profit'], label: ['Profit'], mark: 'bar', negatives: true }),
  C('negative-stacked', { cols: ['Region'], rows: ['Profit'], color: ['Store'], label: ['Profit'], mark: 'bar' }),
  C('negative-color-measure', { cols: ['Category'], rows: ['Units'], color: ['Profit'], label: ['Profit'], mark: 'bar' }),
  C('null-region', { cols: ['Region'], rows: ['Units'], color: ['Region'], label: ['Units'], mark: 'bar' }),
  C('long-names', { rows: ['Category'], cols: ['Units'], label: ['Category'], mark: 'bar' }),
  C('one-row', { cols: ['Region'], rows: ['Units'], label: ['Units'], color: ['Region'], mark: 'bar', filters: [['Region', { include: ['North'] }]] }),
  C('exact-time-line', { cols: [['Sold at', { part: 'exact' }]], rows: ['Units'], label: ['Units'], mark: 'line' }),
  C('day-color', { cols: ['Region'], rows: ['Units'], color: [['Sold at', { part: 'day' }]], mark: 'bar' }),
  C('month-label-tooltip', { cols: [['Sold at', { part: 'month' }]], rows: ['Units'], label: [['Sold at', { part: 'month' }]], mark: 'line', utcCheck: true })
];

(async () => {
  const { browser, page, errors } = await open({ viewport: { width: 1280, height: 800 } });
  await page.waitForSelector('#canvas .tile', { timeout: 30000 });
  await page.setInputFiles('#fileInput', csv);
  await page.waitForFunction(() => window.__vizora.state.DS && window.__vizora.state.DS.fields.some(f => f.name === 'Category'), null, { timeout: 15000 });
  const results = await page.evaluate(async (cases) => {
    const P = await import('/js/pills.js'), St = await import('/js/store.js'), R = await import('/js/render.js'), Ch = await import('/js/chart.js'), E = await import('/js/engine.js');
    const holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:0;top:0;width:1008px;height:568px;overflow:hidden;background:var(--panel);z-index:9999'; document.body.appendChild(holder);
    const mk = (spec, shelf) => {
      const [fname, o] = Array.isArray(spec) ? spec : [spec, {}];
      if (shelf === 'filters') { const p = P.makePill(fname, 'filters'); Object.assign(p.filter, o); return p; }
      const p = P.makePill(fname, shelf); if (o.part) p.part = o.part; return p;
    };
    const out = [];
    for (const cfg of cases) {
      const r = { name: cfg.name, problems: [] };
      const shelves = {};
      for (const k of ['cols', 'rows', 'color', 'size', 'label', 'detail', 'filters']) shelves[k] = (cfg[k] || []).map(s => mk(s, k));
      const sh = St.newSheet(cfg.name, shelves, cfg.mark);
      let res, spec;
      try { res = E.runQuery(sh, []); spec = Ch.compileSpec(sh, res, 1000, 560, Ch.theme(), {}); } catch (e) { r.problems.push('threw ' + e.message); out.push(r); continue; }
      const warns = [];
      if (spec && !spec.hint) { const logger = { level() { return this; }, warn(...a) { warns.push(a.join(' ')); return this; }, info() { return this; }, debug() { return this; }, error(...a) { warns.push(a.join(' ')); return this; } }; vegaLite.compile(spec, { logger }); }
      warns.forEach(w => r.problems.push('vega-lite: ' + w));
      holder.innerHTML = '<div style="width:1000px;height:560px"></div>';
      await R.renderSheetInto(holder.firstChild, sh, { W: 1000, H: 560 });
      const svg = holder.querySelector('svg');
      const err = holder.querySelector('.error-box');
      if (err) { r.problems.push('error box ' + err.innerText.slice(0, 120)); out.push(r); continue; }
      if (!svg) { r.problems.push('no chart: ' + holder.innerText.slice(0, 120)); out.push(r); continue; }
      const texts = [...svg.querySelectorAll('g.mark-text.role-mark text')].filter(t => t.textContent.trim());
      const boxes = texts.map(t => { const b = t.getBoundingClientRect(); return { t: t.textContent, x0: b.left, x1: b.right, y0: b.top, y1: b.bottom }; });
      r.labels = boxes.length; r.rows = res.rows.length;
      if (cfg.label && cfg.mark !== 'text' && !boxes.length) r.problems.push('no labels');
      let ov = 0; for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i], b = boxes[j]; if (a.t === b.t && Math.abs(a.x0 - b.x0) < 0.5 && Math.abs(a.y0 - b.y0) < 0.5) continue; /* halo + text pair */ if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 1.5 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 1.5) ov++; }
      if (ov) r.problems.push(ov + ' overlapping labels');
      const sb = svg.getBoundingClientRect();
      if (boxes.some(b => b.x0 < sb.left - 1 || b.x1 > sb.right + 1 || b.y0 < sb.top - 1 || b.y1 > sb.bottom + 1)) r.problems.push('label outside chart');
      const legend = [...svg.querySelectorAll('.role-legend-label text')].map(t => t.textContent);
      r.legend = legend;
      if (cfg.color && !legend.length) r.problems.push('no legend');
      if (legend.some(l => /NaN|undefined|Invalid|\d\.\d{4,}/.test(l))) r.problems.push('bad legend label ' + legend.join('|'));
      if (cfg.expectFold && !(legend.length === 8 && legend[7] === 'Other')) r.problems.push('expected 7 categories + Other in the legend, got ' + legend.join('|'));
      if (cfg.negatives) {
        // every negative bar's label sits beyond the bar's negative end
        const vert = !!cfg.rows.length && cfg.rows[0] === 'Profit';
        const neg = res.rows.filter(v => v['SUM(Profit)'] < 0).length;
        if (!neg) r.problems.push('test data has no negative bars');
        const bars = [...svg.querySelectorAll('g.mark-rect.role-mark path')].map(p => p.getBoundingClientRect());
        let bad = 0;
        for (const b of boxes) {
          const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
          const bar = bars.find(r => vert ? cx >= r.left - 1 && cx <= r.right + 1 : cy >= r.top - 1 && cy <= r.bottom + 1);
          if (!bar) { bad++; continue; }
          const val = parseFloat(b.t.replace(/,/g, ''));
          if (vert && val < 0 && !(b.y0 >= bar.bottom - 1)) bad++;
          if (vert && val >= 0 && !(b.y1 <= bar.top + 1)) bad++;
          if (!vert && val < 0 && !(b.x1 <= bar.left + 1)) bad++;
          if (!vert && val >= 0 && !(b.x0 >= bar.right - 1)) bad++;
        }
        if (bad) r.problems.push(`${bad} bar labels not just past their bar end`);
        r.neg = neg;
      }
      if (cfg.utcCheck) {
        const months = [...new Set(texts.map(t => t.textContent))];
        if (!months.includes('Jan 2024') || months.some(m => /2023/.test(m))) r.problems.push('month labels shifted: ' + months.slice(0, 4).join('|'));
        const tipField = Object.keys(spec.data.values[0]).find(k => k.startsWith('·'));
        const jan = spec.data.values.find(v => new Date(v['MONTH(Sold at)']).getUTCMonth() === 0);
        if (!tipField || !jan || jan[tipField] !== 'Jan 2024') r.problems.push('tooltip date string wrong: ' + (jan && jan[tipField]));
      }
      out.push(r);
    }
    holder.remove();
    return out;
  }, cases);
  let fails = 0;
  for (const r of results) {
    if (r.problems.length) { fails++; console.log(`FAIL ${r.name}: ${r.problems.join('; ')}`); }
    else console.log(`ok   ${r.name.padEnd(24)} ${r.rows} rows, ${r.labels} labels${r.legend && r.legend.length ? `, legend ${r.legend.length}` : ''}`);
  }
  const pe = errors.filter(e => !/Service Worker/.test(e));
  if (pe.length) { fails += pe.length; console.log('PAGE ERRORS', pe); }
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
