// Pure game engine for Pakistani Rung (Court Piece, double-sar rules).
// No I/O, no framework — used by the server as the single authority on
// rules, and unit-tested directly.
//
// House rules implemented (agreed spec):
// - Exactly 4 players in fixed partnerships: seats 0 & 2 vs seats 1 & 3.
// - Who calls the rung: the FIRST game is decided by a toss — one card
//   each, face up, highest card's owner calls. Ties between opposite
//   teams re-toss just the tied players; a tie within one team means that
//   team won the toss and either partner may claim the call. From then on
//   the pair that won the previous game chooses among themselves (first
//   to claim it) — the room falls back to a toss whenever that result
//   can't apply cleanly. NOTHING is dealt until the caller is decided.
// - The caller gets 5 cards along with everyone else, announces the trump
//   suit publicly, then the rest is dealt 4-4-4. The caller leads the
//   first sar. (No dealer role — the server deals.)
// - Follow suit if you can; anything (including trump) if you can't.
//   Highest trump heads the sar, else highest card of the led suit; the
//   header leads the next sar.
// - Heading a sar does NOT take it. Completed sars pile up FACE-UP in the
//   middle; the pile is only picked up when the SAME player heads a sar
//   and then stays unbeaten as leader of the next one (defends the lead).
//   Anyone overtaking the leader — an opponent OR their partner — spoils
//   the pickup and takes over the lead with the same burden.
// - Sars 1-4 can never be picked up; the earliest pickup is sar 5 (the
//   header of sar 4 defending through sar 5), and a pickup takes the WHOLE
//   pile for the team.
// - The sar right after a pickup is barred — nobody can pick it up, it
//   starts the new pile. The same player may still earn the next pile
//   (pick up 5, head barred 6, defend 7 → takes 6+7).
// - All 13 sars are played out. Sar 13's header always takes everything
//   left on the table (bar or no bar, defended or not), so team totals
//   always sum to 13 — first to 7 wins, 13-0 is a whitewash.
// - OPTIONAL (rules.aceCannotPick, ON by default): an Ace can't cut the
//   sar — a leader defending with any Ace stays senior but takes nothing;
//   the pile stays, they keep the lead, the next sar is winnable as
//   normal. Sar 13 is immune (its header takes all, Ace or not).
// - One deal per game; the dealer seat rotates between deals (the room
//   handles that).

import { makeDeck, shuffle, rankValue, suitOf, SUITS } from '../cards.js';

export { sortHand } from '../cards.js';

// Partnerships are fixed by seat parity: team 0 = seats 0 & 2, team 1 = 1 & 3.
export function teamOf(seat) {
  return seat % 2;
}

function dealBatch(hands, deck, from, count) {
  for (let i = 0; i < 4; i++) hands[(from + i) % 4].push(...deck.splice(0, count));
}

// The opening toss: one face-up card per participant, highest card wins
// the rung call. Opposite-team ties re-toss just the tied players; a tie
// within one team hands that team the call (both partners may claim it).
// Returns { rounds, winner, claimants } — exactly one of winner/claimants.
function runToss(rng) {
  let deck = shuffle(makeDeck(), rng);
  let participants = [0, 1, 2, 3];
  const rounds = [];
  for (;;) {
    if (deck.length < participants.length) deck = shuffle(makeDeck(), rng);
    const round = participants.map(seat => ({ seat, card: deck.pop() }));
    rounds.push(round);
    const top = Math.max(...round.map(p => rankValue(p.card)));
    const tied = round.filter(p => rankValue(p.card) === top).map(p => p.seat);
    if (tied.length === 1) return { rounds, winner: tied[0], claimants: null };
    if (new Set(tied.map(teamOf)).size === 1) {
      return { rounds, winner: null, claimants: tied };
    }
    participants = tied;
  }
}

// Deal the caller their moment: 5 cards each (caller first), and the game
// waits for their rung declaration. Nothing was dealt before this.
function assignCaller(state, seat) {
  state.caller = seat;
  state.claimants = null;
  dealBatch(state.hands, state.undealt, seat, 5);
  state.phase = 'calling';
  state.turn = seat;
}

// `claimants` (two seats of the previous game's winning pair) puts the
// game in the 'choosing' phase — first of the two to claim becomes the
// caller. Without it the opening toss decides on the spot.
export function createGame({ claimants = null, rng = Math.random, rules = {} } = {}) {
  const state = {
    // Optional-rule flags. aceCannotPick is the university house rule (an
    // Ace can't cut the sar) — ON by default because that's how the group
    // plays; pass { aceCannotPick: false } for the classic game. To make
    // it selectable per room later, thread a lobby toggle through the
    // adapter's start() into this parameter.
    rules: { aceCannotPick: rules.aceCannotPick ?? true },
    numPlayers: 4,
    caller: null, // decided by toss or claim before anything is dealt
    claimants: null, // [seatA, seatB] who may claim the call ('choosing')
    toss: null, // toss rounds for display: [[{seat, card}] …]
    phase: 'choosing', // 'choosing' | 'calling' | 'playing' | 'over'
    trump: null,
    undealt: shuffle(makeDeck(), rng), // dealt in 5 / 4-4-4 batches
    hands: [[], [], [], []],
    trickNumber: 1,
    trick: [], // [{seat, card}] in play order
    ledSuit: null,
    leader: null,
    turn: null, // during 'calling': whose declaration we wait for
    pile: [], // completed, unclaimed sars (face-up): [[{seat, card}] × 4]
    barred: false, // the current sar follows a pickup and can't be taken
    tricksWon: [0, 0], // sars PICKED UP, per team
    decided: false, // a team already crossed 7 (margin still plays out)
    winnerTeam: null, // 0 or 1 once phase === 'over'
    whitewash: false, // 13-0 sweep
    lastPlay: null, // most recent unresolved play {seat, card}; undoable
  };
  if (claimants) {
    if (!Array.isArray(claimants) || claimants.length !== 2
        || claimants.some(s => !Number.isInteger(s) || s < 0 || s > 3)
        || claimants[0] === claimants[1]) {
      throw new Error('Claimants must be two different seats 0-3');
    }
    state.claimants = [...claimants];
    return state;
  }
  const toss = runToss(rng);
  state.toss = toss.rounds;
  if (toss.winner !== null) assignCaller(state, toss.winner);
  else state.claimants = toss.claimants;
  return state;
}

export function claimCall(state, seat) {
  if (state.phase !== 'choosing') throw new Error('The caller is already decided');
  if (!state.claimants.includes(seat)) throw new Error('Only the winning pair can claim the rung call');
  assignCaller(state, seat);
  return [{ type: 'caller_chosen', seat }];
}

export function callTrump(state, seat, suit) {
  if (state.phase === 'choosing') throw new Error('Waiting for the winners to decide who calls');
  if (state.phase !== 'calling') throw new Error('The rung has already been called');
  if (seat !== state.caller) throw new Error('Only the trump-caller declares the rung');
  if (typeof suit !== 'string' || !SUITS.includes(suit) || suit.length !== 1) {
    throw new Error('Pick a suit for the rung');
  }
  state.trump = suit;
  for (const n of [4, 4, 4]) dealBatch(state.hands, state.undealt, state.caller, n);
  state.undealt = [];
  state.phase = 'playing';
  state.leader = state.caller;
  state.turn = state.caller;
  return [{ type: 'trump_called', seat, suit }];
}

export function legalMoves(state, seat) {
  if (state.phase !== 'playing' || seat !== state.turn) return [];
  const hand = state.hands[seat];
  if (state.trick.length === 0) return [...hand];
  const follow = hand.filter(c => suitOf(c) === state.ledSuit);
  return follow.length ? follow : [...hand];
}

// Does card a beat card b (the current best), given trump and led suit?
function beats(state, a, b) {
  const aTrump = suitOf(a) === state.trump;
  const bTrump = suitOf(b) === state.trump;
  if (aTrump !== bTrump) return aTrump;
  if (aTrump) return rankValue(a) > rankValue(b);
  const aLed = suitOf(a) === state.ledSuit;
  const bLed = suitOf(b) === state.ledSuit;
  if (aLed !== bLed) return aLed;
  return aLed && rankValue(a) > rankValue(b);
}

// The heading play {seat, card} — the card matters for the Ace rule.
function trickWinner(state) {
  let best = state.trick[0];
  for (const play of state.trick.slice(1)) {
    if (beats(state, play.card, best.card)) best = play;
  }
  return best;
}

export function playCard(state, seat, card) {
  if (state.phase === 'choosing' || state.phase === 'calling') {
    throw new Error('Waiting for the rung to be called');
  }
  if (state.phase !== 'playing') throw new Error('Game is over');
  if (seat !== state.turn) throw new Error('Not your turn');
  if (!legalMoves(state, seat).includes(card)) throw new Error('You cannot play that card');

  const events = [{ type: 'played', seat, card }];
  const hand = state.hands[seat];
  hand.splice(hand.indexOf(card), 1);
  if (state.trick.length === 0) state.ledSuit = suitOf(card);
  state.trick.push({ seat, card });

  // This throw locks any previous undoable play; the new play itself is
  // undoable only while it does NOT resolve the trick.
  state.lastPlay = null;

  if (state.trick.length === 4) {
    const header = trickWinner(state);
    const team = teamOf(header.seat);
    const isLast = state.trickNumber === 13;
    // The sar joins the face-up pile; it only leaves the table on a pickup.
    state.pile.push([...state.trick]);
    // Pickup rules: the header must be the sar's leader (they headed the
    // previous sar and defended the lead), sars 1-4 are never taken, and a
    // sar right after a pickup is barred. With the aceCannotPick house
    // rule, a defense headed by any Ace takes nothing either — the pile
    // simply stays. The 13th sar overrides it all — its header takes
    // whatever is on the table.
    const defended = header.seat === state.leader;
    const couldPick = !state.barred && state.trickNumber >= 5 && defended;
    const aceBlocked = !isLast && couldPick
      && state.rules.aceCannotPick && header.card[0] === 'A';
    let picked = 0;
    if (isLast || (couldPick && !aceBlocked)) {
      picked = state.pile.length;
      state.tricksWon[team] += picked;
      state.pile = [];
    }
    events.push({
      type: 'trick_won',
      seat: header.seat,
      team,
      hand: state.trickNumber,
      picked, // 0 = the pile stays on the table
      defended, // the header was the sar's leader
      barred: state.barred, // this sar followed a pickup
      aceBlocked, // the Ace rule alone stopped this pickup
      tricksWon: [...state.tricksWon],
      pileSize: state.pile.length,
    });
    if (!isLast && picked > 0 && !state.decided && state.tricksWon[team] >= 7) {
      // Verdict is in — the rest of the deal only settles the margin.
      state.decided = true;
      events.push({ type: 'seven_reached', team, tricksWon: [...state.tricksWon] });
    }
    if (isLast) {
      state.phase = 'over';
      state.winnerTeam = state.tricksWon[0] > state.tricksWon[1] ? 0 : 1;
      state.whitewash = state.tricksWon[state.winnerTeam] === 13;
      state.turn = null;
      state.leader = null;
      events.push({
        type: 'game_over',
        winnerTeam: state.winnerTeam,
        tricksWon: [...state.tricksWon],
        whitewash: state.whitewash,
      });
    } else {
      state.barred = picked > 0;
      state.trick = [];
      state.ledSuit = null;
      state.trickNumber++;
      state.leader = header.seat;
      state.turn = header.seat;
    }
  } else {
    state.turn = (seat + 1) % 4;
    state.lastPlay = { seat, card };
  }
  return events;
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
