// Runs many shelf setups through the engine, records the generated SQL and the engine's rows,
// and writes the source tables as CSV. tests/duckdb_parity.py then runs the SQL in DuckDB and compares.
const { open } = require('./harness');
const fs = require('fs'), path = require('path');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const SAMPLE_CONFIGS = [
  { name: 'bar', cols: [['pickup_borough']], rows: [['fare_amount']] },
  { name: 'joined field', cols: [['borough']], rows: [['population_2020', { agg: 'max' }], ['Records']] },
  { name: 'agg calc over join', cols: [['pickup_borough']], rows: [['Trips per 100k residents']] },
  { name: 'tip rate by month', cols: [['pickup_datetime', { part: 'month' }]], rows: [['Tip rate %']] },
  { name: 'row calc string dim', cols: [['Trip length']], rows: [['Fare per mile', { agg: 'avg' }], ['fare_amount', { agg: 'median' }]] },
  { name: 'bins', cols: [['trip_distance', { kind: 'dim', bin: 2 }]], rows: [['Records']], color: [['Trip length']] },
  { name: 'weekday x hour', cols: [['pickup_datetime', { part: 'weekday' }]], rows: [['pickup_datetime', { part: 'hour' }]], color: [['Records']] },
  { name: 'set + range filters', cols: [['payment_type']], rows: [['tip_amount', { agg: 'avg' }]], filters: [['pickup_borough', { filter: { type: 'set', include: ['Queens', 'Bronx'] } }], ['trip_distance', { filter: { type: 'range', min: 1, max: 8 } }], ['pickup_datetime', { filter: { type: 'range', min: Date.UTC(2025, 2, 1), max: Date.UTC(2025, 5, 30) } }]] },
  { name: 'match filters (cross-filter)', cols: [['payment_type']], rows: [['Records']], filters: [['pickup_datetime', { filter: { type: 'match', part: 'month', values: [Date.UTC(2025, 6, 1)] } }], ['pickup_datetime', { filter: { type: 'match', part: 'weekday', values: ['Sat', 'Sun'] } }], ['trip_distance', { filter: { type: 'match', bin: 2, values: [0, 2] } }]] },
  { name: 'filter on row calc', cols: [['pickup_borough']], rows: [['total_amount', { agg: 'sum' }]], filters: [['Trip length', { filter: { type: 'set', include: ['Long, 10+ mi'] } }]] },
  { name: 'quarter + countd', cols: [['pickup_datetime', { part: 'quarter' }]], rows: [['payment_type', { kind: 'measure', agg: 'countd' }]] }
];

const MESSY = [
  'Order Date,Ship Date,Region,Sales,Units,Customer ID,Note',
  '1/5/2024,1/9/2024,East,"$1,200.50",3,1001,"a, b"',
  '2/14/2024,2/20/2024,West,$980.00,2,1002,',
  '3/3/2024,3/3/2024,East,"$2,410.00",,1003,ok',
  '12/30/2024,1/2/2025,,$15.25,1,1004,"say ""hi"""',
  '6/1/2025,6/15/2025,South,$700,7,1005,x',
  '6/1/2025,7/31/2025,South,$45.5,1,1006,y',
  '2/28/2025,3/31/2025,West,$300,4,1001,z'
].join('\n') + '\n';
const REGIONS = 'Region,Manager,Target\nEast,Ana,3000\nWest,Bo,1500\nSouth,Cy,900\nNorth,Di,100\n';
const MESSY_CALCS = [
  { id: 'm1', name: 'Days to ship', formula: "DATEDIFF('day', [Order Date], [Ship Date])" },
  { id: 'm2', name: 'Price per unit', formula: 'IF ZN([Units]) > 0 THEN [Sales] / [Units] END' },
  { id: 'm3', name: 'Label', formula: 'IFNULL([Region], "None") + " · " + STR([Customer ID])' },
  { id: 'm4', name: 'Late', formula: "DATEDIFF('day', [Order Date], [Ship Date]) > 7" },
  { id: 'm5', name: 'Sales vs target', formula: 'SUM([Sales]) / MAX([Target])' },
  { id: 'm6', name: 'Order month start', formula: "DATETRUNC('month', [Order Date])" },
  { id: 'm7', name: 'Due', formula: "DATEADD('month', 1, [Order Date])" },
  { id: 'm8', name: 'Weird math', formula: 'ROUND(SQRT(ABS([Sales])) * 2.5 % 7, 2) + POWER(2, 3) - LOG(100) + LN(EXP(1))' },
  { id: 'm9', name: 'Text bits', formula: 'UPPER(LEFT(IFNULL([Note], "-"), 2)) + LOWER(RIGHT([Region], 2)) + MID("abcdef", 2, 3)' },
  { id: 'm10', name: 'Has comma', formula: 'IIF(CONTAINS(IFNULL([Note], ""), ","), "yes", "no")' }
];
const MESSY_CONFIGS = [
  { name: 'messy: region join + target', cols: [['Region']], rows: [['Sales'], ['Sales vs target']], label: [['Manager']] },
  { name: 'messy: us dates by month', cols: [['Order Date', { part: 'month' }]], rows: [['Sales', { agg: 'avg' }]] },
  { name: 'messy: date calcs', cols: [['Days to ship', { kind: 'dim' }]], rows: [['Records']], detail: [['Late'], ['Order month start', { part: 'day' }], ['Due', { part: 'day' }]] },
  { name: 'messy: text calcs', cols: [['Label']], rows: [['Price per unit', { agg: 'max' }], ['Weird math', { agg: 'sum' }]], detail: [['Text bits'], ['Has comma']] },
  { name: 'messy: null region filter', cols: [['Region']], rows: [['Units', { agg: 'sum' }]], filters: [['Region', { filter: { type: 'set', include: ['East', 'Null'] } }]] }
];

async function runConfigs(page, configs) {
  return page.evaluate(async (configs) => {
    const st = await import('/js/store.js'), pills = await import('/js/pills.js'), eng = await import('/js/engine.js'), sql = await import('/js/sql.js');
    return configs.map(cfg => {
      const sh = st.newSheet(cfg.name);
      for (const shelf of ['cols', 'rows', 'color', 'size', 'label', 'detail', 'filters']) sh.shelves[shelf] = (cfg[shelf] || []).map(([f, extra]) => Object.assign(pills.makePill(f, shelf), extra || {}));
      for (const shelf of Object.keys(sh.shelves)) sh.shelves[shelf].forEach(p => { if (p.kind === 'measure' && p.agg === 'countd' && false) {} });
      try { const q = eng.runQuery(sh); return { name: cfg.name, sql: sql.buildSQL(sh), rows: q.rows }; }
      catch (e) { return { name: cfg.name, error: e.message }; }
    });
  }, configs);
}

(async () => {
  const { browser, page, errors } = await open();
  await page.waitForSelector('#canvas .tile', { timeout: 20000 });
  const out = [];
  out.push(...await runConfigs(page, SAMPLE_CONFIGS));
  const csvs = await page.evaluate(async () => { const d = await import('/js/data.js'); return d.sampleTables().map(t => ({ base: t.base, csv: d.tablesToCSV(t) })); });
  for (const t of csvs) fs.writeFileSync(path.join(OUT, t.base + '.csv'), t.csv);
  // messy project: US dates, currency text, blanks, quotes, a joined lookup and lots of calculated fields
  await page.evaluate(async ({ MESSY, REGIONS, MESSY_CALCS }) => {
    const st = await import('/js/store.js'), d = await import('/js/data.js');
    const a = d.parseTable('messy_sales.csv', MESSY), b = d.parseTable('regions.csv', REGIONS);
    st.state.model = { tables: [a, b], joins: [{ id: 'j', tableId: b.id, leftKey: a.id + '::Region', rightKey: 'Region', type: 'left' }], fields: {}, calcs: MESSY_CALCS };
    st.state.DS = d.buildDataset(st.state.model);
  }, { MESSY, REGIONS, MESSY_CALCS });
  const calcErrors = await page.evaluate(async () => { const st = await import('/js/store.js'); return st.state.DS.fields.filter(f => f.type === 'error').map(f => f.name + ': ' + f.calc.error); });
  if (calcErrors.length) console.log('CALC ERRORS', calcErrors);
  out.push(...await runConfigs(page, MESSY_CONFIGS));
  fs.writeFileSync(path.join(OUT, 'messy_sales.csv'), MESSY);
  fs.writeFileSync(path.join(OUT, 'regions.csv'), REGIONS);
  fs.writeFileSync(path.join(OUT, 'queries.json'), JSON.stringify(out));
  const bad = out.filter(o => o.error);
  console.log(`wrote ${out.length} queries`, bad.length ? 'ENGINE ERRORS ' + JSON.stringify(bad) : '');
  console.log('PAGE ERRORS', [...new Set(errors)].slice(0, 5).join('\n'));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
