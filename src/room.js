// GameRoom Durable Object: one instance per room code. Owns the seats, the
// chat and the authoritative game state, and talks to clients over
// WebSockets. Clients only ever receive their own hand.
//
// The room itself is game-agnostic: rules live in the game adapters
// (src/games/*), selected per room via room.gameId. The room provides the
// shared machinery — seats, spectators, disconnect grace, the undo window,
// the scoreboard — and delegates every rule decision to the adapter.

import { GAMES, DEFAULT_GAME } from './games/index.js';
import { BOTS } from './bots/index.js';

const MAX_PLAYERS = 7; // room seat capacity (a game may use fewer)
const GRACE_MS = 30_000; // reconnect window before a dropped player is cut
const UNDO_MS = 10_000; // window to take a misplayed card back
const CHAT_KEEP = 100;
const CHAT_MAX_LEN = 200;
const NAME_MAX_LEN = 16;

const FRESH_STATS = { games: 0, wins: 0, losses: 0, whitewashes: 0 };

export class GameRoom {
  constructor(ctx) {
    this.ctx = ctx;
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get('room')) ?? null;
    });
  }

  get adapter() {
    return GAMES[this.room?.gameId] ?? GAMES[DEFAULT_GAME];
  }

  // The current game's bot brain, if it has one. Bots live in src/bots/,
  // entirely outside the game engines and adapters.
  get bot() {
    return BOTS[this.room?.gameId ?? DEFAULT_GAME] ?? null;
  }

  /* ---------- plumbing ---------- */

  async save() {
    await this.ctx.storage.put('room', this.room);
  }

  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket already gone */ }
  }

  sendError(ws, message) {
    this.send(ws, { type: 'error', message });
  }

  tokenOf(ws) {
    try { return ws.deserializeAttachment()?.token ?? null; } catch { return null; }
  }

  seatOf(token) {
    return this.room ? this.room.players.findIndex(p => p.token === token) : -1;
  }

  // The host role follows the first CONNECTED player, so a departed room
  // creator can never leave the others stuck.
  hostSeat(connected = this.connectedTokens()) {
    return this.room.players.findIndex(p => connected.has(p.token));
  }

  // `except` skips a socket that is mid-close: webSocketClose fires while
  // the dying socket is still listed in getWebSockets(), so it must not
  // count as connected during that event's broadcast.
  forEachClient(fn, except = null) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const token = this.tokenOf(ws);
      if (token) fn(ws, token);
    }
  }

  connectedTokens(except = null) {
    const set = new Set();
    this.forEachClient((_ws, token) => set.add(token), except);
    return set;
  }

  /* ---------- HTTP entry ---------- */

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/init' && request.method === 'POST') {
      if (!this.room) {
        const game = url.searchParams.get('game');
        this.room = {
          code: url.searchParams.get('code'),
          gameId: GAMES[game] ? game : DEFAULT_GAME,
          players: [], // [{token, name}] — seat = array index, seat 0 is host
          phase: 'lobby', // 'lobby' | 'playing' | 'over'
          game: null,
          chat: [],
          graceDeadline: null,
          pendingTake: null, // {from, target} awaiting the target's approval
          pendingConcede: null, // {seat, winner} awaiting the winner's approval
          gamesPlayed: 0, // finished games this session (aborted ones don't count)
          spectators: [], // [{token, name}] watching; dealt in at the next game
        };
        await this.save();
      }
      return Response.json({ code: this.room.code });
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      // Accept even for unknown rooms; the join message gets a proper error
      // the client can display, which a failed upgrade would not.
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('Not found', { status: 404 });
  }

  /* ---------- message routing ---------- */

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      await this.route(ws, msg);
      await this.runBots();
    } catch (err) {
      this.sendError(ws, err.message);
    }
  }

  async route(ws, msg) {
    if (msg.type === 'join') return await this.handleJoin(ws, msg);
    const token = this.tokenOf(ws);
    const seat = token ? this.seatOf(token) : -1;
    const spectator = token && seat < 0
      ? (this.room?.spectators ?? []).find(s => s.token === token)
      : null;
    if (seat < 0 && !spectator) return this.sendError(ws, 'Join the room first');
    if (msg.type === 'chat') return await this.handleChat(seat, spectator, msg);
    if (msg.type === 'rtc') return this.handleRtc(token, msg);
    if (msg.type === 'voice') return this.handleVoice(token, msg);
    if (seat < 0) return this.sendError(ws, 'You are watching — you can play from the next game');
    if (msg.type === 'start') return await this.handleStart(ws, token);
    if (msg.type === 'set_game') return await this.handleSetGame(ws, token, msg);
    if (msg.type === 'set_rule') return await this.handleSetRule(ws, token, msg);
    if (msg.type === 'dissolve') return await this.handleDissolve(ws, token);
    if (msg.type === 'add_bot') return await this.handleAddBot(ws, token);
    if (msg.type === 'remove_bot') return await this.handleRemoveBot(ws, token);
    if (msg.type === 'swap_seats') return await this.handleSwapSeats(ws, token, msg);
    if (msg.type === 'play') return await this.handleMove(ws, () => this.adapter.play(this.room.game, seat, msg.card));
    if (msg.type === 'undo') return await this.handleUndo(ws, seat);
    const action = this.adapter.actions?.[msg.type];
    if (action) {
      if (this.room.phase !== 'playing' || !this.room.game) {
        return this.sendError(ws, 'No game in progress');
      }
      return await action(this, ws, seat, msg);
    }
  }

  /* ---------- the bot (one seat-filler, moves instantly) ---------- */

  // After anything happens, let the bot act until a human is up again.
  // The bot has no socket: handleMove's error path goes nowhere (ws null),
  // which is fine — its moves are always legal by construction.
  async runBots() {
    if (this.botBusy || !this.room || !this.bot) return;
    const seat = this.room.players.findIndex(p => p.isBot);
    if (seat < 0) return;
    this.botBusy = true;
    try {
      let guard = 0;
      while (this.room.phase === 'playing' && this.room.game
          && this.bot.needsAct(this.room.game, seat)) {
        if (++guard > 60) break; // never loop forever on a logic bug
        await this.handleMove(null, () => this.bot.act(this.room.game, seat));
      }
    } finally {
      this.botBusy = false;
    }
  }

  /* ---------- joining & leaving ---------- */

  async handleJoin(ws, msg) {
    if (!this.room) {
      return this.send(ws, { type: 'error', fatal: true, message: 'Room not found — check the code' });
    }
    const name = String(msg.name ?? '').trim().slice(0, NAME_MAX_LEN);
    const spectators = (this.room.spectators ??= []);
    const events = [];
    let player = msg.token ? this.room.players.find(p => p.token === msg.token) : null;
    let spectator = !player && msg.token ? spectators.find(s => s.token === msg.token) : null;

    // A watcher arriving between games takes a seat right away.
    if (!player && spectator && this.room.phase !== 'playing' && this.room.players.length < MAX_PLAYERS) {
      this.room.spectators = spectators.filter(s => s !== spectator);
      player = spectator; // keeps their token
      this.room.players.push(player);
      spectator = null;
    }

    // Same-name rescue: a joiner with no valid token takes over their own
    // DISCONNECTED seat (storage lost, device switched, or they left and
    // came straight back). Friends-room trust model — the name is the
    // identity; a seat with a live connection is never taken this way.
    if (!player && !spectator && name) {
      const connected = this.connectedTokens();
      player = this.room.players.find(p => !p.isBot && !connected.has(p.token)
        && p.name.toLowerCase() === name.toLowerCase()) ?? null;
    }

    if (!player && !spectator) {
      if (this.room.phase === 'playing') {
        // Mid-game arrivals watch now and are dealt in at the next game.
        spectator = { token: crypto.randomUUID(), name: name || `Guest ${spectators.length + 1}` };
        spectators.push(spectator);
        events.push({ type: 'spectator_joined', name: spectator.name });
      } else if (this.room.players.length >= MAX_PLAYERS) {
        return this.send(ws, { type: 'error', fatal: true, message: `Room is full (${MAX_PLAYERS} players max)` });
      } else {
        player = { token: crypto.randomUUID(), name: name || `Player ${this.room.players.length + 1}` };
        this.room.players.push(player);
      }
    }

    const who = player ?? spectator;
    if (name) who.name = name;
    // Public voice-mesh identity — safe to share, unlike the session token.
    who.peerId ??= crypto.randomUUID();
    ws.serializeAttachment({ token: who.token });
    // Everyone back on board? Cancel the pending drop.
    if (player && this.room.phase === 'playing' && this.disconnectedActive().length === 0) {
      await this.clearGrace();
    }
    await this.save();
    this.send(ws, { type: 'joined', token: who.token, code: this.room.code });
    this.send(ws, { type: 'chat_history', messages: this.room.chat ?? [] });
    this.broadcast(events);
  }

  async webSocketClose(ws) { await this.handleGone(ws); }
  async webSocketError(ws) { await this.handleGone(ws); }

  async handleGone(ws) {
    const token = this.tokenOf(ws);
    if (!token || !this.room) return;
    const stillConnected = this.connectedTokens(ws).has(token);
    if (!stillConnected) {
      if (this.seatOf(token) < 0) {
        // A spectator who leaves is simply removed — the game never waits
        // for watchers.
        this.room.spectators = (this.room.spectators ?? []).filter(s => s.token !== token);
      } else if (this.room.phase === 'lobby') {
        // In the lobby a departed player simply frees their seat.
        this.room.players = this.room.players.filter(p => p.token !== token);
      } else if (this.room.phase === 'playing' && this.isActiveSeat(this.seatOf(token))) {
        // Mid-game: give them a grace window to reconnect before the rest
        // of the table moves on without them.
        await this.startGrace();
      }
      await this.save();
    }
    this.broadcast([], ws);
  }

  /* ---------- disconnect grace & auto-restart ---------- */

  isActiveSeat(seat) {
    const g = this.room.game;
    return seat >= 0 && !!g && this.room.phase === 'playing' && this.adapter.isActiveSeat(g, seat);
  }

  // Players the game is still waiting on (in the game, not done, and
  // currently without a connection). Bots have no socket but are always
  // present — the game never waits on them.
  disconnectedActive(connected = this.connectedTokens()) {
    return this.room.players.filter((p, seat) =>
      !p.isBot && !connected.has(p.token) && this.isActiveSeat(seat));
  }

  async startGrace() {
    this.room.graceDeadline = Date.now() + GRACE_MS;
    await this.ctx.storage.setAlarm(this.room.graceDeadline);
  }

  async clearGrace() {
    if (this.room.graceDeadline == null) return;
    this.room.graceDeadline = null;
    await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    if (!this.room) return;
    this.room.graceDeadline = null;
    if (this.room.phase !== 'playing') {
      await this.save();
      return;
    }
    if (this.disconnectedActive().length === 0) {
      await this.save();
      this.broadcast();
      return;
    }
    const dropped = this.pruneDisconnected();
    const events = [{ type: 'players_dropped', names: dropped.map(p => p.name) }];
    // The interrupted game is over for good — watchers join the next one,
    // and an aborted game leaves no result to base the next rung call on.
    this.room.lastResult = null;
    this.seatSpectatorsEvent(events);
    if (this.room.players.length >= this.adapter.minPlayers) {
      events.push({ type: 'restarted' }, ...this.startNewGame());
    } else {
      this.room.phase = 'lobby';
      this.room.game = null;
      this.room.pendingTake = null;
      this.room.pendingConcede = null;
      events.push({ type: 'back_to_lobby' });
    }
    await this.save();
    this.broadcast(events);
    await this.runBots(); // the auto-restarted game may open on the bot
  }

  /* ---------- game lifecycle ---------- */

  // Remove players with no live connection (bots stay); returns the
  // removed entries.
  pruneDisconnected() {
    const connected = this.connectedTokens();
    const keep = p => p.isBot || connected.has(p.token);
    const dropped = this.room.players.filter(p => !keep(p));
    this.room.players = this.room.players.filter(keep);
    return dropped;
  }

  // Seat waiting spectators (join order) while seats are free; returns the
  // names of everyone who got a seat.
  promoteSpectators() {
    const connected = this.connectedTokens();
    this.room.spectators = (this.room.spectators ?? []).filter(s => connected.has(s.token));
    const seated = [];
    while (this.room.spectators.length && this.room.players.length < MAX_PLAYERS) {
      const s = this.room.spectators.shift();
      this.room.players.push(s);
      seated.push(s.name);
    }
    return seated;
  }

  seatSpectatorsEvent(events) {
    const seated = this.promoteSpectators();
    if (seated.length) events.push({ type: 'spectators_seated', names: seated });
    return events;
  }

  // Hands the deal to the adapter; returns the new game's opening events.
  startNewGame() {
    this.room.phase = 'playing';
    this.room.pendingTake = null;
    this.room.pendingConcede = null;
    this.room.undoDeadline = null;
    return this.adapter.start(this.room);
  }

  async handleStart(ws, token) {
    if (this.room.phase === 'playing') {
      return this.sendError(ws, 'Game already started');
    }
    this.pruneDisconnected();
    const events = this.seatSpectatorsEvent([]);
    if (this.seatOf(token) !== this.hostSeat()) {
      return this.sendError(ws, 'Only the host can start the game');
    }
    if (this.room.players.length < this.adapter.minPlayers) {
      return this.sendError(ws, `Need at least ${this.adapter.minPlayers} players for ${this.adapter.title}`);
    }
    events.push(...this.startNewGame());
    await this.save();
    this.broadcast(events);
  }

  // Host switches what the room plays; only between games. The table goes
  // back to the lobby so everyone starts the new game deliberately.
  async handleSetGame(ws, token, msg) {
    if (this.room.phase === 'playing') {
      return this.sendError(ws, 'Finish the current game first');
    }
    if (this.seatOf(token) !== this.hostSeat()) {
      return this.sendError(ws, 'Only the host can switch games');
    }
    const id = String(msg.game ?? '');
    if (!GAMES[id]) return this.sendError(ws, 'Unknown game');
    if (id === this.room.gameId) return;
    this.room.gameId = id;
    this.room.phase = 'lobby';
    this.room.game = null;
    this.room.pendingTake = null;
    this.room.pendingConcede = null;
    const events = [{ type: 'game_changed', game: id, title: GAMES[id].title }];
    // The bot is strictly a seat-filler for games that ship a bot brain —
    // switching to one that doesn't sends it home.
    const idx = this.room.players.findIndex(p => p.isBot);
    if (idx >= 0 && !BOTS[id]) {
      const [bot] = this.room.players.splice(idx, 1);
      events.push({ type: 'bot_removed', name: bot.name });
    }
    await this.save();
    this.broadcast(events);
  }

  // Host flips an optional rule of the current game (e.g. Rung's "Ace
  // can't win the sar"). Never mid-game — the rule set is locked in at the deal.
  // Settings are stored per game id, so they survive switching games.
  async handleSetRule(ws, token, msg) {
    if (this.room.phase === 'playing') {
      return this.sendError(ws, 'Rules can only change between games');
    }
    if (this.seatOf(token) !== this.hostSeat()) {
      return this.sendError(ws, 'Only the host can change the rules');
    }
    const settings = this.adapter.settings ?? {};
    const rule = String(msg.rule ?? '');
    if (!(rule in settings)) return this.sendError(ws, 'Unknown rule');
    this.room.rules ??= {};
    this.room.rules[this.room.gameId] ??= {};
    this.room.rules[this.room.gameId][rule] = !!msg.value;
    await this.save();
    this.broadcast([{ type: 'rule_changed', rule, value: !!msg.value }]);
  }

  // Abort the running game with nothing recorded — no scoreboard change,
  // no result to base the next rung call on, as if the deal never
  // happened — and return everyone to the lobby, seats kept.
  async abortGame(events) {
    await this.clearGrace();
    this.room.phase = 'lobby';
    this.room.game = null;
    this.room.pendingTake = null;
    this.room.pendingConcede = null;
    this.room.undoDeadline = null;
    this.room.lastResult = null;
    events.push({ type: 'dissolved' });
    this.seatSpectatorsEvent(events); // watchers can take seats now
    return events;
  }

  async handleDissolve(ws, token) {
    if (this.room.phase !== 'playing' || !this.room.game) {
      return this.sendError(ws, 'No game to dissolve');
    }
    if (this.seatOf(token) !== this.hostSeat()) {
      return this.sendError(ws, 'Only the host can dissolve the game');
    }
    const events = await this.abortGame([]);
    await this.save();
    this.broadcast(events);
  }

  /* ---------- the bot's seat ---------- */

  // Host seats the one bot (a games-with-a-bot room, not a bot room):
  // only between games, only for games that ship a bot brain.
  async handleAddBot(ws, token) {
    if (!this.bot) {
      return this.sendError(ws, `${this.adapter.title} has no bot player`);
    }
    if (this.room.phase === 'playing') {
      return this.sendError(ws, 'Wait for the game to end to add the bot');
    }
    if (this.seatOf(token) !== this.hostSeat()) {
      return this.sendError(ws, 'Only the host can add the bot');
    }
    if (this.room.players.some(p => p.isBot)) {
      return this.sendError(ws, 'The bot is already seated');
    }
    if (this.room.players.length >= MAX_PLAYERS) {
      return this.sendError(ws, `Room is full (${MAX_PLAYERS} players max)`);
    }
    this.room.players.push({ token: 'bot-' + crypto.randomUUID(), name: 'Botta', isBot: true });
    await this.save();
    this.broadcast([{ type: 'bot_added', name: 'Botta' }]);
  }

  // Host removes the bot whenever — pulling it mid-game aborts the deal
  // (Rung needs its 4), with nothing counted.
  async handleRemoveBot(ws, token) {
    if (!this.room.players.some(p => p.isBot)) {
      return this.sendError(ws, 'No bot in the room');
    }
    if (this.seatOf(token) !== this.hostSeat()) {
      return this.sendError(ws, 'Only the host can remove the bot');
    }
    let events = [];
    if (this.room.phase === 'playing') events = await this.abortGame(events);
    const idx = this.room.players.findIndex(p => p.isBot);
    const [bot] = this.room.players.splice(idx, 1);
    if (this.room.phase === 'over') {
      // Seats shifted under the finished game's display — back to the lobby.
      this.room.phase = 'lobby';
      this.room.game = null;
    }
    events.push({ type: 'bot_removed', name: bot.name });
    await this.save();
    this.broadcast(events);
  }

  // Host rearranges seats (lobby, or between games — which returns the
  // table to the lobby first, since the old deal's seats no longer match).
  async handleSwapSeats(ws, token, msg) {
    if (this.room.phase === 'playing') {
      return this.sendError(ws, 'You cannot move players mid-game');
    }
    if (this.seatOf(token) !== this.hostSeat()) {
      return this.sendError(ws, 'Only the host can move players');
    }
    const a = Number(msg.a), b = Number(msg.b);
    const n = this.room.players.length;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b
        || a < 0 || b < 0 || a >= n || b >= n) {
      return this.sendError(ws, 'Pick two different seated players to swap');
    }
    const players = this.room.players;
    [players[a], players[b]] = [players[b], players[a]];
    if (this.room.phase === 'over') {
      this.room.phase = 'lobby';
      this.room.game = null;
    }
    await this.save();
    this.broadcast([{ type: 'seats_swapped', names: [players[b].name, players[a].name] }]);
  }

  async handleMove(ws, fn) {
    if (this.room.phase !== 'playing' || !this.room.game) {
      return this.sendError(ws, 'No game in progress');
    }
    const events = fn(); // throws on an illegal move; caught by the router
    // Any successful action invalidates a pending take or concede request:
    // the asker has moved on (or the request just went through).
    this.room.pendingTake = null;
    this.room.pendingConcede = null;
    // A fresh unresolved play opens its 10s change-of-mind window.
    this.room.undoDeadline = this.room.game.lastPlay ? Date.now() + UNDO_MS : null;
    if (this.room.game.phase === 'over') {
      this.room.phase = 'over';
      this.recordResult(); // before spectators are seated: seats still match
      await this.clearGrace();
      this.seatSpectatorsEvent(events); // watchers get a seat for the next game
    }
    await this.save();
    this.broadcast(events);
  }

  // Fat-finger insurance: the player who just threw an unresolved card may
  // take it back within the window — unless it expired (or the next throw
  // already cleared lastPlay).
  async handleUndo(ws, seat) {
    const g = this.room.game;
    if (this.room.phase !== 'playing' || !g) {
      return this.sendError(ws, 'No game in progress');
    }
    if (!g.lastPlay || g.lastPlay.seat !== seat || Date.now() > (this.room.undoDeadline ?? 0)) {
      return this.sendError(ws, 'Too late to change your card');
    }
    await this.handleMove(ws, () => this.adapter.undo(g, seat));
  }

  /* ---------- session scoreboard ---------- */

  // Tally a finished game via the adapter's verdict. Stats live on the
  // player entry itself, so they survive reconnects (same token) but vanish
  // when the player leaves the room. Only games that reach a verdict count
  // — grace-timer aborts don't.
  recordResult() {
    const g = this.room.game;
    const res = this.adapter.result(g);
    this.room.gamesPlayed = (this.room.gamesPlayed ?? 0) + 1;
    // Remembered by token so seat swaps can't mistake identities — Rung
    // uses this to hand the next rung call to the winning pair.
    this.room.lastResult = {
      gameId: this.room.gameId,
      winnerTokens: res.winners.map(seat => this.room.players[seat]?.token).filter(Boolean),
    };
    for (let seat = 0; seat < g.numPlayers; seat++) {
      const p = this.room.players[seat];
      if (!p) continue;
      p.stats = { ...FRESH_STATS, ...(p.stats ?? {}) };
      p.stats.games++;
      if (res.winners.includes(seat)) {
        p.stats.wins++;
        if (res.whitewash) p.stats.whitewashes++;
      }
      if (res.losers.includes(seat)) p.stats.losses++;
    }
  }

  /* ---------- voice (WebRTC mesh signaling) ---------- */

  personByToken(token) {
    return this.room.players.find(p => p.token === token)
      ?? (this.room.spectators ?? []).find(s => s.token === token)
      ?? null;
  }

  personByPeerId(peerId) {
    return this.room.players.find(p => p.peerId === peerId)
      ?? (this.room.spectators ?? []).find(s => s.peerId === peerId)
      ?? null;
  }

  // Relay one SDP/ICE payload to one peer. Audio itself never touches the
  // server — these are only the handshake messages that set up the P2P link.
  handleRtc(token, msg) {
    const me = this.personByToken(token);
    if (!me?.peerId || !msg.to || msg.to === me.peerId) return;
    const target = this.personByPeerId(msg.to);
    if (!target) return;
    for (const ws of this.ctx.getWebSockets()) {
      if (this.tokenOf(ws) === target.token) {
        this.send(ws, { type: 'rtc', from: me.peerId, data: msg.data });
      }
    }
  }

  // Transient push-to-talk indicator, fanned out to everyone.
  handleVoice(token, msg) {
    const me = this.personByToken(token);
    if (!me?.peerId) return;
    this.forEachClient(ws => this.send(ws, {
      type: 'voice', peerId: me.peerId, speaking: !!msg.speaking,
    }));
  }

  /* ---------- chat ---------- */

  // Room-wide chat: one channel, everyone sees everything — spectators too.
  async handleChat(seat, spectator, msg) {
    const text = String(msg.text ?? '').trim().slice(0, CHAT_MAX_LEN);
    if (!text) return;
    const name = spectator ? spectator.name : this.room.players[seat].name;
    const entry = { seat, name, text, ts: Date.now() };
    this.room.chat = [...(this.room.chat ?? []), entry].slice(-CHAT_KEEP);
    await this.save();
    this.forEachClient(ws => this.send(ws, { type: 'chat', message: entry }));
  }

  /* ---------- state broadcasting ---------- */

  broadcast(events = [], except = null) {
    if (!this.room) return;
    const connected = this.connectedTokens(except);
    this.forEachClient((ws, token) => this.send(ws, this.view(token, connected, events)), except);
  }

  // Personalized snapshot: only your own cards ever leave the server.
  view(token, connected, events) {
    const room = this.room;
    const g = room.game;
    const seat = this.seatOf(token);
    const hostSeat = this.hostSeat(connected);
    return {
      type: 'state',
      code: room.code,
      gameId: room.gameId ?? DEFAULT_GAME,
      gameTitle: this.adapter.title,
      gameRules: room.rules?.[room.gameId ?? DEFAULT_GAME] ?? {},
      phase: room.phase,
      youSeat: seat,
      events,
      pendingTake: room.pendingTake ?? null,
      pendingConcede: room.pendingConcede ?? null,
      gamesPlayed: room.gamesPlayed ?? 0,
      spectators: (room.spectators ?? []).map(s => ({ name: s.name, peerId: s.peerId ?? null })),
      grace: room.graceDeadline != null ? {
        remainingMs: Math.max(0, room.graceDeadline - Date.now()),
        waitingFor: this.disconnectedActive(connected).map(p => p.name),
      } : null,
      youPeerId: this.personByToken(token)?.peerId ?? null,
      players: room.players.map((p, i) => ({
        seat: i,
        name: p.name,
        peerId: p.peerId ?? null,
        connected: p.isBot || connected.has(p.token),
        isBot: !!p.isBot,
        isHost: i === hostSeat,
        stats: { ...FRESH_STATS, ...(p.stats ?? {}) },
        ...(g ? this.adapter.seatView(g, i) : { cardCount: 0, safe: false }),
      })),
      game: g ? {
        ...this.adapter.gameView(g, seat),
        undo: g.lastPlay && room.undoDeadline && Date.now() <= room.undoDeadline
          ? { seat: g.lastPlay.seat, remainingMs: room.undoDeadline - Date.now() }
          : null,
      } : null,
    };
  }
}
