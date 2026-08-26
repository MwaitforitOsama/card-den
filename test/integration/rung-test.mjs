// End-to-end Rung test: 4 clients create a Rung room, exercise game
// switching and seat swapping, then play a full deal — calling phase,
// follow-suit play, all 13 tricks — and check the verdict and scoreboard.
// Finally a rematch verifies the dealer rotation.
const PORT = process.env.PORT ?? 8787;
const BASE = `http://localhost:${PORT}`;

const res = await fetch(BASE + '/api/create?game=rung', { method: 'POST' });
const { code } = await res.json();
console.log('room:', code);

const NAMES = ['Hanzalah', 'Ali', 'Usman', 'Bilal'];
const errors = [];
const clients = NAMES.map(makeClient);

function makeClient(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/${code}`);
  const c = {
    name, ws, token: null, state: null, stateCount: 0,
    lastError: null, trickWins: 0, sarEvents: [], gameOvers: [], starteds: [],
  };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name, token: null }));
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'joined') c.token = msg.token;
    else if (msg.type === 'error') c.lastError = msg.message;
    else if (msg.type === 'state') {
      c.state = msg;
      c.stateCount++;
      for (const ev of msg.events || []) {
        if (ev.type === 'trick_won') { c.trickWins++; c.sarEvents.push(ev); }
        if (ev.type === 'game_over') c.gameOvers.push(ev);
        if (ev.type === 'started') c.starteds.push(ev);
      }
    }
  };
  return c;
}

function until(pred, what, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > timeout) {
        clearInterval(iv);
        reject(new Error('timeout waiting for: ' + what));
      }
    }, 10);
  });
}

function send(c, msg) {
  c.ws.send(JSON.stringify(msg));
}

async function expectError(c, msg, what) {
  c.lastError = null;
  send(c, msg);
  await until(() => c.lastError !== null, `error for ${what}`);
  console.log(`rejected ok (${what}): ${c.lastError}`);
}

const bySeat = seat => clients.find(c => c.state?.youSeat === seat);
const host = () => bySeat(0);

/* ---------- lobby: game switching & seat swapping ---------- */

await until(() => clients.every(c => c.state?.players?.length === 4), 'all seated');
if (clients[0].state.gameId !== 'rung') errors.push(`gameId is ${clients[0].state.gameId}, expected rung`);

await expectError(bySeat(1), { type: 'set_game', game: 'thulla' }, 'non-host set_game');
send(host(), { type: 'set_game', game: 'thulla' });
await until(() => host().state.gameId === 'thulla', 'switch to thulla');
send(host(), { type: 'set_game', game: 'rung' });
await until(() => host().state.gameId === 'rung', 'switch back to rung');
console.log('game switching ok: rung → thulla → rung');

await expectError(bySeat(1), { type: 'swap_seats', a: 1, b: 2 }, 'non-host swap');
const beforeSwap = host().state.players.map(p => p.name);
const swapCount = host().stateCount;
send(host(), { type: 'swap_seats', a: 1, b: 2 });
await until(() => host().stateCount > swapCount
  && host().state.players[1].name === beforeSwap[2]
  && host().state.players[2].name === beforeSwap[1], 'seats swapped');
console.log(`seat swap ok: ${beforeSwap[1]} <-> ${beforeSwap[2]}`);

/* ---------- house-rule toggle (Ace can't win the sar) ---------- */

await expectError(bySeat(1), { type: 'set_rule', rule: 'aceCannotPick', value: false }, 'non-host rule change');
await expectError(host(), { type: 'set_rule', rule: 'nope', value: false }, 'unknown rule');
send(host(), { type: 'set_rule', rule: 'aceCannotPick', value: false });
await until(() => host().state.gameRules?.aceCannotPick === false, 'ace rule off');
console.log('ace rule toggled OFF (classic game for the guest)');

/* ---------- toss & calling phase ---------- */

send(host(), { type: 'start' });
await until(() => clients.every(c => ['choosing', 'calling'].includes(c.state?.game?.phase)), 'first deal underway');
let g0 = host().state.game;
if (!g0.toss) errors.push('first rung game did not run a toss');

// A same-team toss tie leaves the call with that pair — resolve the claim.
if (g0.phase === 'choosing') {
  for (const c of clients) {
    if (c.state.game.hand.length !== 0) errors.push('cards dealt before the caller was decided');
  }
  const outsider = clients.find(c => !g0.claimants.includes(c.state.youSeat));
  await expectError(outsider, { type: 'claim_call' }, 'outsider claiming the call');
  console.log(`toss tie: seats ${g0.claimants.join(' & ')} decide who calls`);
  send(bySeat(g0.claimants[0]), { type: 'claim_call' });
  await until(() => clients.every(c => c.state.game.phase === 'calling'), 'caller claimed');
}
g0 = host().state.game;
const callerSeat = g0.caller;
if (g0.aceRule !== false) errors.push('aceCannotPick=false was not threaded into the game');
if (g0.secondAceRule !== true) errors.push('secondAceIsTwo should default to ON');
for (const c of clients) {
  if (c.state.game.hand.length !== 5) errors.push(`${c.name} has ${c.state.game.hand.length} cards during calling, expected 5`);
  const expectCall = c.state.youSeat === callerSeat;
  if (c.state.game.youCall !== expectCall) errors.push(`${c.name} youCall=${c.state.game.youCall}, expected ${expectCall}`);
  if (c.state.game.trump !== null) errors.push('trump leaked before the call');
  if ('youAcePending' in c.state.game) errors.push('double-Ace trap state leaked to the client');
}
console.log(`calling phase ok: 5 cards each, caller = seat ${callerSeat} (via toss)`);

await expectError(bySeat((callerSeat + 1) % 4), { type: 'call_trump', suit: 'H' }, 'non-caller calling');
await expectError(bySeat(callerSeat), { type: 'play', card: bySeat(callerSeat).state.game.hand[0] }, 'playing before the call');

// Caller picks the suit they hold most of.
const caller = bySeat(callerSeat);
const counts = {};
for (const card of caller.state.game.hand) counts[card[1]] = (counts[card[1]] ?? 0) + 1;
const suit = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
send(caller, { type: 'call_trump', suit });
await until(() => clients.every(c => c.state.game.phase === 'playing'), 'playing phase');
for (const c of clients) {
  if (c.state.game.trump !== suit) errors.push('trump not visible to everyone after the call');
  if (c.state.game.hand.length !== 13) errors.push(`${c.name} has ${c.state.game.hand.length} cards after the call`);
}
if (host().state.game.turn !== callerSeat) errors.push('caller does not lead the first sar');
console.log(`rung called: ${suit} — everyone at 13 cards, caller leads`);
await expectError(host(), { type: 'set_rule', rule: 'aceCannotPick', value: true }, 'rule change mid-game');

/* ---------- play out the deal ---------- */

let moves = 0;
while (host().state.game.phase === 'playing') {
  if (++moves > 52) { errors.push('move limit exceeded'); break; }
  const turn = host().state.game.turn;
  const c = bySeat(turn);
  const before = c.stateCount;
  const legal = c.state.game.legal;
  if (!legal.length) { errors.push(`seat ${turn} has no legal moves`); break; }
  send(c, { type: 'play', card: legal[Math.floor(Math.random() * legal.length)] });
  await until(() => c.stateCount > before, `state after move ${moves}`);
}

const over = host().gameOvers[0];
if (!over) errors.push('no game_over event seen');
else {
  const sars = host().sarEvents;
  if (host().trickWins !== 13) errors.push(`saw ${host().trickWins} trick_won events, expected 13`);
  if (over.tricksWon[0] + over.tricksWon[1] !== 13) errors.push('tricksWon does not sum to 13');
  if (over.tricksWon[over.winnerTeam] < 7) errors.push('winner has fewer than 7 sars');
  // Pakistani double-sar rules: sar 1 always piles up face-up, pickups only
  // from sar 5 (defended, not barred — except the 13th, which takes all),
  // and every sar is eventually collected.
  if (sars[0]?.picked !== 0 || sars[0]?.pileSize !== 1) errors.push('sar 1 was not piled');
  const pickedSum = sars.reduce((sum, ev) => sum + ev.picked, 0);
  if (pickedSum !== 13) errors.push(`pickups sum to ${pickedSum}, expected 13`);
  for (const ev of sars.filter(s => s.picked > 0)) {
    if (ev.hand < 5) errors.push(`pickup on sar ${ev.hand} (before sar 5)`);
    if (ev.hand !== 13 && (!ev.defended || ev.barred)) {
      errors.push(`illegal pickup on sar ${ev.hand} (defended=${ev.defended}, barred=${ev.barred})`);
    }
  }
  for (const ev of sars) {
    if (ev.aceBlocked && ev.picked !== 0) errors.push(`Ace-blocked sar ${ev.hand} still picked up`);
  }
  if (sars[12]?.picked < 1) errors.push('sar 13 header did not take the leftovers');
  const pickups = sars.filter(s => s.picked > 0).map(s => `${s.picked}@${s.hand}`).join(', ');
  console.log(`deal over: team ${over.winnerTeam} wins ${over.tricksWon.join('-')}${over.whitewash ? ' WHITEWASH' : ''} — pickups: ${pickups}`);
}

/* ---------- scoreboard ---------- */

const st = host().state;
if (st.gamesPlayed !== 1) errors.push(`gamesPlayed ${st.gamesPlayed}, expected 1`);
for (const p of st.players) {
  const won = over && p.seat % 2 === over.winnerTeam;
  if (p.stats.games !== 1) errors.push(`${p.name} stats.games ${p.stats.games}`);
  if (p.stats.wins !== (won ? 1 : 0)) errors.push(`${p.name} stats.wins ${p.stats.wins}, expected ${won ? 1 : 0}`);
  if (p.stats.losses !== (won ? 0 : 1)) errors.push(`${p.name} stats.losses ${p.stats.losses}, expected ${won ? 0 : 1}`);
}
console.log('scoreboard ok: team win/loss recorded per player');

/* ---------- rematch: the winning pair chooses the caller ---------- */

// House rules flip between games and must reach the next deal.
send(host(), { type: 'set_rule', rule: 'aceCannotPick', value: true });
await until(() => host().state.gameRules?.aceCannotPick === true, 'ace rule back on');
send(host(), { type: 'set_rule', rule: 'secondAceIsTwo', value: false });
await until(() => host().state.gameRules?.secondAceIsTwo === false, 'double-Ace rule off');
send(host(), { type: 'start' });
await until(() => clients.every(c => c.state?.game?.phase === 'choosing'), 'rematch choosing phase');
const g2 = host().state.game;
if (g2.toss) errors.push('rematch ran a toss despite a clean previous result');
if (!g2.claimants || g2.claimants.some(s => s % 2 !== over.winnerTeam)) {
  errors.push(`claimants ${g2.claimants} are not the winning team (team ${over.winnerTeam})`);
}
for (const c of clients) {
  if (c.state.game.hand.length !== 0) errors.push('rematch dealt cards before the claim');
}
const loser = clients.find(c => c.state.youSeat % 2 !== over.winnerTeam);
await expectError(loser, { type: 'claim_call' }, 'loser claiming the call');
send(bySeat(g2.claimants[1]), { type: 'claim_call' });
await until(() => clients.every(c => c.state.game.phase === 'calling'), 'rematch caller set');
if (host().state.game.caller !== g2.claimants[1]) errors.push('claim did not set the caller');
if (host().state.game.aceRule !== true) errors.push('aceCannotPick=true was not threaded into the rematch');
if (host().state.game.secondAceRule !== false) errors.push('secondAceIsTwo=false was not threaded into the rematch');
console.log(`rematch ok: winners (team ${over.winnerTeam}) chose seat ${g2.claimants[1]} to call`);

/* ---------- dissolve: host aborts, nothing is counted ---------- */

// Any player who is not the host — the "loser" above may BE the host
// (whose dissolve would rightly succeed) whenever the host's team lost.
const nonHost = clients.find(c => !c.state.players.find(p => p.seat === c.state.youSeat)?.isHost);
await expectError(nonHost, { type: 'dissolve' }, 'non-host dissolving');
const gamesBefore = host().state.gamesPlayed;
send(host(), { type: 'dissolve' });
await until(() => clients.every(c => c.state.phase === 'lobby' && !c.state.game), 'dissolved to lobby');
if (host().state.gamesPlayed !== gamesBefore) errors.push('a dissolved game was tallied');
if (host().state.players.length !== 4) errors.push('seats were lost on dissolve');
await expectError(host(), { type: 'dissolve' }, 'dissolving with no game');
console.log('dissolve ok: back to lobby, nothing counted, seats kept');

clients.forEach(c => { try { c.ws.close(); } catch {} });
if (errors.length) { console.log('ERRORS:', errors); process.exit(1); }
console.log('RUNG TEST PASSED: switching, seating, toss, claiming, full deal, stats, dissolve');
process.exit(0);
