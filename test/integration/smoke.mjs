// End-to-end smoke test: 4 WebSocket clients create a room, join, start,
// and auto-play random legal moves until the game ends. Then one client
// reconnects with its token to verify seat reclaim and a rematch is played.
const PORT = process.env.PORT ?? 8787;
const BASE = `http://localhost:${PORT}`;

const res = await fetch(BASE + '/api/create', { method: 'POST' });
const { code } = await res.json();
console.log('room:', code);

const NAMES = ['Hanzalah', 'Ali', 'Usman', 'Bilal'];
const clients = [];
let gameOverCount = 0;
let decisiveGames = 0; // finished with a bhabhi (not a draw)
let eventsSeen = new Set();
let errors = [];
let moves = 0;
let startSent = 0;
let reconnectDone = false;
let done;
const finished = new Promise(r => (done = r));

function isHost(c) {
  const s = c.state;
  return s && s.youSeat === 0;
}

function makeClient(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/${code}`);
  const c = { name, ws, token: null, state: null };
  wire(c, ws);
  return c;
}

function wire(c, ws) {
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name: c.name, token: c.token }));
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'joined') {
      const reclaimed = c.token === msg.token;
      c.token = msg.token;
      if (c.expectReclaim) {
        if (!reclaimed) errors.push('reconnect did not reclaim seat');
        else console.log('reconnect ok: seat reclaimed');
        c.expectReclaim = false;
      }
    } else if (msg.type === 'error') {
      errors.push(`${c.name}: ${msg.message}`);
    } else if (msg.type === 'state') {
      c.state = msg;
      (msg.events || []).forEach(ev => eventsSeen.add(ev.type));
      const over = (msg.events || []).find(ev => ev.type === 'game_over');
      if (over && isHost(c)) {
        gameOverCount++;
        if (over.bhabhi !== null) decisiveGames++;
        console.log(`game ${gameOverCount} over, bhabhi seat: ${over.bhabhi}, after ${moves} moves`);
        if (gameOverCount === 1) rematchWithReconnect();
        else done();
      }
      // Host starts the first game once everyone is seated.
      if (isHost(c) && msg.phase === 'lobby' && msg.players.length === 4 && startSent === 0) {
        startSent++;
        c.ws.send(JSON.stringify({ type: 'start' }));
      }
      act(c, msg);
    }
  };
}

function act(c, msg) {
  const g = msg.game;
  if (!g || g.phase !== 'playing') return;
  // Takes need consent now: approve any request aimed at us.
  if (msg.pendingTake && msg.pendingTake.target === msg.youSeat) {
    setTimeout(() => c.ws.send(JSON.stringify({ type: 'take_response', approve: Math.random() < 0.7 })), 5);
    return;
  }
  if (msg.youSeat !== g.turn) return;
  if (msg.pendingTake) return; // our own request is pending; wait for the answer
  moves++;
  if (moves > 3000) { errors.push('move limit exceeded'); return done(); }
  setTimeout(() => {
    if (g.takeTarget !== null && g.takeTarget !== undefined && Math.random() < 0.03) {
      c.ws.send(JSON.stringify({ type: 'take' }));
      return;
    }
    if (g.legal.length) {
      const card = g.legal[Math.floor(Math.random() * g.legal.length)];
      c.ws.send(JSON.stringify({ type: 'play', card }));
    }
  }, 5);
}

function rematchWithReconnect() {
  if (reconnectDone) return;
  reconnectDone = true;
  // A non-host player drops and reconnects with their token, then host restarts.
  const c = clients.find(cl => cl.state && cl.state.youSeat !== 0);
  c.ws.close();
  setTimeout(() => {
    c.expectReclaim = true;
    const ws2 = new WebSocket(`ws://localhost:${PORT}/ws/${code}`);
    c.ws = ws2;
    wire(c, ws2);
    setTimeout(() => {
      moves = 0;
      const host = clients.find(cl => isHost(cl));
      console.log('starting rematch');
      host.ws.send(JSON.stringify({ type: 'start' }));
    }, 500);
  }, 300);
}

// Also verify a bad room code is rejected cleanly.
const badWs = new WebSocket(`ws://localhost:${PORT}/ws/ZZZZ`);
badWs.onopen = () => badWs.send(JSON.stringify({ type: 'join', name: 'ghost' }));
badWs.onmessage = e => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'error' && msg.fatal) { console.log('bad-code rejection ok:', msg.message); badWs.close(); }
  else errors.push('bad room code was not rejected');
};

NAMES.forEach(n => clients.push(makeClient(n)));

const timeout = setTimeout(() => { errors.push('TIMEOUT'); done(); }, 60000);
await finished;
clearTimeout(timeout);
clients.forEach(c => { try { c.ws.close(); } catch {} });

// Session scoreboard: both games counted, the reconnecting player's stats
// survived (same token), and losses add up to the decisive games.
const st = clients.find(cl => isHost(cl)).state;
if (st.gamesPlayed !== 2) errors.push(`gamesPlayed is ${st.gamesPlayed}, expected 2`);
for (const p of st.players) {
  if (p.stats?.games !== 2) errors.push(`${p.name} has stats.games ${p.stats?.games}, expected 2`);
}
const lossSum = st.players.reduce((sum, p) => sum + (p.stats?.losses ?? 0), 0);
if (lossSum !== decisiveGames) errors.push(`loss total ${lossSum} != decisive games ${decisiveGames}`);
console.log(`scoreboard ok: ${st.gamesPlayed} games, losses ${st.players.map(p => p.stats.losses).join('/')}`);

console.log('events seen:', [...eventsSeen].sort().join(', '));
const expected = ['played', 'trick_won', 'safe', 'game_over', 'started'];
for (const ev of expected) if (!eventsSeen.has(ev)) errors.push(`event never seen: ${ev}`);
if (errors.length) { console.log('ERRORS:', errors); process.exit(1); }
console.log('SMOKE TEST PASSED: two full games incl. reconnect + rematch');
process.exit(0);
