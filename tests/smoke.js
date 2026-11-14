// Opens the sample project, visits every tab, and fails on any page error or broken visual.
const { open } = require('./harness');
const fs = require('fs');
const OUT = process.env.SHOTS || require('path').join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const { browser, page, errors } = await open();
  await page.waitForSelector('#canvas .tile', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/dashboard.png` });
  const tabs = await page.$$eval('#tabs [data-kind]', els => els.map(e => [e.dataset.kind, e.dataset.i]));
  let bad = 0;
  for (const [kind, i] of tabs) {
    await page.click(`#tabs [data-kind="${kind}"][data-i="${i}"]`);
    await page.waitForTimeout(kind === 'dash' ? 1500 : 700);
    const info = await page.evaluate(() => ({
      errs: [...document.querySelectorAll('.error-box')].filter(e => e.offsetParent).map(e => e.textContent.slice(0, 200)),
      hints: [...document.querySelectorAll('.empty-state.small')].filter(e => e.offsetParent).map(e => e.textContent.slice(0, 120)),
      marks: document.querySelectorAll('#chart svg, #chart canvas, #canvas svg, #canvas canvas, #chart table, #canvas table, .kpi, .gauge, #sourceView table').length,
      title: document.querySelector('#tabs [aria-selected="true"]').textContent
    }));
    if (info.errs.length || info.hints.length || !info.marks) bad++;
    console.log(kind, i, info.title, JSON.stringify({ marks: info.marks, errs: info.errs, hints: info.hints }));
    await page.screenshot({ path: `${OUT}/tab-${kind}-${i}.png` });
  }
  const uniq = [...new Set(errors)];
  console.log('ERRORS', uniq.length, uniq.slice(0, 15).join('\n'));
  await browser.close();
  process.exit(bad || uniq.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
