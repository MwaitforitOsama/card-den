// Sarrein house-rule test (Thulla): the switch is OFF by default, host-only
// and between-games-only; with it ON, real games are played out over the
// sockets until a Sarrein happens (≈17% of random games), and the duel is
// checked end to end — face-down slots never leak cards, only the picker
// can pick, picks validate and can't be undone, nobody can concede, and
// the verdict lands on the scoreboard.
const PORT = process.env.PORT ?? 8787;
const BASE = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = [];
const MAX_GAMES = 60;

const { code } = await (await fetch(BASE + '/api/create', { method: 'POST' })).json();
console.log('room:', code);

let stateCount = 0;
const clients = [];

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/${code}`);
  const c = { name, ws, state: null, errors: [], events: [], raw: [] };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name }));
  ws.onmessage = e => {
    c.raw.push(e.data);
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
    await sleep(15);
  }
  fail.push(`timed out waiting for: ${what}`);
  return false;
}

async function send(c, msg, what) {
  const before = stateCount;
  const errs = c.errors.length;
  c.ws.send(JSON.stringify(msg));
  await until(() => stateCount > before || c.errors.length > errs, what, 3000);
  return c.errors.length > errs ? c.errors.at(-1) : null;
}

const bySeat = seat => clients.find(c => c.state?.youSeat === seat);
const host = () => clients.find(c => c.state?.players.find(p => p.seat === c.state.youSeat)?.isHost);

const [a] = [client('A'), client('B'), client('C')];
await until(() => clients.every(c => c.state?.players.length === 3), 'all 3 seated');

/* ---------- the switch ---------- */

if (a.state.gameRules?.sarrein !== undefined) fail.push('sarrein should be unset (default OFF) in a new room');
const nonHost = clients.find(c => c !== host());
let err = await send(nonHost, { type: 'set_rule', rule: 'sarrein', value: true }, 'non-host set_rule');
if (!/Only the host/.test(err ?? '')) fail.push(`non-host flip should be rejected, got: ${err}`);
err = await send(host(), { type: 'set_rule', rule: 'sarrein', value: true }, 'host set_rule');
if (err) fail.push(`host flip failed: ${err}`);
await until(() => clients.every(c => c.state.gameRules?.sarrein === true), 'everyone sees Sarrein ON');
if (!clients.every(c => c.events.some(ev => ev.type === 'rule_changed' && ev.rule === 'sarrein' && ev.value))) {
  fail.push('rule_changed event not broadcast to everyone');
}

/* ---------- play until a Sarrein ---------- */

let checkedDuel = false;
let games = 0;
let sarreinGames = 0;

async function startGame() {
  const h = host();
  const e = await send(h, { type: 'start' }, 'start');
  if (e) fail.push(`start failed: ${e}`);
  await until(() => clients.every(c => c.state?.phase === 'playing'), 'game playing');
  if (games === 0) {
    const e2 = await send(h, { type: 'set_rule', rule: 'sarrein', value: false }, 'mid-game set_rule');
    if (!/between games/.test(e2 ?? '')) fail.push(`mid-game flip should be rejected, got: ${e2}`);
  }
  games++;
}

// The first time a duel is live, poke at every guard before playing it out.
async function inspectDuel(g) {
  const picker = bySeat(g.sarrein.picker);
  const holder = bySeat(g.sarrein.holder);
  const holderCards = holder.state.game.hand;
  if (holderCards.length !== g.sarrein.slots) fail.push('slot count ≠ holder hand size');
  if (holderCards.length < 2) fail.push('a Sarrein round started with the holder on < 2 cards');
  for (const c of clients) {
    const v = c.state.game;
    if (v.youPick !== (c === picker)) fail.push(`${c.name}: youPick wrong`);
    if (v.youCanConcede) fail.push(`${c.name}: concede offered during Sarrein`);
    // The latest raw state any non-holder received must not contain the holder's cards.
    if (c !== holder) {
      const last = c.raw.findLast(r => r.includes('"type":"state"'));
      for (const card of holderCards) {
        if (last.includes(`"${card}"`) && !JSON.parse(last).game.trick.some(t => t.card === card)) {
          fail.push(`${c.name} can see the holder's ${card}`);
        }
      }
    }
  }
  if (picker.state.players.find(p => p.seat === picker.state.youSeat).cardCount !== 0) {
    fail.push('picker should hold no cards');
  }
  let e = await send(holder, { type: 'sarrein_pick', slot: 0 }, 'holder tries to pick');
  if (!/Not your pick/.test(e ?? '')) fail.push(`holder pick should fail, got: ${e}`);
  e = await send(picker, { type: 'sarrein_pick', slot: g.sarrein.slots }, 'out-of-range pick');
  if (!/face-down/.test(e ?? '')) fail.push(`bad slot should fail, got: ${e}`);
  e = await send(holder, { type: 'concede' }, 'concede during Sarrein');
  if (!/only concede/.test(e ?? '')) fail.push(`concede should fail, got: ${e}`);
  e = await send(picker, { type: 'sarrein_pick', slot: 0 }, 'real pick');
  if (e) fail.push(`valid pick failed: ${e}`);
  const pick = picker.events.findLast(ev => ev.type === 'played' && ev.blind);
  if (!pick) fail.push('no blind played event');
  else if (!clients.every(c => c.state.game.trick.some(t => t.card === pick.card && t.blind))) {
    fail.push('picked card not face up on everyone\'s table');
  }
  e = await send(picker, { type: 'undo' }, 'undo the pick');
  if (!/Too late/.test(e ?? '')) fail.push(`undo of a pick should fail, got: ${e}`);
  checkedDuel = true;
}

async function playOneMove() {
  const actor = clients.find(c => {
    const g = c.state?.game;
    return g && g.phase === 'playing' && g.turn === c.state.youSeat && (g.legal.length || g.youPick);
  });
  if (!actor) { await sleep(20); return; }
  const g = actor.state.game;
  if (g.youPick) {
    if (!checkedDuel) return inspectDuel(g);
    const e = await send(actor, { type: 'sarrein_pick', slot: Math.floor(Math.random() * g.sarrein.slots) }, 'pick');
    if (e) fail.push(`pick failed: ${e}`);
    return;
  }
  const e = await send(actor, { type: 'play', card: g.legal[Math.floor(Math.random() * g.legal.length)] }, 'play');
  if (e) fail.push(`play failed: ${e}`);
}

// Keep playing until a duel with at least one real pick has been checked.
while (games < MAX_GAMES && !checkedDuel && fail.length === 0) {
  await startGame();
  let guard = 0;
  while (a.state.phase === 'playing' && guard++ < 400) await playOneMove();
  await until(() => clients.every(c => c.state.phase === 'over'), 'game over');
  const g = a.state.game;
  if (g.sarreinResult) {
    sarreinGames++;
    const { winner, loser, reason } = g.sarreinResult;
    console.log(`game ${games}: Sarrein decided — winner seat ${winner}, loser seat ${loser} (${reason})`);
    if (g.bhabhi !== loser) fail.push('bhabhi ≠ Sarrein loser');
    if (!a.events.some(ev => ev.type === 'sarrein_started')) fail.push('no sarrein_started event');
    const loserStats = a.state.players.find(p => p.seat === loser).stats;
    if (loserStats.losses < 1) fail.push('Sarrein loser not tallied on the scoreboard');
    if (reason !== 'one_card' && !checkedDuel) fail.push('a pick happened without the guard checks');
  }
}

if (!sarreinGames) fail.push(`no Sarrein in ${games} games (expected ≈17% each)`);
else if (!checkedDuel) fail.push(`Sarrein only ever ended on the one-card rule in ${games} games`);

clients.forEach(c => { try { c.ws.close(); } catch {} });
if (fail.length) { console.log('FAILURES:', fail); process.exit(1); }
console.log(`SARREIN TEST PASSED: switch host-only/between games, duel guards hold, verdict recorded (${games} game(s), ${sarreinGames} Sarrein)`);
process.exit(0);
