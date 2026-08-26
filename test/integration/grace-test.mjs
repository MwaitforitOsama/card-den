// Grace-timer test: (A) a player who disconnects mid-game triggers a grace
// countdown, and after 30s the game restarts with the remaining players.
// (B) a player who reconnects within the window cancels the restart.
// (C) a tokenless rejoin under the same name reclaims the seat (rescue).
const PORT = process.env.PORT ?? 8787;
const BASE = `http://localhost:${PORT}`;
const errors = [];

function client(code, name, token, onMsg) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/${code}`);
  const c = { name, ws, token, state: null };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name, token }));
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'joined') c.token = m.token;
    if (m.type === 'state') c.state = m;
    onMsg && onMsg(c, m);
  };
  return c;
}

async function makeRoom(names, onMsg) {
  const { code } = await (await fetch(BASE + '/api/create', { method: 'POST' })).json();
  const clients = names.map(n => client(code, n, null, onMsg));
  await new Promise(r => {
    const iv = setInterval(() => {
      const host = clients.find(c => c.state && c.state.youSeat === 0);
      if (host && host.state.players.length === names.length) { clearInterval(iv); r(host); }
    }, 100);
  });
  const host = clients.find(c => c.state.youSeat === 0);
  host.ws.send(JSON.stringify({ type: 'start' }));
  await new Promise(r => {
    const iv = setInterval(() => {
      if (host.state.phase === 'playing') { clearInterval(iv); r(); }
    }, 100);
  });
  return { code, clients, host };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* --- Scenario A: drop and stay gone → auto-restart without the player --- */
{
  let sawGrace = false, sawDropped = false, sawRestarted = false;
  const { clients, host } = await makeRoom(['Osama', 'Ali', 'Abu', 'Bilal'], (c, m) => {
    if (m.type !== 'state') return;
    if (m.grace && m.grace.waitingFor.length) sawGrace = true;
    for (const ev of m.events || []) {
      if (ev.type === 'players_dropped') sawDropped = ev.names;
      if (ev.type === 'restarted') sawRestarted = true;
    }
  });
  const victim = clients.find(c => c.state.youSeat !== 0);
  const victimName = victim.name;
  victim.ws.close();
  await sleep(2000);
  if (!sawGrace) errors.push('A: no grace countdown broadcast after disconnect');
  await sleep(31000);
  if (!sawDropped) errors.push('A: players_dropped never fired');
  else if (!sawDropped.includes(victimName)) errors.push(`A: wrong player dropped: ${sawDropped}`);
  if (!sawRestarted) errors.push('A: game did not auto-restart');
  if (host.state.players.length !== 3) errors.push(`A: expected 3 players, got ${host.state.players.length}`);
  if (host.state.phase !== 'playing') errors.push(`A: expected playing, got ${host.state.phase}`);
  // Fresh deal: the A♠ is auto-thrown, so 51 in hands + 1 on the table.
  const total = host.state.players.reduce((s, p) => s + p.cardCount, 0);
  if (total !== 51) errors.push(`A: fresh deal has ${total} cards in hands`);
  if (host.state.game.trick.length !== 1 || host.state.game.trick[0].card !== 'AS') {
    errors.push('A: restarted game did not auto-throw the AS');
  }
  clients.forEach(c => { try { c.ws.close(); } catch {} });
  console.log('scenario A done (drop → auto-restart with 3 players)');
}

/* --- Scenario B: reconnect within the window → no restart --- */
{
  let restarted = false;
  const { code, clients, host } = await makeRoom(['W', 'X', 'Y'], (c, m) => {
    (m.events || []).forEach(ev => { if (ev.type === 'restarted' || ev.type === 'players_dropped') restarted = true; });
  });
  const victim = clients.find(c => c.state.youSeat !== 0);
  const token = victim.token;
  victim.ws.close();
  await sleep(3000);
  if (!host.state.grace || !host.state.grace.waitingFor.length) errors.push('B: grace not active after disconnect');
  const back = client(code, victim.name, token, () => {});
  await sleep(3000);
  if (host.state.grace) errors.push('B: grace not cleared after reconnect');
  await sleep(27000); // past the original deadline
  if (restarted) errors.push('B: game restarted despite reconnect');
  if (host.state.players.length !== 3) errors.push(`B: player count changed to ${host.state.players.length}`);
  clients.forEach(c => { try { c.ws.close(); } catch {} });
  try { back.ws.close(); } catch {}
  console.log('scenario B done (reconnect in time → no restart)');
}

/* --- Scenario C: tokenless same-name rejoin reclaims the seat --- */
{
  let restarted = false;
  const { code, clients, host } = await makeRoom(['Meer', 'Nadir', 'Omar', 'Pasha'], (c, m) => {
    (m.events || []).forEach(ev => { if (ev.type === 'restarted' || ev.type === 'players_dropped') restarted = true; });
  });
  const victim = clients.find(c => c.state.youSeat !== 0);
  const seat = victim.state.youSeat;
  victim.ws.close();
  await sleep(2000);
  const back = client(code, victim.name, null, () => {}); // no token at all
  await sleep(3000);
  if (!back.state || back.state.youSeat !== seat) {
    errors.push(`C: name rescue failed — youSeat ${back.state?.youSeat}, expected ${seat}`);
  }
  if (host.state.grace) errors.push('C: grace not cleared after name rescue');
  // A stranger's name mid-game still becomes a spectator, never a player.
  const stranger = client(code, 'Ghost', null, () => {});
  await sleep(2000);
  if (!stranger.state || stranger.state.youSeat !== -1) errors.push('C: unknown name did not become a spectator');
  if (host.state.players.length !== 4) errors.push(`C: player count changed to ${host.state.players.length}`);
  if (restarted) errors.push('C: game restarted despite the rescue');
  [...clients, back, stranger].forEach(c => { try { c.ws.close(); } catch {} });
  console.log('scenario C done (tokenless same-name rejoin reclaims the seat)');
}

if (errors.length) { console.log('ERRORS:', errors); process.exit(1); }
console.log('GRACE TEST PASSED');
process.exit(0);
