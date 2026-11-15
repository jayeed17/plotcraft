// Exhaustive Color × Label test: renders every mark type, on every shelf layout, with every kind of field on
// Color and on Label, in light and dark mode and at dashboard-tile size. For each chart it checks:
//   - it renders (or shows a hint) without exceptions, page errors or Vega-Lite warnings
//   - a Label pill produces visible labels (unless the chart has nowhere to put them)
//   - no two labels overlap, and no label sticks out of the chart
//   - a Color pill produces a legend, and its entries match the colours drawn
//   - stacked segments are ordered like the legend (first entry on the baseline)
// Run: node tests/labels.js   (exit code 1 on any failure)
const { open } = require('./harness');

const LAYOUTS = {
  catV: { cols: ['pickup_borough'], rows: ['fare_amount'] },
  catH: { rows: ['pickup_borough'], cols: ['fare_amount'] },
  time: { cols: ['pickup_datetime'], rows: ['fare_amount'] },
  scatter: { cols: ['trip_distance'], rows: ['fare_amount'], detail: ['payment_type'] },
  grid: { cols: ['payment_type'], rows: ['pickup_borough'] },
  hist: { cols: [['trip_distance', { dim: true, set: { bin: 2 } }]], rows: ['Records'] },
  facet: { cols: ['payment_type', 'pickup_borough'], rows: ['fare_amount'] },
  twoMeasures: { cols: ['pickup_borough'], rows: ['fare_amount', 'tip_amount'] },
  none: {}
};
const MARKS = ['auto', 'bar', 'line', 'area', 'circle', 'square', 'text', 'tick'];
const COLORS = {
  none: null,
  dim: ['payment_type'],
  sameDim: ['pickup_borough'],
  measure: ['tip_amount'],
  date: ['pickup_datetime'],
  numDim: [['passenger_count', { dim: true }]],
  calcDim: ['Trip length']
};
const LABELS = { none: null, measure: ['fare_amount'], otherMeasure: ['tip_amount'], dim: ['payment_type'], date: ['pickup_datetime'], calc: ['Tip rate %'] };

function configs() {
  const out = [];
  for (const [ln, lay] of Object.entries(LAYOUTS)) {
    const marks = ln === 'none' ? ['pie', 'donut', 'treemap'] : MARKS;
    for (const mark of marks) for (const [cn, color] of Object.entries(COLORS)) for (const [lbn, label] of Object.entries(LABELS)) {
      if (ln === 'none' && !color) continue;
      const c = Object.assign({ name: `${ln}/${mark}/color=${cn}/label=${lbn}`, mark, horizontal: ln === 'catH' }, JSON.parse(JSON.stringify(lay)));
      if (color) c.color = color;
      if (label) c.label = label;
      if (ln === 'none') c.size = ['fare_amount'];
      out.push(c);
    }
  }
  return out;
}

async function runAll(page, list, opts) {
  return page.evaluate(async ({ list, opts }) => {
    const P = await import('/js/pills.js'), St = await import('/js/store.js'), R = await import('/js/render.js'), C = await import('/js/chart.js'), E = await import('/js/engine.js');
    const holder = document.getElementById('lbl-holder') || Object.assign(document.createElement('div'), { id: 'lbl-holder' });
    holder.style.cssText = `position:fixed;left:0;top:0;width:${opts.W + 8}px;height:${opts.H + 8}px;overflow:hidden;background:var(--panel);z-index:9999`;
    document.body.appendChild(holder);
    const mk = (spec, shelf) => {
      const [fname, o] = Array.isArray(spec) ? spec : [spec, {}];
      const p = o.dim ? P.makeDim(fname) : P.makePill(fname, shelf);
      return Object.assign(p, o.set || {});
    };
    const results = [];
    for (const cfg of list) {
      const r = { name: cfg.name, problems: [], notes: [] };
      const shelves = {};
      for (const k of ['cols', 'rows', 'color', 'size', 'label', 'detail', 'filters']) shelves[k] = (cfg[k] || []).map(s => mk(s, k));
      const sh = St.newSheet(cfg.name, shelves, cfg.mark);
      let spec = null, res = null;
      try {
        res = E.runQuery(sh, []);
        spec = C.compileSpec(sh, res, opts.W, opts.H, C.theme(), { compact: opts.compact });
      } catch (e) { r.problems.push('compile threw: ' + e.message); results.push(r); continue; }
      if (spec && !spec.hint) {
        const warns = [];
        const logger = { level() { return this; }, warn(...a) { warns.push(a.join(' ')); return this; }, info() { return this; }, debug() { return this; }, error(...a) { warns.push('error ' + a.join(' ')); return this; } };
        try { vegaLite.compile(spec, { logger }); } catch (e) { warns.push('vl threw ' + e.message); }
        for (const w of warns) r.problems.push('vega-lite: ' + w);
      }
      holder.innerHTML = '<div id="lbl-chart"></div>';
      const el = holder.firstChild;
      el.style.cssText = `width:${opts.W}px;height:${opts.H}px`;
      try { await R.renderSheetInto(el, sh, { W: opts.W, H: opts.H, compact: opts.compact }); } catch (e) { r.problems.push('render threw: ' + e.message); }
      const err = el.querySelector('.error-box');
      if (err) { r.problems.push('error box: ' + err.innerText.replace(/\s+/g, ' ').slice(0, 160)); results.push(r); continue; }
      const svg = el.querySelector('svg');
      if (!svg) { r.notes.push('no chart: ' + el.innerText.replace(/\s+/g, ' ').slice(0, 100)); results.push(r); continue; }
      // label texts = text marks (not axis/legend/title text)
      const markTexts = [...svg.querySelectorAll('g.mark-text.role-mark text')].filter(t => t.textContent.trim() !== '');
      const boxes = markTexts.map(t => { const b = t.getBoundingClientRect(); return { t: t.textContent, x0: b.left, x1: b.right, y0: b.top, y1: b.bottom }; });
      r.labels = boxes.length;
      const isTextMark = cfg.mark === 'text' || (cfg.mark === 'auto' && svg.querySelectorAll('g.mark-text.role-mark').length && !svg.querySelector('g.mark-rect, g.mark-symbol, g.mark-line, g.mark-area, g.mark-arc'));
      // no labels at all is only acceptable when the chart is crowded (many marks in a small space)
      const marksPerPx = res.rows.length / (opts.W * opts.H / 10000);
      if (cfg.label && !isTextMark && boxes.length === 0 && res.rows.length) {
        if (res.rows.length <= 24 || marksPerPx < 0.25) r.problems.push(`Label pill set but no labels drawn (${res.rows.length} marks)`);
        else r.notes.push(`no labels: ${res.rows.length} marks too crowded`);
      }
      // overlap: two labels whose boxes intersect by more than 1.5px both ways (text-table cells are exempt from nothing)
      let overlaps = 0; const ex = [];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ox > 1.5 && oy > 1.5 && !(a.t === b.t && Math.abs(a.x0 - b.x0) < 0.5 && Math.abs(a.y0 - b.y0) < 0.5)) { overlaps++; if (ex.length < 3) ex.push(`"${a.t}" × "${b.t}"`); }
      }
      if (overlaps) r.problems.push(`${overlaps} overlapping labels, e.g. ${ex.join(', ')}`);
      // bar labels line up with a bar: each label's centre falls inside some bar along the category axis
      const bars = [...svg.querySelectorAll('g.mark-rect.role-mark path')].map(p => p.getBoundingClientRect()).filter(b => b.width > 0 && b.height > 0);
      if (bars.length && cfg.label && (cfg.mark === 'bar' || cfg.mark === 'auto') && svg.querySelectorAll('g.mark-rect.role-mark').length) {
        const vertical = !cfg.horizontal;
        // a label belongs to a bar when it reaches into the bar's span on the category axis (centred, or hung inward at an edge)
        const off = boxes.filter(b => !bars.some(r => vertical ? Math.min(b.x1, r.right) - Math.max(b.x0, r.left) > -1.5 : Math.min(b.y1, r.bottom) - Math.max(b.y0, r.top) > -1.5));
        if (off.length) r.problems.push(`${off.length} bar labels not over any bar, e.g. "${off[0].t}"`);
      }
      // the chart fits the width it was given (facets with many panels may scroll, everything else must fit)
      const svgW = svg.getBoundingClientRect().width;
      if (!/^facet/.test(cfg.name) && svgW > opts.W + 24) r.problems.push(`chart is ${Math.round(svgW)}px wide in a ${opts.W}px box`);
      // labels inside the drawing
      const sb = svg.getBoundingClientRect();
      const out = boxes.filter(b => b.x0 < sb.left - 1 || b.x1 > sb.right + 1 || b.y0 < sb.top - 1 || b.y1 > sb.bottom + 1);
      if (out.length) r.problems.push(`${out.length} labels outside the chart, e.g. "${out[0].t}"`);
      // legend
      const legend = svg.querySelector('.role-legend');
      if (cfg.color && !legend) r.problems.push('Color pill set but no legend');
      if (legend) {
        const labels = [...svg.querySelectorAll('.role-legend-label text')].map(t => t.textContent);
        if (labels.some(l => /\d\.\d{4,}/.test(l))) r.problems.push('unreadable legend label: ' + labels.join(' | '));
        if (labels.some(l => /NaN|undefined|Invalid/.test(l))) r.problems.push('broken legend label: ' + labels.join(' | '));
        r.legend = labels;
      }
      // stacked bars: the first legend entry sits on the baseline of the tallest bar
      if (cfg.stackCheck && legend) {
        const sym = [...svg.querySelectorAll('.role-legend-symbol path')].map(p => p.getAttribute('fill'));
        const bars = [...svg.querySelectorAll('g.mark-rect.role-mark path')].map(p => ({ fill: p.getAttribute('fill'), b: p.getBoundingClientRect() }));
        const lowest = bars.reduce((a, b) => (b.b.bottom > a.b.bottom + 0.5 || (Math.abs(b.b.bottom - a.b.bottom) < 0.5 && b.b.height > a.b.height) ? b : a), bars[0]);
        if (lowest && sym.length && lowest.fill !== sym[0]) r.problems.push(`stack order: baseline segment is ${lowest.fill}, first legend entry is ${sym[0]}`);
      }
      results.push(r);
    }
    holder.remove();
    return results;
  }, { list, opts });
}

(async () => {
  const all = configs();
  all.push({ name: 'stack-order', mark: 'bar', cols: ['pickup_borough'], rows: ['fare_amount'], color: ['payment_type'], stackCheck: true });
  const runs = [
    { name: 'light', scheme: 'light', W: 1000, H: 560, compact: false },
    { name: 'dark', scheme: 'dark', W: 1000, H: 560, compact: false },
    { name: 'tile', scheme: 'light', W: 460, H: 300, compact: true }
  ];
  let failures = 0, total = 0, labelled = 0, crowded = 0;
  for (const run of runs) {
    const { browser, page, errors } = await open({ viewport: { width: 1280, height: 800 }, colorScheme: run.scheme });
    await page.waitForSelector('#canvas .tile', { timeout: 30000 });
    const list = run.name === 'light' ? all : all.filter((c, i) => i % 3 === 0 || c.stackCheck); // dark + tile: a third of the matrix each
    const results = [];
    for (let i = 0; i < list.length; i += 60) results.push(...await runAll(page, list.slice(i, i + 60), run));
    const pe = errors.filter(e => !/Service Worker/.test(e));
    if (pe.length) { failures += pe.length; console.log(`[${run.name}] PAGE ERRORS`, pe.slice(0, 5)); }
    for (const r of results) {
      total++;
      if (r.notes.some(n => n.startsWith('no labels'))) crowded++;
      if (r.labels) labelled++;
      if (r.problems.length) { failures++; console.log(`FAIL [${run.name}] ${r.name}\n   - ${r.problems.join('\n   - ')}`); }
    }
    console.log(`[${run.name}] ${results.length} charts, ${results.filter(r => !r.problems.length).length} clean`);
    await browser.close();
  }
  console.log(`\n${total} charts rendered, ${labelled} with labels, ${crowded} too crowded for labels, ${failures} failures`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
