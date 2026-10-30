// Thulla's plug into the generic GameRoom. The room owns seats, sockets and
// timers; everything rule-flavored — starting a deal, validating moves,
// consent flows, the personalized view — goes through this adapter.

import {
  createGame, playCard, undoPlay, takeHand, legalMoves, canTake,
  canConcede, concede, sortHand, sarreinPick,
} from './engine.js';

export const thulla = {
  id: 'thulla',
  title: 'Thulla',
  minPlayers: 3,

  // Optional house rules the host may toggle between games (the room's
  // set_rule handler); stored on room.rules.thulla and threaded into
  // createGame below.
  settings: {
    sarrein: { default: false },
  },

  // Deals a fresh game and auto-throws the forced A♠ opening for its
  // holder; returns the full event list for the new deal.
  start(room) {
    room.game = createGame(room.players.length, Math.random, room.rules?.thulla ?? {});
    const events = [{ type: 'started', leader: room.game.leader }];
    events.push(...playCard(room.game, room.game.leader, 'AS'));
    room.game.lastPlay = null; // a forced play gets no undo window
    return events;
  },

  play(game, seat, card) {
    return playCard(game, seat, card);
  },

  undo(game, seat) {
    return undoPlay(game, seat);
  },

  // Seats the game still waits on (drives the disconnect grace timer).
  isActiveSeat(game, seat) {
    return game.phase === 'playing' && !game.safe[seat];
  },

  // Scoreboard verdict for a finished game: Thulla has no winners, only
  // the bhabhi (none on a draw).
  result(game) {
    return {
      winners: [],
      losers: game.bhabhi !== null ? [game.bhabhi] : [],
      whitewash: false,
    };
  },

  // Per-player public fields merged into the seat list everyone sees.
  seatView(game, seat) {
    // Seats past the game's arrays belong to players seated after the deal
    // (promoted spectators) — they hold no cards in this game.
    return {
      cardCount: game.hands[seat]?.length ?? 0,
      safe: game.safe[seat] ?? false,
    };
  },

  // Personalized game snapshot: only your own cards ever leave the server.
  gameView(game, seat) {
    return {
      phase: game.phase,
      turn: game.turn,
      leader: game.leader,
      trick: game.trick,
      ledSuit: game.ledSuit,
      trickNumber: game.trickNumber,
      bhabhi: game.bhabhi,
      hand: seat >= 0 ? sortHand(game.hands[seat] ?? []) : [],
      legal: seat >= 0 ? legalMoves(game, seat) : [],
      takeTarget: seat >= 0 ? canTake(game, seat) : null,
      youCanConcede: seat >= 0 && (canConcede(game, seat) ?? -1) >= 0,
      sarreinRule: !!game.rules?.sarrein,
      // Only how many cards lie face down — never which, nor their order.
      sarrein: game.sarrein ? {
        picker: game.sarrein.picker,
        holder: game.sarrein.holder,
        slots: game.sarrein.order?.length ?? 0,
      } : null,
      youPick: !!game.sarrein && game.sarrein.picker === seat && game.turn === seat
        && game.trick.length === 0,
      sarreinResult: game.sarreinResult ?? null,
    };
  },

  // Game-specific messages, dispatched by the room once a game is running.
  // R is the GameRoom instance; each handler validates and either replies
  // with an error or saves + broadcasts.
  actions: {
    // Sarrein: the picker blind-picks one of the holder's face-down cards.
    async sarrein_pick(R, ws, seat, msg) {
      await R.handleMove(ws, () => sarreinPick(R.room.game, seat, msg.slot));
    },

    // Taking another player's hand needs their approval: 'take' only files
    // a request; the transfer happens when the target approves.
    async take(R, ws, seat) {
      if (R.room.pendingTake) {
        return R.sendError(ws, 'A take request is already pending');
      }
      const target = canTake(R.room.game, seat);
      if (target === null) {
        return R.sendError(ws, 'Taking cards is not allowed right now');
      }
      R.room.pendingTake = { from: seat, target };
      await R.save();
      R.broadcast([{ type: 'take_requested', from: seat, target }]);
    },

    async take_response(R, ws, seat, msg) {
      const pending = R.room.pendingTake;
      if (!pending || pending.target !== seat) {
        return R.sendError(ws, 'No take request waiting for you');
      }
      if (!msg.approve) {
        R.room.pendingTake = null;
        await R.save();
        return R.broadcast([{ type: 'take_declined', from: pending.from, target: pending.target }]);
      }
      // handleMove re-checks the game state, executes, and clears the request.
      await R.handleMove(ws, () => takeHand(R.room.game, pending.from));
    },

    // A locked head-to-head endgame can be dissolved: either of the last
    // two players may offer to concede; the game only ends when the
    // opponent — the winner — approves.
    async concede(R, ws, seat) {
      if (R.room.pendingConcede) {
        return R.sendError(ws, 'A concede offer is already pending');
      }
      const winner = canConcede(R.room.game, seat);
      if (winner === null || winner < 0) {
        return R.sendError(ws, 'You can only concede when two players are left');
      }
      R.room.pendingConcede = { seat, winner };
      await R.save();
      R.broadcast([{ type: 'concede_requested', seat, winner }]);
    },

    async concede_response(R, ws, seat, msg) {
      const pending = R.room.pendingConcede;
      if (!pending || pending.winner !== seat) {
        return R.sendError(ws, 'No concede offer waiting for you');
      }
      if (!msg.approve) {
        R.room.pendingConcede = null;
        await R.save();
        return R.broadcast([{ type: 'concede_declined', seat: pending.seat, winner: pending.winner }]);
      }
      // handleMove re-checks the game state, executes, and clears the offer.
      await R.handleMove(ws, () => concede(R.room.game, pending.seat));
    },
  },
};
