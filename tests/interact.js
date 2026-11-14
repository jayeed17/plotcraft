// Drives the UI like a person: cross-filtering, slicers, layout editing, calculated fields,
// renaming and joining, opening files, and reloading to check the project is remembered.
const { open } = require('./harness');
const fs = require('fs'), path = require('path');
const OUT = process.env.SHOTS || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };

(async () => {
  let { browser, context, page, errors } = await open();
  await page.waitForSelector('#canvas .tile', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const kpi = id => page.textContent(`[data-tile="${id}"] .kpi-value`);
  const trips0 = await kpi('kpi0-3');
  check(trips0.trim() === '9,000', `KPI starts at 9,000 trips (got ${trips0})`);

  // cross-filter: click the Manhattan bar in "Trips per 100k residents"
  await page.locator('[data-tile="sheet4-17"] .mark-rect path').first().click({ force: true });
  await page.waitForTimeout(1200);
  const sel = await page.evaluate(() => window.__plotcraft.state.selection);
  const COUNTS = { Manhattan: '5,716', Queens: '1,414', Brooklyn: '1,123', Bronx: '548', 'Staten Island': '199' };
  check(sel && COUNTS[sel.items[0].value], `clicking a bar selects ${sel && sel.items.map(i => i.value)}`);
  check(sel && (await kpi('kpi0-3')).trim() === COUNTS[sel.items[0].value], `other tiles filter to it (Trips = ${(await kpi('kpi0-3')).trim()})`);
  await page.screenshot({ path: `${OUT}/i-crossfilter.png` });
  await page.click('#clearSelBtn'); await page.waitForTimeout(900);
  check((await kpi('kpi0-3')).trim() === '9,000', 'clear selection restores totals');

  // slicer: untick Manhattan
  await page.uncheck('[data-tile="slicer0-8"] input[value="Manhattan"]');
  await page.waitForTimeout(1200);
  check((await kpi('kpi0-3')).trim() === '3,284', `slicer filters KPI (Trips = ${(await kpi('kpi0-3')).trim()})`);
  await page.check('[data-tile="slicer0-8"] input[data-slall]'); await page.waitForTimeout(900);

  // edit layout: drag the line chart tile and resize the donut
  await page.click('#editLayoutBtn'); await page.waitForTimeout(600);
  const before = await page.evaluate(() => JSON.stringify(window.__plotcraft.state.dashboards[0].tiles.map(t => [t.id, t.x, t.y, t.w, t.h])));
  const h = await page.locator('[data-drag="sheet0-17"]').boundingBox();
  await page.mouse.move(h.x + 40, h.y + 10); await page.mouse.down(); await page.mouse.move(h.x + 40 + 700, h.y + 10, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(800);
  const r = await page.locator('[data-resize="sheet3-8"]').boundingBox();
  await page.mouse.move(r.x + 8, r.y + 8); await page.mouse.down(); await page.mouse.move(r.x + 8 - 300, r.y + 8 + 120, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(800);
  const tiles = await page.evaluate(() => window.__plotcraft.state.dashboards[0].tiles.map(t => ({ ...t })));
  const overl = tiles.some(a => tiles.some(b => a !== b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
  check(JSON.stringify(tiles.map(t => [t.id, t.x, t.y, t.w, t.h])) !== before, 'drag and resize changed the layout');
  check(!overl, 'no tiles overlap after moving');
  await page.screenshot({ path: `${OUT}/i-editing.png` });
  await page.click('#editLayoutBtn');

  // add a KPI card from the Add menu
  await page.click('#addTileBtn'); await page.click('#menu button:has-text("KPI card")');
  await page.selectOption('#kMeasure', 'tip_amount'); await page.click('#kOk'); await page.waitForTimeout(900);
  const nT = await page.evaluate(() => window.__plotcraft.state.dashboards[0].tiles.length);
  check(nT === 13, `KPI card added (${nT} tiles)`);

  // calculated field from a sheet
  await page.click('#tabs [data-kind="sheet"][data-i="0"]'); await page.waitForTimeout(600);
  await page.click('#newCalcBtn');
  await page.fill('#calcName', 'Total per trip');
  await page.fill('#calcFormula', 'SUM([total_amount]) / COUNT([total_amount])');
  await page.waitForTimeout(300);
  check((await page.getAttribute('#calcStatus', 'class')).includes('ok'), 'valid formula shows a preview: ' + (await page.textContent('#calcStatus')).slice(0, 90));
  await page.screenshot({ path: `${OUT}/i-calc.png` });
  await page.fill('#calcFormula', 'SUM([total_amount]) / [trip_minutes]');
  await page.waitForTimeout(300);
  check((await page.getAttribute('#calcStatus', 'class')).includes('bad'), 'mixing row and aggregate is an error: ' + (await page.textContent('#calcStatus')).slice(0, 100));
  await page.fill('#calcFormula', 'SUM([total_amount]) / COUNT([total_amount])');
  await page.click('#calcSave'); await page.waitForTimeout(800);
  check(await page.isVisible('.field[data-field="Total per trip"]'), 'new calc appears in the Data pane');
  await page.dragAndDrop('.field[data-field="Total per trip"]', '#shelf-rows'); await page.waitForTimeout(800);
  check(await page.evaluate(() => document.querySelectorAll('#chart svg').length > 0 && !document.querySelector('#chart .error-box')), 'calc draws in a chart');

  // data source: rename a field, then check sheets follow
  await page.click('#tabs [data-kind="source"]'); await page.waitForTimeout(600);
  await page.fill('input[data-fname="payment_type"]', 'Payment method'); await page.press('input[data-fname="payment_type"]', 'Enter');
  await page.waitForTimeout(800);
  const renamed = await page.evaluate(() => window.__plotcraft.state.sheets[4].shelves.color[0].field);
  check(renamed === 'Payment method', `rename flows into sheets (${renamed})`);
  await page.screenshot({ path: `${OUT}/i-source.png`, fullPage: true });

  // join a new table from a file
  fs.writeFileSync('/tmp/claude-0/payment_codes.csv', 'Payment method,code,is_electronic\nCredit card,1,yes\nCash,2,no\nNo charge,3,no\nDispute,4,no\n');
  await page.setInputFiles('#addTableInput', '/tmp/claude-0/payment_codes.csv');
  await page.waitForSelector('#jOk'); await page.waitForTimeout(300);
  const stats = await page.textContent('#jStats');
  check(/9,000/.test(stats), 'join editor finds the right key: ' + stats.slice(0, 60));
  await page.click('#jOk'); await page.waitForTimeout(900);
  check(await page.evaluate(() => !!window.__plotcraft.state.DS.fieldMap.get('is_electronic')), 'joined columns become fields');

  // reload: project (including the new table) is remembered
  await page.goto('https://plotcraft.test/'); await page.waitForTimeout(2500);
  const kept = await page.evaluate(() => ({ calc: !!window.__plotcraft.state.DS.fieldMap.get('Total per trip'), join: !!window.__plotcraft.state.DS.fieldMap.get('is_electronic'), tiles: window.__plotcraft.state.dashboards[0].tiles.length }));
  check(kept.calc && kept.join && kept.tiles === 13, 'reload restores the project ' + JSON.stringify(kept));

  // open a different CSV as a new project
  fs.writeFileSync('/tmp/claude-0/sales.csv', 'Order Date,Region,Sales\n1/5/2024,East,"$1,200.50"\n2/14/2024,West,$980.00\n3/3/2024,East,"$2,410.00"\n');
  await page.setInputFiles('#fileInput', '/tmp/claude-0/sales.csv'); await page.waitForTimeout(1000);
  const f = await page.evaluate(() => window.__plotcraft.state.DS.fields.map(x => x.name + ':' + x.type));
  check(f.includes('Sales:number') && f.includes('Order Date:date'), 'new CSV infers types ' + f.join(', '));
  console.log('PAGE ERRORS', [...new Set(errors)].slice(0, 10).join('\n') || 'none');
  if ([...new Set(errors)].length) failures++;
  await browser.close();

  // phone and dark screenshots
  ({ browser, page, errors } = await open({ viewport: { width: 390, height: 844 } }));
  await page.waitForSelector('#canvas .tile', { timeout: 20000 }); await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/m-dashboard.png`, fullPage: true });
  check(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'no sideways scroll on a phone');
  await browser.close();
  ({ browser, page, errors } = await open({ colorScheme: 'dark' }));
  await page.waitForSelector('#canvas .tile', { timeout: 20000 }); await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/d-dashboard.png` });
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
