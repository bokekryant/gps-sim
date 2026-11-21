// app.js — drawing + interaction. All the maths lives in solver.js.
// The page tells a story in four steps:
//   problem  1 · The problem: a slightly wrong clock breaks positioning
//   trick    2 · The trick: shrink every circle by the same amount until they meet
//   step     3 · How it's computed: Gauss-Newton, one step at a time
//   play     4 · Play: sandbox

const WORLD = { w: 100, h: 66 }; // map size in km (toy scale; real satellites are ~20,000 km up)
const CENTER = { x: WORLD.w / 2, y: WORLD.h / 2 };
const COLORS = ["#e4572e", "#17a2b8", "#e0a800", "#5a9e3a", "#9b59b6", "#2e86ab", "#d35400"];
const PINK = "#d63384";
const BIAS_RANGE = 60; // range of "your guess" in step 2: ±60 μs
const MODES = ["problem", "trick", "step", "play"];

const freshStep = () => ({
  guess: { x: CENTER.x, y: CENTER.y, d: 0 },
  history: [{ x: CENTER.x, y: CENTER.y }],
  k: 0,
});

const DEFAULT_STATE = () => ({
  sats: [
    { x: 14, y: 10 },
    { x: 50, y: 5 },
    { x: 86, y: 12 },
  ],
  receiver: { x: 42, y: 46 },
  clockBiasUs: 0, // the phone's real clock error (μs). Starts perfect; the user breaks it in step 1.
  noiseM: 0,
  noise: [],
  mode: "problem",
  solveClock: true,
  guessBiasUs: 0, // step 2: the user's guess of the clock error
  step: freshStep(),
});

let state = DEFAULT_STATE();

const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");
let dpr = 1, scale = 1; // scale: device pixels per km
const $ = (id) => document.getElementById(id);

// ---------- coordinates / helpers ----------
const toPx = (v) => v * scale;
function eventToWorld(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) * dpr) / scale,
    y: ((e.clientY - rect.top) * dpr) / scale,
  };
}
const colorOf = (i) => COLORS[i % COLORS.length];
function fmtDist(km) {
  const m = Math.abs(km) * 1000;
  const sign = km < 0 ? "−" : "";
  return m < 1000 ? `${sign}${m.toFixed(0)} m` : `${sign}${(m / 1000).toFixed(2)} km`;
}
const rmsOf = (arr) => Math.sqrt(arr.reduce((a, v) => a + v * v, 0) / arr.length);

// ---------- noise ----------
function gaussian() {
  const u = 1 - Math.random(), v = Math.random(); // Box-Muller
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function regenNoise() {
  state.noise = state.sats.map(() => (gaussian() * state.noiseM) / 1000);
}

// ---------- drawing primitives ----------
function resize() {
  const w = canvas.parentElement.clientWidth;
  const h = (w * WORLD.h) / WORLD.w;
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.height = h + "px";
  scale = canvas.width / WORLD.w;
  draw();
}

function drawGrid() {
  ctx.strokeStyle = "#eef0f3";
  ctx.lineWidth = 1 * dpr;
  for (let x = 0; x <= WORLD.w; x += 10) {
    ctx.beginPath(); ctx.moveTo(toPx(x), 0); ctx.lineTo(toPx(x), canvas.height); ctx.stroke();
  }
  for (let y = 0; y <= WORLD.h; y += 10) {
    ctx.beginPath(); ctx.moveTo(0, toPx(y)); ctx.lineTo(canvas.width, toPx(y)); ctx.stroke();
  }
  ctx.fillStyle = "#9aa3ad";
  ctx.font = `${10 * dpr}px system-ui, sans-serif`;
  ctx.fillText("each square = 10 km", 6 * dpr, canvas.height - 6 * dpr);
}

function circle(c, rKm, color, { dashed = false, width = 2, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width * dpr;
  ctx.setLineDash(dashed ? [6 * dpr, 5 * dpr] : []);
  ctx.beginPath();
  ctx.arc(toPx(c.x), toPx(c.y), Math.max(0, toPx(rKm)), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function line(a, b, color, { width = 1.5, dashed = false, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width * dpr;
  ctx.setLineDash(dashed ? [4 * dpr, 4 * dpr] : []);
  ctx.beginPath(); ctx.moveTo(toPx(a.x), toPx(a.y)); ctx.lineTo(toPx(b.x), toPx(b.y)); ctx.stroke();
  ctx.restore();
}

function arrow(a, b, color, { width = 2.5, dashed = false } = {}) {
  const x1 = toPx(a.x), y1 = toPx(a.y), x2 = toPx(b.x), y2 = toPx(b.y);
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

function label(text, p, color, dy = -14) {
  ctx.fillStyle = color;
  ctx.font = `600 ${12 * dpr}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(text, toPx(p.x), toPx(p.y) + dy * dpr);
  ctx.textAlign = "start";
}

function drawSat(s, i) {
  const c = colorOf(i);
  const x = toPx(s.x), y = toPx(s.y), r = 8 * dpr;
  ctx.fillStyle = c;
  ctx.fillRect(x - r, y - r / 2, r * 2, r);
  ctx.fillRect(x - r * 2.2, y - r / 4, r * 0.9, r / 2);
  ctx.fillRect(x + r * 1.3, y - r / 4, r * 0.9, r / 2);
  label(`Satellite ${i + 1}`, s, c);
}

function drawReceiver(p) {
  ctx.fillStyle = "#1f2933";
  ctx.beginPath(); ctx.arc(toPx(p.x), toPx(p.y), 7 * dpr, 0, Math.PI * 2); ctx.fill();
  label("You (true position)", p, "#1f2933", 24);
}

function drawCross(p, text) {
  const x = toPx(p.x), y = toPx(p.y), r = 9 * dpr;
  ctx.strokeStyle = PINK;
  ctx.lineWidth = 3 * dpr;
  ctx.beginPath();
  ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
  ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
  ctx.stroke();
  label(text, p, PINK, -16);
}

function drawGuess(p) {
  ctx.fillStyle = PINK;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath(); ctx.arc(toPx(p.x), toPx(p.y), 7 * dpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  label("Current guess (drag me)", p, PINK, -16);
}

function drawPath(path) {
  ctx.strokeStyle = "rgba(214,51,132,0.35)";
  ctx.fillStyle = "rgba(214,51,132,0.5)";
  ctx.lineWidth = 1.5 * dpr;
  ctx.setLineDash([]);
  ctx.beginPath();
  path.forEach((p, i) => (i ? ctx.lineTo(toPx(p.x), toPx(p.y)) : ctx.moveTo(toPx(p.x), toPx(p.y))));
  ctx.stroke();
  path.forEach((p) => { ctx.beginPath(); ctx.arc(toPx(p.x), toPx(p.y), 2.5 * dpr, 0, Math.PI * 2); ctx.fill(); });
}

// ---------- main draw ----------
function draw() {
  const rho = measurePseudoranges(state.sats, state.receiver, state.clockBiasUs, state.noise);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid();
  if (state.mode === "problem") drawProblem(rho);
  else if (state.mode === "trick") drawTrick(rho);
  else if (state.mode === "step") drawStepMode(rho);
  else drawPlay(rho);
  state.sats.forEach(drawSat);

  const clockTxt = `${state.clockBiasUs.toFixed(1)} μs`;
  const distTxt = `= every distance is ${fmtDist(C * state.clockBiasUs)} too long`;
  $("clockVal").textContent = clockTxt;
  $("clockDist").textContent = distTxt;
  $("probClockVal").textContent = clockTxt;
  $("probClockDist").textContent = distTxt;
  $("noiseVal").textContent = `${state.noiseM} m`;
}

// For a guessed clock error b̂: subtract C·b̂ from every pseudorange,
// then find the single point that best fits all the circles, and measure how much they disagree.
function fitForBias(rho, biasUs) {
  const corr = rho.map((r) => r - C * biasUs);
  const fit = solvePosition(state.sats, corr, { solveClock: false, initial: CENTER });
  return { corr, fit, rms: fit.ok ? rmsOf(fit.residuals) : NaN };
}

// Draw circles + the best-fit point + a thick line from that point to each circle.
function drawFit(corr, fit, crossLabel) {
  state.sats.forEach((s, i) => circle(s, corr[i], colorOf(i), { alpha: 0.85 }));
  if (fit.ok) {
    state.sats.forEach((s, i) => {
      const R = Math.max(dist(s, fit), 1e-9);
      const onCircle = { x: s.x + ((fit.x - s.x) / R) * corr[i], y: s.y + ((fit.y - s.y) / R) * corr[i] };
      line(fit, onCircle, colorOf(i), { width: 4 });
    });
  }
  drawReceiver(state.receiver);
  if (fit.ok) drawCross(fit, crossLabel);
}

// 1 · The problem — the phone assumes its clock is perfect.
function drawProblem(rho) {
  const { corr, fit } = fitForBias(rho, 0);
  drawFit(corr, fit, "Phone's best guess");
  if (!fit.ok) { $("probVerdict").textContent = "⚠️ " + fit.reason; return; }
  const err = Math.hypot(fit.x - state.receiver.x, fit.y - state.receiver.y);
  $("probVerdict").innerHTML =
    Math.abs(state.clockBiasUs) < 0.05
      ? "Perfect clock: all the circles meet exactly at you. 👍<br>Now drag the slider."
      : `The circles no longer meet at one point. Your phone's best guess is <b>${fmtDist(err)}</b> away from you.`;
}

// 2 · The trick — the user guesses the clock error.
function drawTrick(rho) {
  const { corr, fit, rms } = fitForBias(rho, state.guessBiasUs);
  drawFit(corr, fit, "Best point for all circles");

  $("guessVal").textContent = `${state.guessBiasUs.toFixed(1)} μs`;
  if (!fit.ok) {
    $("rmsVal").textContent = "—";
    $("trickVerdict").textContent = "⚠️ " + fit.reason;
  } else {
    $("rmsVal").textContent = fmtDist(rms);
    const tolKm = Math.max(0.03, (2 * state.noiseM) / 1000);
    $("trickVerdict").textContent =
      state.sats.length < 3
        ? "With only 2 satellites, ANY guess works — so you can't tell what the clock error is. That's why you need one extra satellite: 3 on a flat map, 4 in the real 3D world."
        : rms < tolKm
        ? "✓ The circles meet! That guess is your phone's clock error."
        : "Not yet. Find the lowest point of the curve below.";
  }
  drawBiasChart(rho);
}

function drawBiasChart(rho) {
  const cv = $("biasChart");
  const cctx = cv.getContext("2d");
  const w = cv.parentElement.clientWidth, h = 150;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  cv.style.height = h + "px";
  const pad = { l: 8 * dpr, r: 8 * dpr, t: 14 * dpr, b: 22 * dpr };
  const W = cv.width - pad.l - pad.r, Hh = cv.height - pad.t - pad.b;

  // Sweep every possible guess and compute how much the circles disagree for each.
  const pts = [];
  for (let b = -BIAS_RANGE; b <= BIAS_RANGE + 1e-9; b += 0.5) pts.push({ b, rms: fitForBias(rho, b).rms });
  const valid = pts.filter((p) => isFinite(p.rms));
  const yMax = Math.max(0.05, ...valid.map((p) => p.rms));
  const X = (b) => pad.l + ((b + BIAS_RANGE) / (2 * BIAS_RANGE)) * W;
  const Y = (r) => pad.t + Hh - (r / yMax) * Hh;

  cctx.clearRect(0, 0, cv.width, cv.height);
  cctx.strokeStyle = "#cbd2d9"; cctx.lineWidth = 1 * dpr;
  cctx.beginPath(); cctx.moveTo(pad.l, pad.t + Hh); cctx.lineTo(pad.l + W, pad.t + Hh); cctx.stroke();
  cctx.fillStyle = "#7b8794";
  cctx.font = `${10 * dpr}px system-ui, sans-serif`;
  cctx.textAlign = "center";
  for (const b of [-60, -30, 0, 30, 60]) cctx.fillText(`${b}`, X(b), cv.height - 6 * dpr);
  cctx.textAlign = "start";
  cctx.fillText("↑ how much the circles disagree", pad.l, 10 * dpr);
  cctx.textAlign = "right";
  cctx.fillText("your guess (μs) →", pad.l + W, pad.t + Hh - 4 * dpr);
  cctx.textAlign = "start";

  cctx.strokeStyle = "#52606d"; cctx.lineWidth = 2 * dpr;
  cctx.beginPath();
  valid.forEach((p, i) => (i ? cctx.lineTo(X(p.b), Y(p.rms)) : cctx.moveTo(X(p.b), Y(p.rms))));
  cctx.stroke();

  // current guess
  const cur = fitForBias(rho, state.guessBiasUs).rms;
  cctx.strokeStyle = PINK; cctx.lineWidth = 1.5 * dpr;
  cctx.beginPath(); cctx.moveTo(X(state.guessBiasUs), pad.t); cctx.lineTo(X(state.guessBiasUs), pad.t + Hh); cctx.stroke();
  if (isFinite(cur)) {
    cctx.fillStyle = PINK;
    cctx.beginPath(); cctx.arc(X(state.guessBiasUs), Y(Math.min(cur, yMax)), 5 * dpr, 0, Math.PI * 2); cctx.fill();
  }
}

// 3 · How it's computed — Gauss-Newton, one step at a time.
function drawStepMode(rho) {
  const g = state.step.guess;
  const st = gaussNewtonStep(state.sats, rho, g, true);

  // circles corrected by the current clock-error guess
  state.sats.forEach((s, i) => circle(s, rho[i] - g.d, colorOf(i), { alpha: 0.4 }));
  // satellite → guess lines
  state.sats.forEach((s, i) => line(s, g, colorOf(i), { dashed: true, alpha: 0.5 }));
  drawPath(state.step.history);

  // each satellite's "push": residual × direction
  st.rows.forEach((r, i) =>
    arrow(g, { x: g.x + r.ux * r.residual, y: g.y + r.uy * r.residual }, colorOf(i), { width: 3 })
  );
  // the step actually taken after combining all pushes
  if (st.ok) arrow(g, st.next, PINK, { dashed: true, width: 2.5 });

  drawReceiver(state.receiver);
  drawGuess(g);

  $("stepK").textContent = state.step.k;
  $("stepClock").textContent = `${(g.d / C).toFixed(2)} μs`;
  $("stepRms").textContent = fmtDist(st.rms);
  $("stepErr").textContent = fmtDist(Math.hypot(g.x - state.receiver.x, g.y - state.receiver.y));
  $("stepStatus").textContent = st.ok
    ? st.size < 1e-4 ? "✓ Converged: more steps don't move it." : ""
    : "⚠️ " + st.reason;
  $("stepTable").innerHTML = st.rows
    .map(
      (r, i) => `<tr>
        <td><span class="dot" style="background:${colorOf(i)}"></span>${i + 1}</td>
        <td>${r.measured.toFixed(2)}</td>
        <td>${r.predicted.toFixed(2)}</td>
        <td class="${r.residual >= 0 ? "pos" : "neg"}">${r.residual >= 0 ? "+" : "−"}${Math.abs(r.residual).toFixed(2)}</td>
      </tr>`
    )
    .join("");
}

function stepOnce() {
  const rho = measurePseudoranges(state.sats, state.receiver, state.clockBiasUs, state.noise);
  const st = gaussNewtonStep(state.sats, rho, state.step.guess, true);
  if (!st.ok) return false;
  state.step.guess = st.next;
  state.step.history.push({ x: st.next.x, y: st.next.y });
  state.step.k++;
  draw();
  return st.size > 1e-4;
}

let runTimer = null;
function runToEnd() {
  clearInterval(runTimer);
  let n = 0;
  runTimer = setInterval(() => {
    if (!stepOnce() || ++n > 25) clearInterval(runTimer);
  }, 450);
}

// 4 · Play — the full solver.
function drawPlay(rho) {
  const sol = solvePosition(state.sats, rho, { solveClock: state.solveClock, initial: CENTER });

  // solid: distances the phone measured (stretched by the clock error)
  state.sats.forEach((s, i) => circle(s, rho[i], colorOf(i), { alpha: 0.85 }));
  // dashed: after removing the clock error the solver found — they meet again
  if (sol.ok && state.solveClock) {
    state.sats.forEach((s, i) =>
      circle(s, rho[i] - C * sol.clockBiasUs, colorOf(i), { dashed: true, width: 1.5, alpha: 0.6 })
    );
  }
  if (sol.path) drawPath(sol.path);
  drawReceiver(state.receiver);
  if (sol.ok) drawCross(sol, "Computed position");

  if (!sol.ok) {
    $("playStatus").textContent = "⚠️ " + sol.reason;
    ["errVal", "clockEst", "iterVal"].forEach((id) => ($(id).textContent = "—"));
    return;
  }
  $("playStatus").textContent = "";
  $("errVal").textContent = fmtDist(Math.hypot(sol.x - state.receiver.x, sol.y - state.receiver.y));
  $("clockEst").textContent = state.solveClock ? `${sol.clockBiasUs.toFixed(2)} μs` : "(not solved for)";
  $("iterVal").textContent = sol.iterations;
}

// ---------- dragging ----------
let dragging = null;

function pick(p) {
  const hitKm = (16 * dpr) / scale;
  const near = (o) => Math.hypot(p.x - o.x, p.y - o.y) < hitKm;
  if (state.mode === "step" && near(state.step.guess)) return { kind: "guess", obj: state.step.guess };
  if (near(state.receiver)) return { kind: "point", obj: state.receiver };
  const s = state.sats.find(near);
  return s ? { kind: "point", obj: s } : null;
}

canvas.addEventListener("pointerdown", (e) => {
  dragging = pick(eventToWorld(e));
  if (dragging) { canvas.setPointerCapture(e.pointerId); clearInterval(runTimer); }
});
canvas.addEventListener("pointermove", (e) => {
  const p = eventToWorld(e);
  if (!dragging) { canvas.style.cursor = pick(p) ? "grab" : "default"; return; }
  dragging.obj.x = Math.min(WORLD.w, Math.max(0, p.x));
  dragging.obj.y = Math.min(WORLD.h, Math.max(0, p.y));
  if (dragging.kind === "guess") {
    state.step.history = [{ x: dragging.obj.x, y: dragging.obj.y }];
    state.step.k = 0;
  }
  draw();
});
const endDrag = () => (dragging = null);
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// ---------- controls ----------
function setClock(v) {
  state.clockBiasUs = v;
  $("clock").value = v;
  $("probClock").value = v;
}

function setMode(mode) {
  // Steps 2–4 need a wrong clock to be interesting. If the user left it perfect, break it for them.
  if (mode !== "problem" && Math.abs(state.clockBiasUs) < 1) setClock(15);
  state.mode = mode;
  clearInterval(runTimer);
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === mode));
  document.querySelectorAll("[data-for]").forEach((el) => (el.hidden = !el.dataset.for.split(" ").includes(mode)));
  draw();
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setMode(t.dataset.mode)));
document.querySelectorAll("[data-goto]").forEach((a) =>
  a.addEventListener("click", (e) => { e.preventDefault(); setMode(a.dataset.goto); })
);

$("clock").addEventListener("input", (e) => { setClock(+e.target.value); draw(); });
$("probClock").addEventListener("input", (e) => { setClock(+e.target.value); draw(); });
$("noise").addEventListener("input", (e) => { state.noiseM = +e.target.value; regenNoise(); draw(); });
$("solveClock").addEventListener("change", (e) => { state.solveClock = e.target.checked; draw(); });
$("guess").addEventListener("input", (e) => { state.guessBiasUs = +e.target.value; draw(); });
$("remeasure").addEventListener("click", () => { regenNoise(); draw(); });
$("addSat").addEventListener("click", () => {
  state.sats.push({ x: 10 + Math.random() * 80, y: 4 + Math.random() * 20 });
  regenNoise(); draw();
});
$("removeSat").addEventListener("click", () => {
  if (state.sats.length > 1) state.sats.pop();
  regenNoise(); draw();
});
$("reset").addEventListener("click", () => {
  const mode = state.mode;
  state = DEFAULT_STATE();
  setClock(0); $("noise").value = 0; $("guess").value = 0;
  $("solveClock").checked = true;
  regenNoise(); setMode(mode);
});
$("stepNext").addEventListener("click", () => { clearInterval(runTimer); stepOnce(); });
$("stepRun").addEventListener("click", runToEnd);
$("stepReset").addEventListener("click", () => { clearInterval(runTimer); state.step = freshStep(); draw(); });

window.addEventListener("resize", resize);
regenNoise();
setMode("problem");
resize();
