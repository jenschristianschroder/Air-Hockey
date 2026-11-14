import test from 'node:test';
import assert from 'node:assert/strict';
import { Rink, STEP, WIDTH, RAIL, PUCK_RADIUS, PADDLE_RADIUS, GOAL_WIDTH, MAX_PUCK_SPEED, PointerOwnership, toWorld, reflectX } from '../physics.js';

function active(options = {}) {
  const r = new Rink({ mode: 'local', random: () => .5, ...options });
  r.start(); r.phase = 'playing';
  r.paddles.forEach((p, side) => { p.x = p.tx = 70; p.y = p.ty = side === 0 ? 150 : 850; });
  return r;
}
function run(r, seconds, fps = 60) { for (let i = 0; i < Math.round(seconds * fps); i++) r.update(1 / fps); }

test('both paddles stay inside their own half and rail bounds', () => {
  const r = active();
  r.setTarget(0, -100, 900); r.setTarget(1, 900, -100);
  run(r, .5);
  assert.equal(r.paddles[0].x, RAIL + PADDLE_RADIUS);
  assert.ok(r.paddles[0].y + PADDLE_RADIUS < r.height / 2);
  assert.equal(r.paddles[1].x, WIDTH - RAIL - PADDLE_RADIUS);
  assert.ok(r.paddles[1].y - PADDLE_RADIUS > r.height / 2);
});

test('a fast puck rebounds off the side rail without escaping', () => {
  const r = active(); Object.assign(r.puck, { x: 550, y: 500, vx: 1500, vy: 0 });
  run(r, .05);
  assert.ok(r.puck.vx < 0);
  assert.ok(r.puck.x <= WIDTH - RAIL - PUCK_RADIUS);
  assert.deepEqual(r.scores, [0, 0]);
});

test('shots score only through a goal and reset toward the conceding side', () => {
  const r = active(); Object.assign(r.puck, { x: 300, y: 70, vx: 0, vy: -1500 });
  run(r, .1);
  assert.deepEqual(r.scores, [0, 1]); assert.equal(r.phase, 'goal'); assert.equal(r.serveTo, 0);
  run(r, 3);
  assert.equal(r.phase, 'playing'); assert.ok(r.puck.vy < 0);
});

test('the full puck must cross the goal line before a score', () => {
  const r = active(); Object.assign(r.puck, { x: 300, y: -10, vx: 0, vy: -100 });
  r.update(STEP); assert.deepEqual(r.scores, [0, 0]);
  run(r, .1); assert.deepEqual(r.scores, [0, 1]);
});

test('shots outside the mouth and at both posts cannot leak into a goal', () => {
  const leftPost = (WIDTH - GOAL_WIDTH) / 2;
  for (const x of [34, 120, leftPost - 1, leftPost + 5, WIDTH - leftPost - 5, WIDTH - 34]) {
    const r = active(); Object.assign(r.puck, { x, y: 65, vx: 0, vy: -1500 });
    run(r, .08);
    assert.deepEqual(r.scores, [0, 0], `x=${x}`);
    assert.ok(r.puck.vy > 0, `rebound at x=${x}`);
  }
});

test('maximum-speed shot cannot tunnel through a stationary paddle', () => {
  const r = active(); Object.assign(r.paddles[0], { x: 300, tx: 300, y: 170, ty: 170 });
  Object.assign(r.puck, { x: 300, y: 270, vx: 0, vy: -MAX_PUCK_SPEED });
  run(r, .06);
  assert.ok(r.puck.vy > 0); assert.equal(r.hits, 1);
});

test('a quick moving paddle imparts momentum without teleporting', () => {
  const r = active(); const p = r.paddles[1];
  Object.assign(p, { x: 300, tx: 300, y: 820, ty: 820 });
  Object.assign(r.puck, { x: 300, y: 700, vx: 0, vy: 0 });
  r.setTarget(1, 300, 550); r.update(STEP);
  assert.ok(p.y > 800, 'first step is speed limited');
  run(r, .1);
  assert.ok(r.puck.vy < -500);
  assert.ok(Math.hypot(r.puck.vx, r.puck.vy) <= MAX_PUCK_SPEED + .0001);
});

test('reaching target ends once and cannot add more scores', () => {
  const events = []; const r = active({ target: 5, onEvent: e => events.push(e) });
  r.scores = [4, 2]; Object.assign(r.puck, { x: 300, y: 980, vx: 0, vy: 1500 });
  run(r, 1); r.goal(0); run(r, 5);
  assert.equal(r.phase, 'finished'); assert.equal(r.winner, 0);
  assert.deepEqual(r.scores, [5, 2]); assert.equal(events.filter(e => e.type === 'finish').length, 1);
  r.start(); assert.deepEqual(r.scores, [0, 0]); assert.equal(r.winner, null);
});

test('pause freezes the puck, score, countdown, and clock', () => {
  const r = active(); r.paused = true; r.puck.vx = 700;
  const before = JSON.stringify({ p: r.puck, t: r.elapsed, scores: r.scores });
  run(r, 5);
  assert.equal(JSON.stringify({ p: r.puck, t: r.elapsed, scores: r.scores }), before);
});

test('stalled puck is served again without awarding a point', () => {
  const r = active(); Object.assign(r.puck, { x: 350, y: 600, vx: 0, vy: 0 });
  run(r, 2.7);
  assert.equal(r.phase, 'countdown'); assert.equal(r.serveTo, 1); assert.deepEqual(r.scores, [0, 0]);
});

test('a puck squeezed against a corner cannot chatter indefinitely', () => {
  const events = []; const r = active({ onEvent: e => events.push(e) });
  Object.assign(r.paddles[1], { x: 55, tx: 55, y: 945, ty: 945 });
  Object.assign(r.puck, { x: 33, y: 967, vx: 1000, vy: 1000 });
  run(r, 4);
  assert.ok(events.some(e => e.type === 'unstick'));
  assert.deepEqual(r.scores, [0, 0]);
});

test('physics is equivalent at 30, 60 and 120 render frames per second', () => {
  const results = [30,60,120].map(fps => { const r = active(); Object.assign(r.puck, { x: 250, y: 450, vx: 540, vy: 170 }); run(r, 1, fps); return r.puck; });
  for (const p of results.slice(1)) {
    assert.ok(Math.abs(p.x - results[0].x) < .001);
    assert.ok(Math.abs(p.y - results[0].y) < .001);
  }
});

test('large elapsed frames are capped rather than jumping a match forward', () => {
  const r = active(); r.update(30);
  assert.ok(r.elapsed <= .101);
});

test('simultaneous touch ownership is independent, persistent and cancelable', () => {
  const touch = new PointerOwnership();
  assert.equal(touch.claim(11, 100, 1000, 'local'), 0);
  assert.equal(touch.claim(22, 900, 1000, 'local'), 1);
  assert.equal(touch.claim(33, 800, 1000, 'local'), null);
  assert.equal(touch.claim(11, 900, 1000, 'local'), null);
  assert.equal(touch.get(11), 0);
  assert.equal(touch.release(11), 0);
  assert.equal(touch.get(22), 1);
  assert.equal(touch.claim(33, 100, 1000, 'solo'), null);
  touch.clear(); assert.equal(touch.owners.size, 0);
});

test('pointer coordinates map correctly in portrait and rotated landscape', () => {
  const view = { cx: 300, cy: 500, scale: .5, height: 1000, rotated: false };
  assert.deepEqual(toWorld(350, 600, view), { x: 400, y: 700 });
  assert.deepEqual(toWorld(350, 600, { ...view, rotated: true }), { x: 500, y: 400 });
});

test('resize preserves the match and clamps paddles to their new halves', () => {
  const r = active(); r.scores = [2, 3]; r.resize(1350);
  assert.deepEqual(r.scores, [2, 3]); assert.equal(r.height, 1350);
  for (const p of r.paddles) { const bounds = r.limits(p.side); assert.ok(p.y >= bounds.min && p.y <= bounds.max); }
});

test('bank-shot prediction reflects across multiple wall bounces', () => {
  assert.equal(reflectX(600, 0, 600), 600);
  assert.equal(reflectX(750, 0, 600), 450);
  assert.equal(reflectX(-200, 0, 600), 200);
  assert.equal(reflectX(2500, 0, 600), 100);
});

test('all AI levels obey speed and half limits during a long rally simulation', () => {
  for (const level of ['easy', 'normal', 'hard']) {
    let seed = 3;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const r = new Rink({ mode: 'solo', level, random, target: 11 }); r.start();
    for (let i = 0; i < 60 * 60; i++) {
      if (i % 8 === 0) r.setTarget(1, r.puck.x + (random() - .5) * 80, r.puck.y + 60);
      r.update(1 / 60);
      for (const p of r.paddles) {
        assert.ok(Number.isFinite(p.x + p.y + p.vx + p.vy));
        const limits = r.limits(p.side); assert.ok(p.y >= limits.min && p.y <= limits.max);
      }
      assert.ok(Number.isFinite(r.puck.x + r.puck.y + r.puck.vx + r.puck.vy));
      assert.ok(Math.hypot(r.puck.vx, r.puck.vy) <= MAX_PUCK_SPEED + .001);
    }
    assert.ok(r.hits > 3, `${level}: playable rallies`);
    assert.ok(r.scores[0] + r.scores[1] > 0, `${level}: goals are possible`);
  }
});
