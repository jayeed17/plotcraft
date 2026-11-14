// Menus and modal dialogs shared by every view.
import { $, esc } from './util.js';

let menuAnchor = null, menuSections = null;
export function openMenu(anchor, sections) {
  const menu = $('#menu');
  menuSections = sections;
  menu.innerHTML = sections.map((sec, si) => (sec.title ? `<h4 class="label-caps">${esc(sec.title)}</h4>` : '') +
    sec.items.map((it, i) => `<button type="button" role="menuitem" data-mi="${si}:${i}" ${it.disabled ? 'disabled' : ''} class="${it.danger ? 'danger' : ''}"><span class="chk">${it.checked ? '✓' : ''}</span>${esc(it.label)}</button>`).join('')).join('<hr>');
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = r.left, top = r.bottom + 4;
  if (left + mw > innerWidth - 8) left = innerWidth - mw - 8;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = Math.max(8, left) + 'px'; menu.style.top = top + 'px';
  menuAnchor = anchor;
  const first = menu.querySelector('button:not([disabled])'); if (first) first.focus();
}
export function closeMenu(refocus) {
  const menu = $('#menu');
  if (menu.hidden) return;
  menu.hidden = true;
  if (refocus && menuAnchor && document.contains(menuAnchor)) menuAnchor.focus();
  menuAnchor = null;
}
export function initMenus() {
  const menu = $('#menu');
  menu.addEventListener('click', e => {
    const b = e.target.closest('button[data-mi]'); if (!b) return;
    const [s, i] = b.dataset.mi.split(':').map(Number);
    const it = menuSections[s].items[i];
    closeMenu(false);
    if (it && it.action) it.action();
  });
  menu.addEventListener('keydown', e => {
    const items = [...menu.querySelectorAll('button:not([disabled])')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
  });
  document.addEventListener('mousedown', e => { if (!menu.hidden && !e.target.closest('#menu')) closeMenu(false); });
}

// Opens a modal. body is HTML; returns { el, close }. Esc and clicking the scrim close it.
export function openModal({ title, desc = '', body, foot = '', wide = false }) {
  const m = $('#modal');
  const prev = document.activeElement;
  m.innerHTML = `<div class="modal-card${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="mhead"><div class="modal-head"><h2 id="mhead">${esc(title)}</h2>${desc ? `<p>${esc(desc)}</p>` : ''}</div><div class="modal-body">${body}</div><div class="modal-foot">${foot}</div></div>`;
  m.hidden = false;
  const close = () => { m.hidden = true; m.innerHTML = ''; m.onclick = null; m.onkeydown = null; if (prev && document.contains(prev)) prev.focus(); };
  m.onclick = e => { if (e.target === m) close(); };
  m.onkeydown = e => { if (e.key === 'Escape') close(); };
  return { el: m, close };
}
