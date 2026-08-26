// Bot test: 3 clients + the host-added bot play a full Rung deal. The bot
// moves by itself (legally, after its ~3s thinking pause — so this test
// spends most of its runtime waiting on Botta); the host can eject it
// anytime — mid-game ejection dissolves the deal — and switching the room
// to Thulla sends it home automatically.
const PORT = process.env.PORT ?? 8787;
const BASE = `http://localhost:${PORT}`;

const res = await fetch(BASE + '/api/create?game=rung', { method: 'POST' });
const { code } = await res.json();
console.log('room:', code);

const NAMES = ['Hanzalah', 'Ali', 'Usman'];
const errors = [];
const clients = NAMES.map(makeClient);

function makeClient(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/${code}`);
  const c = { name, ws, token: null, state: null, stateCount: 0, lastError: null, trickWins: 0, gameOvers: [] };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name, token: null }));
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'joined') c.token = msg.token;
    else if (msg.type === 'error') c.lastError = msg.message;
    else if (msg.type === 'state') {
      c.state = msg;
      c.stateCount++;
      for (const ev of msg.events || []) {
        if (ev.type === 'trick_won') c.trickWins++;
        if (ev.type === 'game_over') c.gameOvers.push(ev);
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

const send = (c, msg) => c.ws.send(JSON.stringify(msg));

async function expectError(c, msg, what) {
  c.lastError = null;
  send(c, msg);
  await until(() => c.lastError !== null, `error for ${what}`);
  console.log(`rejected ok (${what}): ${c.lastError}`);
}

const bySeat = seat => clients.find(c => c.state?.youSeat === seat);
const host = () => clients.find(c => c.state?.players?.[c.state.youSeat]?.isHost);
const isHumanSeat = seat => clients.some(c => c.state?.youSeat === seat);

// Drive the deal: humans act when it's their decision; the bot's moves
// just arrive on their own.
async function playDeal() {
  let moves = 0;
  for (;;) {
    await until(() => {
      const st = host().state;
      if (st.phase !== 'playing') return true;
      const g = st.game;
      if (g.phase === 'choosing') return g.claimants.some(isHumanSeat);
      if (g.phase === 'calling') return isHumanSeat(g.caller);
      return isHumanSeat(g.turn);
    }, 'a human decision or game end');
    const st = host().state;
    if (st.phase !== 'playing') return;
    const g = st.game;
    if (g.phase === 'choosing') {
      const c = bySeat(g.claimants.find(isHumanSeat));
      const before = c.stateCount;
      send(c, { type: 'claim_call' });
      await until(() => c.stateCount > before, 'claim applied');
    } else if (g.phase === 'calling') {
      const c = bySeat(g.caller);
      const counts = {};
      for (const card of c.state.game.hand) counts[card[1]] = (counts[card[1]] ?? 0) + 1;
      const suit = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      const before = c.stateCount;
      send(c, { type: 'call_trump', suit });
      await until(() => c.stateCount > before, 'trump applied');
    } else {
      if (++moves > 60) throw new Error('human move limit exceeded');
      const c = bySeat(g.turn);
      const legal = c.state.game.legal;
      const before = c.stateCount;
      send(c, { type: 'play', card: legal[Math.floor(Math.random() * legal.length)] });
      await until(() => c.stateCount > before, 'move applied');
    }
  }
}

/* ---------- add the bot ---------- */

await until(() => clients.every(c => c.state?.players?.length === 3), 'all humans seated');
const nonHost = clients.find(c => c !== host());
await expectError(nonHost, { type: 'add_bot' }, 'non-host adding the bot');
send(host(), { type: 'add_bot' });
await until(() => host().state.players.length === 4, 'bot seated');
const bot = host().state.players.find(p => p.isBot);
if (!bot) errors.push('no player flagged as bot');
if (!bot?.connected) errors.push('bot shows as disconnected');
if (bot?.peerId) errors.push('bot has a voice peerId');
await expectError(host(), { type: 'add_bot' }, 'second bot');
console.log(`bot seated: ${bot?.name} at seat ${bot?.seat}`);

/* ---------- a full deal with the bot playing ---------- */

send(host(), { type: 'start' });
await until(() => host().state.phase === 'playing', 'deal underway');
await playDeal();
const over = host().gameOvers[0];
if (!over) errors.push('no game_over seen');
else if (over.tricksWon[0] + over.tricksWon[1] !== 13) errors.push('tricksWon does not sum to 13');
if (host().trickWins !== 13) errors.push(`saw ${host().trickWins} sars, expected 13`);
const botStats = host().state.players.find(p => p.isBot)?.stats;
if (botStats?.games !== 1) errors.push(`bot stats.games ${botStats?.games}, expected 1`);
if (host().state.grace) errors.push('grace timer ran with a bot seated');
console.log(`deal over with bot: ${over?.tricksWon.join('-')} — bot on the scoreboard`);

/* ---------- mid-game ejection dissolves the deal ---------- */

send(host(), { type: 'start' });
await until(() => host().state.phase === 'playing', 'second deal underway');
await expectError(nonHost, { type: 'remove_bot' }, 'non-host removing the bot');
const gamesBefore = host().state.gamesPlayed;
send(host(), { type: 'remove_bot' });
await until(() => host().state.phase === 'lobby' && host().state.players.length === 3, 'bot ejected, game dissolved');
if (host().state.gamesPlayed !== gamesBefore) errors.push('dissolved game was tallied');
console.log('mid-game ejection ok: deal dissolved, nothing counted');

/* ---------- switching to thulla sends the bot home ---------- */

send(host(), { type: 'add_bot' });
await until(() => host().state.players.length === 4, 'bot re-seated');
send(host(), { type: 'set_game', game: 'thulla' });
await until(() => host().state.gameId === 'thulla' && host().state.players.length === 3, 'bot left on switch');
await expectError(host(), { type: 'remove_bot' }, 'removing an absent bot');
await expectError(host(), { type: 'add_bot' }, 'adding a bot to thulla');
console.log('thulla switch ok: bot auto-removed, no thulla bot');

clients.forEach(c => { try { c.ws.close(); } catch {} });
if (errors.length) { console.log('ERRORS:', errors); process.exit(1); }
console.log('BOT TEST PASSED: seating, full deal, ejection, thulla switch');
process.exit(0);
