// Rung-specific table rendering: teams, the trump badge, the face-up sar
// pile, pickup/barred cues and the trick-to-winner sweep. The shared frame
// (chips, hand, grace, undo, overlay shell) lives in game-view.js.

import { $, el, escapeHtml } from '../dom.js';
import { cardEl, SUIT_SYM } from '../cards.js';
import { toast } from '../toast.js';
import { playerName, renderTrickCards, flyToTarget, chipRect, splash } from './table-common.js';

export function createRungView({ send }) {
  // While a resolved sar is still displayed in the trick area (awaiting its
  // sweep), keep it out of the pile display so it isn't shown twice.
  let holdLastSar = false;

  // "Hanzalah & Usman" — the pair holding the even or odd seats.
  function teamNames(state, team) {
    return state.players
      .filter(p => p.seat < 4 && p.seat % 2 === team)
      .map(p => p.name)
      .join(' & ');
  }

  function losingTeam(state) {
    const g = state.game;
    return g && g.winnerTeam !== null ? 1 - g.winnerTeam : null;
  }

  function onState(msg, events) {
    holdLastSar = events.some(ev => ev.type === 'trick_won' && ev.picked === 0);
  }

  function nextSeat(state) {
    const g = state.game;
    if (!g || g.phase !== 'playing' || g.turn === null) return null;
    return (g.turn + 1) % 4;
  }

  function turnBadge(state, p) {
    const g = state.game;
    if (g && g.phase === 'calling') {
      return p.seat === state.youSeat ? '🎺 YOUR CALL' : '🎺 CALLING';
    }
    return null; // default ▶ TURN badge
  }

  function chipDecor(state, p, chip) {
    const g = state.game;
    if (!p.connected) chip.classList.add('offline');
    const team = g ? p.team : (p.seat < 4 ? p.seat % 2 : null);
    if (team !== null && team !== undefined) chip.classList.add(`team-${team}`);
    if (g && p.sittingOut) chip.classList.add('benched');
    const lost = g && state.phase === 'over' && !p.sittingOut && p.team === losingTeam(state);
    if (lost) chip.classList.add('bhabhi');
    if (state.phase === 'lobby') return p.connected ? 'ready' : 'away';
    if (p.sittingOut) return 'sitting out';
    if (state.phase === 'over') return lost ? 'game parr gayi' : '🏆 winner';
    if (g && g.phase === 'choosing') {
      if (g.claimants?.includes(p.seat)) {
        chip.classList.add('turn');
        chip.appendChild(el('div', 'chip-badge',
          p.seat === state.youSeat ? '🎺 CLAIM?' : '🎺 DECIDING'));
        return 'picks the caller';
      }
      return 'waiting';
    }
    return `${p.cardCount} cards`;
  }

  // Lobby line under the status: who partners whom, and the swap hint.
  function lobbyNote(state, iAmHost) {
    const n = state.players.length;
    if (n < 2) return null;
    const a = teamNames(state, 0), b = teamNames(state, 1);
    const teams = n >= 4 ? `Teams: ${a} vs ${b}` : `Partners sit opposite (seats 1 & 3 vs 2 & 4)`;
    const bench = n > 4 ? ` · ${state.players.slice(4).map(p => p.name).join(', ')} sit(s) out` : '';
    const hint = iAmHost && n >= 2 ? ' — tap two players to swap seats' : '';
    return `${teams}${bench}${hint}`;
  }

  function statusText(state) {
    const g = state.game;
    if (!g) return '';
    if (g.phase === 'choosing') {
      const [a, b] = g.claimants;
      if (g.claimants.includes(state.youSeat)) {
        return 'Your side calls the rung — claim it, or let your partner take it';
      }
      const pair = `${playerName(state, a).replace(' (you)', '')} or ${playerName(state, b).replace(' (you)', '')}`;
      return `${pair} will call the rung — cards come out once they decide`;
    }
    if (g.phase === 'calling') {
      return state.youSeat === g.caller
        ? 'Your 5 cards are in — choose the rung!'
        : `${playerName(state, g.caller)} is choosing the rung…`;
    }
    if (g.phase !== 'playing') return '';
    const turnName = playerName(state, g.turn);
    const leadName = playerName(state, g.leader).replace(' (you)', '');
    const atStake = g.pile.length + 1; // pile plus the sar being played
    let tag;
    if (g.trickNumber === 13) tag = ` · last sar — its header takes all ${atStake}`;
    else if (g.barred) tag = ' · barred sar, no pickup';
    else if (g.trickNumber < 5) tag = ' · pile building';
    else tag = ` · ${leadName} takes ${atStake} if unbeaten${g.aceRule ? ' (Ace can’t cut)' : ''}`;
    if (g.trick.length === 0) return `Sarr ${g.trickNumber} — ${turnName} leads${tag}`;
    return `Sarr ${g.trickNumber} — ${SUIT_SYM[g.ledSuit]} led · ${turnName} to play${tag}`;
  }

  /* ---------- center: pile, trump badge, score, call prompt ---------- */

  // The unclaimed pile stays FACE-UP on the table (house rule): every sar
  // shown as a fanned group, oldest first.
  function renderPile(state) {
    const g = state.game;
    const box = $('#rung-pile');
    const sars = (g && state.phase !== 'lobby') ? g.pile.slice(0, holdLastSar ? -1 : undefined) : [];
    box.hidden = sars.length === 0;
    if (!sars.length) return;
    const wrap = $('#rung-pile-sars');
    wrap.innerHTML = '';
    for (const sar of sars) {
      const group = el('div', 'pile-sar');
      for (const play of sar) group.appendChild(cardEl(play.card, { mini: true }));
      wrap.appendChild(group);
    }
    $('#rung-pile-count').textContent =
      `${sars.length} sar${sars.length === 1 ? '' : 'rein'} on the table`;
  }

  function renderCenter(state) {
    const g = state.game;
    renderPile(state);

    // Trump badge + team score, always on show during a deal.
    const info = $('#rung-info');
    if (g && state.phase !== 'lobby') {
      info.hidden = false;
      const trumpBox = $('#rung-trump');
      if (g.trump) {
        trumpBox.textContent = `RUNG ${SUIT_SYM[g.trump]}`;
        trumpBox.classList.toggle('red', g.trump === 'H' || g.trump === 'D');
        trumpBox.classList.remove('uncalled');
      } else {
        trumpBox.textContent = 'RUNG ?';
        trumpBox.classList.remove('red');
        trumpBox.classList.add('uncalled');
      }
      $('#rung-score').innerHTML =
        `<span class="score-team t0">${escapeHtml(teamNames(state, 0))} <b>${g.tricksWon[0]}</b></span>` +
        `<span class="score-dash">–</span>` +
        `<span class="score-team t1"><b>${g.tricksWon[1]}</b> ${escapeHtml(teamNames(state, 1))}</span>`;
    }

    // The calling prompt, for the caller only.
    if (g && g.youCall) {
      $('#call-prompt').hidden = false;
      $('#call-prompt-text').textContent = 'Tera rung — pick the trump suit:';
    }

    // The claim prompt, for the two who get to decide.
    if (g && g.youCanClaim) {
      $('#claim-prompt').hidden = false;
      const partner = state.players.find(p => g.claimants.includes(p.seat) && p.seat !== state.youSeat);
      $('#claim-prompt-text').textContent =
        `You or ${partner ? partner.name : 'your partner'} calls the rung — talk it over:`;
    }

    // The toss ceremony stays on the table until the first card is played.
    if (g && g.toss && g.trickNumber === 1 && g.trick.length === 0
        && (g.phase === 'choosing' || g.phase === 'calling')) {
      renderTrickCards(state, g.toss[g.toss.length - 1]);
    }
  }

  function overlayHTML(state) {
    const g = state.game;
    if (g.winnerTeam === null) return '';
    const winners = escapeHtml(teamNames(state, g.winnerTeam));
    const losers = escapeHtml(teamNames(state, 1 - g.winnerTeam));
    const score = `${g.tricksWon[g.winnerTeam]}–${g.tricksWon[1 - g.winnerTeam]}`;
    return g.whitewash
      ? `🧹 <b>WHITEWASH!</b> <b>${winners}</b> sweep it <b>${score}</b> — ${losers} di game parr gayi!`
      : `🏆 <b>${winners}</b> win <b>${score}</b> — ${losers} di game parr gayi!`;
  }

  function resolutionOf(events) {
    return events.find(ev => ev.type === 'trick_won') ?? null;
  }

  // Picked-up sarrein fly into the winner's chip; an unclaimed sar slides
  // onto the face-up pile.
  function fly(sources, resolution) {
    if (resolution.picked > 0) return flyToTarget(sources, chipRect(resolution.seat));
    const pileBox = $('#rung-pile');
    if (!pileBox.hidden) flyToTarget(sources, pileBox.getBoundingClientRect());
  }

  function announce(state, ev) {
    const name = seat => escapeHtml(playerName(state, seat));
    switch (ev.type) {
      case 'started':
        if (ev.viaToss) toast('🎴 New deal — toss for the rung call!');
        else toast(`🏆 New deal! ${name(ev.claimants[0])} & ${name(ev.claimants[1])} won — deciding who calls`);
        return true;
      case 'toss': {
        const again = ev.rounds.length > 1 ? 'After a re-toss, ' : '';
        if (ev.winner !== null) toast(`🪙 ${again}${name(ev.winner)} draws the highest card — they call the rung`);
        else toast(`🪙 ${again}${name(ev.claimants[0])} & ${name(ev.claimants[1])} tie on top — their team claims the call`);
        return true;
      }
      case 'caller_chosen':
        toast(`🎺 ${name(ev.seat)} takes the rung call — cards coming out`);
        return true;
      case 'trump_called':
        toast(`🎺 ${name(ev.seat)} calls ${SUIT_SYM[ev.suit]} — that's the rung!`);
        return true;
      case 'trick_won': {
        const score = `${ev.tricksWon[0]}–${ev.tricksWon[1]}`;
        if (ev.picked > 0 && ev.hand === 13) {
          toast(`${name(ev.seat)} heads the last sar — takes the ${ev.picked} left · ${score}`);
        } else if (ev.picked > 0) {
          toast(`💰 ${name(ev.seat)} defends the lead — picks up ${ev.picked} sarrein! ${score}`, 'thulla');
        } else if (ev.aceBlocked) {
          toast(`🂡 ${name(ev.seat)} stays senior, but an Ace can't cut the sar — pile stays at ${ev.pileSize}`);
        } else if (ev.barred) {
          toast(`${name(ev.seat)} heads the barred sar — no pickup, pile at ${ev.pileSize}`);
        } else if (ev.hand < 5) {
          toast(`${name(ev.seat)} heads sar ${ev.hand} — pile grows to ${ev.pileSize}`);
        } else if (!ev.defended) {
          toast(`${name(ev.seat)} snatches the lead — pile stays at ${ev.pileSize}`);
        } else {
          toast(`${name(ev.seat)} heads the sar — pile at ${ev.pileSize}`);
        }
        return true;
      }
      case 'seven_reached':
        toast(`🏁 ${escapeHtml(teamNames(state, ev.team))} have 7 — game theirs, playing out the margin`);
        return true;
      case 'game_over': {
        const winners = escapeHtml(teamNames(state, ev.winnerTeam));
        const score = `${ev.tricksWon[ev.winnerTeam]}–${ev.tricksWon[1 - ev.winnerTeam]}`;
        if (ev.whitewash) splash('🧹 WHITEWASH!');
        toast(ev.whitewash ? `🧹 WHITEWASH! ${winners} sweep it ${score}` : `🏆 ${winners} win ${score}`,
          ev.whitewash ? 'thulla' : undefined);
        return true;
      }
    }
    return false;
  }

  function reset() {
    holdLastSar = false;
  }

  return {
    id: 'rung',
    minPlayers: 4,
    onState, nextSeat, turnBadge, chipDecor, lobbyNote, statusText,
    renderCenter, overlayHTML, resolutionOf, fly, announce, reset,
  };
}
