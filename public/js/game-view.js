// The table screen coordinator. Owns everything every game shares — the
// player chips, hand, timers, overlay, seat swapping, sweep bookkeeping —
// and delegates the game-specific parts (center widgets, status text,
// animations, toasts) to the view matching the room's current game.

import { $, el } from './dom.js';
import { cardEl } from './cards.js';
import {
  renderTrickCards, captureTrickRects, renderStandings, announceShared,
} from './views/table-common.js';
import { createThullaView } from './views/thulla-view.js';
import { createRungView } from './views/rung-view.js';

export function createGameView({ send }) {
  const VIEWS = {
    thulla: createThullaView({ send, rerender: () => lastState && render(lastState) }),
    rung: createRungView({ send }),
  };
  let currentView = VIEWS.thulla;
  let lastState = null;
  let pendingSweep = null; // completed sarr shown face-up, awaiting the next move
  let overlayDismissed = false; // player closed the game-over overlay
  let swapPick = null; // first seat the host tapped for a swap
  let dissolveArmedUntil = 0; // two-tap confirm for the dissolve button
  let graceTimer = null;
  let graceEndsAt = null;

  $('#btn-overlay-close').onclick = () => {
    overlayDismissed = true;
    $('#overlay').hidden = true;
  };

  /* ---------- undo countdown ---------- */

  let undoTimer = null;
  let undoEndsAt = null;

  function renderUndo(state) {
    const g = state.game;
    const u = g && g.phase === 'playing' ? g.undo : null;
    if (u && u.seat === state.youSeat) {
      undoEndsAt = Date.now() + u.remainingMs;
      $('#btn-undo').hidden = false;
      tickUndo();
      if (!undoTimer) undoTimer = setInterval(tickUndo, 250);
    } else {
      stopUndo();
    }
  }

  function tickUndo() {
    const remain = Math.ceil((undoEndsAt - Date.now()) / 1000);
    if (remain <= 0) return stopUndo();
    $('#btn-undo').textContent = `↩ Change card (${remain}s)`;
  }

  function stopUndo() {
    clearInterval(undoTimer);
    undoTimer = null;
    $('#btn-undo').hidden = true;
  }

  /* ---------- grace countdown ---------- */

  function renderGrace(state) {
    const banner = $('#grace-banner');
    if (state.phase === 'playing' && state.grace && state.grace.waitingFor.length) {
      graceEndsAt = Date.now() + state.grace.remainingMs;
      banner.dataset.names = state.grace.waitingFor.join(', ');
      banner.hidden = false;
      tickGrace();
      if (!graceTimer) graceTimer = setInterval(tickGrace, 250);
    } else {
      stopGrace();
    }
  }

  function tickGrace() {
    const banner = $('#grace-banner');
    const remain = Math.max(0, Math.ceil((graceEndsAt - Date.now()) / 1000));
    banner.textContent =
      `📡 ${banner.dataset.names} disconnected — starting a new game in ${remain}s unless they return`;
    if (remain <= 0) stopGrace(); // the server's restart follows right after
  }

  function stopGrace() {
    clearInterval(graceTimer);
    graceTimer = null;
    $('#grace-banner').hidden = true;
  }

  /* ---------- seat swapping (host, between games) ---------- */

  function bindSwap(state, p, chip, iAmHost) {
    if (!iAmHost || (state.phase !== 'lobby' && state.phase !== 'over')) return;
    chip.classList.add('swappable');
    if (swapPick === p.seat) chip.classList.add('swap-pick');
    chip.onclick = () => {
      if (swapPick === null) {
        swapPick = p.seat;
        chip.classList.add('swap-pick');
      } else if (swapPick === p.seat) {
        swapPick = null;
        chip.classList.remove('swap-pick');
      } else {
        send({ type: 'swap_seats', a: swapPick, b: p.seat });
        swapPick = null;
      }
    };
  }

  /* ---------- main render ---------- */

  function render(state) {
    const view = currentView;
    $('#screen-home').hidden = true;
    $('#screen-table').hidden = false;
    $('#room-code').textContent = state.code;
    $('#room-game').textContent = state.gameTitle || '';
    $('#btn-help').href = `/how-to-play.html#${state.gameId || 'thulla'}`;
    const g = state.game;
    const me = state.players.find(p => p.seat === state.youSeat);
    // Who this tab is playing as — vital with several tabs open at once.
    $('#you-name').textContent = me ? `👤 ${me.name}` : '👁 spectating';
    const iAmHost = !!(me && me.isHost);
    const nextSeat = view.nextSeat(state);
    if (state.phase === 'playing') swapPick = null;

    // Players row
    const row = $('#players');
    row.innerHTML = '';
    for (const p of state.players) {
      const chip = el('div', 'player-chip');
      if (p.peerId) chip.dataset.peerId = p.peerId;
      const isTurn = g && (g.phase === 'playing' || g.phase === 'calling') && p.seat === g.turn;
      if (isTurn) {
        chip.classList.add('turn');
        chip.appendChild(el('div', 'chip-badge',
          view.turnBadge?.(state, p)
            ?? (p.seat === state.youSeat ? '▶ YOUR TURN' : '▶ TURN')));
      } else if (p.seat === nextSeat) {
        chip.classList.add('next');
        chip.appendChild(el('div', 'chip-badge', 'NEXT'));
      }
      const sub = view.chipDecor(state, p, chip);
      chip.appendChild(el('div', 'chip-name',
        `${p.isHost ? '★ ' : ''}${p.isBot ? '🤖 ' : ''}${p.name}${p.seat === state.youSeat ? ' (you)' : ''}`));
      chip.appendChild(el('div', 'chip-sub', sub));
      if (p.stats && p.stats.games > 0) {
        const wins = p.stats.wins > 0 ? ` · 🏆 ${p.stats.wins}` : '';
        chip.appendChild(el('div', 'chip-stats', `🎮 ${p.stats.games} · 💀 ${p.stats.losses}${wins}`));
      }
      bindSwap(state, p, chip, iAmHost);
      row.appendChild(chip);
    }
    for (const s of state.spectators || []) {
      const chip = el('div', 'player-chip spectator');
      if (s.peerId) chip.dataset.peerId = s.peerId;
      chip.appendChild(el('div', 'chip-name', `👁 ${s.name}`));
      chip.appendChild(el('div', 'chip-sub', 'watching'));
      row.appendChild(chip);
    }
    $('#spectate-note').hidden = !(state.youSeat < 0 && state.phase === 'playing');

    // Center: trick, then whatever the game view wants around it. Every
    // game-owned element hides first; the view re-shows its own.
    for (const id of ['#waste', '#btn-take', '#btn-concede', '#take-prompt',
      '#concede-prompt', '#rung-info', '#call-prompt', '#claim-prompt', '#rung-pile',
      '#rule-ace', '#rule-two-aces', '#rule-rung-win', '#rule-sarrein', '#sarrein', '#btn-add-bot']) {
      $(id).hidden = true;
    }
    if (g && state.phase !== 'lobby') renderTrickCards(state, view.visibleTrick?.(state) ?? g.trick);
    else $('#trick').innerHTML = '';
    view.renderCenter(state);
    renderGrace(state);
    renderUndo(state);

    // Status line
    const host = state.players.find(p => p.isHost);
    const status = $('#status-line');
    if (state.phase === 'lobby') {
      const n = state.players.length;
      const min = view.minPlayers ?? 3;
      status.textContent = n < min
        ? `Waiting for players… ${n}/7 joined (need at least ${min})`
        : `${n}/7 players ready — waiting for the host to start`;
    } else if (state.phase === 'over') {
      status.textContent = iAmHost
        ? 'Game over — start the next one when ready'
        : `Game over — waiting for ${host ? host.name : 'the host'} to start the next one`;
    } else {
      status.textContent = view.statusText(state, nextSeat);
    }
    status.classList.toggle('your-turn',
      !!(g && (g.phase === 'playing' || g.phase === 'calling') && g.turn === state.youSeat));

    // Seat / team note under the status line (lobby and between games).
    const note = $('#seat-note');
    const noteText = (state.phase === 'lobby' || state.phase === 'over')
      ? view.lobbyNote?.(state, iAmHost) : null;
    note.hidden = !noteText;
    note.textContent = noteText || '';

    // Action buttons — the start button doubles as "Play again" on the
    // table itself, so a host who dismissed the overlay can still restart.
    const startBtn = $('#btn-start');
    startBtn.hidden = !(iAmHost && (state.phase === 'lobby' || state.phase === 'over'));
    startBtn.disabled = state.players.filter(p => p.connected).length < (view.minPlayers ?? 3);
    startBtn.textContent = state.phase === 'over' ? 'Play again' : 'Start game';

    // Dissolve (host, mid-game): aborts the game with nothing recorded.
    // Two taps required — the first arms the button for a few seconds.
    const dissolveBtn = $('#btn-dissolve');
    if (iAmHost && state.phase === 'playing') {
      dissolveBtn.hidden = false;
      dissolveBtn.textContent = Date.now() < dissolveArmedUntil
        ? '⚠️ Really dissolve?' : '🛑 Dissolve game';
      dissolveBtn.onclick = () => {
        if (Date.now() < dissolveArmedUntil) {
          dissolveArmedUntil = 0;
          send({ type: 'dissolve' });
          return;
        }
        dissolveArmedUntil = Date.now() + 4000;
        dissolveBtn.textContent = '⚠️ Really dissolve?';
        setTimeout(() => {
          if (Date.now() >= dissolveArmedUntil) dissolveBtn.textContent = '🛑 Dissolve game';
        }, 4100);
      };
    } else {
      dissolveBtn.hidden = true;
      dissolveArmedUntil = 0;
    }

    // Game switcher (host, between games): one tap flips to the other game.
    const switchBtn = $('#btn-switch-game');
    if (iAmHost && (state.phase === 'lobby' || state.phase === 'over')) {
      const other = state.gameId === 'rung' ? 'thulla' : 'rung';
      switchBtn.hidden = false;
      switchBtn.textContent = `⇄ Switch to ${VIEWS[other] === VIEWS.rung ? 'Rung' : 'Thulla'}`;
      switchBtn.onclick = () => send({ type: 'set_game', game: other });
    } else {
      switchBtn.hidden = true;
    }

    // Hand
    const hand = $('#hand');
    hand.innerHTML = '';
    hand.classList.toggle('few',
      !!g && state.phase !== 'lobby' && state.youSeat >= 0 && g.hand.length > 0 && g.hand.length <= 7);
    if (g && state.phase !== 'lobby' && state.youSeat >= 0) {
      const legal = new Set(g.legal || []);
      // A view may briefly lock the hand (Thulla's A♠ reveal at the deal).
      const myTurn = g.phase === 'playing' && g.turn === state.youSeat && !view.handLocked?.();
      for (const card of g.hand) {
        const node = cardEl(card);
        const playable = myTurn && legal.has(card);
        node.disabled = !playable;
        if (playable) node.classList.add('legal');
        else if (myTurn) node.classList.add('illegal');
        view.decorateCard?.(card, node);
        node.onclick = () => send({ type: 'play', card });
        hand.appendChild(node);
      }
    }

    // Game-over overlay (dismissible via ✕ so the table, chat and header
    // stay reachable; the Leave button on it always works)
    const overlay = $('#overlay');
    if (state.phase === 'over' && g && !overlayDismissed) {
      overlay.hidden = false;
      $('#overlay-text').innerHTML = view.overlayHTML(state);
      renderStandings(state);
      $('#btn-again').hidden = !iAmHost;
      const wait = $('#overlay-wait');
      wait.hidden = iAmHost;
      wait.textContent = `Waiting for ${host ? host.name : 'the host'} to start the next game…`;
    } else {
      overlay.hidden = true;
      if (state.phase !== 'over') overlayDismissed = false;
    }
  }

  /* ---------- state entry point ---------- */

  function announceAll(state, events) {
    events.forEach(ev => {
      if (!currentView.announce(state, ev)) announceShared(state, ev);
    });
  }

  function handleState(msg) {
    const events = msg.events || [];
    const view = VIEWS[msg.gameId] ?? VIEWS.thulla;
    if (view !== currentView) {
      currentView.reset();
      pendingSweep = null;
      swapPick = null;
      currentView = view;
    }
    const resolution = view.resolutionOf(events);
    const played = events.find(ev => ev.type === 'played');
    const prevGame = lastState && lastState.gameId === msg.gameId ? lastState.game : null;
    lastState = msg;
    view.onState?.(msg, events, prevGame);

    // A fresh deal makes any leftover completed sarr irrelevant.
    if (events.some(ev => ev.type === 'started')) pendingSweep = null;

    // A completed sarr stays face-up on the table until the NEXT move —
    // that move is what finally sweeps it away.
    if (pendingSweep && (played || events.some(ev => ev.type === 'took'))) {
      view.fly(captureTrickRects(), pendingSweep.resolution);
      pendingSweep = null;
    }

    if (resolution && prevGame) {
      render(msg);
      // Overwrite the (empty) trick area with the completed sarr, including
      // the final card, which the new state may no longer contain.
      const fullTrick = [...prevGame.trick];
      if (played) fullTrick.push({ seat: played.seat, card: played.card });
      renderTrickCards(msg, fullTrick);
      pendingSweep = { resolution, fullTrick };
      announceAll(msg, events);
      return;
    }
    render(msg);
    // Rebroadcasts without a move (joins, connection blips) must not wipe a
    // still-displayed completed sarr.
    if (pendingSweep && lastState.game) renderTrickCards(msg, pendingSweep.fullTrick);
    announceAll(msg, events);
  }

  function reset() {
    lastState = null;
    pendingSweep = null;
    swapPick = null;
    dissolveArmedUntil = 0;
    overlayDismissed = false;
    Object.values(VIEWS).forEach(v => v.reset());
    stopGrace();
    stopUndo();
  }

  return { handleState, reset };
}
