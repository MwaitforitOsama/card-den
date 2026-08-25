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

export function initVoice(send) {
  let myId = null;
  let localStream = null; // null until mic granted; false = denied
  let pushed = false;
  const peers = new Map(); // peerId -> RTCPeerConnection
  const audioEls = new Map(); // peerId -> <audio>
  const speaking = new Set(); // peerIds currently transmitting

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
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') dropPeer(peerId); // rebuilt on next state
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
  }

  /* ---------- signaling ---------- */

  async function handleRtc(msg) {
    const peerId = msg.from;
    const data = msg.data || {};
    let pc = peers.get(peerId);
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
    for (const peerId of [...peers.keys()]) {
      if (!wantedIds.has(peerId)) dropPeer(peerId);
    }
    for (const p of wanted) {
      // The lower id calls; the higher id waits for the offer.
      if (!peers.has(p.peerId) && isInitiator(p.peerId)) createPeer(p.peerId);
    }
    applySpeaking();
  }

  function reset() {
    for (const peerId of [...peers.keys()]) dropPeer(peerId);
    speaking.clear();
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

  // Browsers may block remote audio until a user gesture: unlock on any tap.
  document.addEventListener('pointerdown', () => {
    for (const audio of audioEls.values()) audio.play().catch(() => {});
  }, { capture: true });

  return { update, handleRtc, handleSpeaking, reset };
}
