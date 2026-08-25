// Card element factory: every card shown anywhere in the UI comes from here.

import { el } from './dom.js';

export const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };

// Warm the browser cache with every card face so slow connections don't
// show half-loaded cards mid-game.
export function preloadCards() {
  const urls = ['/cards/back.svg'];
  for (const s of 'SHDC') for (const r of '23456789TJQKA') urls.push(`/cards/${r}${s}.svg`);
  urls.forEach(src => { new Image().src = src; });
}

export function cardEl(card, { mini = false, faceDown = false } = {}) {
  const node = el(mini ? 'div' : 'button', 'card' + (mini ? ' mini' : ''));
  const img = document.createElement('img');
  img.draggable = false;
  img.alt = faceDown ? 'card back' : card;
  img.src = faceDown ? '/cards/back.svg' : `/cards/${card}.svg`;
  node.appendChild(img);
  if (!faceDown) node.dataset.card = card;
  return node;
}
