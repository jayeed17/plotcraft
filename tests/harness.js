// Serves the app at https://vizora.test/ under a strict content security policy (no eval, no remote fetch),
// with the CDN libraries answered from node_modules, so tests run offline.
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const LIBS = [process.env.LIBS_DIR, path.join(__dirname, 'node_modules'), path.join(ROOT, 'node_modules')].filter(Boolean).find(d => fs.existsSync(path.join(d, 'vega')));
const CSP = ["default-src 'none'", "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net/npm/", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data:", "img-src 'self' data: blob:", "connect-src 'self'", "worker-src 'self' blob:", "manifest-src 'self'"].join('; ');
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

async function open(opts = {}) {
  const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(p => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 900 }, colorScheme: opts.colorScheme || 'light', serviceWorkers: opts.serviceWorkers || 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (/Service Worker registration blocked/.test(m.text())) return; if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.host === 'vizora.test') {
      const p = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.join(ROOT, decodeURIComponent(p));
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP }, body: fs.readFileSync(file) });
    }
    const m = url.href.match(/^https:\/\/cdn\.jsdelivr\.net\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.*)$/);
    if (m && LIBS) { const f = path.join(LIBS, m[1], m[2]); if (fs.existsSync(f)) return route.fulfill({ status: 200, headers: { 'content-type': 'application/javascript' }, body: fs.readFileSync(f) }); }
    if (url.host === 'fonts.googleapis.com') return route.fulfill({ status: 200, headers: { 'content-type': 'text/css' }, body: '' });
    return route.fulfill({ status: 404, body: '' });
  });
  if (opts.clean !== false) {
    await page.goto('https://vizora.test/index.html');
    await page.evaluate(() => new Promise(r => { const q = indexedDB.deleteDatabase('vizora'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  }
  await page.goto('https://vizora.test/');
  return { browser, context, page, errors };
}
module.exports = { open };
