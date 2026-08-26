// Rung's plug into the generic GameRoom. Exactly 4 seats play (0-3, teams
// by parity); a fuller room benches seats 4+ for the deal — the host can
// swap people in between games.

import {
  createGame, callTrump, claimCall, playCard, undoPlay, legalMoves, teamOf, sortHand,
} from './engine.js';

// The previous game's winning pair chooses who calls the rung — but only
// while that result still applies cleanly: it was a Rung game (an aborted
// game clears it, a Thulla game overwrites it), both winners are still
// seated among the playing four, and seat swaps haven't split them onto
// different teams. Anything else falls back to the opening toss.
function claimantsFor(room) {
  const last = room.lastResult;
  if (!last || last.gameId !== 'rung' || last.winnerTokens?.length !== 2) return null;
  const seats = last.winnerTokens.map(t => room.players.findIndex(p => p.token === t));
  if (seats.some(s => s < 0 || s > 3)) return null;
  if (teamOf(seats[0]) !== teamOf(seats[1])) return null;
  return seats;
}

export const rung = {
  id: 'rung',
  title: 'Rung',
  minPlayers: 4,

  // Optional rules the host may toggle between games (see the room's
  // set_rule handler); values are stored on room.rules.rung and threaded
  // into createGame below. Keys must match the engine's rules object.
  settings: {
    aceCannotPick: { default: true },
    secondAceIsTwo: { default: true },
  },

  // Start a fresh game. Nothing is dealt until the caller is known: the
  // previous winners pick among themselves ('choosing'), or the opening
  // toss decides on the spot.
  start(room) {
    room.game = createGame({ claimants: claimantsFor(room), rules: room.rules?.rung ?? {} });
    const g = room.game;
    const events = [{ type: 'started', caller: g.caller, claimants: g.claimants, viaToss: !!g.toss }];
    if (g.toss) events.push({ type: 'toss', rounds: g.toss, winner: g.caller, claimants: g.claimants });
    return events;
  },

  play(game, seat, card) {
    return playCard(game, seat, card);
  },

  undo(game, seat) {
    return undoPlay(game, seat);
  },

  // The game waits on all 4 playing seats until it's over — including
  // during the calling phase. Benched seats (4+) are never waited on.
  isActiveSeat(game, seat) {
    return seat < game.numPlayers && game.phase !== 'over';
  },

  // Scoreboard verdict: the winning pair each log a win (and the 🧹 on a
  // 13-0), the losing pair each log a loss.
  result(game) {
    const winners = [game.winnerTeam, game.winnerTeam + 2];
    const losers = [1 - game.winnerTeam, 3 - game.winnerTeam];
    return { winners, losers, whitewash: game.whitewash };
  },

  // Per-player public fields merged into the seat list everyone sees.
  seatView(game, seat) {
    const playing = seat < game.numPlayers;
    return {
      cardCount: game.hands[seat]?.length ?? 0,
      safe: false,
      team: playing ? teamOf(seat) : null,
      sittingOut: !playing,
    };
  },

  // Personalized game snapshot: only your own cards ever leave the server.
  // During the calling phase everyone already sees their first 5 cards —
  // the remaining 32 stay undealt on the server until the rung is called.
  gameView(game, seat) {
    const playing = seat >= 0 && seat < game.numPlayers;
    return {
      phase: game.phase,
      turn: game.turn,
      leader: game.leader,
      trick: game.trick,
      ledSuit: game.ledSuit,
      trickNumber: game.trickNumber,
      caller: game.caller,
      claimants: game.claimants,
      toss: game.toss, // public ceremony — face-up by definition
      trump: game.trump,
      pile: game.pile, // face-up by rule: every card in it was played openly
      barred: game.barred,
      aceRule: game.rules?.aceCannotPick ?? false,
      secondAceRule: game.rules?.secondAceIsTwo ?? false,
      // Deliberately NOT exposed: acePending. The double-Ace rule is a
      // trap — a player must remember their own last card, so the view
      // gives no hint that their next Ace would count as a 2.
      tricksWon: [...game.tricksWon],
      decided: game.decided,
      winnerTeam: game.winnerTeam,
      whitewash: game.whitewash,
      hand: playing ? sortHand(game.hands[seat] ?? []) : [],
      legal: playing ? legalMoves(game, seat) : [],
      youCall: playing && game.phase === 'calling' && seat === game.caller,
      youCanClaim: playing && game.phase === 'choosing' && game.claimants.includes(seat),
    };
  },

  actions: {
    async claim_call(R, ws, seat) {
      await R.handleMove(ws, () => claimCall(R.room.game, seat));
    },
    async call_trump(R, ws, seat, msg) {
      await R.handleMove(ws, () => callTrump(R.room.game, seat, msg.suit));
    },
  },
};
