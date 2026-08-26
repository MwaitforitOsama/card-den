import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, callTrump, claimCall, playCard, undoPlay, legalMoves, teamOf,
} from '../src/games/rung/engine.js';
import { rankValue } from '../src/games/cards.js';
import { pickTrump } from '../src/bots/rung-bot.js';

test('bot trump pick: longest suit, ties broken by stronger cards', () => {
  assert.equal(pickTrump(['2H', '3H', '4H', 'AS', 'KD']), 'H'); // 3 hearts
  assert.equal(pickTrump(['2S', '3S', 'AH', 'KH', '4D']), 'H'); // 2v2, hearts stronger
  assert.equal(pickTrump(['AC', '2H', '3D', '4S', '5S']), 'S'); // 2 spades beat singles
});

// A game with a known caller: skip the toss via the claimants path.
function freshGame(caller = 0) {
  const g = createGame({ claimants: [caller, (caller + 2) % 4] });
  claimCall(g, caller);
  return g;
}

// Hand-craft a mid-game state so each rule can be tested in isolation.
function state(hands, opts = {}) {
  return {
    numPlayers: 4,
    caller: opts.caller ?? 0,
    claimants: null,
    toss: null,
    phase: opts.phase ?? 'playing',
    trump: opts.trump ?? 'S',
    undealt: [],
    hands: hands.map(h => [...h]),
    trickNumber: opts.trickNumber ?? 1,
    trick: opts.trick ?? [],
    ledSuit: opts.ledSuit ?? null,
    leader: opts.leader ?? opts.turn ?? 0,
    turn: opts.turn ?? 0,
    rules: opts.rules ?? { aceCannotPick: true, secondAceIsTwo: true },
    acePending: opts.acePending ? [...opts.acePending] : [false, false, false, false],
    pile: opts.pile ? opts.pile.map(h => [...h]) : [],
    barred: opts.barred ?? false,
    tricksWon: opts.tricksWon ? [...opts.tricksWon] : [0, 0],
    decided: opts.decided ?? false,
    winnerTeam: null,
    whitewash: false,
    lastPlay: null,
  };
}

// A dummy already-piled sar (contents don't matter for pile counting).
const SAR = [{ seat: 0, card: '2C' }, { seat: 1, card: '3C' }, { seat: 2, card: '4C' }, { seat: 3, card: '5C' }];

function playHand(g, plays) {
  let events = [];
  for (const [seat, card] of plays) events = playCard(g, seat, card);
  return events.find(ev => ev.type === 'trick_won');
}

test('teams are fixed by seat parity', () => {
  assert.equal(teamOf(0), 0);
  assert.equal(teamOf(2), 0);
  assert.equal(teamOf(1), 1);
  assert.equal(teamOf(3), 1);
});

test('claimants path: nothing is dealt until a winner claims the call', () => {
  const g = createGame({ claimants: [1, 3] });
  assert.equal(g.phase, 'choosing');
  assert.equal(g.caller, null);
  assert.equal(g.toss, null);
  g.hands.forEach(h => assert.equal(h.length, 0)); // nothing revealed yet
  assert.equal(g.undealt.length, 52);
  assert.equal(g.rules.aceCannotPick, true); // university rule on by default
  assert.equal(createGame({ rules: { aceCannotPick: false } }).rules.aceCannotPick, false);
  assert.throws(() => claimCall(g, 0), /Only the winning pair/);
  assert.throws(() => callTrump(g, 1, 'H'), /Waiting for the winners/);
  assert.throws(() => playCard(g, 1, 'AS'), /Waiting for the rung/);
  const events = claimCall(g, 3);
  assert.deepEqual(events, [{ type: 'caller_chosen', seat: 3 }]);
  assert.equal(g.phase, 'calling');
  assert.equal(g.caller, 3);
  assert.equal(g.turn, 3);
  g.hands.forEach(h => assert.equal(h.length, 5));
  assert.equal(g.undealt.length, 32);
  assert.throws(() => claimCall(g, 1), /already decided/);
  assert.throws(() => createGame({ claimants: [1, 1] }));
  assert.throws(() => createGame({ claimants: [0, 4] }));
});

test('toss path: highest card calls; a team tie hands the call to that pair', () => {
  for (let i = 0; i < 200; i++) {
    const g = createGame();
    assert.ok(Array.isArray(g.toss) && g.toss.length >= 1);
    const last = g.toss[g.toss.length - 1];
    const top = Math.max(...last.map(p => rankValue(p.card)));
    const tied = last.filter(p => rankValue(p.card) === top).map(p => p.seat);
    if (g.phase === 'calling') {
      assert.equal(tied.length, 1);
      assert.equal(g.caller, tied[0]);
      g.hands.forEach(h => assert.equal(h.length, 5));
      assert.equal(new Set([...g.hands.flat(), ...g.undealt]).size, 52);
    } else {
      assert.equal(g.phase, 'choosing');
      assert.deepEqual([...g.claimants].sort(), [...tied].sort());
      assert.equal(new Set(g.claimants.map(teamOf)).size, 1); // one team tied
      g.hands.forEach(h => assert.equal(h.length, 0));
    }
    // Every earlier round must have ended in a cross-team tie on top.
    for (const round of g.toss.slice(0, -1)) {
      const t = Math.max(...round.map(p => rankValue(p.card)));
      const tt = round.filter(p => rankValue(p.card) === t).map(p => p.seat);
      assert.ok(tt.length > 1 && new Set(tt.map(teamOf)).size > 1);
    }
  }
});

test('calling: only the caller declares, with a real suit, exactly once', () => {
  const g = freshGame(0);
  assert.equal(g.caller, 0);
  assert.throws(() => callTrump(g, 1, 'H'), /Only the trump-caller/);
  assert.throws(() => callTrump(g, 0, 'X'), /Pick a suit/);
  assert.throws(() => callTrump(g, 0, 'SH'), /Pick a suit/);
  const events = callTrump(g, 0, 'H');
  assert.deepEqual(events, [{ type: 'trump_called', seat: 0, suit: 'H' }]);
  assert.equal(g.phase, 'playing');
  assert.equal(g.trump, 'H');
  assert.equal(g.turn, 0); // caller leads
  assert.equal(g.leader, 0);
  g.hands.forEach(h => assert.equal(h.length, 13));
  assert.equal(g.undealt.length, 0);
  assert.equal(new Set(g.hands.flat()).size, 52);
  assert.throws(() => callTrump(g, 0, 'S'), /already been called/);
});

test('no card may be played before the rung is called', () => {
  const g = createGame({ claimants: [0, 2] });
  claimCall(g, 0);
  assert.throws(() => playCard(g, g.caller, g.hands[g.caller][0]), /Waiting for the rung/);
  assert.deepEqual(legalMoves(g, g.caller), []);
});

test('follow suit when you can, anything when void', () => {
  const g = state([
    ['AS', 'KH'],
    ['2H', '3S'],
    ['4D', '5D'],
    ['6C', '7H'],
  ], { trump: 'D', turn: 0 });
  playCard(g, 0, 'KH'); // leads hearts
  assert.deepEqual(legalMoves(g, 1), ['2H']); // must follow
  assert.throws(() => playCard(g, 1, '3S'), /cannot play/);
  playCard(g, 1, '2H');
  assert.deepEqual(legalMoves(g, 2).sort(), ['4D', '5D']); // void — anything
  playCard(g, 2, '4D');
  playCard(g, 3, '7H');
});

test('heading a sar: highest of led suit, but it goes to the pile, not the team', () => {
  const g = state([
    ['9H', 'AS'], ['KH', '2S'], ['AH', '3S'], ['4H', '5S'],
  ], { trump: 'C', turn: 0 });
  const won = playHand(g, [[0, '9H'], [1, 'KH'], [2, 'AH'], [3, '4H']]);
  assert.equal(won.seat, 2); // AH heads
  assert.equal(won.team, 0);
  assert.equal(won.picked, 0); // sar 1 can never be picked up
  assert.equal(won.pileSize, 1);
  assert.deepEqual(g.tricksWon, [0, 0]);
  assert.equal(g.pile.length, 1);
  assert.equal(g.turn, 2); // header leads next
  assert.equal(g.trickNumber, 2);
});

test('any trump heads over the led suit, higher trump over lower', () => {
  const g = state([
    ['AH', '2S'], ['3D', '3S'], ['KD', '4S'], ['9H', '5S'],
  ], { trump: 'D', turn: 0 });
  const won = playHand(g, [[0, 'AH'], [1, '3D'], [2, 'KD'], [3, '9H']]);
  assert.equal(won.seat, 2);
  assert.equal(won.picked, 0);
});

test('an off-suit non-trump card never heads the sar', () => {
  const g = state([
    ['2H', 'AS'], ['AC', '3S'], ['3H', '4S'], ['4H', '5S'],
  ], { trump: 'D', turn: 0 });
  const won = playHand(g, [[0, '2H'], [1, 'AC'], [2, '3H'], [3, '4H']]);
  assert.equal(won.seat, 3); // 4H highest heart
});

test('undo: allowed while the sar is unresolved, locked after the 4th card', () => {
  const g = state([
    ['AH', '2S'], ['KH', '3S'], ['QH', '4S'], ['JH', '5S'],
  ], { trump: 'C', turn: 0 });
  playCard(g, 0, 'AH');
  assert.throws(() => undoPlay(g, 1), /Nothing to take back/); // not their play
  undoPlay(g, 0);
  assert.equal(g.turn, 0);
  assert.equal(g.trick.length, 0);
  assert.equal(g.ledSuit, null);
  assert.ok(g.hands[0].includes('AH'));
  playHand(g, [[0, 'AH'], [1, 'KH'], [2, 'QH'], [3, 'JH']]);
  assert.equal(g.lastPlay, null);
  assert.throws(() => undoPlay(g, 3), /Nothing to take back/);
});

test('sars 1-4 pile up even when defended; sar 5 defense picks up all 5', () => {
  // Seat 0 leads every sar and always stays unbeaten (nobody holds trump).
  const g = state([
    ['AH', 'KH', 'QH', 'JH', 'TH'],
    ['2H', '3H', '4H', '2C', '3C'],
    ['5H', '6H', '4C', '5C', '6C'],
    ['7H', '8H', '2D', '3D', '4D'],
  ], { trump: 'S', turn: 0 });
  const hands = [
    [[0, 'AH'], [1, '2H'], [2, '5H'], [3, '7H']],
    [[0, 'KH'], [1, '3H'], [2, '6H'], [3, '8H']],
    [[0, 'QH'], [1, '4H'], [2, '4C'], [3, '2D']],
    [[0, 'JH'], [1, '2C'], [2, '5C'], [3, '3D']],
  ];
  for (const [i, plays] of hands.entries()) {
    const won = playHand(g, plays);
    assert.equal(won.seat, 0, `sar ${i + 1} headed by seat 0`);
    assert.equal(won.picked, 0, `sar ${i + 1} cannot be picked up`);
    assert.equal(won.pileSize, i + 1);
  }
  const won5 = playHand(g, [[0, 'TH'], [1, '3C'], [2, '6C'], [3, '4D']]);
  assert.equal(won5.picked, 5); // the whole pile, sars 1-5
  assert.deepEqual(g.tricksWon, [5, 0]);
  assert.deepEqual(g.pile, []);
  assert.equal(g.barred, true); // sar 6 is barred
});

test('overtaking the leader spoils the pickup; the new header must defend', () => {
  const g = state([
    ['5H', '2S'], ['AH', 'KH'], ['3H', '3S'], ['4H', '4S'],
  ], { trump: 'C', trickNumber: 5, turn: 0, pile: [SAR, SAR, SAR, SAR] });
  // Sar 5: seat 1 overtakes the leader — no pickup, pile grows to 5.
  const won5 = playHand(g, [[0, '5H'], [1, 'AH'], [2, '3H'], [3, '4H']]);
  assert.equal(won5.seat, 1);
  assert.equal(won5.picked, 0);
  assert.equal(won5.pileSize, 5);
  assert.equal(g.leader, 1);
  // Sar 6: seat 1 defends the lead — takes all 6.
  const won6 = playHand(g, [[1, 'KH'], [2, '3S'], [3, '4S'], [0, '2S']]);
  assert.equal(won6.seat, 1);
  assert.equal(won6.picked, 6);
  assert.deepEqual(g.tricksWon, [0, 6]);
});

test('a PARTNER overtaking the leader spoils the pickup too', () => {
  const g = state([
    ['5H', '2S'], ['2H', '3S'], ['AH', 'KH'], ['4H', '4S'],
  ], { trump: 'C', trickNumber: 5, turn: 0, pile: [SAR, SAR, SAR, SAR] });
  // Seat 2 (seat 0's partner) heads seat 0's led sar — same-player rule.
  const won = playHand(g, [[0, '5H'], [1, '2H'], [2, 'AH'], [3, '4H']]);
  assert.equal(won.seat, 2);
  assert.equal(won.picked, 0);
  assert.equal(g.leader, 2); // partner now carries the burden
});

test('the sar after a pickup is barred, but back-to-back pickups are allowed', () => {
  const g = state([
    ['AH', 'KH', '2S'], ['2H', '3H', '3S'], ['4H', '5H', '4S'], ['6H', '7H', '5S'],
  ], { trump: 'C', trickNumber: 6, turn: 0, barred: true });
  // Sar 6 (barred): seat 0 defends but nothing can be picked up.
  const won6 = playHand(g, [[0, 'AH'], [1, '2H'], [2, '4H'], [3, '6H']]);
  assert.equal(won6.seat, 0);
  assert.equal(won6.picked, 0);
  assert.equal(won6.pileSize, 1);
  assert.equal(g.barred, false);
  // Sar 7: same player defends again — takes sars 6+7.
  const won7 = playHand(g, [[0, 'KH'], [1, '3H'], [2, '5H'], [3, '7H']]);
  assert.equal(won7.picked, 2);
  assert.deepEqual(g.tricksWon, [2, 0]);
  assert.equal(g.barred, true);
});

test('crossing 7 fires seven_reached once; play continues for the margin', () => {
  const g = state([
    ['KH', '2S'], ['2H', '3S'], ['3H', '4S'], ['4H', '5S'],
  ], { trump: 'C', trickNumber: 5, turn: 0, pile: [SAR, SAR], tricksWon: [5, 0] });
  let events = [];
  for (const [seat, card] of [[0, 'KH'], [1, '2H'], [2, '3H'], [3, '4H']]) {
    events = playCard(g, seat, card);
  }
  const reached = events.find(ev => ev.type === 'seven_reached');
  assert.ok(reached, 'seven_reached emitted');
  assert.equal(reached.team, 0);
  assert.deepEqual(g.tricksWon, [8, 0]);
  assert.equal(g.decided, true);
  assert.equal(g.phase, 'playing'); // the deal plays out
});

test('house rule: an Ace cannot win the sar, but the next non-Ace defense can', () => {
  const g = state([
    ['AH', 'KH', '2S'], ['2H', '3H', '3S'], ['4H', '5H', '4S'], ['6H', '7H', '5S'],
  ], { trump: 'C', trickNumber: 5, turn: 0, pile: [SAR, SAR, SAR, SAR] });
  // Sar 5: seat 0 defends with the Ace — senior, but takes nothing.
  const won5 = playHand(g, [[0, 'AH'], [1, '2H'], [2, '4H'], [3, '6H']]);
  assert.equal(won5.seat, 0);
  assert.equal(won5.defended, true);
  assert.equal(won5.aceBlocked, true);
  assert.equal(won5.picked, 0);
  assert.equal(won5.pileSize, 5);
  assert.equal(g.barred, false); // no pickup happened, so no bar
  assert.equal(g.leader, 0); // the lead stays theirs
  // Sar 6: defends with the King — takes all 6.
  const won6 = playHand(g, [[0, 'KH'], [1, '3H'], [2, '5H'], [3, '7H']]);
  assert.equal(won6.aceBlocked, false);
  assert.equal(won6.picked, 6);
  assert.deepEqual(g.tricksWon, [6, 0]);
});

test('house rule: the trump Ace is blocked too', () => {
  const g = state([
    ['AC', '2S'], ['2H', '3S'], ['4H', '4S'], ['6H', '5S'],
  ], { trump: 'C', trickNumber: 5, turn: 0, pile: [SAR] });
  const won = playHand(g, [[0, 'AC'], [1, '2H'], [2, '4H'], [3, '6H']]);
  assert.equal(won.seat, 0);
  assert.equal(won.aceBlocked, true);
  assert.equal(won.picked, 0);
});

test('house rule off: the classic game lets an Ace pick up', () => {
  const g = state([
    ['AH', '2S'], ['2H', '3S'], ['4H', '4S'], ['6H', '5S'],
  ], { trump: 'C', trickNumber: 5, turn: 0, pile: [SAR, SAR, SAR, SAR], rules: { aceCannotPick: false } });
  const won = playHand(g, [[0, 'AH'], [1, '2H'], [2, '4H'], [3, '6H']]);
  assert.equal(won.aceBlocked, false);
  assert.equal(won.picked, 5);
});

test('double Ace: the second back-to-back Ace fights as the 2 of its suit', () => {
  const g = state([
    ['AD', 'AS'], ['2D', '3S'], ['3D', '4S'], ['4D', '5S'],
  ], { trump: 'S', turn: 0 });
  // Sar 1: seat 0 heads with a full Ace of diamonds — the pair is armed.
  const won1 = playHand(g, [[0, 'AD'], [1, '2D'], [2, '3D'], [3, '4D']]);
  assert.equal(won1.seat, 0);
  assert.equal(g.acePending[0], true);
  // Sar 2: seat 0 leads the trump Ace — demoted to a 2♠, every spade beats it.
  const ev = playCard(g, 0, 'AS');
  assert.equal(ev[0].demoted, true);
  assert.equal(g.trick[0].demoted, true);
  assert.equal(g.acePending[0], false); // pair consumed
  playCard(g, 1, '3S');
  playCard(g, 2, '4S');
  const won2 = playCard(g, 3, '5S').find(e => e.type === 'trick_won');
  assert.equal(won2.seat, 3); // 5♠ tops the demoted Ace
});

test('a demoted trump Ace is still a trump — just the lowest one', () => {
  const g = state([
    ['AH'], ['AS'], ['3H'], ['4H'],
  ], { trump: 'S', turn: 0, acePending: [false, true, false, false] });
  playCard(g, 0, 'AH');
  const ev = playCard(g, 1, 'AS'); // void in hearts; second Ace in a row
  assert.equal(ev[0].demoted, true);
  playCard(g, 2, '3H');
  const won = playCard(g, 3, '4H').find(e => e.type === 'trick_won');
  assert.equal(won.seat, 1); // only trump in the sar, even as a "2"
});

test('pairs only: A-A-A demotes just the middle Ace', () => {
  const g = state([
    ['AD', 'AH', 'AS'], ['2D', '3H', '2S'], ['3D', '4H', '3S'], ['4D', '5H', '4S'],
  ], { trump: 'C', turn: 0 });
  playHand(g, [[0, 'AD'], [1, '2D'], [2, '3D'], [3, '4D']]); // full Ace, arms the pair
  const ev2 = playCard(g, 0, 'AH');
  assert.equal(ev2[0].demoted, true); // second in a row — a 2
  playCard(g, 1, '3H');
  playCard(g, 2, '4H');
  const won2 = playCard(g, 3, '5H').find(e => e.type === 'trick_won');
  assert.equal(won2.seat, 3); // 5♥ beats the demoted Ace
  // Sar 3: the pair was consumed — seat 0's third Ace is a full Ace again.
  playCard(g, 3, '4S');
  const ev3 = playCard(g, 0, 'AS');
  assert.equal(ev3[0].demoted, false);
  playCard(g, 1, '2S');
  const won3 = playCard(g, 2, '3S').find(e => e.type === 'trick_won');
  assert.equal(won3.seat, 0); // full A♠ heads
  assert.equal(g.acePending[0], true); // and arms the next pair
});

test('a non-Ace between two Aces resets the pair', () => {
  const g = state([
    ['AD', 'KD', 'AH'], ['2D', '3D', '2H'], ['4D', '5D', '3H'], ['6D', '7D', '4H'],
  ], { trump: 'C', turn: 0 });
  playHand(g, [[0, 'AD'], [1, '2D'], [2, '4D'], [3, '6D']]);
  playHand(g, [[0, 'KD'], [1, '3D'], [2, '5D'], [3, '7D']]); // non-Ace disarms
  assert.equal(g.acePending[0], false);
  const ev = playCard(g, 0, 'AH');
  assert.equal(ev[0].demoted, false); // full Ace again
});

test('a demoted Ace is no longer an Ace — it CAN win the sar', () => {
  const g = state([
    ['AH', 'AD'], ['2H', '5H'], ['3H', '6H'], ['4H', '7H'],
  ], { trump: 'C', trickNumber: 5, turn: 0, pile: [SAR, SAR, SAR, SAR] });
  // Sar 5: defends with a full Ace — senior, but an Ace can't win it.
  const won5 = playHand(g, [[0, 'AH'], [1, '2H'], [2, '3H'], [3, '4H']]);
  assert.equal(won5.aceBlocked, true);
  assert.equal(won5.picked, 0);
  // Sar 6: defends with the second Ace — a "2" now, so it wins the pile.
  const won6 = playHand(g, [[0, 'AD'], [1, '5H'], [2, '6H'], [3, '7H']]);
  assert.equal(won6.seat, 0); // everyone else off-suit, no trumps
  assert.equal(won6.aceBlocked, false);
  assert.equal(won6.picked, 6);
});

test('double-Ace rule off: every Ace plays at full strength', () => {
  const g = state([
    ['AD', 'AS'], ['2D', '3S'], ['3D', '4S'], ['4D', '5S'],
  ], { trump: 'C', turn: 0, rules: { aceCannotPick: true, secondAceIsTwo: false } });
  playHand(g, [[0, 'AD'], [1, '2D'], [2, '3D'], [3, '4D']]);
  const ev = playCard(g, 0, 'AS');
  assert.equal(ev[0].demoted, false);
  playCard(g, 1, '3S');
  playCard(g, 2, '4S');
  const won = playCard(g, 3, '5S').find(e => e.type === 'trick_won');
  assert.equal(won.seat, 0); // the back-to-back A♠ still heads
});

test('undo restores the double-Ace state', () => {
  const g = state([
    ['AD', 'KD'], ['2D', '3D'], ['4D', '5D'], ['6D', '7D'],
  ], { trump: 'C', turn: 0 });
  playCard(g, 0, 'AD');
  assert.equal(g.acePending[0], true);
  undoPlay(g, 0);
  assert.equal(g.acePending[0], false); // un-armed
  playCard(g, 0, 'KD');
  assert.equal(g.acePending[0], false);
});

test('the trap springs silently: no acePending in the view, no undo for a demoted Ace', () => {
  // The demoted throw is final — it opens no undo window.
  const g = state([
    ['AS', '2H'], ['2S', '3H'], ['3S', '4H'], ['4S', '5H'],
  ], { trump: 'C', turn: 0, acePending: [true, false, false, false] });
  assert.equal(playCard(g, 0, 'AS')[0].demoted, true);
  assert.equal(g.lastPlay, null);
  assert.throws(() => undoPlay(g, 0), /Nothing to take back/);
  // A normal play right after is undoable as usual.
  playCard(g, 1, '2S');
  assert.deepEqual(g.lastPlay, { seat: 1, card: '2S', prevAcePending: false });
});

test('sar 13: the header takes everything left, even undefended', () => {
  const g = state([
    ['5H'], ['AH'], ['3H'], ['4H'],
  ], { trump: 'C', trickNumber: 13, turn: 0, pile: [SAR, SAR, SAR], tricksWon: [6, 3] });
  const events = [];
  for (const [seat, card] of [[0, '5H'], [1, 'AH'], [2, '3H'], [3, '4H']]) {
    events.length = 0;
    events.push(...playCard(g, seat, card));
  }
  const won = events.find(ev => ev.type === 'trick_won');
  assert.equal(won.seat, 1); // overtook the leader — takes it anyway
  assert.equal(won.picked, 4); // 3 piled + the 13th
  const over = events.find(ev => ev.type === 'game_over');
  assert.deepEqual(over.tricksWon, [6, 7]);
  assert.equal(over.winnerTeam, 1);
  assert.equal(over.whitewash, false);
  assert.equal(g.phase, 'over');
});

test('sar 13: the bar after a 12th-sar pickup does not apply', () => {
  const g = state([
    ['AH'], ['2H'], ['3H'], ['4H'],
  ], { trump: 'C', trickNumber: 13, turn: 0, barred: true, tricksWon: [12, 0] });
  const events = [];
  for (const [seat, card] of [[0, 'AH'], [1, '2H'], [2, '3H'], [3, '4H']]) {
    events.length = 0;
    events.push(...playCard(g, seat, card));
  }
  const won = events.find(ev => ev.type === 'trick_won');
  assert.equal(won.picked, 1);
  const over = events.find(ev => ev.type === 'game_over');
  assert.deepEqual(over.tricksWon, [13, 0]);
  assert.equal(over.whitewash, true);
});

test('full random games: 13 sars, pickups only where legal, totals sum to 13', () => {
  for (let run = 0; run < 60; run++) {
    // Cover both entries: claimants path on even runs, live toss on odd.
    let g;
    if (run % 2 === 0) g = freshGame(run % 4);
    else {
      g = createGame();
      if (g.phase === 'choosing') claimCall(g, g.claimants[0]);
    }
    const counts = {};
    for (const c of g.hands[g.caller]) counts[c[1]] = (counts[c[1]] ?? 0) + 1;
    const suit = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    callTrump(g, g.caller, suit);
    let pickedTotal = 0;
    let guard = 0;
    let wasBarred = g.barred;
    const lastAce = [false, false, false, false];
    while (g.phase === 'playing') {
      if (++guard > 60) assert.fail('game did not terminate');
      const legal = legalMoves(g, g.turn);
      assert.ok(legal.length > 0, 'current player must always have a legal move');
      const before = { hand: g.trickNumber, leader: g.leader, barred: wasBarred };
      const events = playCard(g, g.turn, legal[Math.floor(Math.random() * legal.length)]);
      const played = events.find(ev => ev.type === 'played');
      const wasAce = played.card[0] === 'A';
      assert.equal(!!played.demoted, wasAce && lastAce[played.seat],
        'demotion exactly when the same player played a full Ace last sar');
      lastAce[played.seat] = wasAce && !played.demoted;
      const won = events.find(ev => ev.type === 'trick_won');
      if (won) {
        if (won.aceBlocked) assert.equal(won.picked, 0, 'an Ace-blocked sar takes nothing');
        if (won.picked > 0 && before.hand !== 13) {
          assert.ok(before.hand >= 5, `no pickups before sar 5 (sar ${before.hand})`);
          assert.ok(!before.barred, 'no pickups on a barred sar');
          assert.equal(won.seat, before.leader, 'pickups require defending the lead');
        }
        if (before.hand === 13) assert.ok(won.picked > 0, 'sar 13 header takes the leftovers');
        pickedTotal += won.picked;
        wasBarred = g.barred;
      }
    }
    assert.equal(pickedTotal, 13);
    assert.equal(g.tricksWon[0] + g.tricksWon[1], 13);
    assert.deepEqual(g.pile, []);
    assert.equal(g.winnerTeam, g.tricksWon[0] > g.tricksWon[1] ? 0 : 1);
    assert.ok(g.tricksWon[g.winnerTeam] >= 7);
    assert.equal(g.whitewash, g.tricksWon[g.winnerTeam] === 13);
    g.hands.forEach(h => assert.equal(h.length, 0));
  }
});
