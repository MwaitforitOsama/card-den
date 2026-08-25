// Spectator test: a mid-game joiner watches (no seat, no hand, public state
// only), can chat, and is dealt in automatically when the game ends.
const PORT = process.env.PORT ?? 8787;
const BASE = `http://localhost:${PORT}`;
const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { code } = await (await fetch(BASE + '/api/create', { method: 'POST' })).json();
const clients = [];
let gameOver = false;
let seatedEvent = null;
let done;
const finished = new Promise(r => (done = r));

function client(name, autoplay) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/${code}`);
  const c = { name, ws, state: null, chats: [] };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name }));
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'chat') c.chats.push(m.message);
    if (m.type === 'error') errors.push(`${name}: ${m.message}`);
    if (m.type !== 'state') return;
    c.state = m;
    for (const ev of m.events || []) {
      if (ev.type === 'spectators_seated') seatedEvent = ev;
      if (ev.type === 'game_over' && !gameOver) { gameOver = true; setTimeout(done, 600); }
    }
    const g = m.game;
    if (!autoplay || !g || g.phase !== 'playing') return;
    if (m.pendingTake) return;
    if (m.youSeat === g.turn && g.legal.length) {
      setTimeout(() => ws.send(JSON.stringify({
        type: 'play', card: g.legal[Math.floor(Math.random() * g.legal.length)],
      })), 5);
    }
  };
  clients.push(c);
  return c;
}

['P1', 'P2', 'P3'].forEach(n => client(n, false));
await sleep(1000);
const host = clients.find(c => c.state && c.state.youSeat === 0);
host.ws.send(JSON.stringify({ type: 'start' }));
await sleep(500);

// The 4th friend arrives mid-game → must become a watcher, not an error.
const watcher = client('Late', false);
await sleep(1000);
if (!watcher.state) errors.push('watcher got no state (join rejected?)');
else {
  if (watcher.state.youSeat !== -1) errors.push(`watcher has a seat: ${watcher.state.youSeat}`);
  if (watcher.state.game.hand.length !== 0) errors.push('watcher has cards');
  if (watcher.state.players.length !== 3) errors.push('player count changed by watching');
  if (!watcher.state.spectators.some(s => s.name === 'Late')) errors.push('watcher not in spectators list');
}
// Watchers cannot play but can chat.
watcher.ws.send(JSON.stringify({ type: 'play', card: 'AS' }));
await sleep(300);
const playRejected = errors.some(e => e.startsWith('Late:'));
if (!playRejected) errors.push('watcher was allowed to play');
else errors.splice(errors.findIndex(e => e.startsWith('Late:')), 1); // expected rejection
watcher.ws.send(JSON.stringify({ type: 'chat', text: 'saved a seat for me?' }));
await sleep(300);
if (!host.chats.some(m => m.name === 'Late')) errors.push('watcher chat not delivered');

// Let the game play out; on game over the watcher must be seated.
clients.slice(0, 3).forEach(c => { c.autoplay = true; });
// (autoplay flag was captured at creation — re-wire by nudging the turn holder)
const timeout = setTimeout(() => { errors.push('TIMEOUT waiting for game over'); done(); }, 60000);
const pump = setInterval(() => {
  const turnC = clients.find(c => c.state && c.state.game && c.state.game.phase === 'playing'
    && c.state.youSeat === c.state.game.turn && !c.state.pendingTake);
  if (turnC && turnC.state.game.legal.length) {
    turnC.ws.send(JSON.stringify({
      type: 'play', card: turnC.state.game.legal[Math.floor(Math.random() * turnC.state.game.legal.length)],
    }));
  }
}, 60);
await finished;
clearTimeout(timeout);
clearInterval(pump);

if (!seatedEvent) errors.push('spectators_seated never fired');
else if (!seatedEvent.names.includes('Late')) errors.push('watcher not among the seated');
await sleep(300);
if (host.state.players.length !== 4) errors.push(`expected 4 players after game over, got ${host.state.players.length}`);
if (watcher.state.youSeat < 0) errors.push('watcher still has no seat after game over');

// Rematch deals the former watcher in: 4 hands of 13.
host.ws.send(JSON.stringify({ type: 'start' }));
await sleep(600);
const counts = host.state.players.map(p => p.cardCount).sort((a, b) => a - b);
if (host.state.phase !== 'playing') errors.push('rematch did not start');
// 4 players get 13 each, minus the auto-thrown A♠ from its holder's hand.
if (JSON.stringify(counts) !== JSON.stringify([12, 13, 13, 13])) {
  errors.push(`expected 12,13,13,13 cards, got ${counts}`);
}

clients.forEach(c => { try { c.ws.close(); } catch {} });
if (errors.length) { console.log('ERRORS:', errors); process.exit(1); }
console.log('SPECTATE TEST PASSED: watch mid-game, chat, auto-seat at game end, dealt into rematch');
process.exit(0);
