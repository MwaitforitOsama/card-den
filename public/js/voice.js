// Group voice: a WebRTC full mesh with push-to-talk. Audio flows directly
// between browsers; the room's WebSocket only relays the SDP/ICE handshake
// ('rtc' messages) and the transient speaking flag ('voice' messages).
//
// Mesh rules (inspired by the classic webrtc-group-chat pattern):
// - one RTCPeerConnection per other participant, keyed by their peerId;
// - only the side with the lower peerId creates the offer (no glare);
// - the mic track exists from the start but stays disabled — holding the
//   talk button enables it (true push-to-talk, near-silent otherwise).

import { $ } from './dom.js';
import { toast } from './toast.js';

const ICE_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

// Reconnects: 'disconnected' often heals itself, so wait before acting; a
// recovery restarts ICE (fresh candidates, same connection) with a bounded
// backoff — after the last attempt the peer is dropped and left alone.
const DISCONNECT_GRACE_MS = 4000;
const MAX_RECOVERY_ATTEMPTS = 4;
const backoffMs = attempt => 2000 * 2 ** (attempt - 1); // 2s, 4s, 8s, 16s

export function initVoice(send) {
  let myId = null;
  let localStream = null; // null until mic granted; false = denied
  let pushed = false;
  const peers = new Map(); // peerId -> RTCPeerConnection
  const audioEls = new Map(); // peerId -> <audio>
  const speaking = new Set(); // peerIds currently transmitting
  const health = new Map(); // peerId -> { attempts, graceTimer, retryTimer }
  const gaveUp = new Set(); // peers past the retry budget — no rebuilds until the roster or network changes
  const names = new Map(); // peerId -> display name, for failure toasts

  /* ---------- mic ---------- */

  async function ensureMic() {
    if (localStream !== null) return;
    localStream = false; // claim while the prompt is up; overwritten on success
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      stream.getAudioTracks().forEach(t => { t.enabled = false; });
      localStream = stream;
      // Late tracks for peers connected before the mic was granted.
      for (const pc of peers.values()) {
        if (pc.getSenders().every(s => !s.track)) {
          stream.getTracks().forEach(t => pc.addTrack(t, stream));
        }
      }
    } catch {
      localStream = false;
      updateTalkButton();
      toast('🔇 Mic blocked — you can hear the boys but not talk', 'error');
    }
    updateTalkButton();
  }

  /* ---------- peers ---------- */

  function roster(state) {
    const people = [
      ...(state.players || []).filter(p => p.connected),
      ...(state.spectators || []),
    ];
    return people.filter(p => p.peerId && p.peerId !== myId);
  }

  function createPeer(peerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peers.set(peerId, pc);
    gaveUp.delete(peerId); // a fresh connection gets a fresh retry budget

    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.onicecandidate = e => {
      if (e.candidate) send({ type: 'rtc', to: peerId, data: { kind: 'ice', candidate: e.candidate } });
    };
    pc.ontrack = e => {
      let audio = audioEls.get(peerId);
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        audio.setAttribute('playsinline', '');
        $('#voice-audio').appendChild(audio);
        audioEls.set(peerId, audio);
      }
      audio.srcObject = e.streams[0];
      audio.play().catch(() => {}); // unlocked on first tap if blocked
    };
    pc.onnegotiationneeded = async () => {
      if (!isInitiator(peerId)) return;
      try {
        await pc.setLocalDescription(await pc.createOffer());
        send({ type: 'rtc', to: peerId, data: { kind: 'sdp', sdp: pc.localDescription } });
      } catch { /* peer may be mid-teardown */ }
    };
    pc.onconnectionstatechange = () => {
      const h = healthOf(peerId);
      if (pc.connectionState === 'connected') {
        h.attempts = 0;
        clearTimeout(h.graceTimer); h.graceTimer = null;
        clearTimeout(h.retryTimer); h.retryTimer = null;
      } else if (pc.connectionState === 'disconnected') {
        if (!h.graceTimer) {
          h.graceTimer = setTimeout(() => { h.graceTimer = null; attemptRecovery(peerId); },
            DISCONNECT_GRACE_MS);
        }
      } else if (pc.connectionState === 'failed') {
        clearTimeout(h.graceTimer); h.graceTimer = null;
        attemptRecovery(peerId);
      }
    };
    return pc;
  }

  function isInitiator(peerId) {
    return myId !== null && myId < peerId;
  }

  function dropPeer(peerId) {
    peers.get(peerId)?.close();
    peers.delete(peerId);
    audioEls.get(peerId)?.remove();
    audioEls.delete(peerId);
    speaking.delete(peerId);
    const h = health.get(peerId);
    if (h) { clearTimeout(h.graceTimer); clearTimeout(h.retryTimer); health.delete(peerId); }
  }

  /* ---------- reconnects ---------- */

  function healthOf(peerId) {
    let h = health.get(peerId);
    if (!h) { h = { attempts: 0, graceTimer: null, retryTimer: null }; health.set(peerId, h); }
    return h;
  }

  // Only the offerer (lower peerId) can restart ICE; the other side asks for
  // it with a relayed 'restart' message. Each attempt schedules a recheck —
  // if the link still isn't up after the backoff, try again until the budget
  // runs out, then drop the peer and stop.
  function attemptRecovery(peerId) {
    const pc = peers.get(peerId);
    if (!pc || pc.connectionState === 'connected') return;
    const h = healthOf(peerId);
    clearTimeout(h.retryTimer); h.retryTimer = null;
    if (h.attempts >= MAX_RECOVERY_ATTEMPTS) {
      toast(`🔇 Voice to ${names.get(peerId) ?? 'a player'} couldn't reconnect`, 'error');
      gaveUp.add(peerId);
      dropPeer(peerId);
      return;
    }
    h.attempts += 1;
    if (isInitiator(peerId)) pc.restartIce(); // → negotiationneeded → fresh offer
    else send({ type: 'rtc', to: peerId, data: { kind: 'restart' } });
    h.retryTimer = setTimeout(() => { h.retryTimer = null; attemptRecovery(peerId); },
      backoffMs(h.attempts));
  }

  /* ---------- signaling ---------- */

  async function handleRtc(msg) {
    const peerId = msg.from;
    const data = msg.data || {};
    let pc = peers.get(peerId);
    if (data.kind === 'restart') {
      // The non-offerer noticed the link die and asks us to restart ICE.
      if (!isInitiator(peerId)) return;
      if (pc) pc.restartIce();
      else createPeer(peerId); // they tore their side down — offer from scratch
      return;
    }
    if (!pc && data.kind === 'sdp' && data.sdp?.type === 'offer') pc = createPeer(peerId);
    if (!pc) return;
    try {
      if (data.kind === 'sdp') {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          send({ type: 'rtc', to: peerId, data: { kind: 'sdp', sdp: pc.localDescription } });
        }
      } else if (data.kind === 'ice' && data.candidate) {
        await pc.addIceCandidate(data.candidate);
      }
    } catch { /* stale negotiation from a torn-down peer — ignore */ }
  }

  /* ---------- speaking indicator ---------- */

  function handleSpeaking(msg) {
    if (msg.speaking) speaking.add(msg.peerId);
    else speaking.delete(msg.peerId);
    applySpeaking();
  }

  function applySpeaking() {
    for (const chip of document.querySelectorAll('#players .player-chip[data-peer-id]')) {
      chip.classList.toggle('speaking', speaking.has(chip.dataset.peerId));
    }
  }

  /* ---------- push-to-talk ---------- */

  function setPushed(on) {
    if (pushed === on) return;
    pushed = on;
    if (localStream) {
      localStream.getAudioTracks().forEach(t => { t.enabled = on; });
      send({ type: 'voice', speaking: on });
    }
    updateTalkButton();
  }

  function updateTalkButton() {
    const btn = $('#btn-talk');
    if (localStream === false) {
      btn.classList.remove('talking');
      btn.textContent = '🔇';
      btn.disabled = true;
      btn.title = 'Microphone blocked';
      return;
    }
    btn.disabled = false;
    btn.classList.toggle('talking', pushed);
    btn.textContent = pushed ? '🎙️' : '🎙';
    btn.title = 'Hold to talk (or hold Space)';
  }

  /* ---------- lifecycle ---------- */

  // Called on every state broadcast: sync the mesh with who's in the room.
  function update(state) {
    myId = state.youPeerId ?? myId;
    if (!myId) return;
    $('#btn-talk').hidden = false;
    ensureMic();
    const wanted = roster(state);
    const wantedIds = new Set(wanted.map(p => p.peerId));
    names.clear();
    wanted.forEach(p => names.set(p.peerId, p.name));
    for (const peerId of [...peers.keys()]) {
      if (!wantedIds.has(peerId)) dropPeer(peerId);
    }
    // A peer who left and came back has a new peerId — forget the old grudge.
    for (const peerId of [...gaveUp]) {
      if (!wantedIds.has(peerId)) gaveUp.delete(peerId);
    }
    for (const p of wanted) {
      // The lower id calls; the higher id waits for the offer.
      if (!peers.has(p.peerId) && !gaveUp.has(p.peerId) && isInitiator(p.peerId)) createPeer(p.peerId);
    }
    applySpeaking();
  }

  function reset() {
    for (const peerId of [...peers.keys()]) dropPeer(peerId);
    speaking.clear();
    gaveUp.clear();
    names.clear();
    setPushed(false);
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    myId = null;
    $('#btn-talk').hidden = true;
  }

  /* ---------- UI wiring ---------- */

  const talkBtn = $('#btn-talk');
  talkBtn.addEventListener('pointerdown', e => { e.preventDefault(); setPushed(true); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
    talkBtn.addEventListener(ev, () => setPushed(false));
  }
  talkBtn.addEventListener('contextmenu', e => e.preventDefault());

  const inTextField = () => /^(input|textarea)$/i.test(document.activeElement?.tagName ?? '');
  window.addEventListener('keydown', e => {
    if (e.code === 'Space' && !e.repeat && !inTextField() && !talkBtn.hidden) {
      e.preventDefault();
      setPushed(true);
    }
  });
  window.addEventListener('keyup', e => {
    if (e.code === 'Space' && !inTextField()) setPushed(false);
  });

  // Our network came back (VPN toggle, Wi-Fi switch): every candidate is
  // stale, so skip the backoff and retry everything at once, fresh budget.
  window.addEventListener('online', () => {
    gaveUp.clear();
    for (const [peerId, pc] of peers) {
      if (pc.connectionState === 'connected') continue;
      const h = healthOf(peerId);
      h.attempts = 0;
      clearTimeout(h.graceTimer); h.graceTimer = null;
      clearTimeout(h.retryTimer); h.retryTimer = null;
      attemptRecovery(peerId);
    }
  });

  // Browsers may block remote audio until a user gesture: unlock on any tap.
  document.addEventListener('pointerdown', () => {
    for (const audio of audioEls.values()) audio.play().catch(() => {});
  }, { capture: true });

  return { update, handleRtc, handleSpeaking, reset };
}
