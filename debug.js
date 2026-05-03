// ── Debug logger ──────────────────────────────────────────────────────────
// Runs as a plain (non-module) script so log() is global
// and available to app.js which loads after this.

function log(msg, type) {
type = type || 'info';
var time = new Date().toLocaleTimeString('en-US', { hour12: false });
var dl   = document.getElementById('debug-log');
if (dl) {
var line = document.createElement('div');
line.className   = 'log-line log-' + type;
line.textContent = time + '  ' + msg;
dl.appendChild(line);
dl.scrollTop = dl.scrollHeight;
}
// Mirror to page title so it's visible in background tabs
document.title = msg.slice(0, 50);
console.log('[' + type + '] ' + msg);
}

// ── Global error capture ──────────────────────────────────────────────────
window.addEventListener('error', function (e) {
log('JS ERROR: ' + e.message + ' (line ' + e.lineno + ')', 'error');
});
window.addEventListener('unhandledrejection', function (e) {
log('UNHANDLED PROMISE: ' + e.reason, 'error');
});

// ── Debug panel toggle ────────────────────────────────────────────────────
document.getElementById('debug-toggle').addEventListener('click', function () {
var panel = document.getElementById('debug-panel');
panel.classList.toggle('hidden');
this.textContent = panel.classList.contains('hidden') ? '⌥ DEBUG' : '✕ DEBUG';
});

// ── Boot diagnostics ──────────────────────────────────────────────────────
log('Page loaded ✓', 'ok');
log('Protocol: ' + location.protocol,
location.protocol === 'https:' ? 'ok' : 'warn');
log('getUserMedia: ' + (
!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
? 'available ✓' : 'MISSING ✗'),
!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
? 'ok' : 'error');
