// Transient notifications stacked at the top of the screen.

import { $ } from './dom.js';

const SHOW_MS = 3200;
const REMOVE_MS = 3800;

export function toast(html, kind = '') {
  const node = document.createElement('div');
  node.className = 'toast ' + kind;
  node.innerHTML = html; // callers escape any user-provided text
  $('#toasts').appendChild(node);
  setTimeout(() => node.classList.add('gone'), SHOW_MS);
  setTimeout(() => node.remove(), REMOVE_MS);
}
