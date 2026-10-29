// Group voice: an opt-in WebRTC full mesh with push-to-talk. Audio flows
// directly between browsers; the room's WebSocket only relays the SDP/ICE
// handshake ('rtc'), who is in voice ('voice_join'), and the transient
// speaking flag ('voice').
//
// Mesh rules (inspired by the classic webrtc-group-chat pattern):
// - only people who tapped "Join voice" are meshed — one RTCPeerConnection
//   per other voice member, keyed by their peerId;
// - only the side with the lower peerId creates the offer (no glare);
// - each link has one audio transceiver negotiated up front, but its sender
//   carries no track until the talk button is held (replaceTrack), so an
//   idle mesh encodes and sends nothing;
// - the mic itself is released after a short idle spell and re-acquired on
//   the next press; spectators listen only and never open the mic.
//
// Battery savers on top: Opus is asked for mono + DTX at a low bitrate, and
// a tab left in the background drops out of voice after a minute.

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

const MIC_IDLE_MS = 15000; // release the mic this long after the last press
const AWAY_LEAVE_MS = 60000; // leave voice after this long in the background
const MAX_BITRATE = 24000; // bps per outgoing link — plenty for table talk
// Asked of the far side's encoder via our SDP: mono, silence suppression
// (DTX), and a low average bitrate.
const OPUS_PARAMS = { stereo: 0, usedtx: 1, maxaveragebitrate: 20000 };

export function initVoice(send) {
  let myId = null;
  let joined = false; // this tab opted into voice
  let listenOnly = false; // spectators hear the table but can't talk
  let mic = null; // MediaStream while the mic is open
  let micPending = null; // in-flight getUserMedia
  let micBlocked = false;
  let idleTimer = null;
  let awayTimer = null;
  let leftWhileAway = false;
  let pushed = false;
  let announced = false; // we told the room we're speaking
  const peers = new Map(); // peerId -> RTCPeerConnection
  const audioEls = new Map(); // peerId -> <audio>
  const speaking = new Set(); // peerIds currently transmitting
  const health = new Map(); // peerId -> { attempts, graceTimer, retryTimer }
  const gaveUp = new Set(); // peers past the retry budget — no rebuilds until the roster or network changes
  const names = new Map(); // peerId -> display name, for failure toasts

  /* ---------- mic ---------- */

  function acquireMic() {
    if (mic) return Promise.resolve(mic);
    if (micBlocked) return Promise.resolve(null);
    micPending ??= navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    }).then(stream => {
      // Left voice (or got released) while the prompt was up: don't keep it.
      if (!joined || listenOnly) { stream.getTracks().forEach(t => t.stop()); return null; }
      mic = stream;
      return stream;
    }, () => {
      micBlocked = true;
      toast('🔇 Mic blocked — you can hear the boys but not talk', 'error');
      return null;
    }).finally(() => {
      micPending = null;
      updateButtons();
    });
    return micPending;
  }

  function releaseMic() {
    clearTimeout(idleTimer); idleTimer = null;
    if (!mic) return;
    attachTrack(null);
    mic.getTracks().forEach(t => t.stop());
    mic = null;
  }

  function scheduleMicRelease() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleTimer = null; if (!pushed) releaseMic(); }, MIC_IDLE_MS);
  }

  const micTrack = () => (pushed && mic ? mic.getAudioTracks()[0] ?? null : null);

  // Put the mic on (or take it off) every link — no renegotiation needed.
  function attachTrack(track) {
    for (const pc of peers.values()) senderOf(pc)?.replaceTrack(track).catch(() => {});
  }

  /* ---------- peers ---------- */

  const senderOf = pc => pc.getTransceivers()[0]?.sender ?? null;

  function roster(state) {
    const people = [
      ...(state.players || []).filter(p => p.connected),
      ...(state.spectators || []),
    ];
    return people.filter(p => p.inVoice && p.peerId && p.peerId !== myId);
  }

  function createPeer(peerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peers.set(peerId, pc);
    gaveUp.delete(peerId); // a fresh connection gets a fresh retry budget

    // The offerer opens the audio line; the answerer's appears with the offer.
    if (isInitiator(peerId)) {
      const t = pc.addTransceiver('audio', {
        direction: 'sendrecv',
        sendEncodings: [{ maxBitrate: MAX_BITRATE }],
      });
      const track = micTrack();
      if (track) t.sender.replaceTrack(track).catch(() => {});
    }

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
      audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      audio.play().catch(() => {}); // unlocked on first tap if blocked
    };
    pc.onnegotiationneeded = async () => {
      if (!isInitiator(peerId)) return;
      try {
        await pc.setLocalDescription(await pc.createOffer());
        sendSdp(peerId, pc.localDescription);
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

  function dropAllPeers() {
    for (const peerId of [...peers.keys()]) dropPeer(peerId);
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

  // Append our Opus wishes to the fmtp line; the far side's encoder obeys
  // the parameters in the description it receives from us.
  function tuneOpus(sdp) {
    const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1];
    if (!pt) return sdp;
    return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (line, params) => {
      const extra = Object.entries(OPUS_PARAMS)
        .filter(([k]) => !new RegExp(`(^|;)\\s*${k}=`).test(params))
        .map(([k, v]) => `${k}=${v}`);
      return extra.length ? `${line};${extra.join(';')}` : line;
    });
  }

  function sendSdp(peerId, desc) {
    send({ type: 'rtc', to: peerId, data: { kind: 'sdp', sdp: { type: desc.type, sdp: tuneOpus(desc.sdp) } } });
  }

  // Answerer side: the offer created our transceiver as receive-only — open
  // it both ways, put the mic on if we're mid-press, and cap the bitrate.
  async function prepareAnswerer(pc) {
    const t = pc.getTransceivers()[0];
    if (!t) return;
    if (t.direction !== 'sendrecv') t.direction = 'sendrecv';
    const track = micTrack();
    if (track && t.sender.track !== track) await t.sender.replaceTrack(track).catch(() => {});
  }

  async function capBitrate(sender) {
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) return;
      if (params.encodings[0].maxBitrate === MAX_BITRATE) return;
      params.encodings[0].maxBitrate = MAX_BITRATE;
      await sender.setParameters(params);
    } catch { /* not supported here — the Opus fmtp still applies */ }
  }

  async function handleRtc(msg) {
    if (!joined) return;
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
          await prepareAnswerer(pc);
          await pc.setLocalDescription(await pc.createAnswer());
          sendSdp(peerId, pc.localDescription);
        }
        capBitrate(senderOf(pc));
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

  function announce(on) {
    if (announced === on) return;
    announced = on;
    send({ type: 'voice', speaking: on });
  }

  async function setPushed(on) {
    if (pushed === on) return;
    if (on && (!joined || listenOnly || micBlocked)) return;
    pushed = on;
    clearTimeout(idleTimer); idleTimer = null;
    updateButtons();
    if (!on) {
      attachTrack(null);
      announce(false);
      if (mic) scheduleMicRelease();
      return;
    }
    const stream = await acquireMic();
    if (!stream) { pushed = false; updateButtons(); return; }
    if (!pushed) { scheduleMicRelease(); return; } // let go while the mic was opening
    attachTrack(stream.getAudioTracks()[0] ?? null);
    announce(true);
  }

  /* ---------- buttons ---------- */

  function updateButtons() {
    const voiceBtn = $('#btn-voice');
    const talkBtn = $('#btn-talk');
    voiceBtn.hidden = !myId;
    voiceBtn.classList.toggle('on', joined);
    voiceBtn.title = joined ? 'Leave voice' : 'Join voice';
    voiceBtn.setAttribute('aria-pressed', String(joined));

    talkBtn.hidden = !myId || !joined;
    talkBtn.classList.toggle('talking', pushed);
    if (listenOnly) {
      talkBtn.disabled = true;
      talkBtn.textContent = '👂';
      talkBtn.title = 'Watching — listen only';
    } else if (micBlocked) {
      talkBtn.disabled = true;
      talkBtn.textContent = '🔇';
      talkBtn.title = 'Microphone blocked';
    } else {
      talkBtn.disabled = false;
      talkBtn.textContent = pushed ? '🎙️' : '🎙';
      talkBtn.title = 'Hold to talk (or hold Space)';
    }
  }

  /* ---------- joining & leaving ---------- */

  function joinVoice() {
    if (joined || !myId) return;
    joined = true;
    leftWhileAway = false;
    send({ type: 'voice_join', on: true });
    updateButtons();
    // Ask for the mic now (inside this tap) so the first press is instant,
    // then let it go if nobody talks soon.
    if (!listenOnly) acquireMic().then(stream => { if (stream && !pushed) scheduleMicRelease(); });
    for (const audio of audioEls.values()) audio.play().catch(() => {});
  }

  function leaveVoice({ notify = true } = {}) {
    if (!joined) return;
    setPushed(false);
    announce(false);
    joined = false;
    if (notify) send({ type: 'voice_join', on: false });
    dropAllPeers();
    releaseMic();
    speaking.clear();
    gaveUp.clear();
    applySpeaking();
    updateButtons();
  }

  /* ---------- lifecycle ---------- */

  // Called on every state broadcast: sync the mesh with who's in voice.
  function update(state) {
    myId = state.youPeerId ?? myId;
    if (!myId) return;
    const wasListenOnly = listenOnly;
    listenOnly = state.youSeat < 0;
    if (listenOnly && !wasListenOnly) { setPushed(false); releaseMic(); }
    updateButtons();
    if (!joined) { dropAllPeers(); return; }

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

  // The socket (re)joined the room: the server forgets voice membership on
  // disconnect, so re-assert it.
  function rejoined() {
    announced = false;
    if (joined) send({ type: 'voice_join', on: true });
  }

  function reset() {
    leaveVoice({ notify: false });
    clearTimeout(awayTimer); awayTimer = null;
    leftWhileAway = false;
    micBlocked = false;
    myId = null;
    $('#btn-talk').hidden = true;
    $('#btn-voice').hidden = true;
  }

  /* ---------- UI wiring ---------- */

  $('#btn-voice').addEventListener('click', () => (joined ? leaveVoice() : joinVoice()));

  const talkBtn = $('#btn-talk');
  talkBtn.addEventListener('pointerdown', e => { e.preventDefault(); setPushed(true); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
    talkBtn.addEventListener(ev, () => setPushed(false));
  }
  talkBtn.addEventListener('contextmenu', e => e.preventDefault());

  const inTextField = () => /^(input|textarea)$/i.test(document.activeElement?.tagName ?? '');
  window.addEventListener('keydown', e => {
    if (e.code === 'Space' && !e.repeat && !inTextField() && joined && !talkBtn.hidden) {
      e.preventDefault();
      setPushed(true);
    }
  });
  window.addEventListener('keyup', e => {
    if (e.code === 'Space' && !inTextField()) setPushed(false);
  });

  // Backgrounded: nobody is holding the button, so close the mic at once;
  // still away after a minute, leave voice entirely to stop the mesh.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      setPushed(false);
      releaseMic();
      clearTimeout(awayTimer);
      if (joined) {
        awayTimer = setTimeout(() => {
          awayTimer = null;
          if (document.hidden && joined) { leaveVoice(); leftWhileAway = true; }
        }, AWAY_LEAVE_MS);
      }
    } else {
      clearTimeout(awayTimer); awayTimer = null;
      if (leftWhileAway) {
        leftWhileAway = false;
        toast('🎧 Voice paused while you were away — tap 🎧 to rejoin');
      }
    }
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

  return { update, handleRtc, handleSpeaking, rejoined, reset };
}
