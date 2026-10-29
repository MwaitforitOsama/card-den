// Thulla-specific table rendering: the waste pile, take/concede consent
// flows, fresh-card marking and the thulla pickup animation. The shared
// frame (chips, hand, grace, undo, overlay shell) lives in game-view.js.

import { $, el, escapeHtml } from '../dom.js';
import { cardEl, SUIT_SYM } from '../cards.js';
import { toast } from '../toast.js';
import {
  playerName, prettyCard, makeFlyingCard, deltaToCenter, flyToTarget,
  chipRect, splash,
} from './table-common.js';

const WASTE_STACK_MAX = 14;
const ACE_REVEAL_MS = 2200; // how long the "X has the A♠" reveal holds the table

export function createThullaView({ send, rerender }) {
  let freshCards = new Set(); // cards just picked up, marked until your next play
  // The deal auto-throws the A♠ in the same broadcast, so nobody would see
  // who held it. For a moment after 'started' we name the holder, keep the
  // card off the table and lock hands, then fly it in from their chip.
  let opening = null; // { seat, name, timer } while the reveal plays

  // Cards you just picked up (thulla or a taken hand) stay marked in your
  // hand until you throw your next card — otherwise they vanish into the
  // sorted hand and you can't tell what you actually received.
  function onState(msg, events, prevGame) {
    const me = msg.youSeat;
    if (events.some(ev => ev.type === 'started')) {
      freshCards = new Set();
      startAceReveal(msg, events);
    } else if (opening && events.some(ev => ev.type === 'played')) {
      endAceReveal({ animate: false }); // someone already played on: catch up
    }
    if (me < 0 || !msg.game) return;
    if (events.some(ev => ev.type === 'played' && ev.seat === me)) freshCards = new Set();
    const pickedUp = events.some(ev =>
      (ev.type === 'thulla' && ev.winner === me) || (ev.type === 'took' && ev.seat === me));
    if (!pickedUp) return;
    const before = new Set(prevGame?.hand ?? []);
    freshCards = new Set(msg.game.hand.filter(c => !before.has(c)));
    if (freshCards.size) {
      toast(`You picked up: ${[...freshCards].map(prettyCard).join('  ')}`);
    }
  }

  /* ---------- the A♠ reveal (first sarr only) ---------- */

  function startAceReveal(state, events) {
    const ev = events.find(e => e.type === 'played' && e.card === 'AS');
    endAceReveal({ animate: false, render: false });
    if (!ev) return;
    opening = {
      seat: ev.seat,
      name: playerName(state, ev.seat),
      timer: setTimeout(() => endAceReveal({ animate: true }), ACE_REVEAL_MS),
    };

    const who = ev.seat === state.youSeat
      ? 'You have'
      : `<b>${escapeHtml(playerName(state, ev.seat))}</b> has`;
    const banner = el('div', 'ace-reveal');
    banner.appendChild(cardEl('AS', { mini: true }));
    const text = el('div', 'ace-reveal-text');
    text.innerHTML = `${who} the Ace of Spades<small>throwing it to open sarr 1…</small>`;
    banner.appendChild(text);
    document.body.appendChild(banner);
  }

  function endAceReveal({ animate, render = true }) {
    if (!opening) return;
    clearTimeout(opening.timer);
    const { seat, name } = opening;
    opening = null;
    document.querySelectorAll('.ace-reveal').forEach(n => n.remove());
    if (!render) return;
    rerender();
    if (!animate) return;
    flyAceIn(seat);
    toast(`♠️ <b>${escapeHtml(name)}</b> threw the Ace of Spades`);
  }

  // The A♠ travels from its holder's chip to its spot on the table.
  function flyAceIn(seat) {
    const node = document.querySelector('#trick .trick-card .card[data-card="AS"]')?.closest('.trick-card');
    const from = chipRect(seat);
    if (!node || !from) return;
    const to = node.getBoundingClientRect();
    const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
    const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
    node.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(0.45) rotate(-14deg)`, opacity: 0.3 },
      { transform: 'translate(0, 0) scale(1.15) rotate(3deg)', opacity: 1, offset: 0.75 },
      { transform: 'none', opacity: 1 },
    ], { duration: 650, easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)' });
  }

  const visibleTrick = state =>
    (opening ? state.game.trick.filter(p => p.card !== 'AS') : state.game.trick);
  const handLocked = () => !!opening;

  function decorateCard(card, node) {
    if (freshCards.has(card)) node.classList.add('fresh');
  }

  // Who plays after the current player: next non-safe seat clockwise that
  // still holds cards (a 0-card seat mid-sarr is just waiting to be safe).
  function nextSeat(state) {
    const g = state.game;
    if (!g || g.phase !== 'playing' || g.turn === null) return null;
    for (let i = 1; i < state.players.length; i++) {
      const s = (g.turn + i) % state.players.length;
      const pl = state.players.find(p => p.seat === s);
      if (pl && !pl.safe && pl.cardCount > 0) return s;
    }
    return null;
  }

  function chipDecor(state, p, chip) {
    const g = state.game;
    if (opening && p.seat === opening.seat) {
      chip.classList.add('ace-holder');
      return 'has the A♠ ♠️';
    }
    if (!p.connected) chip.classList.add('offline');
    if (p.safe) chip.classList.add('safe');
    if (g && state.phase === 'over' && g.bhabhi === p.seat) chip.classList.add('bhabhi');
    if (state.phase === 'lobby') return p.connected ? 'ready' : 'away';
    if (g && state.phase === 'over' && g.bhabhi === p.seat) return 'game parr gayi';
    if (p.safe) return 'Safely Bahar';
    return `${p.cardCount} cards`;
  }

  // Lobby line under the status: seat order = play order, host can shuffle.
  function lobbyNote(state, iAmHost) {
    if (!iAmHost || state.players.length < 2) return null;
    return 'Seats are the playing order — tap two players to swap them';
  }

  function statusText(state, next) {
    const g = state.game;
    if (!g || g.phase !== 'playing') return '';
    if (opening) return `Sarr 1 — ${playerName(state, opening.seat)} has the A♠ and throws it…`;
    const turnName = playerName(state, g.turn);
    const nextName = next !== null ? ` · ${playerName(state, next).replace(' (you)', '')} next` : '';
    if (g.trick.length === 0) {
      return g.trickNumber === 1
        ? `Sarr 1 — ${turnName} must open with the A♠`
        : `Sarr ${g.trickNumber} — ${turnName} leads${nextName}`;
    }
    return `Sarr ${g.trickNumber} — ${SUIT_SYM[g.ledSuit]} led · ${turnName} to play${nextName}`;
  }

  /* ---------- waste pile ---------- */

  function renderWaste(count) {
    const box = $('#waste');
    box.hidden = count <= 0;
    if (count <= 0) return;
    const stack = $('#waste-stack');
    stack.innerHTML = '';
    // Deterministic "messy pile": same rotations every render, no jitter.
    const shown = Math.min(count, WASTE_STACK_MAX);
    for (let i = 0; i < shown; i++) {
      const back = cardEl('', { mini: true, faceDown: true });
      back.classList.add('waste-back');
      back.style.transform =
        `translate(${((i * 53) % 9) - 4}px, ${((i * 71) % 9) - 4}px) rotate(${((i * 137) % 24) - 12}deg)`;
      stack.appendChild(back);
    }
    $('#waste-count').textContent = count;
  }

  /* ---------- center: waste + consent buttons ---------- */

  function renderCenter(state) {
    const g = state.game;
    if (g && state.phase !== 'lobby') {
      const handTotal = state.players.reduce((sum, p) => sum + p.cardCount, 0);
      renderWaste(52 - handTotal - g.trick.length);
    } else {
      renderWaste(0);
    }

    // Take button (asker's side) — taking needs the target's approval, so
    // the button only files a request.
    const takeBtn = $('#btn-take');
    const pending = state.pendingTake;
    if (g && g.phase === 'playing' && pending && pending.from === state.youSeat) {
      takeBtn.hidden = false;
      takeBtn.disabled = true;
      takeBtn.textContent = `Waiting for ${playerName(state, pending.target).replace(' (you)', '')}…`;
    } else if (g && g.phase === 'playing' && !pending
        && g.takeTarget !== null && g.takeTarget !== undefined) {
      const target = state.players.find(p => p.seat === g.takeTarget);
      takeBtn.hidden = false;
      takeBtn.disabled = false;
      takeBtn.textContent = `Ask to take ${target ? target.name : 'next player'}’s cards (${target ? target.cardCount : '?'})`;
    }

    // Take prompt (target's side)
    if (g && g.phase === 'playing' && pending && pending.target === state.youSeat) {
      $('#take-prompt').hidden = false;
      $('#take-prompt-text').textContent =
        `${playerName(state, pending.from)} wants to take ALL your cards — you'd be Safely Bahar. Hand them over?`;
    }

    // Concede button (head-to-head only) — needs the opponent's approval,
    // so pressing it only files an offer.
    const concedeBtn = $('#btn-concede');
    const offer = state.pendingConcede;
    if (g && g.phase === 'playing' && offer && offer.seat === state.youSeat) {
      concedeBtn.hidden = false;
      concedeBtn.disabled = true;
      concedeBtn.textContent = `Waiting for ${playerName(state, offer.winner).replace(' (you)', '')}…`;
    } else if (g && g.phase === 'playing' && !offer && g.youCanConcede) {
      concedeBtn.hidden = false;
      concedeBtn.disabled = false;
      concedeBtn.textContent = '🏳️ Concede the game';
    }

    // Concede prompt (winner's side)
    if (g && g.phase === 'playing' && offer && offer.winner === state.youSeat) {
      $('#concede-prompt').hidden = false;
      $('#concede-prompt-text').textContent =
        `${playerName(state, offer.seat)} wants to concede — their game parr gayi, you win. End it here?`;
    }
  }

  function overlayHTML(state) {
    const g = state.game;
    return g.bhabhi !== null
      ? `😆 <b>${escapeHtml(playerName(state, g.bhabhi))}</b> di <b>game parr gayi!</b>`
      : `🤝 It’s a draw — everyone Safely Bahar!`;
  }

  /* ---------- animations ---------- */

  function resolutionOf(events) {
    return events.find(ev => ev.type === 'trick_won' || ev.type === 'thulla') ?? null;
  }

  // Sweep the finished trick away: clean tricks flip to backs and slide onto
  // the waste pile; a thulla gets a full production number.
  function fly(sources, resolution) {
    if (resolution.type === 'thulla') return flyThulla(sources, resolution);
    const waste = $('#waste');
    if (waste && !waste.hidden) flyToTarget(sources, waste.getBoundingClientRect(), { flip: true });
  }

  // The thulla moment: splash text, cards lifting off one by one and arcing
  // into the picker-upper's chip, which flashes red as they land.
  function flyThulla(sources, resolution) {
    const chip = document.querySelectorAll('#players .player-chip')[resolution.winner];
    const target = chip?.getBoundingClientRect();
    if (!target) return;

    splash('💥 THULLA!');
    if (chip) {
      chip.classList.add('thulla-hit');
      setTimeout(() => chip.classList.remove('thulla-hit'), 1700);
    }

    sources.forEach((s, i) => {
      if (!s.card) return;
      const fx = makeFlyingCard(s);
      fx.style.transition = 'none'; // the Web Animation below does the work
      const { dx, dy } = deltaToCenter(s, target);
      const rot = ((i * 53) % 50) - 25;
      fx.animate([
        { transform: 'translate(0, 0) scale(1) rotate(0deg)', opacity: 1, offset: 0 },
        { transform: `translate(0, -16px) scale(1.18) rotate(${rot / 3}deg)`, opacity: 1, offset: 0.2 },
        { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 80}px) scale(1) rotate(${rot}deg)`, opacity: 1, offset: 0.62 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.3) rotate(${rot * 1.6}deg)`, opacity: 0.1, offset: 1 },
      ], { duration: 1050, delay: i * 110, easing: 'cubic-bezier(0.45, 0.2, 0.35, 1)', fill: 'both' });
      setTimeout(() => fx.remove(), 1050 + i * 110 + 120);
    });
  }

  /* ---------- toasts ---------- */

  function announce(state, ev) {
    const name = seat => escapeHtml(playerName(state, seat));
    switch (ev.type) {
      case 'started':
        toast('🃏 Cards dealt!');
        return true;
      case 'thulla':
        toast(`💥 THULLA! ${name(ev.winner)} picks up ${ev.cards.length} cards`, 'thulla');
        return true;
      case 'trick_won':
        toast(`${name(ev.seat)} takes the sarr`);
        return true;
      case 'safe':
        toast(`🎉 ${name(ev.seat)} Safely Bahar!`);
        return true;
      case 'take_requested':
        toast(`${name(ev.from)} wants to take ${name(ev.target)}’s cards`);
        return true;
      case 'take_declined':
        toast(`${name(ev.target)} declined — ${name(ev.from)} plays on`);
        return true;
      case 'concede_requested':
        toast(`🏳️ ${name(ev.seat)} offers to concede`);
        return true;
      case 'concede_declined':
        toast(`${name(ev.winner)} says keep playing — no easy way out`);
        return true;
      case 'conceded':
        toast(`🏳️ ${name(ev.seat)} conceded — ${name(ev.winner)} wins!`, 'thulla');
        return true;
      case 'took':
        toast(`${name(ev.seat)} took ${name(ev.target)}’s ${ev.count} cards`, 'thulla');
        return true;
      case 'game_over':
        toast(ev.bhabhi !== null ? `${name(ev.bhabhi)} di game parr gayi 😆` : 'Draw — everyone Safely Bahar!');
        return true;
    }
    return false;
  }

  function reset() {
    freshCards = new Set();
    endAceReveal({ animate: false, render: false });
  }

  return {
    id: 'thulla',
    minPlayers: 3,
    onState, decorateCard, visibleTrick, handLocked, nextSeat, chipDecor, lobbyNote, statusText,
    renderCenter, overlayHTML, resolutionOf, fly, announce, reset,
  };
}
