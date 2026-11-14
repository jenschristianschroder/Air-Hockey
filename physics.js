// The simulation is independent of the DOM and advances at a fixed 240 Hz.
export const STEP = 1 / 240;
export const WIDTH = 600;
export const RAIL = 18;
export const PUCK_RADIUS = 15;
export const PADDLE_RADIUS = 37;
export const GOAL_WIDTH = 232;
export const MAX_PUCK_SPEED = 1560;
export const MAX_PADDLE_SPEED = 2100;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const speedOf = (p) => Math.hypot(p.vx, p.vy);
const AI = {
  easy: { speed: 360, reaction: .19, error: 63, attack: .39 },
  normal: { speed: 600, reaction: .10, error: 30, attack: .45 },
  hard: { speed: 850, reaction: .055, error: 12, attack: .48 },
};

export function reflectX(x, low = RAIL + PUCK_RADIUS, high = WIDTH - RAIL - PUCK_RADIUS) {
  const span = high - low;
  const offset = ((x - low) % (span * 2) + span * 2) % (span * 2);
  return low + (offset <= span ? offset : span * 2 - offset);
}

// Input stays bound to the half on which a gesture began, even across center.
export function toWorld(clientX, clientY, view) {
  const dx = (clientX - view.cx) / view.scale;
  const dy = (clientY - view.cy) / view.scale;
  return view.rotated
    ? { x: WIDTH / 2 + dy, y: view.height / 2 - dx }
    : { x: WIDTH / 2 + dx, y: view.height / 2 + dy };
}

export class PointerOwnership {
  constructor() { this.owners = new Map(); }
  claim(id, y, height, mode) {
    if (this.owners.has(id)) return null;
    const side = y < height / 2 ? 0 : 1;
    if ((mode === 'solo' && side === 0) || [...this.owners.values()].includes(side)) return null;
    this.owners.set(id, side);
    return side;
  }
  get(id) { return this.owners.get(id); }
  release(id) { const side = this.get(id); this.owners.delete(id); return side; }
  clear() { this.owners.clear(); }
}

export class Rink {
  constructor({ height = 1000, mode = 'solo', level = 'normal', target = 7, random = Math.random, onEvent = () => {} } = {}) {
    this.width = WIDTH;
    this.height = Math.max(780, height);
    this.mode = mode;
    this.level = Object.hasOwn(AI, level) ? level : 'normal';
    this.target = [5, 7, 11].includes(target) ? target : 7;
    this.random = random;
    this.onEvent = onEvent;
    this.scores = [0, 0];
    this.paddles = [0, 1].map(side => ({ side, x: WIDTH / 2, y: 0, tx: WIDTH / 2, ty: 0, vx: 0, vy: 0, r: PADDLE_RADIUS }));
    this.puck = { x: WIDTH / 2, y: this.height / 2, vx: 0, vy: 0, r: PUCK_RADIUS };
    this.phase = 'idle';
    this.timer = 0;
    this.paused = false;
    this.elapsed = 0;
    this.winner = null;
    this.accumulator = 0;
    this.hits = 0;
    this.aiClock = 0;
    this.aiOffset = 0;
    this.stallTime = 0;
    this.progressClock = 0;
    this.progressTime = 0;
    this.progressDistance = 0;
    this.progressAnchor = { x: WIDTH / 2, y: this.height / 2 };
    this.lastHit = -10;
    this.resetPositions(1);
  }

  start() {
    this.scores = [0, 0];
    this.winner = null;
    this.paused = false;
    this.elapsed = 0;
    this.hits = 0;
    this.accumulator = 0;
    this.serveTo = this.mode === 'solo' ? 1 : (this.random() < .5 ? 0 : 1);
    this.resetPositions(this.serveTo);
    this.phase = 'countdown';
    this.timer = 2.4;
    this.onEvent({ type: 'start' });
  }

  resize(height) {
    const old = this.height;
    this.height = Math.max(780, height);
    this.puck.y *= this.height / old;
    for (const p of this.paddles) {
      p.y *= this.height / old;
      p.ty = p.y;
      p.tx = p.x;
      this.boundPaddle(p);
    }
  }

  resetPositions(side) {
    for (const p of this.paddles) {
      p.x = p.tx = WIDTH / 2;
      p.y = p.ty = this.height * (p.side === 0 ? .17 : .83);
      p.vx = p.vy = 0;
    }
    Object.assign(this.puck, { x: WIDTH / 2, y: this.height / 2, vx: 0, vy: 0 });
    this.serveTo = side;
    this.stallTime = 0;
    this.progressClock = 0;
    this.progressTime = 0;
    this.progressDistance = 0;
    this.progressAnchor = { x: this.puck.x, y: this.puck.y };
    this.aiClock = 0;
  }

  setTarget(side, x, y) {
    const p = this.paddles[side];
    if (!p || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const limits = this.limits(side);
    p.tx = clamp(x, RAIL + p.r, WIDTH - RAIL - p.r);
    p.ty = clamp(y, limits.min, limits.max);
  }

  stopPaddle(side) {
    const p = this.paddles[side];
    if (!p) return;
    p.tx = p.x; p.ty = p.y; p.vx = 0; p.vy = 0;
  }

  limits(side) {
    return side === 0
      ? { min: RAIL + PADDLE_RADIUS, max: this.height / 2 - PADDLE_RADIUS - 3 }
      : { min: this.height / 2 + PADDLE_RADIUS + 3, max: this.height - RAIL - PADDLE_RADIUS };
  }

  boundPaddle(p) {
    const { min, max } = this.limits(p.side);
    p.x = clamp(p.x, RAIL + p.r, WIDTH - RAIL - p.r);
    p.y = clamp(p.y, min, max);
  }

  update(dt) {
    if (this.paused || this.phase === 'idle' || this.phase === 'finished') return;
    // A background/slow frame cannot advance multiple seconds or tunnel a shot.
    this.accumulator += clamp(dt, 0, .1);
    while (this.accumulator >= STEP) {
      this.tick(STEP);
      this.accumulator -= STEP;
    }
  }

  tick(dt) {
    if (this.phase === 'finished' || this.phase === 'idle') return;
    this.elapsed += dt;
    if (this.mode === 'solo') this.updateAI(dt);
    for (const p of this.paddles) this.movePaddle(p, dt);

    if (this.phase === 'countdown' || this.phase === 'goal') {
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.phase === 'goal') {
          this.resetPositions(this.serveTo);
          this.phase = 'countdown';
          this.timer = 1.5;
          this.onEvent({ type: 'reset' });
        } else {
          this.phase = 'playing';
          const angle = (this.random() - .5) * .75;
          this.puck.vx = Math.sin(angle) * 420;
          this.puck.vy = Math.cos(angle) * 420 * (this.serveTo === 0 ? -1 : 1);
          this.onEvent({ type: 'serve', side: this.serveTo });
        }
      }
      return;
    }
    const q = this.puck;
    q.x += q.vx * dt;
    q.y += q.vy * dt;
    const friction = Math.exp(-.055 * dt);
    q.vx *= friction; q.vy *= friction;
    this.collideWalls();
    for (const p of this.paddles) this.collidePaddle(p);
    // Resolve contact against rails again after paddle overlap correction.
    this.collideWalls();
    if (q.y < -q.r) { this.goal(1); return; }
    if (q.y > this.height + q.r) { this.goal(0); return; }
    this.capSpeed();
    if (speedOf(q) < 45) this.stallTime += dt;
    else this.stallTime = 0;
    // A squeezed puck may have high velocity but never leave a tiny area.
    // Measure spatial progress too, so corner chatter cannot lock a rally.
    this.progressClock += dt;
    this.progressDistance = Math.max(this.progressDistance, Math.hypot(q.x - this.progressAnchor.x, q.y - this.progressAnchor.y));
    if (this.progressClock >= .5) {
      this.progressTime = this.progressDistance < 24 ? this.progressTime + this.progressClock : 0;
      this.progressClock = 0; this.progressDistance = 0;
      this.progressAnchor = { x: q.x, y: q.y };
    }
    if (this.stallTime > 2.5 || this.progressTime > 2.5) {
      const side = q.y < this.height / 2 ? 0 : 1;
      this.resetPositions(side);
      this.phase = 'countdown';
      this.timer = 1.5;
      this.onEvent({ type: 'unstick' });
    }
  }

  movePaddle(p, dt) {
    const dx = p.tx - p.x, dy = p.ty - p.y;
    const distance = Math.hypot(dx, dy);
    const max = (this.mode === 'solo' && p.side === 0 ? AI[this.level].speed : MAX_PADDLE_SPEED) * dt;
    const f = distance > 0 ? Math.min(1, max / distance) : 0;
    p.vx = dx * f / dt; p.vy = dy * f / dt;
    p.x += dx * f; p.y += dy * f;
    this.boundPaddle(p);
  }

  collidePaddle(p) {
    const q = this.puck;
    const dx = q.x - p.x, dy = q.y - p.y;
    const d = Math.hypot(dx, dy), radius = q.r + p.r;
    if (d >= radius) return;
    const nx = d > .001 ? dx / d : 0;
    const ny = d > .001 ? dy / d : (p.side === 0 ? 1 : -1);
    q.x = p.x + nx * (radius + .05);
    q.y = p.y + ny * (radius + .05);
    const relative = (q.vx - p.vx) * nx + (q.vy - p.vy) * ny;
    if (relative < 0) {
      const impulse = -(1 + .92) * relative;
      q.vx += impulse * nx; q.vy += impulse * ny;
      this.capSpeed();
      if (this.elapsed - this.lastHit > .035) {
        this.hits++;
        this.onEvent({ type: 'hit', x: q.x, y: q.y, side: p.side, power: Math.min(1, Math.abs(relative) / 1100) });
        this.lastHit = this.elapsed;
      }
    }
  }

  collideWalls() {
    const q = this.puck;
    const left = RAIL + q.r, right = WIDTH - RAIL - q.r;
    let bounced = false;
    if (q.x < left) { q.x = left; if (q.vx < 0) { q.vx *= -.97; bounced = true; } }
    if (q.x > right) { q.x = right; if (q.vx > 0) { q.vx *= -.97; bounced = true; } }
    const goalLeft = (WIDTH - GOAL_WIDTH) / 2;
    const goalRight = (WIDTH + GOAL_WIDTH) / 2;
    const inMouth = q.x > goalLeft + q.r && q.x < goalRight - q.r;
    if (!inMouth) {
      if (q.y < RAIL + q.r && q.vy < 0) { q.y = RAIL + q.r; q.vy *= -.97; bounced = true; }
      if (q.y > this.height - RAIL - q.r && q.vy > 0) { q.y = this.height - RAIL - q.r; q.vy *= -.97; bounced = true; }
    }
    // Rounded goal posts produce a glancing rebound instead of a sticky corner.
    for (const y of [RAIL, this.height - RAIL]) {
      for (const x of [goalLeft, goalRight]) {
        const dx = q.x - x, dy = q.y - y, d = Math.hypot(dx, dy), r = q.r + 4;
        if (d < r && d > .001) {
          const nx = dx / d, ny = dy / d;
          q.x = x + nx * r; q.y = y + ny * r;
          const dot = q.vx * nx + q.vy * ny;
          if (dot < 0) { q.vx -= 1.97 * dot * nx; q.vy -= 1.97 * dot * ny; bounced = true; }
        }
      }
    }
    if (bounced) this.onEvent({ type: 'wall', x: q.x, y: q.y, power: speedOf(q) / MAX_PUCK_SPEED });
  }

  capSpeed() {
    const speed = speedOf(this.puck);
    if (speed > MAX_PUCK_SPEED) {
      this.puck.vx *= MAX_PUCK_SPEED / speed;
      this.puck.vy *= MAX_PUCK_SPEED / speed;
    }
  }

  goal(scorer) {
    if (this.phase !== 'playing') return;
    this.scores[scorer]++;
    this.puck.vx = this.puck.vy = 0;
    this.serveTo = 1 - scorer;
    this.onEvent({ type: 'goal', side: scorer, scores: [...this.scores] });
    if (this.scores[scorer] >= this.target) {
      this.winner = scorer;
      this.phase = 'finished';
      this.onEvent({ type: 'finish', side: scorer, scores: [...this.scores] });
    } else {
      this.phase = 'goal';
      this.timer = 1.35;
    }
  }

  updateAI(dt) {
    this.aiClock -= dt;
    if (this.aiClock > 0) return;
    const config = AI[this.level];
    this.aiClock = config.reaction;
    const q = this.puck, p = this.paddles[0];
    if (this.phase !== 'playing') { this.setTarget(0, WIDTH / 2, this.height * .17); return; }
    this.aiOffset = (this.random() - .5) * config.error * 2;
    let x = WIDTH / 2, y = this.height * .16;
    if (q.vy < -35) {
      // Predict bank shots with finite reaction time and imperfect aim.
      const seconds = clamp((y - q.y) / q.vy, 0, 2);
      x = reflectX(q.x + q.vx * seconds) + this.aiOffset;
      if (q.y < this.height * .38) y = clamp(q.y - 65, 85, this.height * config.attack);
    } else if (q.y < this.height * .48) {
      x = q.x + this.aiOffset * .3;
      y = clamp(q.y + 15, 85, this.height * config.attack);
      // Reposition behind a slow puck before driving it toward the other goal.
      if (q.y < p.y - 10) {
        x = q.x + (q.x < WIDTH / 2 ? 80 : -80);
        y = q.y - 75;
      }
    } else {
      x = WIDTH / 2 + (q.x - WIDTH / 2) * .35;
    }
    this.setTarget(0, x, y);
  }
}
