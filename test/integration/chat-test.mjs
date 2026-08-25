// Chat test against the live server: 3 clients join, chat, verify broadcast
// + history on a fresh join.
const PORT = process.env.PORT ?? 8787;
const BASE = `http://localhost:${PORT}`;
const { code } = await (await fetch(BASE + '/api/create', { method: 'POST' })).json();
const errors = [];
let done; const finished = new Promise(r => (done = r));
const received = { Ali: [], Bilal: [] };

function client(name, onMsg) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/${code}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name }));
  ws.onmessage = e => onMsg(ws, JSON.parse(e.data));
  return ws;
}

let joined = 0;
const check = () => {
  if (++joined === 2) {
    // Both listeners seated; sender joins and talks trash.
    client('Osama', (ws, m) => {
      if (m.type === 'joined') {
        ws.send(JSON.stringify({ type: 'chat', text: 'Abu you are going to be the bhabhi tonight' }));
        ws.send(JSON.stringify({ type: 'chat', text: '   ' })); // must be ignored
      }
    });
  }
};

for (const name of ['Ali', 'Bilal']) {
  client(name, (ws, m) => {
    if (m.type === 'joined') check();
    if (m.type === 'chat') {
      received[name].push(m.message);
      if (received.Ali.length && received.Bilal.length) {
        // Late joiner must get history.
        client('Late', (ws2, m2) => {
          if (m2.type === 'chat_history') {
            if (m2.messages.length !== 1) errors.push(`history len ${m2.messages.length}`);
            if (m2.messages[0]?.text !== 'Abu you are going to be the bhabhi tonight') errors.push('history text wrong');
            done();
          }
        });
      }
    }
  });
}

setTimeout(() => { errors.push('TIMEOUT'); done(); }, 15000);
await finished;
for (const n of ['Ali', 'Bilal']) {
  if (received[n].length !== 1) errors.push(`${n} got ${received[n].length} chats`);
  if (received[n][0]?.name !== 'Osama') errors.push(`${n} wrong sender`);
}
if (errors.length) { console.log('ERRORS:', errors); process.exit(1); }
console.log('CHAT TEST PASSED: broadcast to all, blank ignored, history on join');
process.exit(0);
