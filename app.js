// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  WALKIE — app.js  (ES module)                                           ║
// ║  Architecture:                                                          ║
// ║    • LOBBY ROOM  — silent background room, heat map + lock-out          ║
// ║    • CHANNEL ROOM — audio + PTT, max 2 peers                            ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ── Trystero CDN strategies (tried in order, first to load wins) ──────────
const STRATEGIES = [
{ name: ‘nostr’,   urls: [‘https://esm.sh/trystero/nostr’,   ‘https://cdn.skypack.dev/trystero/nostr’]   },
{ name: ‘mqtt’,    urls: [‘https://esm.sh/trystero/mqtt’,    ‘https://cdn.skypack.dev/trystero/mqtt’]    },
{ name: ‘torrent’, urls: [‘https://esm.sh/trystero/torrent’, ‘https://cdn.skypack.dev/trystero/torrent’] },
];

const NOSTR_RELAYS = [
‘wss://relay.damus.io’,
‘wss://nos.lol’,
‘wss://relay.snort.social’,
‘wss://relay.nostr.band’,
];

const APP_ID      = ‘walkie-ptt-v3’;
const LOBBY_CODE  = ‘walkie-lobby-v1’;  // fixed room everyone joins
const TICK_W      = 28;                 // px — must match CSS .ch-tick width
const TOTAL_CH    = 40;
const BASE_FREQ   = 462.5625;           // MHz FRS ch1
const FREQ_STEP   = 0.025;             // MHz per channel

// ── DOM references ────────────────────────────────────────────────────────
const pttBtn        = document.getElementById(‘ptt-button’);
const feedbackEl    = document.getElementById(‘feedback-display’);
const peerIdDisplay = document.getElementById(‘peer-id-display’);
const tunerPanel    = document.getElementById(‘tuner-panel’);
const lockedBadge   = document.getElementById(‘locked-badge’);
const lockedFreqEl  = document.getElementById(‘locked-freq’);
const lockedChEl    = document.getElementById(‘locked-ch’);
const squelchLed    = document.getElementById(‘squelch-led’);
const tuneBtn       = document.getElementById(‘tune-btn’);
const chDownBtn     = document.getElementById(‘ch-down’);
const chUpBtn       = document.getElementById(‘ch-up’);
const disconnectRow = document.getElementById(‘disconnect-row’);
const disconnectBtn = document.getElementById(‘disconnect-btn’);
const busyModal     = document.getElementById(‘busy-modal’);
const modalCancel   = document.getElementById(‘modal-cancel’);
const modalJoin     = document.getElementById(‘modal-join’);
const countdownBar  = document.getElementById(‘countdown-bar’);
const countdownFill = document.getElementById(‘countdown-fill’);

// ── App state ─────────────────────────────────────────────────────────────
let currentCh    = 7;
let lobbyRoom    = null;
let channelRoom  = null;
let localStream  = null;
let sendPresence = null;   // lobby action sender
let peerMap      = {};     // peerId → { ch, status }
let countdownTimer = null;

// My own lobby presence — updated on every state change
let myPresence = { ch: currentCh, status: ‘idle’ };

// ── Strategy loader ───────────────────────────────────────────────────────
async function loadStrategy() {
for (const strat of STRATEGIES) {
for (const url of strat.urls) {
try {
log(‘Trying ’ + strat.name + ’ (’ + url + ‘)…’);
const mod = await import(url);
log(strat.name + ’ loaded ✓’, ‘ok’);
return { joinRoom: mod.joinRoom, name: strat.name };
} catch (e) {
log(strat.name + ’ failed: ’ + (e.message || e), ‘warn’);
}
}
}
throw new Error(‘All signaling strategies failed’);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function freqForCh(ch) {
return (BASE_FREQ + (ch - 1) * FREQ_STEP).toFixed(4);
}
function roomCodeForCh(ch) {
return ‘walkie-frs-ch’ + String(ch).padStart(2, ‘0’);
}
function chLabel(ch) {
return ’CHANNEL ’ + String(ch).padStart(2, ‘0’);
}
function setState(name) {
document.body.className = ‘state-’ + name;
log(’State → ’ + name);
}
function feedback(msg) {
feedbackEl.textContent = msg;
}

// ── Lobby presence ────────────────────────────────────────────────────────
function broadcastPresence(ch, status) {
myPresence = { ch, status };
if (sendPresence) {
try { sendPresence(myPresence); } catch (e) { /* lobby not ready */ }
}
}

// ── Heat map ──────────────────────────────────────────────────────────────
function channelCount(ch) {
// Count only OTHER peers (not self) on a given channel, excluding idle
return Object.values(peerMap).filter(p => p.ch === ch && p.status !== ‘idle’).length;
}
function channelBusyCount(ch) {
// Peers locked or connected — these occupy the channel
return Object.values(peerMap).filter(p => p.ch === ch &&
(p.status === ‘locked’ || p.status === ‘connected’)).length;
}

function updateHeatMap() {
document.querySelectorAll(’.ch-tick’).forEach((tick, i) => {
const ch      = i + 1;
const total   = channelCount(ch);
const busy    = channelBusyCount(ch);
const badge   = tick.querySelector(’.tick-badge’);

```
    // Heat classes
    tick.classList.remove('heat-low', 'heat-busy');
    if (busy >= 2)   tick.classList.add('heat-busy');
    else if (total > 0) tick.classList.add('heat-low');

    // Badge
    if (total > 0) {
        badge.classList.remove('hidden');
        badge.classList.toggle('busy', busy >= 2);
        badge.textContent = busy >= 2 ? 'BUSY' : String(total);
    } else {
        badge.classList.add('hidden');
        badge.classList.remove('busy');
    }
});
```

}

// ── Lobby room ────────────────────────────────────────────────────────────
async function initLobby(strategy) {
log(‘Joining lobby room…’);
const config = { appId: APP_ID };
if (strategy.name === ‘nostr’) config.relayUrls = NOSTR_RELAYS;

```
try {
    lobbyRoom = strategy.joinRoom(config, LOBBY_CODE);
} catch (e) {
    log('Lobby join failed: ' + e.message, 'warn');
    return; // non-fatal — heat map just won't work
}

// Set up the presence data channel
[sendPresence] = lobbyRoom.makeAction('presence');
const [, getPresence] = lobbyRoom.makeAction('presence');

// Send MY current status to every new lobby peer
lobbyRoom.onPeerJoin(peerId => {
    log('Lobby peer joined: ' + peerId.slice(0, 8), 'info');
    try { sendPresence(myPresence, peerId); } catch (e) {}
});

// Receive others' presence updates
getPresence((data, peerId) => {
    peerMap[peerId] = data;
    updateHeatMap();
});

// Remove departed peers
lobbyRoom.onPeerLeave(peerId => {
    log('Lobby peer left: ' + peerId.slice(0, 8), 'info');
    delete peerMap[peerId];
    updateHeatMap();
});

log('Lobby ready ✓', 'ok');
// Broadcast initial idle presence
broadcastPresence(currentCh, 'idle');
```

}

// ── Microphone ────────────────────────────────────────────────────────────
async function setupMedia() {
log(‘Requesting microphone…’);
try {
localStream = await navigator.mediaDevices.getUserMedia({
audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
});
localStream.getAudioTracks()[0].enabled = false; // muted until PTT
pttBtn.disabled = false;
feedback(‘SCANNING…’);
log(‘Microphone granted ✓’, ‘ok’);
} catch (e) {
log(’Mic denied: ’ + e.name + ’ — ’ + e.message, ‘error’);
feedback(‘MIC DENIED’);
}
}

// ── Remote audio ──────────────────────────────────────────────────────────
function playStream(stream) {
let audio = document.getElementById(‘remote-audio’);
if (!audio) {
audio = document.createElement(‘audio’);
audio.id = ‘remote-audio’;
audio.autoplay = true;
audio.setAttribute(‘playsinline’, ‘’);
document.body.appendChild(audio);
}
audio.srcObject = stream;
audio.play().catch(e => log(’Audio play: ’ + e.message, ‘warn’));
log(‘Remote audio playing ✓’, ‘ok’);
}

// ── Countdown (peer disconnected) ─────────────────────────────────────────
function startCountdown(onComplete) {
let remaining = 3;

```
countdownBar.classList.remove('hidden');
countdownFill.style.transition = 'none';
countdownFill.style.width = '100%';

// Kick off the shrink after one frame so the transition fires
requestAnimationFrame(() => {
    requestAnimationFrame(() => {
        countdownFill.style.transition = 'width ' + remaining + 's linear';
        countdownFill.style.width = '0%';
    });
});

function tick() {
    remaining--;
    if (remaining <= 0) {
        countdownBar.classList.add('hidden');
        onComplete();
    } else {
        feedback('RETURNING IN ' + remaining + '...');
        countdownTimer = setTimeout(tick, 1000);
    }
}
feedback('RETURNING IN ' + remaining + '...');
countdownTimer = setTimeout(tick, 1000);
```

}

function clearCountdown() {
if (countdownTimer) { clearTimeout(countdownTimer); countdownTimer = null; }
countdownBar.classList.add(‘hidden’);
}

// ── Disconnect ────────────────────────────────────────────────────────────
function disconnect(reason) {
reason = reason || ‘USER’;
log(‘Disconnecting (’ + reason + ‘)…’, ‘warn’);

```
clearCountdown();

// Stop outgoing audio
if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
}

// Leave channel room
if (channelRoom) {
    try { channelRoom.leave(); } catch (e) {}
    channelRoom = null;
}

// Silence remote audio
const audio = document.getElementById('remote-audio');
if (audio) audio.srcObject = null;

// Reset UI
pttBtn.disabled = true;
squelchLed.classList.remove('open');
lockedBadge.classList.add('hidden', 'scanning');
disconnectRow.classList.add('hidden');

tunerPanel.classList.remove('hidden');
tuneBtn.disabled   = false;
chDownBtn.disabled = false;
chUpBtn.disabled   = false;

feedback('STANDBY');
setState('idle');

// Broadcast idle to lobby
broadcastPresence(currentCh, 'idle');
log('Disconnected — tuner restored ✓', 'ok');
```

}

disconnectBtn.addEventListener(‘click’, () => disconnect(‘USER’));

// ── Channel room ──────────────────────────────────────────────────────────
async function enterRoom(code) {
log(‘Loading signaling library…’);
let strategy;
try {
strategy = await loadStrategy();
} catch (e) {
log(’No strategy available: ’ + e.message, ‘error’);
feedback(‘NETWORK BLOCKED’);
disconnect(‘LOAD_FAIL’);
return;
}

```
// Boot lobby on first successful strategy load (fire-and-forget)
if (!lobbyRoom) initLobby(strategy).catch(e => log('Lobby error: ' + e.message, 'warn'));

const config = { appId: APP_ID };
if (strategy.name === 'nostr') config.relayUrls = NOSTR_RELAYS;

log('Joining channel room "' + code + '"...');
try {
    channelRoom = strategy.joinRoom(config, code);
} catch (e) {
    log('joinRoom failed: ' + e.message, 'error');
    feedback('JOIN FAILED');
    disconnect('JOIN_FAIL');
    return;
}

// ── Peer joins → send stream, update UI ─────────────────────────────
channelRoom.onPeerJoin(peerId => {
    log('Peer joined ✓ ' + peerId.slice(0, 8), 'ok');
    feedback('PEER CONNECTED');
    lockedChEl.textContent = chLabel(currentCh) + ' · LIVE';
    lockedBadge.classList.remove('scanning');
    squelchLed.classList.add('open');
    setState('connected');
    broadcastPresence(currentCh, 'connected');

    if (localStream) {
        try { channelRoom.addStream(localStream, peerId); log('Stream sent ✓', 'ok'); }
        catch (e) { log('addStream: ' + e.message, 'warn'); }
    }
});

// ── Peer leaves → 3-second countdown then auto-return ───────────────
channelRoom.onPeerLeave(peerId => {
    log('Peer left: ' + peerId.slice(0, 8), 'warn');
    pttBtn.disabled = true;
    squelchLed.classList.remove('open');
    lockedBadge.classList.add('scanning');
    lockedChEl.textContent = chLabel(currentCh) + ' · DISCONNECTED';
    setState('connected'); // stay green until countdown finishes
    broadcastPresence(currentCh, 'locked');

    feedback('PEER DISCONNECTED');
    startCountdown(() => disconnect('PEER_LEFT'));
});

// ── Receive remote stream ────────────────────────────────────────────
channelRoom.onPeerStream((stream, peerId) => {
    log('Stream received from ' + peerId.slice(0, 8) + ' ✓', 'ok');
    playStream(stream);
});

log('Channel room joined — setting up mic...');
await setupMedia();

// Handle peers already in room when we join
if (channelRoom.getPeers) {
    const existing = channelRoom.getPeers();
    if (existing && existing.length > 0) {
        log('Sending stream to ' + existing.length + ' existing peer(s)', 'ok');
        existing.forEach(pid => {
            try { channelRoom.addStream(localStream, pid); } catch (e) {}
        });
    }
}
```

}

// ── Busy channel modal ────────────────────────────────────────────────────
function showBusyModal(ch, onJoinAnyway) {
document.getElementById(‘modal-ch-num’).textContent = String(ch).padStart(2, ‘0’);
busyModal.classList.remove(‘hidden’);

```
function cleanup() {
    busyModal.classList.add('hidden');
    modalCancel.removeEventListener('click', onCancel);
    modalJoin.removeEventListener('click', onJoin);
}
function onCancel() {
    cleanup();
    // Restore tuner controls
    tuneBtn.disabled   = false;
    chDownBtn.disabled = false;
    chUpBtn.disabled   = false;
    tunerPanel.classList.remove('hidden');
    lockedBadge.classList.add('hidden');
    disconnectRow.classList.add('hidden');
}
function onJoin() {
    cleanup();
    onJoinAnyway();
}

modalCancel.addEventListener('click', onCancel);
modalJoin.addEventListener('click', onJoin);
```

}

// ── Tune In ───────────────────────────────────────────────────────────────
async function tuneIn() {
const ch    = currentCh;
const freq  = freqForCh(ch);
const code  = roomCodeForCh(ch);

```
// Disable tuner controls
tuneBtn.disabled   = true;
chDownBtn.disabled = true;
chUpBtn.disabled   = true;

// Swap tuner for locked badge
tunerPanel.classList.add('hidden');
lockedBadge.classList.remove('hidden');
lockedBadge.classList.add('scanning');
lockedFreqEl.textContent = freq + ' MHz';
lockedChEl.textContent   = chLabel(ch) + ' · SCANNING...';
disconnectRow.classList.remove('hidden');

// Check if channel is busy (2+ peers already locked/connected)
const busyCount = channelBusyCount(ch);
if (busyCount >= 2) {
    showBusyModal(ch, () => proceedToJoin(ch, freq, code));
    return;
}

proceedToJoin(ch, freq, code);
```

}

async function proceedToJoin(ch, freq, code) {
feedback(‘TUNING ’ + freq + ’ MHz…’);
setState(‘connected’);
broadcastPresence(ch, ‘locked’);
await enterRoom(code);
}

tuneBtn.addEventListener(‘click’, tuneIn);

// ── Frequency tuner UI ────────────────────────────────────────────────────
function updateTape(animate) {
const tape    = document.getElementById(‘freq-tape’);
const wrapper = document.getElementById(‘tape-wrapper’);

```
if (animate) tape.classList.add('animated');
else         tape.classList.remove('animated');

const offset = wrapper.offsetWidth / 2 - (currentCh - 0.5) * TICK_W;
tape.style.transform = 'translateX(' + offset + 'px)';

document.querySelectorAll('.ch-tick').forEach((tick, i) => {
    const d = Math.abs((i + 1) - currentCh);
    tick.classList.toggle('active',   d === 0);
    tick.classList.toggle('near-one', d === 1);
    tick.classList.toggle('near-two', d === 2);
});

document.getElementById('tuner-ch').textContent   = 'CH ' + String(currentCh).padStart(2, '0');
document.getElementById('tuner-freq').textContent = freqForCh(currentCh);
peerIdDisplay.textContent = String(currentCh).padStart(2, '0');
```

}

function buildTape() {
const tape = document.getElementById(‘freq-tape’);
tape.innerHTML = ‘’;
for (let ch = 1; ch <= TOTAL_CH; ch++) {
const isMajor = (ch % 5 === 0 || ch === 1);
const el = document.createElement(‘div’);
el.className = ‘ch-tick’ + (isMajor ? ’ major’ : ‘’) + (ch === currentCh ? ’ active’ : ‘’);
el.innerHTML =
‘<div class="tick-badge hidden"></div>’ +
‘<div class="tick-num">’ + (isMajor ? String(ch).padStart(2, ‘0’) : ‘’) + ‘</div>’ +
‘<div class="tick-bar"></div>’;
tape.appendChild(el);
}
updateTape(false);
}

function setChannel(ch, animate = true) {
currentCh = Math.max(1, Math.min(TOTAL_CH, ch));
updateTape(animate);
if (navigator.vibrate) navigator.vibrate(8);
// Broadcast tuning presence to lobby
broadcastPresence(currentCh, ‘tuning’);
}

// Drag / swipe on tape
(function initDrag() {
const wrapper = document.getElementById(‘tape-wrapper’);
let dragging = false, startX = 0, startCh = currentCh, lastCh = currentCh;

```
wrapper.addEventListener('pointerdown', e => {
    dragging = true; startX = e.clientX; startCh = currentCh; lastCh = currentCh;
    wrapper.setPointerCapture(e.pointerId);
    document.getElementById('freq-tape').classList.remove('animated');
});
wrapper.addEventListener('pointermove', e => {
    if (!dragging) return;
    const newCh = Math.max(1, Math.min(TOTAL_CH,
        startCh + Math.round((startX - e.clientX) / TICK_W)));
    if (newCh !== lastCh) {
        lastCh = newCh; currentCh = newCh;
        updateTape(false);
        broadcastPresence(currentCh, 'tuning');
        if (navigator.vibrate) navigator.vibrate(6);
    }
});
wrapper.addEventListener('pointerup',     () => { dragging = false; });
wrapper.addEventListener('pointercancel', () => { dragging = false; });
```

})();

chDownBtn.addEventListener(‘click’, () => setChannel(currentCh - 1));
chUpBtn.addEventListener(‘click’,   () => setChannel(currentCh + 1));

// Keyboard arrows (when tuner is visible)
document.addEventListener(‘keydown’, e => {
if (tunerPanel.classList.contains(‘hidden’)) return;
if (e.key === ‘ArrowLeft’)  { setChannel(currentCh - 1); e.preventDefault(); }
if (e.key === ‘ArrowRight’) { setChannel(currentCh + 1); e.preventDefault(); }
});

// ── PTT ───────────────────────────────────────────────────────────────────
function startTX() {
if (!localStream || pttBtn.disabled) return;
if (navigator.vibrate) navigator.vibrate(50);
localStream.getAudioTracks()[0].enabled = true;
setState(‘tx’);
feedback(‘TRANSMITTING…’);
}
function stopTX() {
if (!localStream) return;
localStream.getAudioTracks()[0].enabled = false;
setState(‘connected’);
feedback(‘STANDBY’);
}

pttBtn.addEventListener(‘touchstart’,  e => { e.preventDefault(); startTX(); }, { passive: false });
pttBtn.addEventListener(‘touchend’,    e => { e.preventDefault(); stopTX();  }, { passive: false });
pttBtn.addEventListener(‘touchcancel’, e => { e.preventDefault(); stopTX();  }, { passive: false });
pttBtn.addEventListener(‘mousedown’,  startTX);
pttBtn.addEventListener(‘mouseup’,    stopTX);
pttBtn.addEventListener(‘mouseleave’, stopTX);

// Spacebar PTT (desktop)
document.addEventListener(‘keydown’, e => {
if (e.code === ‘Space’ && !e.repeat && !tunerPanel.classList.contains(‘hidden’) === false) {
e.preventDefault(); startTX();
}
});
document.addEventListener(‘keyup’, e => { if (e.code === ‘Space’) stopTX(); });

// ── Cleanup on page unload ────────────────────────────────────────────────
window.addEventListener(‘beforeunload’, () => {
broadcastPresence(null, ‘idle’);
if (channelRoom) try { channelRoom.leave(); } catch (e) {}
if (lobbyRoom)   try { lobbyRoom.leave();   } catch (e) {}
if (localStream) localStream.getTracks().forEach(t => t.stop());
});

// ── Init ──────────────────────────────────────────────────────────────────
buildTape();
log(‘Tuner ready · ’ + TOTAL_CH + ’ channels ✓’, ‘ok’);
