// app.js — drawing + interaction. All the maths lives in solver.js.
//
// The page is one scrolling story with four figures. Each figure has its own canvas,
// its own scene, and ONE main thing to do:
//   fig1  The problem       — drag the clock-error slider, watch the circles miss
//   fig2  The trick         — drag a circle inward until all circles meet
//   fig3  How a computer…   — press "Next step" and watch Gauss-Newton
//   fig4  Play              — sandbox
// Things you can interact with get a soft blue ring (like a macOS focus ring) until you use them.

const WORLD = { w: 100, h: 66 }; // map size in km (toy scale; real satellites are ~20,000 km up)
const CENTER = { x: WORLD.w / 2, y: WORLD.h / 2 };
// macOS system colours: red, cyan, orange, green, purple, indigo, brown
// The page uses no colour: everything is ink on grey (read from the CSS variables in index.html,
// so it flips with light/dark mode). Things are told apart by shape and line style instead:
//   true position = filled dot · calculated position = cross · computer's guess = hollow circle
//   each satellite's push = thin arrow · the combined step = thick dashed arrow
const THEME = {};
function readTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  Object.assign(THEME, {
    ink: v("--ink"), muted: v("--muted"), grid: v("--grid"), screen: v("--screen"),
    accent: v("--accent"), onAccent: v("--on-accent"),
  });
}
readTheme();

// Clock errors the reader sets are whole microseconds; computed ones may not be.
const fmtUs = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? `${Math.round(v)}` : v.toFixed(1)) + " μs";
const BIAS_RANGE = 60; // fig2: guesses range over ±60 μs
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
// Dragged points follow the cursor on a critically damped spring: they start from rest,
// accelerate quickly and catch up in ~0.15 s without overshooting. Higher = snappier.
const FOLLOW_STIFFNESS = 30; // rad/s
const PULSE_MS = 750;        // the ring of light when something clicks into place
const SNAP_US = 3.0;   // fig2: snap to the answer within 3 μs (~8 px; hard to hit exactly by hand)

const $ = (id) => document.getElementById(id);
const colorOf = () => THEME.ink; // every satellite is drawn in ink; labels tell them apart
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rmsOf = (arr) => Math.sqrt(arr.reduce((a, v) => a + v * v, 0) / arr.length);
function fmtDist(km) {
  const m = Math.abs(km) * 1000;
  const sign = km < 0 ? "−" : "";
  return m < 1000 ? `${sign}${m.toFixed(0)} m` : `${sign}${(m / 1000).toFixed(2)} km`;
}
function gaussian() {
  const u = 1 - Math.random(), v = Math.random(); // Box-Muller
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const defaultSats = () => [
  { x: 14, y: 10 },
  { x: 50, y: 5 },
  { x: 86, y: 12 },
];
const defaultReceiver = () => ({ x: 42, y: 46 });

// ---------- maths helpers that work on any scene ----------
const rhoOf = (sc) => measurePseudoranges(sc.sats, sc.receiver, sc.clockBiasUs, sc.noise || []);

// For a guessed clock error b̂: subtract C·b̂ from every pseudorange,
// then find the point that best fits all the circles, and measure how much they disagree.
function fitForBias(sc, rho, biasUs) {
  const corr = rho.map((r) => r - C * biasUs);
  const fit = solvePosition(sc.sats, corr, { solveClock: false, initial: CENTER });
  return { corr, fit, rms: fit.ok ? rmsOf(fit.residuals) : NaN };
}

// The guess that makes the circles agree best: coarse sweep, then ternary search to refine.
function findBestBias(sc, rho) {
  let best = 0, bestR = Infinity;
  for (let b = -BIAS_RANGE; b <= BIAS_RANGE + 1e-9; b += 0.5) {
    const r = fitForBias(sc, rho, b).rms;
    if (r < bestR) { bestR = r; best = b; }
  }
  let lo = Math.max(-BIAS_RANGE, best - 0.5), hi = Math.min(BIAS_RANGE, best + 0.5);
  for (let k = 0; k < 40; k++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (fitForBias(sc, rho, m1).rms < fitForBias(sc, rho, m2).rms) hi = m2; else lo = m1;
  }
  return (lo + hi) / 2;
}

// Paint the filled part of a slider's groove (Chrome/Safari need this; Firefox does it natively).
function syncRange(el) {
  const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty("--fill", pct + "%");
}

// =====================================================================
// Figure: one canvas + one scene + drawing primitives + dragging.
// Each figure supplies hooks: render(fig), pick(fig, p), drag(fig, target, p).
// =====================================================================
class Figure {
  constructor(canvasId, scene, hooks) {
    this.canvas = $(canvasId);
    this.ctx = this.canvas.getContext("2d");
    this.scene = scene;
    this.hooks = hooks;
    this.dpr = 1;
    this.scale = 1; // device pixels per km
    this.dragging = null;
        this.follow = null; // spring state while a point chases the cursor
    this.pulses = [];   // rings of light currently expanding
    this.raf = null;

    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      if (!hooks.pick) return;
      const t = hooks.pick(this, this.toWorld(e));
      if (!t) return;
      this.dragging = t;
      if (t.smooth && !REDUCED_MOTION) {
        this.follow = { t, pos: { ...t.start }, vel: { x: 0, y: 0 }, target: { ...t.start }, last: performance.now() };
      }
      c.setPointerCapture(e.pointerId);
      c.style.cursor = "grabbing";
      e.preventDefault();
    });
    c.addEventListener("pointermove", (e) => {
      const p = this.toWorld(e);
      if (!this.dragging) {
        c.style.cursor = hooks.pick && hooks.pick(this, p) ? "grab" : "default";
        return;
      }
      if (this.follow && this.follow.t === this.dragging) {
        this.follow.target = p; // the spring loop moves the point
        this.animate();
      } else {
        hooks.drag(this, this.dragging, p);
        this.render();
      }
    });
    const end = () => { this.dragging = null; c.style.cursor = "default"; };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
  }

  // ---------- animation: spring-follow + light pulses ----------
  animate() {
    if (!this.raf) this.raf = requestAnimationFrame((now) => this.frame(now));
  }

  frame(now) {
    this.raf = null;
    const f = this.follow;
    if (f) {
      const dt = Math.min((now - f.last) / 1000, 1 / 30);
      f.last = now;
      const w = FOLLOW_STIFFNESS;
      for (const k of ["x", "y"]) {
        // critically damped spring: acceleration = w²·(target − pos) − 2w·velocity
        const a = w * w * (f.target[k] - f.pos[k]) - 2 * w * f.vel[k];
        f.vel[k] += a * dt;
        f.pos[k] += f.vel[k] * dt;
      }
      const settled = Math.hypot(f.target.x - f.pos.x, f.target.y - f.pos.y) < 0.01 && Math.hypot(f.vel.x, f.vel.y) < 0.1;
      if (settled && this.dragging !== f.t) {
        this.hooks.drag(this, f.t, f.target);
        this.follow = null;
      } else {
        this.hooks.drag(this, f.t, f.pos);
      }
    }
    this.render();
    if (this.follow || this.pulses.length) this.animate();
  }

  // A single ring of light from point p (in km), e.g. when the circles meet.
  pulse(p) {
    if (REDUCED_MOTION) return;
    this.pulses.push({ x: p.x, y: p.y, t0: performance.now() });
    this.animate();
  }

  drawPulses() {
    const { ctx, dpr } = this, now = performance.now();
    this.pulses = this.pulses.filter((q) => now - q.t0 < PULSE_MS);
    for (const q of this.pulses) {
      const k = (now - q.t0) / PULSE_MS;
      const ease = 1 - (1 - k) ** 3;
      ctx.save();
      ctx.globalAlpha = (1 - k) * 0.7;
      ctx.strokeStyle = THEME.ink;
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(this.px(q.x), this.px(q.y), (16 + 56 * ease) * dpr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  resize() {
    // the canvas's own CSS width (not its parent's, which includes the screen's padding)
    const w = this.canvas.clientWidth;
    const h = (w * WORLD.h) / WORLD.w;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.height = h + "px";
    this.scale = this.canvas.width / WORLD.w;
        this.render();
  }

  render() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.grid();
    this.hooks.render(this);
    this.scene.sats.forEach((s, i) => this.sat(s, i));
    this.drawPulses();
    document.querySelectorAll('input[type="range"]').forEach(syncRange);
  }

  // --- coordinates ---
  px(v) { return v * this.scale; }
  toWorld(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * this.dpr) / this.scale, y: ((e.clientY - r.top) * this.dpr) / this.scale };
  }
  hitKm() { return (16 * this.dpr) / this.scale; }

  // --- primitives ---
  grid() {
    const { ctx, dpr } = this;
    ctx.strokeStyle = THEME.grid;
    ctx.lineWidth = 1 * dpr;
    for (let x = 0; x <= WORLD.w; x += 10) {
      ctx.beginPath(); ctx.moveTo(this.px(x), 0); ctx.lineTo(this.px(x), this.canvas.height); ctx.stroke();
    }
    for (let y = 0; y <= WORLD.h; y += 10) {
      ctx.beginPath(); ctx.moveTo(0, this.px(y)); ctx.lineTo(this.canvas.width, this.px(y)); ctx.stroke();
    }
    ctx.fillStyle = THEME.muted;
    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    ctx.fillText("each square = 10 km", 6 * dpr, this.canvas.height - 6 * dpr);
  }

  circle(c, rKm, color, { dashed = false, width = 2, alpha = 1 } = {}) {
    const { ctx, dpr } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width * dpr;
    ctx.setLineDash(dashed ? [6 * dpr, 5 * dpr] : []);
    ctx.beginPath();
    ctx.arc(this.px(c.x), this.px(c.y), Math.max(0, this.px(rKm)), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  circleBand(c, rKm) { // soft blue band behind a circle: "you can drag this"
    const { ctx, dpr } = this;
    ctx.save();
    ctx.strokeStyle = THEME.ink;
    ctx.globalAlpha = 0.1;
    ctx.lineWidth = 10 * dpr;
    ctx.beginPath();
    ctx.arc(this.px(c.x), this.px(c.y), Math.max(0, this.px(rKm)), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  halo(p) { // soft blue ring around a point: "you can drag this"
    const { ctx, dpr } = this;
    ctx.save();
    ctx.strokeStyle = THEME.ink;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 3.5 * dpr;
    ctx.beginPath(); ctx.arc(this.px(p.x), this.px(p.y), 16 * dpr, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  tag(text, p, dy = 18) { // a small blue label with an instruction
    const { ctx, dpr } = this;
    ctx.save();
    ctx.font = `600 ${12.5 * dpr}px -apple-system, system-ui, sans-serif`;
    const w = ctx.measureText(text).width + 18 * dpr, h = 24 * dpr;
    const x = clamp(this.px(p.x) - w / 2, 4 * dpr, this.canvas.width - w - 4 * dpr);
    const y = clamp(this.px(p.y) + dy * dpr, 4 * dpr, this.canvas.height - h - 4 * dpr);
    ctx.fillStyle = THEME.accent;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 6 * dpr); else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.fillStyle = THEME.onAccent;
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + 9 * dpr, y + h / 2);
    ctx.restore();
  }

  line(a, b, color, { width = 1.5, dashed = false, alpha = 1 } = {}) {
    const { ctx, dpr } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width * dpr;
    ctx.setLineDash(dashed ? [4 * dpr, 4 * dpr] : []);
    ctx.beginPath(); ctx.moveTo(this.px(a.x), this.px(a.y)); ctx.lineTo(this.px(b.x), this.px(b.y)); ctx.stroke();
    ctx.restore();
  }

  arrow(a, b, color, { width = 2.5, dashed = false } = {}) {
    const { ctx, dpr } = this;
    const x1 = this.px(a.x), y1 = this.px(a.y), x2 = this.px(b.x), y2 = this.px(b.y);
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 3 * dpr) return;
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineWidth = width * dpr;
    ctx.setLineDash(dashed ? [6 * dpr, 4 * dpr] : []);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.setLineDash([]);
    const ang = Math.atan2(y2 - y1, x2 - x1), h = Math.min(11 * dpr, len * 0.45);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - h * Math.cos(ang - 0.45), y2 - h * Math.sin(ang - 0.45));
    ctx.lineTo(x2 - h * Math.cos(ang + 0.45), y2 - h * Math.sin(ang + 0.45));
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  label(text, p, color, dy = -14) {
    const { ctx, dpr } = this;
    ctx.fillStyle = color;
    ctx.font = `600 ${12 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(text, this.px(p.x), this.px(p.y) + dy * dpr);
    ctx.textAlign = "start";
  }

  sat(s, i) {
    const { ctx, dpr } = this;
    const x = this.px(s.x), y = this.px(s.y), r = 8 * dpr;
    ctx.save();
    ctx.fillStyle = colorOf(i);
    ctx.fillRect(x - r, y - r / 2, r * 2, r);
    ctx.fillRect(x - r * 2.2, y - r / 4, r * 0.9, r / 2);
    ctx.fillRect(x + r * 1.3, y - r / 4, r * 0.9, r / 2);
    ctx.restore();
    // label above the satellite, or below it if that would go off the top edge
    const dy = y - 14 * dpr < 12 * dpr ? 24 : -14;
    this.label(`Satellite ${i + 1}`, s, colorOf(i), dy);
  }

  receiver(p, labelDy = 24) {
    const { ctx, dpr } = this;
    ctx.fillStyle = THEME.ink;
    ctx.beginPath(); ctx.arc(this.px(p.x), this.px(p.y), 7 * dpr, 0, Math.PI * 2); ctx.fill();
    this.label("True position", p, THEME.ink, labelDy);
  }

  cross(p, text, labelDy = -16) {
    const { ctx, dpr } = this;
    const x = this.px(p.x), y = this.px(p.y), r = 9 * dpr;
    ctx.save();
    ctx.strokeStyle = THEME.ink;
    ctx.lineWidth = 3 * dpr;
    ctx.beginPath();
    ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
    ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
    ctx.stroke();
    ctx.restore();
    if (text) this.label(text, p, THEME.ink, labelDy);
  }

  successRing(p) {
    const { ctx, dpr } = this;
    ctx.save();
    ctx.strokeStyle = THEME.ink;
    ctx.lineWidth = 3 * dpr;
    ctx.beginPath(); ctx.arc(this.px(p.x), this.px(p.y), 16 * dpr, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  guessDot(p, showLabel = true) {
    const { ctx, dpr } = this;
    ctx.save();
    ctx.fillStyle = THEME.screen;  // hollow: the computer's guess
    ctx.strokeStyle = THEME.ink;
    ctx.lineWidth = 2.5 * dpr;
    ctx.beginPath(); ctx.arc(this.px(p.x), this.px(p.y), 7 * dpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
    if (showLabel) this.label("Guess", p, THEME.ink, -16);
  }

  path(points) {
    const { ctx, dpr } = this;
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = THEME.ink;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([]);
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(this.px(p.x), this.px(p.y)) : ctx.moveTo(this.px(p.x), this.px(p.y))));
    ctx.stroke();
    points.forEach((p) => { ctx.beginPath(); ctx.arc(this.px(p.x), this.px(p.y), 2.5 * dpr, 0, Math.PI * 2); ctx.fill(); });
    ctx.restore();
  }

  // circles + best-fit point + a thick line from that point to each circle
  fitPicture(corr, fit, crossLabel, allColor = null) {
    const sats = this.scene.sats;
    // success = full-strength, thicker circles (no colour change)
    sats.forEach((s, i) => this.circle(s, corr[i], THEME.ink, { alpha: allColor ? 1 : 0.7, width: allColor ? 2.75 : 1.5 }));
    if (fit.ok && !allColor) {
      sats.forEach((s, i) => {
        const R = Math.max(dist(s, fit), 1e-9);
        const onCircle = { x: s.x + ((fit.x - s.x) / R) * corr[i], y: s.y + ((fit.y - s.y) / R) * corr[i] };
        this.line(fit, onCircle, THEME.ink, { width: 3, alpha: 0.4 });
      });
    }
    // keep the two labels apart: if the calculated point is just below the true one,
    // put "True position" above its dot and the calculated label below its cross
    const rx = this.scene.receiver;
    const below = fit.ok && fit.y > rx.y && Math.hypot(fit.x - rx.x, fit.y - rx.y) < 8;
    this.receiver(rx, below ? -14 : 24);
    if (fit.ok) this.cross(fit, crossLabel, below ? 28 : -16);
  }
}

const cue = () => ` <span class="cue">${isOracle() ? "Pass priority" : "Continue below"} ↓</span>`;

// =====================================================================
// fig1 · The problem — the phone assumes its clock is perfect.
// =====================================================================
const fig1 = new Figure("fig1", { sats: defaultSats(), receiver: defaultReceiver(), clockBiasUs: 0, touched: false }, {
  render(f) {
    const sc = f.scene;
    const { corr, fit } = fitForBias(sc, rhoOf(sc), 0);
    const perfect = Math.abs(sc.clockBiasUs) < 0.05;
    f.fitPicture(corr, fit, perfect ? "" : "Calculated position");
    const err = fit.ok ? Math.hypot(fit.x - sc.receiver.x, fit.y - sc.receiver.y) : NaN;

    const supports = fit.ok && err >= 1;
    const b = Math.round(sc.clockBiasUs);
    $("s1Status").innerHTML = (perfect
      ? say("With no clock error, all three circles cross at the true position. Move the slider to add a clock error.",
            "As long as X is 0, all circles share a single point. Move the slider to choose X.")
      : say(`<b>Result:</b> with a clock error of ${b} μs, the circles no longer cross at one point. The best position the phone can calculate is <b>${fmtDist(err)}</b> from the true position.${supports ? " This supports our hypothesis." : ""}`,
            `<b>Result</b> — X is ${b}. The circles don't share a point. Quartz-Clock Navigator's calculated position is <b>${fmtDist(err)}</b> from its true position.${supports ? " <i>(This supports the hypothesis.)</i>" : ""}`)) +
      (Math.abs(sc.clockBiasUs) >= 3 ? cue() : "");
    $("hud1").textContent = fit.ok ? fmtDist(err) : "—";
    $("s1Val").textContent = Math.round(sc.clockBiasUs);
    const d = fmtDist(Math.abs(C * sc.clockBiasUs));
    $("s1Sub").textContent = perfect
      ? say("the measured distances are correct", "Each circle gets +0 km.")
      : say(`every measured distance is ${d} too ${sc.clockBiasUs > 0 ? "long" : "short"}`, `Each circle gets ${sc.clockBiasUs > 0 ? "+" : "−"}${d}.`);
    $("s1Box").classList.toggle("hl", !sc.touched);
  },
});

// The clock error the rest of the story uses: whatever the reader picked in fig1, or 15 μs.
const storyBias = () => (Math.abs(fig1.scene.clockBiasUs) >= 3 ? fig1.scene.clockBiasUs : 15);

// =====================================================================
// fig2 · The trick — drag a circle; all circles shrink together.
// =====================================================================
const fig2 = new Figure("fig2", { sats: defaultSats(), receiver: defaultReceiver(), clockBiasUs: 15, guessBiasUs: 0, touched: false }, {
  render(f) {
    const sc = f.scene;
    const rho = rhoOf(sc);
    const best = findBestBias(sc, rho);
    const { corr, fit, rms } = fitForBias(sc, rho, sc.guessBiasUs);
    const met = fit.ok && Math.abs(sc.guessBiasUs - best) < 1e-6;

    if (!sc.touched) sc.sats.forEach((s, i) => f.circleBand(s, corr[i]));
    f.fitPicture(corr, fit, met ? "" : "Best fit point", met ? THEME.ink : null);
    if (met) f.successRing(fit);
    if (met && !sc.wasMet) f.pulse(fit); // one ring of light the moment they meet
    sc.wasMet = met;
    $("hud2").textContent = fit.ok ? fmtDist(rms) : "—";
    $("hud2").closest(".hud").classList.toggle("good", met);

    if (!sc.touched) {
      // sticker on the bottom of a circle that is on screen
      const i = Math.max(0, sc.sats.findIndex((s, k) => s.y + corr[k] < WORLD.h - 4));
      f.tag("↑ Drag a circle inwards", { x: sc.sats[i].x, y: sc.sats[i].y + corr[i] }, 10);
    }

    const way = best > sc.guessBiasUs ? "inwards" : "outwards";
    const change = sc.guessBiasUs >= 0 ? "reduced" : "increased";
    const shrink = fmtDist(Math.abs(C * sc.guessBiasUs));
    $("s2Status").innerHTML = met
      ? say(`<b>Result:</b> the circles meet when every distance is ${change} by ${shrink}. This means the phone's clock error was <b>${fmtUs(sc.guessBiasUs)}</b>, and the point where they meet is the true position.`,
            `<b>Result</b> — The circles share a single point. Each circle got ${sc.guessBiasUs >= 0 ? "−" : "+"}${shrink}, so the clock error is <b>${fmtUs(sc.guessBiasUs)}</b>. That point is the true position.`) + cue()
      : sc.touched
      ? say(`The circles do not meet yet (disagreement: ${fmtDist(rms)}). Keep dragging ${way}.`,
            `The circles don't share a point. <i>(Disagreement: ${fmtDist(rms)}.)</i> Drag ${way}.`)
      : say("Drag one of the circles inwards and stop when all three meet.", "{T}: Drag target circle inwards.");
    $("s2Status").classList.toggle("ok", met);
    $("guessVal").textContent = fmtUs(sc.guessBiasUs).replace(" μs", "");
    $("rmsVal").textContent = fit.ok ? fmtDist(rms) : "—";
    if ($("s2Maths").open) drawBiasChart(sc, rho);
  },
  pick(f, p) {
    const sc = f.scene, rho = rhoOf(sc);
    for (let i = 0; i < sc.sats.length; i++) {
      const r = rho[i] - C * sc.guessBiasUs;
      if (Math.abs(dist(p, sc.sats[i]) - r) < f.hitKm()) return { i, rho };
    }
    return null;
  },
  drag(f, t, p) {
    // new radius of the grabbed circle → how much it shrank → the guessed clock error
    setGuess((t.rho[t.i] - dist(p, f.scene.sats[t.i])) / C);
    f.scene.touched = true;
  },
});

// Set fig2's guess, snapping to the answer when close.
function setGuess(v) {
  const sc = fig2.scene;
  v = clamp(v, -BIAS_RANGE, BIAS_RANGE);
  const best = findBestBias(sc, rhoOf(sc));
  if (Math.abs(v - best) < SNAP_US) v = best;
  sc.guessBiasUs = v;
  $("guess").value = v;
}

function drawBiasChart(sc, rho) {
  const cv = $("biasChart");
  const cctx = cv.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  cv.style.width = "100%";
  const w = cv.clientWidth, h = 160;
  if (!w) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  cv.style.height = h + "px";
  const pad = { l: 8 * dpr, r: 8 * dpr, t: 14 * dpr, b: 22 * dpr };
  const W = cv.width - pad.l - pad.r, Hh = cv.height - pad.t - pad.b;

  // sweep every possible guess and compute how much the circles disagree for each
  const pts = [];
  for (let b = -BIAS_RANGE; b <= BIAS_RANGE + 1e-9; b += 0.5) pts.push({ b, rms: fitForBias(sc, rho, b).rms });
  const valid = pts.filter((p) => isFinite(p.rms));
  const yMax = Math.max(0.05, ...valid.map((p) => p.rms));
  const X = (b) => pad.l + ((b + BIAS_RANGE) / (2 * BIAS_RANGE)) * W;
  const Y = (r) => pad.t + Hh - (r / yMax) * Hh;

  cctx.clearRect(0, 0, cv.width, cv.height);
  cctx.strokeStyle = THEME.grid; cctx.lineWidth = 1 * dpr;
  cctx.beginPath(); cctx.moveTo(pad.l, pad.t + Hh); cctx.lineTo(pad.l + W, pad.t + Hh); cctx.stroke();
  cctx.fillStyle = THEME.muted;
  cctx.font = `${11 * dpr}px system-ui, sans-serif`;
  cctx.textAlign = "center";
  for (const b of [-60, -30, 0, 30, 60]) cctx.fillText(`${b}`, X(b), cv.height - 6 * dpr);
  cctx.textAlign = "start";
  cctx.fillText("↑ how much the circles disagree", pad.l, 11 * dpr);
  cctx.textAlign = "right";
  cctx.fillText("your guess (μs) →", pad.l + W, pad.t + Hh - 4 * dpr);
  cctx.textAlign = "start";

  cctx.strokeStyle = THEME.ink; cctx.lineWidth = 2 * dpr;
  cctx.beginPath();
  valid.forEach((p, i) => (i ? cctx.lineTo(X(p.b), Y(p.rms)) : cctx.moveTo(X(p.b), Y(p.rms))));
  cctx.stroke();

  const cur = fitForBias(sc, rho, sc.guessBiasUs).rms;
  cctx.strokeStyle = THEME.ink; cctx.lineWidth = 1.5 * dpr;
  cctx.beginPath(); cctx.moveTo(X(sc.guessBiasUs), pad.t); cctx.lineTo(X(sc.guessBiasUs), pad.t + Hh); cctx.stroke();
  if (isFinite(cur)) {
    cctx.fillStyle = THEME.ink;
    cctx.beginPath(); cctx.arc(X(sc.guessBiasUs), Y(Math.min(cur, yMax)), 5 * dpr, 0, Math.PI * 2); cctx.fill();
  }
}

// =====================================================================
// fig3 · How a computer does it — Gauss-Newton, one step at a time.
// =====================================================================
const freshStep = () => ({
  guess: { x: CENTER.x, y: CENTER.y, d: 0 },
  history: [{ x: CENTER.x, y: CENTER.y }],
  k: 0,
});

const fig3 = new Figure("fig3", { sats: defaultSats(), receiver: defaultReceiver(), clockBiasUs: 15, step: freshStep(), touched: false }, {
  render(f) {
    const sc = f.scene, rho = rhoOf(sc);
    const g = sc.step.guess, k = sc.step.k;
    const st = gaussNewtonStep(sc.sats, rho, g, true);
    const converged = st.ok && st.size < 1e-4 && k > 0;

    // circles corrected by the current clock-error guess
    sc.sats.forEach((s, i) => f.circle(s, rho[i] - g.d, THEME.ink, { alpha: converged ? 1 : 0.35, width: converged ? 2.75 : 1.5 }));
    // satellite → guess lines
    sc.sats.forEach((s, i) => f.line(s, g, THEME.muted, { dashed: true, alpha: 0.35, width: 1 }));
    f.path(sc.step.history);
    // each satellite's "push": residual × direction
    // thin arrows: each satellite's push
    st.rows.forEach((r) => f.arrow(g, { x: g.x + r.ux * r.residual, y: g.y + r.uy * r.residual }, THEME.ink, { width: 1.5 }));
    // the move actually made after combining all pushes
    // thick dashed arrow: the combined step
    if (st.ok) f.arrow(g, st.next, THEME.ink, { dashed: true, width: 3 });
    f.receiver(sc.receiver);
    f.guessDot(g, !converged); // once it has found you, the label would sit on top of "You"
    if (converged) f.successRing(g);
    if (converged && !sc.wasDone) f.pulse(g);
    sc.wasDone = converged;
    $("hud3").textContent = fmtUs(g.d / C);
    $("hud3").closest(".hud").classList.toggle("good", converged);

    const off = fmtDist(Math.hypot(g.x - sc.receiver.x, g.y - sc.receiver.y));
    const us = fmtUs(g.d / C);
    $("s3Status").innerHTML = !st.ok
      ? st.reason
      : converged
      ? say(`<b>Result:</b> after ${k} steps the guess stopped moving. It found the true position and a clock error of <b>${us}</b>, which matches the real clock error.`,
            `<b>Result</b> — After ${k} steps, the guess stops moving. It found the true position and a clock error of <b>${us}</b>. <i>(That matches the real clock error.)</i>`) + cue()
      : k === 0
      ? say("Press <b>Next step</b> to run step 1. The thin arrows show how each satellite's measured distance compares with the guess.",
            "Press <b>Resolve</b> to put the first step on the stack. Each thin arrow is a Satellite's push.")
      : say(`After step ${k}, the guess is ${off} from the true position and the clock error guess is ${us}. Press <b>Next step</b> again.`,
            `Step ${k} resolves. The guess counter is ${off} from the true position. The clock error guess is ${us}.`);
    $("s3Status").classList.toggle("ok", converged);
    $("stepNext").classList.toggle("hl", !sc.touched);

    $("stepK").textContent = k;
    $("stepClock").textContent = `${(g.d / C).toFixed(2)} μs`;
    $("stepRms").textContent = fmtDist(st.rms);
    $("stepErr").textContent = fmtDist(Math.hypot(g.x - sc.receiver.x, g.y - sc.receiver.y));
    $("stepTable").innerHTML = st.rows
      .map(
        (r, i) => `<tr>
          <td>${i + 1}</td>
          <td>${r.measured.toFixed(2)}</td>
          <td>${r.predicted.toFixed(2)}</td>
          <td class="${r.residual >= 0 ? "pos" : "neg"}">${r.residual >= 0 ? "+" : "−"}${Math.abs(r.residual).toFixed(2)}</td>
        </tr>`
      )
      .join("");
  },
  pick(f, p) {
    const g = f.scene.step.guess;
    return Math.hypot(p.x - g.x, p.y - g.y) < f.hitKm() ? { guess: true, smooth: true, start: { x: g.x, y: g.y } } : null;
  },
  drag(f, t, p) {
    clearInterval(runTimer);
    const st = f.scene.step;
    st.guess.x = clamp(p.x, 0, WORLD.w);
    st.guess.y = clamp(p.y, 0, WORLD.h);
    st.history = [{ x: st.guess.x, y: st.guess.y }];
    st.k = 0;
  },
});

function stepOnce() {
  const sc = fig3.scene;
  const st = gaussNewtonStep(sc.sats, rhoOf(sc), sc.step.guess, true);
  if (!st.ok) return false;
  sc.step.guess = st.next;
  sc.step.history.push({ x: st.next.x, y: st.next.y });
  sc.step.k++;
  fig3.render();
  return st.size > 1e-4;
}

let runTimer = null;
function runToEnd() {
  clearInterval(runTimer);
  let n = 0;
  runTimer = setInterval(() => { if (!stepOnce() || ++n > 25) clearInterval(runTimer); }, 450);
}

// =====================================================================
// fig4 · Play — the full solver, everything adjustable.
// =====================================================================
const freshPlay = () => ({
  sats: defaultSats(), receiver: defaultReceiver(),
  clockBiasUs: 15, noiseM: 0, noise: [], solveClock: true, touched: false,
});

const fig4 = new Figure("fig4", freshPlay(), {
  render(f) {
    const sc = f.scene, rho = rhoOf(sc);
    const sol = solvePosition(sc.sats, rho, { solveClock: sc.solveClock, initial: CENTER });

    if (!sc.touched) { sc.sats.forEach((s) => f.halo(s)); f.halo(sc.receiver); }
    // solid: distances the phone measured (stretched by the clock error)
    sc.sats.forEach((s, i) => f.circle(s, rho[i], THEME.ink, { alpha: 0.7, width: 1.5 }));
    // dashed: after removing the clock error the solver found — they meet again
    if (sol.ok && sc.solveClock) {
      sc.sats.forEach((s, i) => f.circle(s, rho[i] - C * sol.clockBiasUs, THEME.muted, { dashed: true, width: 1.5, alpha: 0.8 }));
    }
    if (sol.path) f.path(sol.path);
    f.receiver(sc.receiver);
    if (sol.ok) f.cross(sol, "Calculated position");

    $("clockVal").textContent = Math.round(sc.clockBiasUs);
    $("noiseVal").textContent = sc.noiseM;
    if (!sol.ok) {
      $("s4Status").textContent = sol.reason;
      ["errVal", "clockEst", "iterVal", "hud4"].forEach((id) => ($(id).textContent = "—"));
      return;
    }
    $("s4Status").textContent = "";
    $("errVal").textContent = fmtDist(Math.hypot(sol.x - sc.receiver.x, sol.y - sc.receiver.y));
    $("hud4").textContent = $("errVal").textContent;
    $("clockEst").textContent = sc.solveClock ? `${sol.clockBiasUs.toFixed(2)} μs` : "(not solved for)";
    $("iterVal").textContent = sol.iterations;
  },
  pick(f, p) {
    const sc = f.scene, near = (o) => Math.hypot(p.x - o.x, p.y - o.y) < f.hitKm();
    const obj = near(sc.receiver) ? sc.receiver : sc.sats.find(near);
    return obj ? { obj, smooth: true, start: { x: obj.x, y: obj.y } } : null;
  },
  drag(f, t, p) {
    t.obj.x = clamp(p.x, 0, WORLD.w);
    t.obj.y = clamp(p.y, 0, WORLD.h);
    f.scene.touched = true;
  },
});

function regenNoise() {
  const sc = fig4.scene;
  sc.noise = sc.sats.map(() => (gaussian() * sc.noiseM) / 1000);
}

// =====================================================================
// controls
// =====================================================================
const figures = [fig1, fig2, fig3, fig4];

$("s1Clock").addEventListener("input", (e) => {
  fig1.scene.clockBiasUs = +e.target.value;
  fig1.scene.touched = true;
  // later figures use the clock error the reader chose
  const b = storyBias();
  if (fig2.scene.clockBiasUs !== b) {
    fig2.scene.clockBiasUs = b;
    fig3.scene.clockBiasUs = b;
    fig3.scene.step = freshStep();
    clearInterval(runTimer);
    fig2.render(); fig3.render();
  }
  fig1.render();
});

$("guess").addEventListener("input", (e) => { setGuess(+e.target.value); fig2.scene.touched = true; fig2.render(); });
$("s2Maths").addEventListener("toggle", () => fig2.render());

$("stepNext").addEventListener("click", () => { clearInterval(runTimer); fig3.scene.touched = true; stepOnce(); });
$("stepRun").addEventListener("click", () => { fig3.scene.touched = true; runToEnd(); });
$("stepReset").addEventListener("click", () => { clearInterval(runTimer); fig3.scene.step = freshStep(); fig3.render(); });

$("clock").addEventListener("input", (e) => { fig4.scene.clockBiasUs = +e.target.value; fig4.render(); });
$("noise").addEventListener("input", (e) => { fig4.scene.noiseM = +e.target.value; regenNoise(); fig4.render(); });
$("solveClock").addEventListener("change", (e) => { fig4.scene.solveClock = e.target.checked; fig4.render(); });
$("remeasure").addEventListener("click", () => { regenNoise(); fig4.render(); });
$("addSat").addEventListener("click", () => {
  fig4.scene.sats.push({ x: 10 + Math.random() * 80, y: 4 + Math.random() * 20 });
  regenNoise(); fig4.render();
});
$("removeSat").addEventListener("click", () => {
  if (fig4.scene.sats.length > 1) fig4.scene.sats.pop();
  regenNoise(); fig4.render();
});
$("reset").addEventListener("click", () => {
  const touched = fig4.scene.touched;
  fig4.scene = Object.assign(freshPlay(), { touched });
  $("clock").value = 15; $("noise").value = 0; $("solveClock").checked = true;
  fig4.render();
});

// ---------- light / dark mode ----------
function applyTheme(t, save) {
  document.documentElement.dataset.theme = t;
  if (save) { try { localStorage.setItem("theme", t); } catch (e) {} }
  document.querySelectorAll("[data-set-theme]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.setTheme === t)));
  readTheme();
  figures.forEach((f) => f.render());
  if ($("s2Maths").open) fig2.render();
}
document.querySelectorAll("[data-set-theme]").forEach((b) =>
  b.addEventListener("click", () => applyTheme(b.dataset.setTheme, true))
);
// follow the system setting, unless the reader has picked one
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  let saved = null;
  try { saved = localStorage.getItem("theme"); } catch (err) {}
  if (!saved) applyTheme(e.matches ? "dark" : "light", false);
});

window.addEventListener("resize", () => figures.forEach((f) => f.resize()));
figures.forEach((f) => f.resize());
applyTheme(document.documentElement.dataset.theme || "light", false);
initVoice(); // oracle.js: lab report ↔ Oracle text
