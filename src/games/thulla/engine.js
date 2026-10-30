// Pure game engine for Bhabhi Thulla. No I/O, no framework — used by the
// server as the single authority on rules, and unit-tested directly.
//
// House rules implemented (agreed spec):
// - 3 to 7 players, 52 cards dealt as equally as possible.
// - Ace of Spades holder leads it to trick 1. Trick 1 always goes to the
//   waste pile — an off-suit card on trick 1 does NOT end it and nobody
//   picks up.
// - From trick 2 on: must follow suit if possible. An off-suit card
//   (thulla) ends the trick immediately and the highest card of the led
//   suit picks up the whole trick. Highest card of the led suit leads next.
// - No waste-pile draw. If a player's last card wins a clean trick they are
//   safe and the next active player clockwise leads.
// - The leader, before leading (trick 2+), may take the whole hand of the
//   next active player clockwise; that player is instantly safe. Not
//   allowed when only 2 players remain.
// - Last player holding cards is the bhabhi. If the final players all empty
//   their hands on the same clean trick, the game is a draw (bhabhi: null).
// - Head-to-head only: either of the last 2 players may concede the game
//   (opponent must approve — enforced by the caller); the conceder loses.
// - OPTIONAL (rules.sarrein, OFF by default): with exactly 2 players left,
//   if B's LAST card heads a clean sarr while A still holds cards, B is not
//   safe yet — Sarrein begins. Each round A's hand is shuffled face down,
//   B blind-picks one (it leaves A's hand and is B's lead; no undo) and A
//   answers with normal follow-suit, choosing freely:
//     higher card of the suit        → B wins (even with A's last card);
//     lower card, A still has cards  → clean, B picks again next round;
//     lower card, A's last card      → A wins;
//     no card of the suit (thulla)   → A wins (B would pick up).
//   If A holds exactly 1 card when B is due to pick, A loses. No concede
//   while Sarrein runs.

import { makeDeck, shuffle, rankValue, suitOf } from '../cards.js';

export { RANKS, SUITS, makeDeck, rankValue, suitOf, sortHand } from '../cards.js';

export function createGame(numPlayers, rng = Math.random, rules = {}) {
  if (numPlayers < 3 || numPlayers > 7) throw new Error('3 to 7 players required');
  const deck = shuffle(makeDeck(), rng);
  const hands = Array.from({ length: numPlayers }, () => []);
  deck.forEach((card, i) => hands[i % numPlayers].push(card));
  const leader = hands.findIndex(h => h.includes('AS'));
  return {
    numPlayers,
    hands,
    safe: Array(numPlayers).fill(false),
    phase: 'playing', // 'playing' | 'over'
    trickNumber: 1,
    trick: [], // [{seat, card}] in play order
    ledSuit: null,
    leader,
    turn: leader,
    bhabhi: null, // seat of the loser once phase === 'over'; null on a draw
    lastPlay: null, // most recent unresolved play {seat, card}; undoable
    rules: { sarrein: !!rules.sarrein },
    // While Sarrein runs: { picker, holder, order } — order is the
    // holder's hand shuffled for this round (server-only, never sent).
    sarrein: null,
    sarreinResult: null, // { winner, loser, reason } once Sarrein decides the game
  };
}

function nextActiveSeat(state, from) {
  for (let i = 1; i <= state.numPlayers; i++) {
    const seat = (from + i) % state.numPlayers;
    if (!state.safe[seat]) return seat;
  }
  return null;
}

function activeCount(state) {
  return state.safe.filter(s => !s).length;
}

export function legalMoves(state, seat) {
  if (state.phase !== 'playing' || seat !== state.turn) return [];
  const hand = state.hands[seat];
  if (state.trick.length === 0) {
    return state.trickNumber === 1 ? ['AS'] : [...hand];
  }
  const follow = hand.filter(c => suitOf(c) === state.ledSuit);
  return follow.length ? follow : [...hand];
}

// Seat whose whole hand the current leader may take right now, or null.
export function canTake(state, seat) {
  if (state.phase !== 'playing') return null;
  if (seat !== state.turn || state.trick.length !== 0) return null;
  if (state.trickNumber === 1) return null;
  if (activeCount(state) <= 2) return null;
  return nextActiveSeat(state, seat);
}

// Head-to-head endgames can lock into a foregone conclusion (one player
// holds only a suit the other ran out of, so every sarr comes back to
// them). Either of the last two players may concede instead of grinding it
// out — the caller gets the opponent's approval before applying it.
// Returns the seat that would win, or null if conceding isn't allowed.
export function canConcede(state, seat) {
  if (state.phase !== 'playing' || state.safe[seat]) return null;
  if (state.sarrein) return null; // no way out once Sarrein starts
  if (activeCount(state) !== 2) return null;
  return state.safe.findIndex((safe, i) => !safe && i !== seat);
}

export function concede(state, seat) {
  const winner = canConcede(state, seat);
  if (winner === null || winner < 0) throw new Error('Conceding is only possible when two players are left');
  state.safe[winner] = true;
  state.phase = 'over';
  state.bhabhi = seat;
  state.turn = null;
  state.leader = null;
  state.lastPlay = null;
  return [
    { type: 'conceded', seat, winner },
    { type: 'game_over', bhabhi: seat },
  ];
}

function trickWinner(state) {
  let best = null;
  for (const play of state.trick) {
    if (suitOf(play.card) !== state.ledSuit) continue;
    if (!best || rankValue(play.card) > rankValue(best.card)) best = play;
  }
  // The leader's card always sets the led suit, so best is never null.
  return best.seat;
}

function markSafe(state, events) {
  for (let seat = 0; seat < state.numPlayers; seat++) {
    if (!state.safe[seat] && state.hands[seat].length === 0) {
      state.safe[seat] = true;
      events.push({ type: 'safe', seat });
    }
  }
}

function checkGameOver(state, events) {
  const n = activeCount(state);
  if (n > 1) return false;
  state.phase = 'over';
  state.bhabhi = n === 1 ? state.safe.indexOf(false) : null;
  state.turn = null;
  state.leader = null;
  events.push({ type: 'game_over', bhabhi: state.bhabhi });
  return true;
}

function startNextTrick(state, fromSeat) {
  const leader = !state.safe[fromSeat] ? fromSeat : nextActiveSeat(state, fromSeat);
  state.leader = leader;
  state.turn = leader;
  state.trick = [];
  state.ledSuit = null;
  state.trickNumber++;
}

export function playCard(state, seat, card) {
  if (state.phase !== 'playing') throw new Error('Game is over');
  if (seat !== state.turn) throw new Error('Not your turn');
  if (!legalMoves(state, seat).includes(card)) throw new Error('You cannot play that card');

  const events = [{ type: 'played', seat, card }];
  const hand = state.hands[seat];
  hand.splice(hand.indexOf(card), 1);
  if (state.trick.length === 0) state.ledSuit = suitOf(card);
  state.trick.push({ seat, card });

  const isThulla = suitOf(card) !== state.ledSuit;
  const everyonePlayed = state.trick.length === activeCount(state);

  // This throw locks any previous undoable play; the new play itself is
  // undoable only while it does NOT resolve the trick.
  state.lastPlay = null;

  if (state.sarrein) {
    resolveSarreinAnswer(state, seat, card, events);
    return events;
  }

  if (state.trickNumber === 1) {
    // Trick 1 is special: an off-suit card doesn't end it, and the whole
    // trick always goes to the waste pile.
    if (everyonePlayed) {
      const winner = trickWinner(state);
      events.push({ type: 'trick_won', seat: winner, clean: true });
      startNextTrick(state, winner);
    } else {
      state.turn = nextActiveSeat(state, seat);
      state.lastPlay = { seat, card };
    }
  } else if (isThulla) {
    const winner = trickWinner(state);
    const picked = state.trick.map(p => p.card);
    state.hands[winner].push(...picked);
    events.push({ type: 'thulla', seat, winner, cards: picked });
    markSafe(state, events);
    if (!checkGameOver(state, events)) startNextTrick(state, winner);
  } else if (everyonePlayed) {
    const winner = trickWinner(state);
    events.push({ type: 'trick_won', seat: winner, clean: true });
    if (sarreinStarts(state, winner)) {
      startSarrein(state, winner, events);
      return events;
    }
    markSafe(state, events);
    if (!checkGameOver(state, events)) startNextTrick(state, winner);
  } else {
    state.turn = nextActiveSeat(state, seat);
    state.lastPlay = { seat, card };
  }
  return events;
}

/* ---------- Sarrein (optional house rule) ---------- */

// Checked on a clean sarr (2+) before anyone is marked safe: exactly two
// players were in it, the header's last card won it, the other still holds
// cards.
function sarreinStarts(state, winner) {
  if (!state.rules?.sarrein || activeCount(state) !== 2) return false;
  if (state.hands[winner].length !== 0) return false;
  const other = state.trick.find(p => p.seat !== winner)?.seat;
  return other !== undefined && state.hands[other].length > 0;
}

function startSarrein(state, picker, events) {
  const holder = state.trick.find(p => p.seat !== picker).seat;
  state.sarrein = { picker, holder, order: null };
  events.push({ type: 'sarrein_started', picker, holder });
  startSarreinRound(state, events);
}

// A new round: the holder's cards go face down in a fresh shuffle and the
// picker is to choose — unless the holder is down to one card, which loses.
function startSarreinRound(state, events) {
  const { picker, holder } = state.sarrein;
  state.trick = [];
  state.ledSuit = null;
  state.trickNumber++;
  if (state.hands[holder].length === 1) {
    endSarrein(state, picker, holder, 'one_card', events);
    return;
  }
  state.sarrein.order = shuffle([...state.hands[holder]]);
  state.leader = picker;
  state.turn = picker;
}

// The picker taps face-down slot `slot`: that card leaves the holder's hand
// and becomes the picker's lead. Final — no undo window.
export function sarreinPick(state, seat, slot) {
  if (state.phase !== 'playing') throw new Error('Game is over');
  const s = state.sarrein;
  if (!s) throw new Error('Sarrein is not being played');
  if (seat !== s.picker || seat !== state.turn || state.trick.length !== 0) {
    throw new Error('Not your pick');
  }
  if (!Number.isInteger(slot) || slot < 0 || slot >= s.order.length) {
    throw new Error('Pick one of the face-down cards');
  }
  const card = s.order[slot];
  const hand = state.hands[s.holder];
  hand.splice(hand.indexOf(card), 1);
  s.order = null;
  state.trick.push({ seat, card, blind: true });
  state.ledSuit = suitOf(card);
  state.turn = s.holder;
  state.lastPlay = null;
  return [{ type: 'played', seat, card, blind: true, from: s.holder }];
}

// The holder answered the blind lead (already moved into the trick).
function resolveSarreinAnswer(state, seat, card, events) {
  const { picker, holder } = state.sarrein;
  const lead = state.trick[0].card;
  if (suitOf(card) !== state.ledSuit) {
    // Thulla by the holder: the picker would have to pick up — picker loses.
    const picked = state.trick.map(p => p.card);
    state.hands[picker].push(...picked);
    events.push({ type: 'thulla', seat, winner: picker, cards: picked });
    endSarrein(state, holder, picker, 'thulla', events);
  } else if (rankValue(card) > rankValue(lead)) {
    events.push({ type: 'trick_won', seat: holder, clean: true });
    endSarrein(state, picker, holder, 'higher', events);
  } else if (state.hands[holder].length === 0) {
    events.push({ type: 'trick_won', seat: picker, clean: true });
    endSarrein(state, holder, picker, 'last_card', events);
  } else {
    events.push({ type: 'trick_won', seat: picker, clean: true });
    startSarreinRound(state, events);
  }
}

function endSarrein(state, winner, loser, reason, events) {
  state.sarrein = null;
  state.sarreinResult = { winner, loser, reason };
  state.safe[winner] = true;
  state.phase = 'over';
  state.bhabhi = loser;
  state.turn = null;
  state.leader = null;
  state.lastPlay = null;
  events.push({ type: 'sarrein_result', winner, loser, reason });
  events.push({ type: 'game_over', bhabhi: loser });
}

// Take back the most recent play. Only valid while that card sits
// unresolved on the table — a resolved trick is final, and any later throw
// locks it (the caller enforces the time window).
export function undoPlay(state, seat) {
  if (state.phase !== 'playing') throw new Error('Game is over');
  const lp = state.lastPlay;
  if (!lp || lp.seat !== seat) throw new Error('Nothing to take back');
  state.trick.pop(); // lastPlay is always the newest card in the trick
  state.hands[seat].push(lp.card);
  if (state.trick.length === 0) state.ledSuit = null;
  state.turn = seat;
  state.lastPlay = null;
  return [{ type: 'undo', seat, card: lp.card }];
}

export function takeHand(state, seat) {
  const target = canTake(state, seat);
  if (target === null) throw new Error('Taking cards is not allowed right now');
  const cards = state.hands[target];
  state.hands[seat].push(...cards);
  state.hands[target] = [];
  state.safe[target] = true;
  return [
    { type: 'took', seat, target, count: cards.length },
    { type: 'safe', seat: target },
  ];
}
