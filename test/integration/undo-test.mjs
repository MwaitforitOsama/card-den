// Undo test: a played card can be taken back within the window, the next
// player's throw locks it, and locked/expired undos are rejected.
const PORT = process.env.PORT ?? 8787;
const BASE = `http://localhost:${PORT}`;
const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { code } = await (await fetch(BASE + '/api/create', { method: 'POST' })).json();
const clients = [];

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/${code}`);
  const c = { name, ws, state: null, errors: [] };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name }));
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'state') c.state = m;
    if (m.type === 'error') c.errors.push(m.message);
  };
  clients.push(c);
  return c;
}

['P1', 'P2', 'P3'].forEach(client);
await sleep(1000);
const host = clients.find(c => c.state && c.state.youSeat === 0);
host.ws.send(JSON.stringify({ type: 'start' }));
await sleep(500);

const bySeat = seat => clients.find(c => c.state.youSeat === seat);
const send = (c, m) => c.ws.send(JSON.stringify(m));

// The A♠ opening is auto-thrown by the server, with no undo window.
if (host.state.game.trick.length !== 1 || host.state.game.trick[0].card !== 'AS') {
  errors.push('AS was not auto-thrown at game start');
}
if (host.state.game.undo) errors.push('auto-thrown AS has an undo window');
if (host.state.game.turn === host.state.game.leader) errors.push('turn did not advance past the AS holder');

// Sarr 1 is forced/special — play it out.
while (host.state.game.trickNumber === 1) {
  const t = bySeat(host.state.game.turn);
  send(t, { type: 'play', card: t.state.game.legal[0] });
  await sleep(250);
}

// Sarr 2: the leader plays, then changes their mind.
const leader = bySeat(host.state.game.turn);
const before = leader.state.game.hand.length;
const firstChoice = leader.state.game.legal[0];
send(leader, { type: 'play', card: firstChoice });
await sleep(300);
const u = leader.state.game.undo;
if (!u || u.seat !== leader.state.youSeat) errors.push('no undo window after playing');
if (u && (u.remainingMs <= 8000 || u.remainingMs > 10000)) errors.push(`odd undo window: ${u.remainingMs}ms`);
send(leader, { type: 'undo' });
await sleep(300);
if (leader.state.game.hand.length !== before) errors.push('undo did not return the card');
if (!leader.state.game.hand.includes(firstChoice)) errors.push('returned card missing from hand');
if (leader.state.game.trick.length !== 0) errors.push('trick not empty after leader undo');
if (leader.state.game.turn !== leader.state.youSeat) errors.push('turn did not return to the undoer');
if (leader.state.game.ledSuit !== null) errors.push('led suit not reset after leader undo');

// Play again; the follower's throw locks it.
send(leader, { type: 'play', card: leader.state.game.legal[0] });
await sleep(300);
const follower = bySeat(host.state.game.turn);
send(follower, { type: 'play', card: follower.state.game.legal[0] });
await sleep(300);
send(leader, { type: 'undo' });
await sleep(300);
if (!leader.errors.some(e => e.includes('Too late'))) errors.push('locked undo was not rejected');
if (leader.state.game.trick.length !== 2) errors.push('locked undo changed the trick');

// A player with no pending play cannot undo either.
const third = clients.find(c => c !== leader && c !== follower);
send(third, { type: 'undo' });
await sleep(300);
if (!third.errors.some(e => e.includes('Too late'))) errors.push('undo without a play was not rejected');

clients.forEach(c => { try { c.ws.close(); } catch {} });
if (errors.length) { console.log('ERRORS:', errors); process.exit(1); }
console.log('UNDO TEST PASSED: take-back works, next throw locks, invalid undos rejected');
process.exit(0);
