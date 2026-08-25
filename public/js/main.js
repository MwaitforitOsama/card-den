// Application wiring: owns the session, connects the socket, and routes
// server messages to the chat and game-view components.

import { $ } from './dom.js';
import { preloadCards } from './cards.js';
import { toast } from './toast.js';
import { createSocket } from './socket.js';
import { initChat } from './chat.js';
import { initVoice } from './voice.js';
import { createGameView } from './game-view.js';
import * as store from './session.js';

let session = null;

/* ---------- screens ---------- */

function showHome(error, notice) {
  $('#screen-home').hidden = false;
  $('#screen-table').hidden = true;
  $('#overlay').hidden = true;
  const err = $('#home-error');
  err.hidden = !error;
  err.textContent = error || '';
  err.classList.toggle('notice', !!notice);
}

function leaveToHome(error) {
  socket.close();
  session = null;
  store.saveSession(null);
  chat.reset();
  view.reset();
  voice.reset();
  setInviteUrl(null);
  showHome(error);
}

/* ---------- invite links ---------- */

// Keep the address bar shareable: in a room the URL carries ?gamecode=XXXX
// (opening it auto-joins), back home it's clean again.
function inviteLink(code) {
  return `${location.origin}${location.pathname}?gamecode=${code}`;
}

function setInviteUrl(code) {
  history.replaceState(null, '', code ? inviteLink(code) : location.pathname);
}

/* ---------- identity ---------- */

function myName() {
  const name = $('#name-input').value.trim().slice(0, 16);
  store.saveName(name);
  return name;
}

/* ---------- socket & message routing ---------- */

const socket = createSocket({
  makeJoin: code => ({
    type: 'join',
    name: myName(),
    token: session && session.code === code ? session.token : null,
  }),
  onMessage: msg => {
    if (msg.type === 'joined') {
      session = { code: msg.code, token: msg.token };
      store.saveSession(session);
      setInviteUrl(msg.code);
      $('#conn-status').textContent = '';
      $('#screen-home').hidden = true;
      $('#screen-table').hidden = false;
    } else if (msg.type === 'state') {
      view.handleState(msg);
      voice.update(msg);
    } else if (msg.type === 'rtc') {
      voice.handleRtc(msg);
    } else if (msg.type === 'voice') {
      voice.handleSpeaking(msg);
    } else if (msg.type === 'chat') {
      chat.add(msg.message);
    } else if (msg.type === 'chat_history') {
      chat.setHistory(msg.messages || []);
    } else if (msg.type === 'error') {
      if (msg.fatal) leaveToHome(msg.message);
      else toast(msg.message, 'error');
    }
  },
  onReconnecting: () => {
    $('#conn-status').textContent = 'Reconnecting…';
  },
});

const chat = initChat(socket.send);
const voice = initVoice(socket.send);
const view = createGameView({ send: socket.send });

/* ---------- UI wiring ---------- */

// Game picker: the creator chooses what the room plays; joiners just land
// in whatever the room is set to (the host can switch between games later).
let selectedGame = 'thulla';
for (const tab of document.querySelectorAll('#game-picker .game-tab')) {
  tab.onclick = () => {
    selectedGame = tab.dataset.game;
    document.querySelectorAll('#game-picker .game-tab')
      .forEach(t => t.classList.toggle('active', t === tab));
  };
}

$('#btn-create').onclick = async () => {
  if (!myName()) return showHome('Enter your name first');
  try {
    const res = await fetch(`/api/create?game=${selectedGame}`, { method: 'POST' });
    const { code } = await res.json();
    session = null; // brand-new room, no old token
    socket.connect(code);
  } catch {
    showHome('Could not create a room — is the server running?');
  }
};

$('#btn-join').onclick = () => {
  if (!myName()) return showHome('Enter your name first');
  const code = $('#code-input').value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return showHome('Room codes are 4 letters');
  // Only reuse a token this tab itself earned for this room; otherwise join
  // as a fresh player (lets several tabs in one browser be separate players).
  const own = store.tabSession();
  session = own && own.code === code ? own : null;
  socket.connect(code);
};

$('#btn-leave').onclick = () => leaveToHome();
$('#btn-overlay-leave').onclick = () => leaveToHome();

$('#room-code').onclick = () => {
  navigator.clipboard?.writeText(inviteLink($('#room-code').textContent))
    .then(() => toast('Invite link copied — send it to the boys'));
};

$('#btn-start').onclick = () => socket.send({ type: 'start' });
$('#btn-again').onclick = () => socket.send({ type: 'start' });
$('#btn-take').onclick = () => socket.send({ type: 'take' });
$('#btn-undo').onclick = () => socket.send({ type: 'undo' });
$('#btn-take-yes').onclick = () => socket.send({ type: 'take_response', approve: true });
$('#btn-take-no').onclick = () => socket.send({ type: 'take_response', approve: false });
$('#btn-concede').onclick = () => socket.send({ type: 'concede' });
$('#btn-concede-yes').onclick = () => socket.send({ type: 'concede_response', approve: true });
$('#btn-concede-no').onclick = () => socket.send({ type: 'concede_response', approve: false });
for (const btn of document.querySelectorAll('#call-suits button')) {
  btn.onclick = () => socket.send({ type: 'call_trump', suit: btn.dataset.suit });
}
$('#btn-claim-call').onclick = () => socket.send({ type: 'claim_call' });

$('#code-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-join').click(); });
// Enter on the name field: join if a room code is already filled in
// (e.g. from an invite link), otherwise create a room.
$('#name-input').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (/^[A-Za-z]{4}$/.test($('#code-input').value.trim())) $('#btn-join').click();
  else $('#btn-create').click();
});

/* ---------- boot ---------- */

$('#name-input').value = store.loadName();
preloadCards();
// Prefer this tab's own session; fall back to the browser-wide backup only
// when the tab has none (fresh tab after the old one was killed mid-game).
session = store.tabSession() || store.backupSession();
const invite = (new URLSearchParams(location.search).get('gamecode') || '').trim().toUpperCase();
if (/^[A-Z]{4}$/.test(invite)) {
  // Invite link: straight into the room — the code is in the URL. Without a
  // saved name we stop at the home screen once, code pre-filled, and their
  // name (plus Enter or Join) is all that's needed.
  $('#code-input').value = invite;
  if (store.loadName()) socket.connect(invite);
  else {
    showHome(`You're invited to room ${invite} — enter your name to join`, true);
    $('#name-input').focus();
  }
} else if (session && session.code) {
  socket.connect(session.code);
} else {
  showHome();
}
