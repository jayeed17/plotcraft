// Runs the packaged frontend with a mock Tauri bridge. Native installers are tested separately.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { open } = require('./harness');

(async () => {
  execFileSync(process.execPath, [path.join(__dirname, '../desktop/scripts/copy-web.mjs')]);
  const { browser, page, errors } = await open({ desktop: true });
  try {
    await page.waitForSelector('#canvas .tile');
    assert.equal(await page.locator('#installBtn').count(), 0);
    assert.equal(await page.locator('html.desktop').count(), 1);
    assert.equal(await page.evaluate(() => window.__vizora.state.DS.n), 9000);

    const helpUrl = 'https://example.com/vizora-help';
    const openedUrl = await page.evaluate(url => {
      const link = Object.assign(document.createElement('a'), { href: url });
      document.body.append(link);
      link.click();
      return window.__openedDesktopUrl;
    }, helpUrl);
    assert.equal(openedUrl, helpUrl);
    assert.deepEqual(errors, []);
    console.log('Desktop frontend boots and delegates external links to Tauri');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
