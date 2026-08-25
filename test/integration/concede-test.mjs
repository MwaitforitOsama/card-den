// Concede flow test: 3 players play until one is safe (head-to-head left),
// then the full consent choreography runs — early concede rejected, offer
// broadcast, wrong responder rejected, decline, re-offer, approval ends the
// game with the conceder as bhabhi.
const PORT = process.env.PORT ?? 8787;
const BASE = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = [];

const { code } = await (await fetch(BASE + '/api/create', { method: 'POST' })).json();
console.log('room:', code);

let stateCount = 0;
const clients = [];

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/${code}`);
  const c = { name, ws, state: null, errors: [], events: [] };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name }));
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'state') {
      c.state = m;
      stateCount++;
      (m.events || []).forEach(ev => c.events.push(ev));
    }
    if (m.type === 'error') c.errors.push(m.message);
  };
  clients.push(c);
  return c;
}

async function until(pred, what, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(25);
  }
  fail.push(`timed out waiting for: ${what}`);
  return false;
}

const bySeat = seat => clients.find(c => c.state?.youSeat === seat);

// One move at a time, driven centrally, so no plays are ever in flight when
// the choreography below inspects the state.
async function playOneMove() {
  const actor = clients.find(c => {
    const g = c.state?.game;
    return g && g.phase === 'playing' && g.turn === c.state.youSeat && g.legal.length;
  });
  if (!actor) return;
  const g = actor.state.game;
  const card = g.legal[Math.floor(Math.random() * g.legal.length)];
  const before = stateCount;
  actor.ws.send(JSON.stringify({ type: 'play', card }));
  await until(() => stateCount > before, 'state after a play', 3000);
}

const [a, b, c] = [client('A'), client('B'), client('C')];
await until(() => clients.every(cl => cl.state?.players.length === 3), 'all seated');
const host = clients.find(cl => cl.state.youSeat === 0);
host.ws.send(JSON.stringify({ type: 'start' }));
await until(() => clients.every(cl => cl.state.game?.phase === 'playing'), 'game started');

// Conceding with 3 players still in is refused.
const earlyErrs = a.errors.length;
a.ws.send(JSON.stringify({ type: 'concede' }));
await until(() => a.errors.length > earlyErrs, 'early concede rejected');
if (!a.errors.some(m => m.includes('two players'))) fail.push(`early concede error wrong: ${a.errors}`);

// Play (restarting if a game ends without a head-to-head stage) until
// exactly one player is safe while the game is still running.
const headToHead = () => {
  const s = host.state;
  return s.game?.phase === 'playing' && s.players.filter(p => p.safe).length === 1;
};
for (let moves = 0; !headToHead(); moves++) {
  if (moves > 2000) { fail.push('never reached a head-to-head stage'); break; }
  if (host.state.phase === 'over') {
    const before = stateCount;
    host.ws.send(JSON.stringify({ type: 'start' }));
    await until(() => stateCount > before && host.state.game?.phase === 'playing', 'restart');
    continue;
  }
  await playOneMove();
}

if (!fail.length) {
  const safeSeat = host.state.players.find(p => p.safe).seat;
  const active = host.state.players.filter(p => !p.safe).map(p => p.seat);
  const conceder = bySeat(active[0]);
  const winner = bySeat(active[1]);
  const safe = bySeat(safeSeat);
  console.log(`head-to-head: seats ${active.join(' vs ')}, seat ${safeSeat} safe`);

  // Both remaining players see the concede option; the safe player doesn't.
  if (!conceder.state.game.youCanConcede) fail.push('conceder does not see youCanConcede');
  if (!winner.state.game.youCanConcede) fail.push('other active player does not see youCanConcede');
  if (safe.state.game.youCanConcede) fail.push('safe player sees youCanConcede');

  // The offer reaches everyone.
  conceder.ws.send(JSON.stringify({ type: 'concede' }));
  await until(() => clients.every(cl => cl.state.pendingConcede?.seat === conceder.state.youSeat),
    'concede offer broadcast');
  if (host.state.pendingConcede?.winner !== winner.state.youSeat) fail.push('offer names wrong winner');

  // Only the winner may answer it.
  const safeErrs = safe.errors.length;
  safe.ws.send(JSON.stringify({ type: 'concede_response', approve: true }));
  await until(() => safe.errors.length > safeErrs, 'safe player response rejected');
  if (host.state.phase === 'over') fail.push('safe player ended the game');

  // Decline: game continues, offer cleared, and it can be re-made.
  winner.ws.send(JSON.stringify({ type: 'concede_response', approve: false }));
  await until(() => clients.every(cl => cl.state.pendingConcede === null), 'decline clears the offer');
  if (!winner.events.some(ev => ev.type === 'concede_declined')) fail.push('no concede_declined event');
  if (host.state.game.phase !== 'playing') fail.push('decline ended the game');

  // Re-offer, approve: game over, conceder is the bhabhi, opponent wins.
  conceder.ws.send(JSON.stringify({ type: 'concede' }));
  await until(() => winner.state.pendingConcede?.winner === winner.state.youSeat, 're-offer arrives');
  winner.ws.send(JSON.stringify({ type: 'concede_response', approve: true }));
  await until(() => clients.every(cl => cl.state.phase === 'over'), 'approval ends the game');
  const g = host.state.game;
  if (g.bhabhi !== conceder.state.youSeat) fail.push(`bhabhi is seat ${g.bhabhi}, expected the conceder`);
  if (!host.state.players.find(p => p.seat === winner.state.youSeat)?.safe) fail.push('winner not marked safe');
  if (!host.events.some(ev => ev.type === 'conceded' && ev.winner === winner.state.youSeat)) {
    fail.push('no conceded event with the right winner');
  }
  if (host.state.pendingConcede !== null) fail.push('offer not cleared after game over');
}

clients.forEach(cl => { try { cl.ws.close(); } catch {} });
if (fail.length) { console.log('ERRORS:', fail); process.exit(1); }
console.log('CONCEDE TEST PASSED: consent flow, decline, and dissolve verdict all correct');
process.exit(0);
