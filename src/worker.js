// Worker entry point: serves the static frontend (assets binding) and routes
// room creation + WebSocket upgrades to the GameRoom Durable Object.

export { GameRoom } from './room.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid misreads
const CODE_LENGTH = 4;

function makeCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/create' && request.method === 'POST') {
      const code = makeCode();
      const game = url.searchParams.get('game') ?? '';
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      await stub.fetch(
        'https://room/init?code=' + code + '&game=' + encodeURIComponent(game),
        { method: 'POST' },
      );
      return Response.json({ code });
    }

    const match = url.pathname.match(/^\/ws\/([A-Za-z]{4})$/);
    if (match && request.headers.get('Upgrade') === 'websocket') {
      const code = match[1].toUpperCase();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
