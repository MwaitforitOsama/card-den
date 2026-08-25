// WebSocket lifecycle: exactly one live socket per tab, with automatic
// reconnection. A generation counter discards events from replaced sockets
// so a stale connection can never render over — or swallow moves meant
// for — the current room.

const RECONNECT_MS = 1500;

export function createSocket({ makeJoin, onMessage, onReconnecting }) {
  let ws = null;
  let gen = 0;
  let reconnectTimer = null;
  let intentional = false;

  function connect(code) {
    intentional = false;
    clearTimeout(reconnectTimer);
    const g = ++gen;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      try { ws.close(); } catch {}
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/${code}`);

    ws.onopen = () => {
      if (g === gen) ws.send(JSON.stringify(makeJoin(code)));
    };
    ws.onmessage = e => {
      if (g !== gen) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      onMessage(msg);
    };
    ws.onclose = () => {
      if (g !== gen || intentional) return;
      onReconnecting();
      reconnectTimer = setTimeout(() => connect(code), RECONNECT_MS);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function close() {
    intentional = true;
    clearTimeout(reconnectTimer);
    try { ws && ws.close(); } catch {}
  }

  return { connect, send, close };
}
