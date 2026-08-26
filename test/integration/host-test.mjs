// Host-migration test: when the room creator disconnects, the host role
// (start / play-again rights) follows the first connected player, so the
// remaining players are never stuck.
const PORT = process.env.PORT ?? 8787;
const BASE = `http://localhost:${PORT}`;
const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { code } = await (await fetch(BASE + '/api/create', { method: 'POST' })).json();
const clients = [];

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/${code}`);
  const c = { name, ws, state: null };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name }));
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'state') c.state = m;
  };
  clients.push(c);
  return c;
}

['P1', 'P2', 'P3', 'P4'].forEach(client);
await sleep(1000);
const creator = clients.find(c => c.state && c.state.youSeat === 0);
creator.ws.send(JSON.stringify({ type: 'start' }));
await sleep(500);

if (!creator.state.players[0].isHost) errors.push('creator not host at start');

// The room creator vanishes mid-game.
creator.ws.close();
await sleep(2000);

const other = clients.find(c => c !== creator);
const hosts = other.state.players.filter(p => p.isHost);
if (hosts.length !== 1) errors.push(`expected exactly 1 host, got ${hosts.length}`);
else {
  if (hosts[0].seat !== 1) errors.push(`host should migrate to seat 1, got seat ${hosts[0].seat}`);
  if (!hosts[0].connected) errors.push('migrated host is not a connected player');
}

// After the grace period the game restarts among the remaining three, and
// the new seat 0 (a connected player) holds the host role.
await sleep(31000);
if (other.state.players.length !== 3) errors.push(`expected 3 players after restart, got ${other.state.players.length}`);
if (other.state.phase !== 'playing') errors.push(`expected playing after restart, got ${other.state.phase}`);
if (!other.state.players[0]?.isHost) errors.push('seat 0 is not host after restart');

clients.forEach(c => { try { c.ws.close(); } catch {} });
if (errors.length) { console.log('ERRORS:', errors); process.exit(1); }
console.log('HOST-MIGRATION TEST PASSED: badge migrates on disconnect, restart re-anchors it');
process.exit(0);
