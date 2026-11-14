// Copies the web app (repo root) into desktop/dist, which Tauri bundles into the native app.
// The desktop build ships the exact same files as the website, minus the service worker and tests.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const dist = join(here, '..', 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const item of ['index.html', 'css', 'js', 'vendor', 'icons', 'manifest.webmanifest']) {
  cpSync(join(root, item), join(dist, item), { recursive: true });
}
// The desktop window has no address bar, so drop the "Install app" button.
const html = readFileSync(join(dist, 'index.html'), 'utf8')
  .replace(/\s*<button class="btn" id="installBtn"[^>]*>Install app<\/button>/, '');
writeFileSync(join(dist, 'index.html'), html);
console.log('Copied the web app into', dist);
