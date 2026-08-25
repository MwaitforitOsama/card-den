// Room-wide chat component. Docked on desktop; a slide-in drawer with an
// unread badge on mobile (CSS decides which, this module only tracks state).

import { $, el } from './dom.js';

const SEAT_COLORS = ['#fbbf24', '#60a5fa', '#f87171', '#4ade80', '#c084fc', '#fb923c', '#22d3ee'];
const NEAR_BOTTOM_PX = 60;
const MAX_BADGE = 9;

export function initChat(send) {
  let unread = 0;

  const isDocked = () => window.matchMedia('(min-width: 900px)').matches;
  const isOpen = () => document.body.classList.contains('chat-open');

  function setOpen(open) {
    document.body.classList.toggle('chat-open', open);
    if (open) {
      unread = 0;
      updateBadge();
      scroll(true);
      $('#chat-input').focus();
    }
  }

  function updateBadge() {
    const badge = $('#chat-badge');
    badge.hidden = unread === 0;
    badge.textContent = unread > MAX_BADGE ? `${MAX_BADGE}+` : String(unread);
  }

  function scroll(force) {
    const box = $('#chat-messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX;
    if (force || nearBottom) box.scrollTop = box.scrollHeight;
  }

  function add(message, { history = false } = {}) {
    const row = el('div', 'chat-msg');
    const name = el('span', 'chat-name', message.name);
    name.style.color = message.seat >= 0
      ? SEAT_COLORS[message.seat % SEAT_COLORS.length]
      : '#9ca3af'; // spectators chat in gray
    row.append(name, el('span', '', message.text));
    $('#chat-messages').appendChild(row);
    scroll(history);
    if (!history && !isDocked() && !isOpen()) {
      unread++;
      updateBadge();
    }
  }

  function setHistory(messages) {
    $('#chat-messages').innerHTML = '';
    messages.forEach(m => add(m, { history: true }));
  }

  function reset() {
    $('#chat-messages').innerHTML = '';
    unread = 0;
    updateBadge();
    setOpen(false);
  }

  $('#chat-form').onsubmit = e => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    send({ type: 'chat', text });
    input.value = '';
  };
  $('#btn-chat').onclick = () => setOpen(!isOpen());
  $('#btn-chat-close').onclick = () => setOpen(false);

  return { add, setHistory, reset };
}
