// Shared table pieces used by every game view: naming, the trick area,
// card-flight animations, the session standings and room-level toasts.
// Game-specific rendering lives in thulla-view.js / rung-view.js.

import { $, el, escapeHtml } from '../dom.js';
import { cardEl, SUIT_SYM } from '../cards.js';
import { toast } from '../toast.js';

export const FLY_MS = 750;
const FLIP_AT_MS = 280;

export function playerName(state, seat) {
  const p = state.players.find(pl => pl.seat === seat);
  if (!p) return `Player ${seat + 1}`;
  return seat === state.youSeat ? `${p.name} (you)` : p.name;
}

export function prettyCard(card) {
  return `${card[0] === 'T' ? '10' : card[0]}${SUIT_SYM[card[1]]}`;
}

/* ---------- trick area ---------- */

export function renderTrickCards(state, trick) {
  const box = $('#trick');
  box.innerHTML = '';
  for (const play of trick) {
    const wrap = el('div', 'trick-card');
    wrap.appendChild(cardEl(play.card, { mini: true }));
    wrap.appendChild(el('div', 'trick-label', playerName(state, play.seat).replace(' (you)', '')));
    // Rung's double-Ace rule: this Ace fights as a 2 — say so on the table.
    if (play.demoted) wrap.appendChild(el('div', 'demote-tag', 'counts as 2'));
    // Thulla's Sarrein: this card was blind-picked from the opponent's hand.
    if (play.blind) wrap.appendChild(el('div', 'demote-tag', 'blind pick'));
    box.appendChild(wrap);
  }
}

/* ---------- house-rule toggles ---------- */

// A switch shown to everyone between games so guests know what they're
// playing; only the host can flip it (for the next game). `defaultOn` is
// the rule's value when the room never touched it.
export function renderRuleToggle(state, send, id, rule, label, defaultOn) {
  const isHost = !!state.players.find(p => p.seat === state.youSeat)?.isHost;
  const on = state.gameRules?.[rule] ?? defaultOn;
  const toggle = $(id);
  toggle.hidden = false;
  toggle.textContent = `${label}: ${on ? 'ON' : 'OFF'}`;
  toggle.classList.toggle('off', !on);
  toggle.disabled = !isHost;
  toggle.title = isHost ? 'Tap to flip for the next game' : 'Only the host can change this';
  toggle.onclick = () => send({ type: 'set_rule', rule, value: !on });
}

/* ---------- card-flight helpers ---------- */

export function captureTrickRects() {
  return [...document.querySelectorAll('#trick .trick-card .card')].map(node => ({
    card: node.dataset.card,
    rect: node.getBoundingClientRect(),
  }));
}

export function makeFlyingCard(source) {
  const fx = cardEl(source.card, { mini: true });
  fx.classList.add('fx-card');
  Object.assign(fx.style, {
    left: source.rect.left + 'px',
    top: source.rect.top + 'px',
    width: source.rect.width + 'px',
    height: source.rect.height + 'px',
  });
  document.body.appendChild(fx);
  return fx;
}

export function deltaToCenter(source, target) {
  return {
    dx: (target.left + target.width / 2) - (source.rect.left + source.rect.width / 2),
    dy: (target.top + target.height / 2) - (source.rect.top + source.rect.height / 2),
  };
}

// Slide the shown trick cards into a target box (waste pile, winner's
// chip…), optionally flipping them face-down mid-flight.
export function flyToTarget(sources, target, { flip = false } = {}) {
  if (!target) return;
  sources.forEach((s, i) => {
    if (!s.card) return;
    const fx = makeFlyingCard(s);
    const { dx, dy } = deltaToCenter(s, target);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fx.style.transform =
        `translate(${dx}px, ${dy}px) rotate(${((i * 47) % 40) - 20}deg) scale(0.95)`;
    }));
    if (flip) setTimeout(() => { fx.querySelector('img').src = '/cards/back.svg'; }, FLIP_AT_MS);
    setTimeout(() => fx.remove(), FLY_MS);
  });
}

export function chipRect(seat) {
  const chip = document.querySelectorAll('#players .player-chip')[seat];
  return chip ? chip.getBoundingClientRect() : null;
}

export function splash(text) {
  const node = document.createElement('div');
  node.className = 'fx-splash';
  node.textContent = text;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 1450);
}

/* ---------- session standings ---------- */

// Standings on the game-over overlay: losses are the headline (that's the
// house scoring), biggest loser on top for maximum dissing. Wins and
// whitewashes (team games) show once someone has any.
export function renderStandings(state) {
  const box = $('#overlay-stats');
  if (!state.gamesPlayed) { box.hidden = true; return; }
  const rows = [...state.players].sort((a, b) =>
    b.stats.losses - a.stats.losses || b.stats.games - a.stats.games);
  const maxLosses = rows[0]?.stats.losses ?? 0;
  box.hidden = false;
  box.innerHTML =
    `<div class="stats-title">Session scoreboard — ${state.gamesPlayed} game${state.gamesPlayed === 1 ? '' : 's'} played</div>` +
    rows.map(p => {
      const worst = maxLosses > 0 && p.stats.losses === maxLosses;
      const extras =
        (p.stats.wins > 0 ? ` 🏆 ${p.stats.wins}` : '') +
        (p.stats.whitewashes > 0 ? ` 🧹 ${p.stats.whitewashes}` : '');
      return `<div class="stats-row${worst ? ' worst' : ''}">` +
        `<span>${worst ? '👑 ' : ''}${escapeHtml(p.name)}${p.seat === state.youSeat ? ' (you)' : ''}</span>` +
        `<span>💀 ${p.stats.losses}${extras} <small>in ${p.stats.games}</small></span></div>`;
    }).join('');
}

/* ---------- room-level toasts (shared by all games) ---------- */

export function announceShared(state, ev) {
  const name = seat => escapeHtml(playerName(state, seat));
  switch (ev.type) {
    case 'undo':
      toast(`↩ ${name(ev.seat)} took their card back`);
      return true;
    case 'spectator_joined':
      toast(`👁 ${escapeHtml(ev.name)} is watching`);
      return true;
    case 'spectators_seated':
      toast(`🪑 ${escapeHtml(ev.names.join(', '))} joined the game`);
      return true;
    case 'seats_swapped':
      toast(`🪑 ${escapeHtml(ev.names.join(' and '))} swapped seats`);
      return true;
    case 'game_changed':
      toast(`🎲 The room now plays ${escapeHtml(ev.title)}`);
      return true;
    case 'players_dropped':
      toast(`📡 ${escapeHtml(ev.names.join(', '))} dropped (connection lost)`, 'error');
      return true;
    case 'restarted':
      toast('New game started with the remaining players');
      return true;
    case 'back_to_lobby':
      toast('Not enough players left — back to the lobby');
      return true;
    case 'dissolved':
      toast('🛑 The host dissolved the game — nothing counted, back to the lobby');
      return true;
  }
  return false;
}
