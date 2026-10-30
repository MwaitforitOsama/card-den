import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, playCard, takeHand, legalMoves, canTake, makeDeck, undoPlay,
  canConcede, concede, sarreinPick,
} from '../src/games/thulla/engine.js';
import { thulla as thullaAdapter } from '../src/games/thulla/adapter.js';

// Hand-craft a game state so each rule can be tested in isolation.
function state(hands, opts = {}) {
  const numPlayers = hands.length;
  return {
    numPlayers,
    hands: hands.map(h => [...h]),
    safe: opts.safe ?? Array(numPlayers).fill(false),
    phase: 'playing',
    trickNumber: opts.trickNumber ?? 2,
    trick: opts.trick ?? [],
    ledSuit: opts.ledSuit ?? null,
    leader: opts.leader ?? opts.turn ?? 0,
    turn: opts.turn ?? 0,
    bhabhi: null,
    lastPlay: null,
    rules: { sarrein: !!opts.sarrein },
    sarrein: null,
    sarreinResult: null,
  };
}

test('deck has 52 unique cards', () => {
  const deck = makeDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
});

test('deal: 5 players get 11/11/10/10/10 cards, AS holder starts', () => {
  const g = createGame(5);
  const sizes = g.hands.map(h => h.length).sort((a, b) => b - a);
  assert.deepEqual(sizes, [11, 11, 10, 10, 10]);
  assert.equal(g.hands.flat().length, 52);
  assert.ok(g.hands[g.turn].includes('AS'));
  assert.equal(g.turn, g.leader);
  assert.equal(g.trickNumber, 1);
  assert.deepEqual(legalMoves(g, g.turn), ['AS']);
});

test('player count must be 3-7', () => {
  assert.throws(() => createGame(2));
  assert.throws(() => createGame(8));
  createGame(3);
  createGame(7);
});

test('trick 1: forced AS lead, spades must be followed, off-suit does not end it, all to waste', () => {
  const g = state([['AS', '2H'], ['KS', '3H'], ['4D', '5H']], { trickNumber: 1, turn: 0 });
  assert.deepEqual(legalMoves(g, 0), ['AS']);
  assert.throws(() => playCard(g, 0, '2H'));
  playCard(g, 0, 'AS');
  assert.deepEqual(legalMoves(g, 1), ['KS']); // has a spade, must follow
  playCard(g, 1, 'KS');
  assert.deepEqual(legalMoves(g, 2).sort(), ['4D', '5H']); // no spades: anything
  const events = playCard(g, 2, '4D'); // off-suit on trick 1
  // Nobody picked up: every hand is down to exactly one card.
  assert.deepEqual(g.hands.map(h => h.length), [1, 1, 1]);
  assert.ok(events.some(e => e.type === 'trick_won' && e.seat === 0));
  assert.equal(g.turn, 0); // AS is the highest spade, seat 0 leads trick 2
  assert.equal(g.trickNumber, 2);
  assert.equal(g.ledSuit, null);
});

test('must follow suit when possible', () => {
  const g = state([['2H', 'AD'], ['3H', 'KS'], ['5H', '4C']], { turn: 0 });
  playCard(g, 0, '2H');
  assert.deepEqual(legalMoves(g, 1), ['3H']);
  assert.throws(() => playCard(g, 1, 'KS'));
});

test('playing out of turn or a card you do not hold throws', () => {
  const g = state([['2H'], ['3H'], ['5H']], { turn: 0 });
  assert.throws(() => playCard(g, 1, '3H'));
  assert.throws(() => playCard(g, 0, '9H'));
});

test('clean trick: goes to waste, highest of led suit leads next', () => {
  const g = state([['5H', 'AD'], ['9H', '2D'], ['2H', '3D']], { turn: 0 });
  playCard(g, 0, '5H');
  playCard(g, 1, '9H');
  const events = playCard(g, 2, '2H');
  assert.deepEqual(g.hands.map(h => h.length), [1, 1, 1]); // waste, no pickup
  assert.ok(events.some(e => e.type === 'trick_won' && e.seat === 1));
  assert.equal(g.turn, 1);
  assert.equal(g.leader, 1);
  assert.equal(g.trickNumber, 3);
});

test('thulla: trick ends immediately, highest of led suit picks everything up', () => {
  const g = state([['5H', 'AD'], ['QH', '3D', '4D'], ['2C', '6S'], ['8D', '9D']], { turn: 0 });
  playCard(g, 0, '5H');
  playCard(g, 1, 'QH');
  const events = playCard(g, 2, '2C'); // void in hearts → thulla
  const thulla = events.find(e => e.type === 'thulla');
  assert.equal(thulla.winner, 1);
  assert.deepEqual([...thulla.cards].sort(), ['2C', '5H', 'QH']);
  // Seat 3 never got to play.
  assert.equal(g.hands[3].length, 2);
  // Winner holds their 2 remaining + 3 picked up.
  assert.equal(g.hands[1].length, 5);
  assert.ok(g.hands[1].includes('5H') && g.hands[1].includes('2C'));
  assert.equal(g.turn, 1);
  assert.equal(g.trickNumber, 3);
  assert.equal(g.phase, 'playing');
});

test('thulla with your last card makes you safe', () => {
  const g = state([['5H', 'AD'], ['QH', '3D'], ['2C']], { turn: 0 });
  playCard(g, 0, '5H');
  playCard(g, 1, 'QH');
  const events = playCard(g, 2, '2C');
  assert.equal(g.safe[2], true);
  assert.ok(events.some(e => e.type === 'safe' && e.seat === 2));
  assert.equal(g.phase, 'playing'); // seats 0 and 1 still in
  assert.equal(g.turn, 1);
});

test('safe players are skipped in turn order', () => {
  const g = state([['5H', 'AD'], ['9H', '2D'], ['2H', '3D']], { turn: 0, safe: [false, true, false] });
  playCard(g, 0, '5H');
  assert.equal(g.turn, 2); // seat 1 is safe, skipped
  playCard(g, 2, '2H');
  assert.equal(g.turn, 0); // clean trick of the 2 active players, seat 0 highest
  assert.equal(g.trickNumber, 3);
});

test('last card wins a clean trick: player is safe, next active player leads', () => {
  const g = state([['AH'], ['2H', 'KD'], ['3H', 'QD']], { turn: 0 });
  playCard(g, 0, 'AH');
  playCard(g, 1, '2H');
  const events = playCard(g, 2, '3H');
  assert.equal(g.safe[0], true);
  assert.ok(events.some(e => e.type === 'safe' && e.seat === 0));
  assert.equal(g.phase, 'playing');
  assert.equal(g.leader, 1); // next active clockwise from the safe winner
  assert.equal(g.turn, 1);
});

test('game over: last player holding cards is the bhabhi', () => {
  const g = state([['2H'], ['5H', 'KD'], []], { turn: 0, safe: [false, false, true] });
  playCard(g, 0, '2H');
  const events = playCard(g, 1, '5H');
  assert.equal(g.phase, 'over');
  assert.equal(g.bhabhi, 1);
  assert.ok(events.some(e => e.type === 'game_over' && e.bhabhi === 1));
});

test('thulla on your last card can hand the pickup player the loss', () => {
  const g = state([['2H', '7D'], ['3C']], { turn: 0 });
  playCard(g, 0, '2H');
  playCard(g, 1, '3C'); // thulla with last card
  assert.equal(g.safe[1], true);
  assert.equal(g.phase, 'over');
  assert.equal(g.bhabhi, 0); // seat 0 picked up and is the only one left
  assert.equal(g.hands[0].length, 3);
});

test('final players emptying on the same clean trick is a draw', () => {
  const g = state([['2H'], ['5H'], []], { turn: 0, safe: [false, false, true] });
  playCard(g, 0, '2H');
  const events = playCard(g, 1, '5H');
  assert.equal(g.phase, 'over');
  assert.equal(g.bhabhi, null);
  assert.ok(events.some(e => e.type === 'game_over' && e.bhabhi === null));
});

test('take: leader may take next active player\'s whole hand before leading', () => {
  const g = state([['2H', '3H'], ['KD', 'QD', 'JD'], ['4C', '5C'], ['6S', '7S']], { turn: 0 });
  assert.equal(canTake(g, 0), 1);
  const events = takeHand(g, 0);
  assert.equal(g.hands[0].length, 5);
  assert.deepEqual(g.hands[1], []);
  assert.equal(g.safe[1], true);
  assert.ok(events.some(e => e.type === 'took' && e.seat === 0 && e.target === 1 && e.count === 3));
  assert.ok(events.some(e => e.type === 'safe' && e.seat === 1));
  assert.equal(g.turn, 0); // still the taker's lead
  assert.equal(g.phase, 'playing');
});

test('take skips players who are already safe', () => {
  const g = state([['2H'], [], ['4C', '5C'], ['6S']], { turn: 0, safe: [false, true, false, false] });
  assert.equal(canTake(g, 0), 2);
});

test('take is not allowed: with 2 players left, mid-trick, on trick 1, or off-turn', () => {
  const twoLeft = state([['2H'], ['KD']], { turn: 0 });
  assert.equal(canTake(twoLeft, 0), null);
  assert.throws(() => takeHand(twoLeft, 0));

  const midTrick = state([['2H', '3H'], ['KD'], ['4C']], { turn: 1, ledSuit: 'H', trick: [{ seat: 0, card: '5H' }] });
  assert.equal(canTake(midTrick, 1), null);

  const firstTrick = state([['AS', '2H'], ['KD'], ['4C']], { trickNumber: 1, turn: 0 });
  assert.equal(canTake(firstTrick, 0), null);

  const notYourTurn = state([['2H'], ['KD'], ['4C']], { turn: 0 });
  assert.equal(canTake(notYourTurn, 1), null);
});

test('undo: an unresolved play can be taken back and replaced', () => {
  const g = state([['2H', '5H'], ['3H', 'KS'], ['9H', '4C']], { turn: 0 });
  playCard(g, 0, '2H');
  assert.deepEqual(g.lastPlay, { seat: 0, card: '2H' });
  // Leader takes it back: trick empty, led suit reset, still their turn.
  undoPlay(g, 0);
  assert.deepEqual(g.trick, []);
  assert.equal(g.ledSuit, null);
  assert.equal(g.turn, 0);
  assert.ok(g.hands[0].includes('2H'));
  assert.equal(g.lastPlay, null);
  // They may lead a different card; a follower can also undo.
  playCard(g, 0, '5H');
  playCard(g, 1, '3H');
  undoPlay(g, 1);
  assert.equal(g.trick.length, 1);
  assert.equal(g.ledSuit, 'H'); // the lead still stands
  assert.equal(g.turn, 1);
  assert.ok(g.hands[1].includes('3H'));
});

test('undo: the next throw locks the previous play', () => {
  const g = state([['2H', '5H'], ['3H', 'KS'], ['9H', '4C']], { turn: 0 });
  playCard(g, 0, '2H');
  playCard(g, 1, '3H'); // locks seat 0's card
  assert.throws(() => undoPlay(g, 0));
  assert.deepEqual(g.lastPlay, { seat: 1, card: '3H' });
});

test('undo: a play that resolves the sarr is final immediately', () => {
  // Clean-trick completion is final.
  const clean = state([['5H', 'AD'], ['9H', '2D'], ['2H', '3D']], { turn: 0 });
  playCard(clean, 0, '5H');
  playCard(clean, 1, '9H');
  playCard(clean, 2, '2H');
  assert.equal(clean.lastPlay, null);
  assert.throws(() => undoPlay(clean, 2));
  // A thulla is final too.
  const thulla = state([['5H', 'AD'], ['QH', '3D'], ['2C', '6S']], { turn: 0 });
  playCard(thulla, 0, '5H');
  playCard(thulla, 1, 'QH');
  playCard(thulla, 2, '2C');
  assert.equal(thulla.lastPlay, null);
  assert.throws(() => undoPlay(thulla, 2));
});

test('undo: only the player who threw the card can take it back', () => {
  const g = state([['2H', '5H'], ['3H'], ['9H']], { turn: 0 });
  playCard(g, 0, '2H');
  assert.throws(() => undoPlay(g, 1));
  assert.throws(() => undoPlay(g, 2));
});

test('concede: only allowed head-to-head, and only for the players still in', () => {
  const threeLeft = state([['2H'], ['KD'], ['4C']], { turn: 0 });
  assert.equal(canConcede(threeLeft, 0), null);
  assert.throws(() => concede(threeLeft, 0));

  const g = state([['2H', '3H'], [], ['KD', 'QD']], { turn: 0, safe: [false, true, false] });
  assert.equal(canConcede(g, 0), 2); // either active player may concede...
  assert.equal(canConcede(g, 2), 0);
  assert.equal(canConcede(g, 1), null); // ...but a safe player may not
});

test('concede: ends the game, conceder is the bhabhi, opponent wins', () => {
  const g = state([['2H', '3H'], [], ['KD', 'QD']], { turn: 2, safe: [false, true, false] });
  const events = concede(g, 2);
  assert.equal(g.phase, 'over');
  assert.equal(g.bhabhi, 2);
  assert.equal(g.safe[0], true); // the opponent won, cards in hand and all
  assert.equal(g.turn, null);
  assert.ok(events.some(e => e.type === 'conceded' && e.seat === 2 && e.winner === 0));
  assert.ok(events.some(e => e.type === 'game_over' && e.bhabhi === 2));
  // A finished game accepts no further concessions or plays.
  assert.throws(() => concede(g, 0));
  assert.throws(() => playCard(g, 0, '2H'));
});

test('concede: allowed mid-sarr, off-turn, and clears any undoable play', () => {
  const g = state([['2H', '5H'], [], ['3H', 'KD']], { turn: 0, safe: [false, true, false] });
  playCard(g, 0, '2H');
  assert.deepEqual(g.lastPlay, { seat: 0, card: '2H' });
  assert.equal(g.turn, 2);
  const events = concede(g, 0); // conceder is not the turn holder
  assert.equal(g.phase, 'over');
  assert.equal(g.bhabhi, 0);
  assert.equal(g.lastPlay, null);
  assert.ok(events.some(e => e.type === 'conceded' && e.winner === 2));
});

test('full random games always terminate legally', () => {
  // Play many full games with random legal moves; the rules must never
  // wedge (no legal move while playing) and must always reach a verdict.
  for (let n = 3; n <= 7; n++) {
    for (let round = 0; round < 30; round++) {
      const g = createGame(n);
      let moves = 0;
      while (g.phase === 'playing') {
        assert.ok(moves++ < 5000, `game wedged with ${n} players`);
        const legal = legalMoves(g, g.turn);
        assert.ok(legal.length > 0, 'active player has no legal move');
        // Occasionally exercise the take option when available.
        if (canTake(g, g.turn) !== null && Math.random() < 0.02) {
          takeHand(g, g.turn);
          continue;
        }
        playCard(g, g.turn, legal[Math.floor(Math.random() * legal.length)]);
      }
      // Verdict is a seat still holding cards, or a draw with all hands empty.
      if (g.bhabhi !== null) {
        assert.ok(g.hands[g.bhabhi].length > 0);
      } else {
        assert.ok(g.hands.every(h => h.length === 0));
      }
    }
  }
});

/* ---------- Sarrein (optional house rule) ---------- */

// Two players left: seat 0 = A (holder), seat 1 = B (one card), seat 2 safe.
function duel(aHand, bHand, { turn = 0, sarrein = true } = {}) {
  return state([aHand, bHand, []], { turn, sarrein, safe: [false, false, true] });
}

// B blind-picks the given card (finds its face-down slot).
function pickCard(g, card) {
  const slot = g.sarrein.order.indexOf(card);
  assert.ok(slot >= 0, `${card} is not face down`);
  return sarreinPick(g, g.sarrein.picker, slot);
}

test('E1 sarrein: A leads lower club, B answers with last card 10♣ → Sarrein, B to pick', () => {
  const g = duel(['5C', '9H', '3D', 'KS', '7S', '2H'], ['TC'], { turn: 0 });
  playCard(g, 0, '5C');
  const events = playCard(g, 1, 'TC');
  assert.ok(events.some(e => e.type === 'sarrein_started' && e.picker === 1 && e.holder === 0));
  assert.equal(g.phase, 'playing');
  assert.equal(g.safe[1], false, 'B is not safe during Sarrein');
  assert.equal(g.hands[0].length, 5);
  assert.equal(g.turn, 1);
  assert.equal(g.sarrein.order.length, 5);
  assert.deepEqual([...g.sarrein.order].sort(), [...g.hands[0]].sort());
});

test('E2 sarrein: B leads 10♣, A follows lower → Sarrein too', () => {
  const g = duel(['5C', '9H', '3D', 'KS', '7S', '2H'], ['TC'], { turn: 1 });
  playCard(g, 1, 'TC');
  const events = playCard(g, 0, '5C');
  assert.ok(events.some(e => e.type === 'sarrein_started'));
  assert.equal(g.turn, 1);
});

test('E3 sarrein: A plays higher club over B\'s last card → game over, A bhabhi (no Sarrein)', () => {
  const g = duel(['KC', '9H', '3D'], ['TC'], { turn: 1 });
  playCard(g, 1, 'TC');
  const events = playCard(g, 0, 'KC');
  assert.ok(!events.some(e => e.type === 'sarrein_started'));
  assert.equal(g.phase, 'over');
  assert.equal(g.bhabhi, 0);
});

test('E4 sarrein: B\'s last card is a thulla → normal pickup, A bhabhi', () => {
  const g = duel(['9H', '5C', '3D'], ['TC'], { turn: 0 });
  playCard(g, 0, '9H');
  const events = playCard(g, 1, 'TC');
  assert.ok(events.some(e => e.type === 'thulla' && e.winner === 0));
  assert.ok(!events.some(e => e.type === 'sarrein_started'));
  assert.equal(g.phase, 'over');
  assert.equal(g.bhabhi, 0);
});

test('E5 sarrein OFF: same moves as E1 end the game as before', () => {
  const g = duel(['5C', '9H', '3D', 'KS', '7S', '2H'], ['TC'], { turn: 0, sarrein: false });
  playCard(g, 0, '5C');
  const events = playCard(g, 1, 'TC');
  assert.ok(!events.some(e => e.type === 'sarrein_started'));
  assert.equal(g.phase, 'over');
  assert.equal(g.bhabhi, 0);
  assert.equal(g.safe[1], true);
});

test('E6 sarrein: A left with exactly 1 card when B is due to pick → A loses', () => {
  const g = duel(['5C', '9H'], ['TC'], { turn: 0 });
  playCard(g, 0, '5C');
  const events = playCard(g, 1, 'TC');
  assert.ok(events.some(e => e.type === 'sarrein_started'));
  assert.ok(events.some(e => e.type === 'sarrein_result' && e.loser === 0 && e.reason === 'one_card'));
  assert.equal(g.phase, 'over');
  assert.equal(g.bhabhi, 0);
  assert.equal(g.safe[1], true);
});

// Puts a game straight into Sarrein with A holding `aHand` (B empty).
function inSarrein(aHand) {
  const g = duel([...aHand, '2C'], ['TC'], { turn: 0 });
  playCard(g, 0, '2C');
  playCard(g, 1, 'TC');
  assert.ok(g.sarrein, 'Sarrein should be running');
  return g;
}

test('E7 sarrein: A must answer with a higher card (even his last) → B wins', () => {
  const g = inSarrein(['KS', '2S']);
  pickCard(g, '2S');
  assert.deepEqual(legalMoves(g, 0), ['KS']);
  const events = playCard(g, 0, 'KS');
  assert.ok(events.some(e => e.type === 'sarrein_result' && e.winner === 1 && e.reason === 'higher'));
  assert.equal(g.bhabhi, 0);
  assert.equal(g.safe[1], true);
});

test('E8 sarrein: A answers lower with his last card → A wins', () => {
  const g = inSarrein(['3S', '2S']);
  pickCard(g, '3S');
  const events = playCard(g, 0, '2S');
  assert.ok(events.some(e => e.type === 'sarrein_result' && e.winner === 0 && e.reason === 'last_card'));
  assert.equal(g.bhabhi, 1);
});

test('E9 sarrein: A has none of the suit → his thulla makes B pick up, A wins', () => {
  const g = inSarrein(['3D', '7C', '9H']);
  pickCard(g, '3D');
  assert.deepEqual(legalMoves(g, 0).sort(), ['7C', '9H']);
  const events = playCard(g, 0, '7C');
  assert.ok(events.some(e => e.type === 'thulla' && e.seat === 0 && e.winner === 1));
  assert.ok(events.some(e => e.type === 'sarrein_result' && e.winner === 0 && e.reason === 'thulla'));
  assert.equal(g.bhabhi, 1);
});

test('E10 sarrein: clean lower answer → next round; then A on 1 card loses', () => {
  const g = inSarrein(['9D', '4D', 'KS']);
  pickCard(g, '9D');
  let events = playCard(g, 0, '4D');
  assert.ok(events.some(e => e.type === 'sarrein_result' && e.loser === 0 && e.reason === 'one_card'));
  assert.equal(g.bhabhi, 0);
});

test('E10b sarrein: clean lower answer with cards to spare → B picks again from a reshuffle', () => {
  const g = inSarrein(['9D', '4D', 'KS', '5H']);
  pickCard(g, '9D');
  const events = playCard(g, 0, '4D');
  assert.ok(events.some(e => e.type === 'trick_won' && e.seat === 1));
  assert.equal(g.phase, 'playing');
  assert.equal(g.turn, 1);
  assert.deepEqual([...g.sarrein.order].sort(), ['5H', 'KS']);
  assert.deepEqual(g.trick, []);
});

test('E11 sarrein: A chooses freely among the led suit — a higher pick loses for him', () => {
  const g = inSarrein(['QD', '4D', '2D', '7C']);
  pickCard(g, '4D');
  assert.deepEqual(legalMoves(g, 0).sort(), ['2D', 'QD']);
  const events = playCard(g, 0, 'QD');
  assert.ok(events.some(e => e.type === 'sarrein_result' && e.winner === 1 && e.reason === 'higher'));
});

test('E12 sarrein: nobody can concede while it runs', () => {
  const g = inSarrein(['9D', '4D', 'KS']);
  assert.equal(canConcede(g, 0), null);
  assert.equal(canConcede(g, 1), null);
  assert.throws(() => concede(g, 0));
});

test('sarrein: picks are final, validated, and only for the picker', () => {
  const g = inSarrein(['9D', '4D', 'KS']);
  assert.throws(() => sarreinPick(g, 0, 0), /Not your pick/); // holder can't pick
  assert.throws(() => sarreinPick(g, 1, 3), /face-down/);
  assert.throws(() => sarreinPick(g, 1, -1), /face-down/);
  assert.throws(() => sarreinPick(g, 1, '0'), /face-down/);
  assert.deepEqual(legalMoves(g, 1), []); // B has no hand to play from
  const card = g.sarrein.order[0];
  const events = pickCard(g, card);
  assert.ok(events.some(e => e.type === 'played' && e.blind && e.card === card));
  assert.ok(!g.hands[0].includes(card), 'picked card left A\'s hand');
  assert.equal(g.lastPlay, null);
  assert.throws(() => undoPlay(g, 1), /Nothing to take back/);
  assert.throws(() => sarreinPick(g, 1, 0), /Not your pick/); // one pick per round
});

test('sarrein: needs exactly 2 players — with 3 left, a last card winning is just safe', () => {
  const g = state([['5C', '9H'], ['TC'], ['3C', '4H']], { turn: 0, sarrein: true });
  playCard(g, 0, '5C');
  playCard(g, 1, 'TC');
  const events = playCard(g, 2, '3C');
  assert.ok(!events.some(e => e.type === 'sarrein_started'));
  assert.equal(g.safe[1], true);
});

test('sarrein: both emptying on the same clean sarr stays a draw', () => {
  const g = duel(['5C'], ['TC'], { turn: 0 });
  playCard(g, 0, '5C');
  const events = playCard(g, 1, 'TC');
  assert.ok(!events.some(e => e.type === 'sarrein_started'));
  assert.equal(g.phase, 'over');
  assert.equal(g.bhabhi, null);
});

test('sarrein: adapter view shows only the face-down count, never the cards', () => {
  const g = inSarrein(['9D', '4D', 'KS']);
  const forB = thullaAdapter.gameView(g, 1);
  const forA = thullaAdapter.gameView(g, 0);
  const forSpectator = thullaAdapter.gameView(g, -1);
  assert.deepEqual(forB.sarrein, { picker: 1, holder: 0, slots: 3 });
  assert.equal(forB.youPick, true);
  assert.equal(forA.youPick, false);
  assert.equal(forA.youCanConcede, false);
  for (const v of [forB, forSpectator]) {
    const json = JSON.stringify(v);
    for (const c of ['9D', '4D', 'KS']) assert.ok(!json.includes(c), `${c} leaked`);
  }
  assert.equal(forB.sarreinRule, true);
});

test('sarrein: rule is off by default and threads from room rules into new games', () => {
  assert.equal(createGame(4).rules.sarrein, false);
  assert.deepEqual(thullaAdapter.settings, { sarrein: { default: false } });
  const room = { players: [{}, {}, {}], rules: { thulla: { sarrein: true } } };
  thullaAdapter.start(room);
  assert.equal(room.game.rules.sarrein, true);
});

test('sarrein: full random games with the rule ON always terminate with a verdict', () => {
  let sarreins = 0;
  for (let n = 3; n <= 7; n++) {
    for (let round = 0; round < 200; round++) {
      const g = createGame(n, Math.random, { sarrein: true });
      let moves = 0;
      while (g.phase === 'playing') {
        assert.ok(moves++ < 5000, `game wedged with ${n} players`);
        if (g.sarrein && g.turn === g.sarrein.picker) {
          sarreinPick(g, g.turn, Math.floor(Math.random() * g.sarrein.order.length));
          continue;
        }
        const legal = legalMoves(g, g.turn);
        assert.ok(legal.length > 0, 'active player has no legal move');
        playCard(g, g.turn, legal[Math.floor(Math.random() * legal.length)]);
      }
      if (g.sarreinResult) {
        sarreins++;
        assert.equal(g.bhabhi, g.sarreinResult.loser);
        assert.notEqual(g.sarreinResult.winner, g.sarreinResult.loser);
      } else if (g.bhabhi !== null) {
        assert.ok(g.hands[g.bhabhi].length > 0);
      } else {
        assert.ok(g.hands.every(h => h.length === 0));
      }
    }
  }
  assert.ok(sarreins > 0, 'random play never reached Sarrein — test is not exercising it');
});
