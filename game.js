import { Rink, PointerOwnership, toWorld, clamp, WIDTH, RAIL, GOAL_WIDTH } from './physics.js';

const $ = (id) => document.getElementById(id);
const canvas = $('rink');
const ctx = canvas.getContext('2d', { alpha: false });
const staticCanvas = document.createElement('canvas');
const floor = staticCanvas.getContext('2d', { alpha: false });
const colors = ['#c4ed83', '#ff815e'];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const pointers = new PointerOwnership();
const keys = new Set();
const settings = { mode: 'solo', level: 'normal', target: 7, sound: true };
try {
  const saved = JSON.parse(localStorage.getItem('faceoff-settings') || '{}');
  if (['solo', 'local'].includes(saved.mode)) settings.mode = saved.mode;
  if (['easy', 'normal', 'hard'].includes(saved.level)) settings.level = saved.level;
  if ([5, 7, 11].includes(saved.target)) settings.target = saved.target;
  if (typeof saved.sound === 'boolean') settings.sound = saved.sound;
} catch { /* Storage is optional, including in private browsing. */ }
let rink = null;
let view = { cx: 0, cy: 0, scale: 1, height: 1000, rotated: false, dpr: 1 };
let lastTime = 0;
let particles = [];
let trail = [];
let flash = 0;
let flashSide = 1;
let lastCue = '';
let audio = null;
let lastClick = 0;
let wakeLock = null;
let session = 0;
let resultTimer = null;

function saveSettings() { try { localStorage.setItem('faceoff-settings', JSON.stringify(settings)); } catch { /* Optional. */ } }
function syncSettings() {
  for (const b of document.querySelectorAll('[data-mode]')) select(b, b.dataset.mode === settings.mode);
  for (const b of document.querySelectorAll('[data-level]')) select(b, b.dataset.level === settings.level);
  for (const b of document.querySelectorAll('[data-goals]')) select(b, Number(b.dataset.goals) === settings.target);
  $('difficulty-row').hidden = settings.mode === 'local';
  $('local-hint').hidden = settings.mode !== 'local';
  for (const b of document.querySelectorAll('.sound-button')) {
    b.setAttribute('aria-pressed', String(settings.sound));
    b.setAttribute('aria-label', settings.sound ? 'Turn sound off' : 'Turn sound on');
    if (!b.querySelector('svg')) b.textContent = settings.sound ? 'Sound on' : 'Sound off';
  }
}
function select(button, selected) { button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); }
for (const button of document.querySelectorAll('[data-mode],[data-level],[data-goals]')) button.addEventListener('click', () => {
  if (button.dataset.mode) settings.mode = button.dataset.mode;
  if (button.dataset.level) settings.level = button.dataset.level;
  if (button.dataset.goals) settings.target = Number(button.dataset.goals);
  syncSettings(); saveSettings();
});
for (const button of document.querySelectorAll('.sound-button')) button.addEventListener('click', () => {
  settings.sound = !settings.sound;
  unlockAudio(); syncSettings(); saveSettings();
  if (settings.sound) tone(540, .07, .04);
});
syncSettings();

function unlockAudio() {
  try {
    if (!audio) { const Audio = window.AudioContext || window.webkitAudioContext; if (Audio) audio = new Audio(); }
    if (audio?.state === 'suspended') void audio.resume().catch(() => {});
  } catch { /* Audio must never prevent playing. */ }
}
function tone(frequency, duration, volume = .04, shape = 'sine', delay = 0) {
  if (!settings.sound || !audio || audio.state !== 'running') return;
  const oscillator = audio.createOscillator(), gain = audio.createGain();
  const at = audio.currentTime + delay;
  oscillator.type = shape;
  oscillator.frequency.setValueAtTime(frequency, at);
  oscillator.frequency.exponentialRampToValueAtTime(frequency * .65, at + duration);
  gain.gain.setValueAtTime(volume, at);
  gain.gain.exponentialRampToValueAtTime(.001, at + duration);
  oscillator.connect(gain); gain.connect(audio.destination);
  oscillator.start(at); oscillator.stop(at + duration + .01);
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
}
async function keepAwake() {
  if (!('wakeLock' in navigator) || wakeLock || !rink || rink.paused || rink.phase === 'finished') return;
  const requestSession = session;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (requestSession !== session || !rink || rink.paused || rink.phase === 'finished') { await lock.release(); return; }
    wakeLock = lock;
    lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
  } catch { /* Browser support, battery saving and permission can differ. */ }
}
function releaseWakeLock() { if (wakeLock) { void wakeLock.release().catch(() => {}); wakeLock = null; } }

function startMatch() {
  clearTimeout(resultTimer); session++;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  unlockAudio();
  $('home').hidden = true; $('game').hidden = false;
  document.body.style.overflow = 'hidden';
  clearInputs();
  rink = null;
  fitTable(false);
  rink = new Rink({ ...settings, height: view.height, onEvent: event });
  particles = []; trail = []; flash = 0; lastCue = '';
  $('top-name').textContent = settings.mode === 'solo' ? 'THE MACHINE' : 'MINT / P2';
  $('bottom-name').textContent = settings.mode === 'solo' ? 'YOU / P1' : 'CORAL / P1';
  $('match-label').textContent = `FIRST TO ${settings.target}`;
  rink.start(); syncScores(); drawFloor();
  canvas.focus({ preventScroll: true });
  void keepAwake();
}
function goHome() {
  clearTimeout(resultTimer); session++;
  clearInputs(); rink = null; releaseWakeLock();
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('game').hidden = true; $('home').hidden = false;
  document.body.style.overflow = '';
  $('start-button').focus({ preventScroll: true });
}
function clearInputs() {
  for (const [id, side] of pointers.owners) {
    rink?.stopPaddle(side);
    try { if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id); } catch { /* Already released. */ }
  }
  pointers.clear(); keys.clear();
  if (rink) { rink.stopPaddle(1); if (settings.mode === 'local') rink.stopPaddle(0); }
}
function pause(reason = 'Your match is right where you left it.') {
  if (!rink || rink.phase === 'finished' || rink.paused) return;
  rink.paused = true; clearInputs(); releaseWakeLock();
  $('pause-reason').textContent = reason;
  $('pause-dialog').showModal();
  $('resume-button').focus();
}
function resume() {
  $('pause-dialog').close();
  if (!rink) return;
  rink.paused = false; rink.accumulator = 0;
  lastTime = performance.now(); unlockAudio();
  canvas.focus({ preventScroll: true });
  void keepAwake();
}
$('start-button').addEventListener('click', startMatch);
$('rematch-button').addEventListener('click', startMatch);
$('restart-button').addEventListener('click', startMatch);
$('menu-button').addEventListener('click', goHome);
$('result-menu-button').addEventListener('click', goHome);
$('resume-button').addEventListener('click', resume);
$('how-button').addEventListener('click', () => $('help-dialog').showModal());
for (const button of document.querySelectorAll('.pause-button')) button.addEventListener('click', () => pause());
$('pause-dialog').addEventListener('cancel', e => { e.preventDefault(); resume(); });
$('result-dialog').addEventListener('cancel', e => { e.preventDefault(); goHome(); });
$('fullscreen-button').hidden = !document.fullscreenEnabled;
$('fullscreen-button').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
    $('fullscreen-button').textContent = document.fullscreenElement ? 'Exit full screen ↙' : 'Full screen ↗';
  } catch { $('fullscreen-button').textContent = 'Full screen unavailable'; }
});
document.addEventListener('fullscreenchange', () => {
  $('fullscreen-button').textContent = document.fullscreenElement ? 'Exit full screen ↙' : 'Full screen ↗';
});
window.addEventListener('blur', () => pause('Paused while you were away. Ready when you are.'));
document.addEventListener('visibilitychange', () => { if (document.hidden) pause('Paused while you were away. Ready when you are.'); });

function fitTable(allowPause = true) {
  if ($('game').hidden) return;
  const bounds = $('game').getBoundingClientRect();
  const style = getComputedStyle($('game'));
  const l = parseFloat(style.paddingLeft), r = parseFloat(style.paddingRight), t = parseFloat(style.paddingTop), b = parseFloat(style.paddingBottom);
  const w = bounds.width - l - r, h = bounds.height - t - b;
  const rotated = w > h * 1.1;
  const short = rotated ? h : w, long = rotated ? w : h;
  const scale = Math.min(short / WIDTH, long / 780);
  const height = long / scale;
  const changed = rotated !== view.rotated || Math.abs(height - view.height) > 90;
  view = { cx: bounds.left + l + w / 2, cy: bounds.top + t + h / 2, scale, height, rotated, dpr: Math.min(window.devicePixelRatio || 1, 2) };
  const stage = $('stage');
  stage.style.width = `${WIDTH * scale}px`; stage.style.height = `${height * scale}px`;
  stage.style.left = `${l + w / 2}px`; stage.style.top = `${t + h / 2}px`;
  stage.style.transform = `translate(-50%, -50%) rotate(${rotated ? 90 : 0}deg)`;
  canvas.width = Math.round(WIDTH * scale * view.dpr); canvas.height = Math.round(height * scale * view.dpr);
  staticCanvas.width = canvas.width; staticCanvas.height = canvas.height;
  if (rink) {
    rink.resize(height); trail = [];
    if (changed && allowPause) pause('The table has turned. Get settled, then keep playing.');
  }
  drawFloor();
}
let resizeFrame;
window.addEventListener('resize', () => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(() => fitTable()); });

canvas.addEventListener('pointerdown', e => {
  if (!rink || rink.paused || rink.phase === 'finished' || (e.pointerType === 'mouse' && e.button !== 0)) return;
  e.preventDefault();
  const point = toWorld(e.clientX, e.clientY, view);
  const side = pointers.claim(e.pointerId, point.y, rink.height, settings.mode);
  if (side === null) return;
  canvas.setPointerCapture(e.pointerId);
  rink.setTarget(side, point.x, point.y);
  unlockAudio();
});
canvas.addEventListener('pointermove', e => {
  const side = pointers.get(e.pointerId);
  if (side === undefined || !rink || rink.paused) return;
  e.preventDefault();
  const point = toWorld(e.clientX, e.clientY, view);
  rink.setTarget(side, point.x, point.y);
});
function releasePointer(e) {
  const side = pointers.release(e.pointerId);
  if (side !== undefined) rink?.stopPaddle(side);
}
canvas.addEventListener('pointerup', releasePointer);
canvas.addEventListener('pointercancel', releasePointer);
canvas.addEventListener('lostpointercapture', releasePointer);
canvas.addEventListener('contextmenu', e => e.preventDefault());
window.addEventListener('keydown', e => {
  if (!rink || rink.phase === 'finished') return;
  if (e.code === 'Space' || e.code === 'Escape') {
    if (e.target instanceof HTMLButtonElement && e.code === 'Space') return;
    e.preventDefault();
    if (!e.repeat) rink.paused ? resume() : pause();
    return;
  }
  if (rink.paused || !['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowLeft','ArrowDown','ArrowRight'].includes(e.code)) return;
  e.preventDefault(); keys.add(e.code);
});
window.addEventListener('keyup', e => { keys.delete(e.code); });
function keyboard(dt) {
  const maps = settings.mode === 'solo'
    ? [{ side: 1, left: ['KeyA','ArrowLeft'], right: ['KeyD','ArrowRight'], up: ['KeyW','ArrowUp'], down: ['KeyS','ArrowDown'] }]
    : [{ side: 1, left: ['KeyA'], right: ['KeyD'], up: ['KeyW'], down: ['KeyS'] }, { side: 0, left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'] }];
  for (const map of maps) {
    let dx = Number(map.right.some(k => keys.has(k))) - Number(map.left.some(k => keys.has(k)));
    let dy = Number(map.down.some(k => keys.has(k))) - Number(map.up.some(k => keys.has(k)));
    const length = Math.hypot(dx, dy);
    if (!length) continue;
    dx /= length; dy /= length;
    if (view.rotated) [dx, dy] = [dy, -dx];
    const p = rink.paddles[map.side];
    rink.setTarget(map.side, p.x + dx * 1050 * dt, p.y + dy * 1050 * dt);
  }
}

function event(e) {
  if (e.type === 'hit' || e.type === 'wall') {
    if (e.type === 'hit' || Math.random() > .6) burst(e.x, e.y, e.type === 'hit' ? colors[e.side] : '#bec9a7', e.type === 'hit' ? 12 : 5);
    const now = performance.now();
    if (now - lastClick > 45) { tone(e.type === 'hit' ? 230 + e.power * 270 : 140, .065, .025 + e.power * .035, 'triangle'); lastClick = now; }
  } else if (e.type === 'goal') {
    flash = .9; flashSide = e.side; trail = []; clearInputs(); syncScores();
    burst(WIDTH / 2, e.side === 0 ? rink.height - 24 : 24, colors[e.side], 40);
    tone(430, .18, .06, 'sine'); tone(650, .25, .05, 'sine', .1); tone(860, .35, .04, 'sine', .2);
    $('game-announcer').textContent = `${nameOf(e.side)} scores. Mint ${e.scores[0]}, coral ${e.scores[1]}.`;
  } else if (e.type === 'serve') {
    tone(780, .1, .035); lastCue = '';
    $('game-announcer').textContent = `Play. First to ${rink.target}.`;
  } else if (e.type === 'reset' || e.type === 'unstick') {
    clearInputs(); trail = [];
    if (e.type === 'unstick') $('game-announcer').textContent = 'Puck stalled. Fresh drop.';
  } else if (e.type === 'finish') {
    releaseWakeLock();
    $('game-announcer').textContent = `${nameOf(e.side)} wins ${e.scores[e.side]} to ${e.scores[1 - e.side]}.`;
    const matchSession = session;
    resultTimer = setTimeout(() => { if (matchSession === session && rink?.phase === 'finished') showResult(); }, 1300);
  }
}
function nameOf(side) { return side === 0 ? (settings.mode === 'solo' ? 'The machine' : 'Mint') : (settings.mode === 'solo' ? 'You' : 'Coral'); }
function syncScores() {
  $('top-score').textContent = rink.scores[0]; $('top-other-score').textContent = rink.scores[1];
  $('bottom-score').textContent = rink.scores[1]; $('bottom-other-score').textContent = rink.scores[0];
}
function showResult() {
  const winner = rink.winner;
  $('result-title').textContent = settings.mode === 'solo' ? (winner === 1 ? 'YOU WIN.' : 'MACHINE WINS.') : `${nameOf(winner).toUpperCase()} WINS.`;
  $('result-kicker').textContent = settings.mode === 'solo' ? 'HUMAN VS. MACHINE' : 'A RIVALRY IN THE MAKING';
  $('result-score').innerHTML = `${rink.scores[winner]} <span>—</span> ${rink.scores[1 - winner]}`;
  $('result-score').style.color = colors[winner];
  $('result-detail').textContent = `${rink.hits} paddle hits. ${Math.floor(rink.elapsed / 60)}:${String(Math.floor(rink.elapsed % 60)).padStart(2, '0')} at the table. Fancy a rematch?`;
  $('result-dialog').showModal();
}
function updateCues() {
  let top = '', bottom = '', detailTop = '', detailBottom = '';
  if (rink.phase === 'countdown') {
    const count = Math.max(1, Math.ceil(rink.timer));
    top = bottom = String(count);
    detailTop = settings.mode === 'solo' ? 'THE MACHINE IS READY' : 'DRAG IN YOUR HALF';
    detailBottom = 'DRAG IN YOUR HALF';
  } else if (rink.phase === 'goal') {
    top = flashSide === 0 ? 'YOUR GOAL.' : 'THEIR GOAL.';
    bottom = flashSide === 1 ? 'YOUR GOAL.' : 'THEIR GOAL.';
    detailTop = detailBottom = 'NEXT PUCK COMING UP';
    if (settings.mode === 'solo') top = flashSide === 0 ? 'MACHINE SCORES' : 'HUMAN SCORES';
  } else if (rink.phase === 'finished') {
    top = rink.winner === 0 ? 'YOU WIN.' : 'GOOD GAME.';
    bottom = rink.winner === 1 ? 'YOU WIN.' : 'GOOD GAME.';
    detailTop = detailBottom = 'THAT’S A MATCH';
  } else if (rink.elapsed < 8 && rink.hits === 0) {
    detailTop = settings.mode === 'solo' ? '' : 'DRAG ANYWHERE IN YOUR HALF';
    detailBottom = 'DRAG ANYWHERE IN YOUR HALF';
  }
  const state = [top, bottom, detailTop, detailBottom].join('|');
  if (state === lastCue) return;
  lastCue = state;
  for (const [id, head, detail] of [['top-cue', top, detailTop], ['bottom-cue', bottom, detailBottom]]) {
    $(id).querySelector('.cue-head').textContent = head;
    $(id).querySelector('.cue-detail').textContent = detail;
  }
}

function circle(context, x, y, r, fill, stroke, line = 1) {
  context.beginPath(); context.arc(x, y, r, 0, Math.PI * 2);
  if (fill) { context.fillStyle = fill; context.fill(); }
  if (stroke) { context.strokeStyle = stroke; context.lineWidth = line; context.stroke(); }
}
function line(context, x1, y1, x2, y2, color, width = 1) {
  context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.strokeStyle = color; context.lineWidth = width; context.stroke();
}
function drawFloor() {
  const H = view.height, scale = view.scale * view.dpr;
  floor.setTransform(scale, 0, 0, scale, 0, 0);
  floor.fillStyle = '#111b13'; floor.fillRect(0, 0, WIDTH, H);
  const gradient = floor.createLinearGradient(0, 0, WIDTH, H);
  gradient.addColorStop(0, '#223326'); gradient.addColorStop(.49, '#1b281e'); gradient.addColorStop(1, '#302b21');
  floor.fillStyle = gradient; floor.fillRect(RAIL, RAIL, WIDTH - RAIL * 2, H - RAIL * 2);
  floor.fillStyle = '#ccdeb611';
  for (let x = 33; x < WIDTH - 26; x += 17) for (let y = 30; y < H - 26; y += 17) floor.fillRect(x, y, 1.2, 1.2);
  floor.lineJoin = 'round'; floor.lineCap = 'round';
  floor.strokeStyle = '#a1b38465'; floor.lineWidth = 2;
  floor.strokeRect(RAIL, RAIL, WIDTH - RAIL * 2, H - RAIL * 2);
  line(floor, RAIL, H / 2, WIDTH - RAIL, H / 2, '#9bac7c77', 1.5);
  circle(floor, WIDTH / 2, H / 2, 78, null, '#9bac7c77', 1.5);
  circle(floor, WIDTH / 2, H / 2, 5, '#9bac7c77');
  for (const side of [0, 1]) {
    const y = side === 0 ? RAIL : H - RAIL;
    floor.save();
    floor.beginPath(); floor.rect(RAIL, RAIL, WIDTH - RAIL * 2, H - RAIL * 2); floor.clip();
    circle(floor, WIDTH / 2, y, 155, null, side === 0 ? '#c4ed8330' : '#ff815e30', 1.5);
    circle(floor, WIDTH / 2, y, 157, null, '#02080430', 3);
    floor.restore();
    const left = (WIDTH - GOAL_WIDTH) / 2, right = (WIDTH + GOAL_WIDTH) / 2;
    floor.fillStyle = '#0a110c'; floor.fillRect(left, side === 0 ? 0 : H - RAIL - 2, GOAL_WIDTH, RAIL + 2);
    floor.shadowColor = colors[side]; floor.shadowBlur = 12 * view.scale;
    line(floor, left + 4, side === 0 ? 4 : H - 4, right - 4, side === 0 ? 4 : H - 4, colors[side], 5);
    floor.shadowBlur = 0;
    circle(floor, left, y, 4, colors[side]); circle(floor, right, y, 4, colors[side]);
    for (const x of [50, WIDTH - 50]) {
      const yy = side === 0 ? 48 : H - 48;
      line(floor, x - 4, yy, x + 4, yy, '#8e9f6b66', 1);
      line(floor, x, yy - 4, x, yy + 4, '#8e9f6b66', 1);
    }
    floor.save(); floor.translate(WIDTH / 2, side === 0 ? H * .31 : H * .69);
    if (side === 0) floor.rotate(Math.PI);
    floor.textAlign = 'center'; floor.fillStyle = '#d5e1b306'; floor.font = 'bold 86px Impact, Arial Black, sans-serif';
    floor.fillText(side === 0 ? 'FACE' : 'OFF', 0, 0); floor.restore();
  }
}
function burst(x, y, color, count) {
  if (reducedMotion) return;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = 80 + Math.random() * 300;
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: .2 + Math.random() * .4, max: .6, color, r: 1 + Math.random() * 3 });
  }
  if (particles.length > 150) particles.splice(0, particles.length - 150);
}
function draw(dt) {
  const H = rink.height, unit = view.scale * view.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(staticCanvas, 0, 0);
  ctx.setTransform(unit, 0, 0, unit, 0, 0);
  if (flash > 0) {
    const g = ctx.createLinearGradient(0, flashSide === 0 ? H : 0, 0, H / 2);
    g.addColorStop(0, colors[flashSide] + Math.floor(flash * 48).toString(16).padStart(2, '0')); g.addColorStop(1, colors[flashSide] + '00');
    ctx.fillStyle = g; ctx.fillRect(RAIL, RAIL, WIDTH - RAIL * 2, H - RAIL * 2);
    if (!rink.paused) flash = Math.max(0, flash - dt);
  }
  if (rink.phase === 'playing' && !rink.paused) {
    trail.push({ x: rink.puck.x, y: rink.puck.y });
    if (trail.length > (reducedMotion ? 2 : 12)) trail.shift();
  }
  for (let i = 1; i < trail.length; i++) {
    ctx.globalAlpha = i / trail.length * .25;
    line(ctx, trail[i-1].x, trail[i-1].y, trail[i].x, trail[i].y, '#f0f0dd', 5 + i * 1.4);
  }
  ctx.globalAlpha = 1;
  for (const p of rink.paddles) {
    // The broad contact ring remains visible around a fingertip.
    circle(ctx, p.x, p.y + 6, p.r + 3, '#00000040');
    const grad = ctx.createRadialGradient(p.x - 12, p.y - 14, 3, p.x, p.y, p.r);
    grad.addColorStop(0, p.side === 0 ? '#d8f4ad' : '#ffa388'); grad.addColorStop(1, colors[p.side]);
    circle(ctx, p.x, p.y, p.r, grad, '#ffffff70', 1.5);
    circle(ctx, p.x, p.y, p.r - 6, null, '#20281745', 1.5);
    circle(ctx, p.x, p.y + 3, p.r * .46, '#00000040');
    circle(ctx, p.x, p.y - 2, p.r * .45, grad, '#ffffff50', 1);
    line(ctx, p.x - 5, p.y - 2, p.x + 5, p.y - 2, '#18231570', 1.5);
    line(ctx, p.x, p.y - 7, p.x, p.y + 3, '#18231570', 1.5);
    if ([...pointers.owners.values()].includes(p.side)) circle(ctx, p.x, p.y, p.r + 8, null, colors[p.side] + '70', 1.5);
  }
  if (rink.phase !== 'goal' && rink.phase !== 'finished') {
    const q = rink.puck;
    circle(ctx, q.x + 1, q.y + 5, q.r + 1, '#00000060');
    circle(ctx, q.x, q.y + 2, q.r, '#8c947d');
    circle(ctx, q.x, q.y, q.r, '#f0f0dd', '#ffffff', 1);
    circle(ctx, q.x, q.y, q.r - 5, null, '#b4b9a255', 1);
  }
  for (const p of particles) {
    if (!rink.paused) { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }
    ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
    circle(ctx, p.x, p.y, p.r, p.color);
  }
  particles = particles.filter(p => p.life > 0); ctx.globalAlpha = 1;
}
function frame(time) {
  const dt = Math.min((time - (lastTime || time)) / 1000, .05); lastTime = time;
  if (rink) {
    if (!rink.paused) { keyboard(dt); rink.update(dt); }
    updateCues(); draw(dt);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
