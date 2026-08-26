// The Rung seat-filler bot — a separate entity from the game code. The
// rung engine and adapter contain no bot logic; this module consumes the
// engine's public API exactly the way the server does for human messages:
// it reads the legal options and applies a move. The room drives it via
// the registry in ./index.js after every state change.
//
// Behavior (deliberately basic): a random legal card on its turn, its
// longest suit if the toss made it the caller — and nothing else. It
// never claims the rung call (its human partner does).

import { callTrump, playCard, legalMoves } from '../games/rung/engine.js';
import { rankValue, suitOf, SUITS } from '../games/cards.js';

// Called on the toss, the bot picks the rung as its longest suit from the
// first 5, ties broken by stronger cards.
export function pickTrump(hand) {
  let best = null;
  for (const suit of SUITS) {
    const cards = hand.filter(c => suitOf(c) === suit);
    const strength = cards.reduce((sum, c) => sum + rankValue(c), 0);
    if (!best || cards.length > best.count
        || (cards.length === best.count && strength > best.strength)) {
      best = { suit, count: cards.length, strength };
    }
  }
  return best.suit;
}

export const rungBot = {
  // Does the game currently wait on this seat for a forced action?
  needsAct(game, seat) {
    return (game.phase === 'calling' && game.caller === seat)
      || (game.phase === 'playing' && game.turn === seat);
  },

  // Perform exactly one action; returns the engine's events.
  act(game, seat) {
    if (game.phase === 'calling') return callTrump(game, seat, pickTrump(game.hands[seat]));
    const legal = legalMoves(game, seat);
    return playCard(game, seat, legal[Math.floor(Math.random() * legal.length)]);
  },
};
