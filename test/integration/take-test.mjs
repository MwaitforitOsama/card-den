// Take-consent test: a take is only a request; the transfer happens when the
// target approves, a decline cancels it (and the asker may re-ask), and the
// asker playing a card cancels a hanging request.
const PORT = process.env.PORT ?? 8787;
const BASE = `http://localhost:${PORT}`;
const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { code } = await (await fetch(BASE + '/api/create', { method: 'POST' })).json();
const events = [];
const clients = [];

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/${code}`);
  const c = { name, ws, state: null };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name }));
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'state') { c.state = m; (m.events || []).forEach(ev => c === clients[0] && events.push(ev)); }
    if (m.type === 'error') errors.push(`${name}: ${m.message}`);
  };
  clients.push(c);
  return c;
}

['P1', 'P2', 'P3', 'P4'].forEach(client);
await sleep(1000);
const host = clients.find(c => c.state && c.state.youSeat === 0);
host.ws.send(JSON.stringify({ type: 'start' }));
await sleep(500);

const bySeat = seat => clients.find(c => c.state.youSeat === seat);
const send = (c, m) => c.ws.send(JSON.stringify(m));

// Play out sarr 1 (forced A♠ + follows) so the sarr-2 leader can take.
while (host.state.game.trickNumber === 1) {
  const turnClient = bySeat(host.state.game.turn);
  send(turnClient, { type: 'play', card: turnClient.state.game.legal[0] });
  await sleep(300);
}

const asker = bySeat(host.state.game.turn);
const targetSeat = asker.state.game.takeTarget;
if (targetSeat === null) { errors.push('leader of sarr 2 has no take target'); }
const target = bySeat(targetSeat);
const targetCards = target.state.players[targetSeat].cardCount;

// 1. Request + decline: nothing transfers, pending clears.
send(asker, { type: 'take' });
await sleep(300);
if (!asker.state.pendingTake) errors.push('no pendingTake after request');
if (!events.some(ev => ev.type === 'take_requested')) errors.push('take_requested not broadcast');
if (target.state.players[targetSeat].cardCount !== targetCards) errors.push('cards moved before approval!');
send(target, { type: 'take_response', approve: false });
await sleep(300);
if (asker.state.pendingTake) errors.push('pendingTake not cleared after decline');
if (!events.some(ev => ev.type === 'take_declined')) errors.push('take_declined not broadcast');
if (target.state.players[targetSeat].cardCount !== targetCards) errors.push('decline still moved cards');

// 2. Re-request immediately (allowed) + approve: transfer happens.
send(asker, { type: 'take' });
await sleep(300);
send(target, { type: 'take_response', approve: true });
await sleep(300);
if (!events.some(ev => ev.type === 'took')) errors.push('approve did not transfer');
if (target.state.players[targetSeat].cardCount !== 0) errors.push('target still has cards');
if (!target.state.players[targetSeat].safe) errors.push('target not Safely Bahar');
if (asker.state.pendingTake) errors.push('pendingTake not cleared after approve');

// 3. A hanging request is cancelled when the asker plays instead.
const asker2 = bySeat(host.state.game.turn);
const t2 = asker2.state.game.takeTarget;
if (t2 !== null) {
  send(asker2, { type: 'take' });
  await sleep(300);
  if (!asker2.state.pendingTake) errors.push('second request not pending');
  send(asker2, { type: 'play', card: asker2.state.game.legal[0] });
  await sleep(300);
  if (asker2.state.pendingTake) errors.push('playing a card did not cancel the request');
} else {
  errors.push('no take target for scenario 3 (unexpected with 3 active players)');
}

clients.forEach(c => { try { c.ws.close(); } catch {} });
if (errors.length) { console.log('ERRORS:', errors); process.exit(1); }
console.log('TAKE-CONSENT TEST PASSED: decline blocks, approve transfers, playing cancels');
process.exit(0);
