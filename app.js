// app.js —— 画图 + 交互。数学全在 solver.js 里。

const WORLD = { w: 100, h: 66 }; // 地图大小，单位 km（玩具尺度，真实卫星在 2 万 km 高空）
const COLORS = ["#e4572e", "#17a2b8", "#e0a800", "#5a9e3a", "#9b59b6", "#2e86ab", "#d35400"];

const DEFAULT_STATE = () => ({
  sats: [
    { x: 14, y: 10 },
    { x: 50, y: 5 },
    { x: 86, y: 12 },
  ],
  receiver: { x: 42, y: 46 },
  clockBiasUs: 0,  // 接收机时钟误差（μs）
  noiseM: 0,       // 测距噪声标准差（m）
  solveClock: true,
  noise: [],       // 每颗卫星的噪声样本（km），点“重新测量”时更新
});

let state = DEFAULT_STATE();

const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");
let dpr = 1, scale = 1; // scale：每 km 多少个设备像素

// ---------- 坐标换算 ----------
const toPx = (v) => v * scale;
function eventToWorld(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) * dpr) / scale,
    y: ((e.clientY - rect.top) * dpr) / scale,
  };
}

// ---------- 噪声 ----------
function gaussian() {
  // Box-Muller
  const u = 1 - Math.random(), v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function regenNoise() {
  state.noise = state.sats.map(() => (gaussian() * state.noiseM) / 1000);
}

// ---------- 画图 ----------
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
  ctx.fillStyle = "#9aa3ad";
  ctx.font = `${10 * dpr}px system-ui, sans-serif`;
  for (let x = 0; x <= WORLD.w; x += 10) {
    ctx.beginPath(); ctx.moveTo(toPx(x), 0); ctx.lineTo(toPx(x), canvas.height); ctx.stroke();
  }
  for (let y = 0; y <= WORLD.h; y += 10) {
    ctx.beginPath(); ctx.moveTo(0, toPx(y)); ctx.lineTo(canvas.width, toPx(y)); ctx.stroke();
  }
  ctx.fillText("每格 10 km", 6 * dpr, canvas.height - 6 * dpr);
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

function label(text, p, color, dy = -14) {
  ctx.fillStyle = color;
  ctx.font = `600 ${12 * dpr}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(text, toPx(p.x), toPx(p.y) + dy * dpr);
  ctx.textAlign = "start";
}

function drawSat(s, i) {
  const c = COLORS[i % COLORS.length];
  const x = toPx(s.x), y = toPx(s.y), r = 8 * dpr;
  ctx.fillStyle = c;
  ctx.fillRect(x - r, y - r / 2, r * 2, r);          // 机身
  ctx.fillRect(x - r * 2.2, y - r / 4, r * 0.9, r / 2); // 太阳能板
  ctx.fillRect(x + r * 1.3, y - r / 4, r * 0.9, r / 2);
  label(`卫星 ${i + 1}`, s, c);
}

function drawReceiver(p) {
  ctx.fillStyle = "#1f2933";
  ctx.beginPath();
  ctx.arc(toPx(p.x), toPx(p.y), 7 * dpr, 0, Math.PI * 2);
  ctx.fill();
  label("你（真实位置）", p, "#1f2933", 24);
}

function drawEstimate(p) {
  const x = toPx(p.x), y = toPx(p.y), r = 9 * dpr;
  ctx.strokeStyle = "#d63384";
  ctx.lineWidth = 3 * dpr;
  ctx.beginPath();
  ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
  ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
  ctx.stroke();
  label("算出来的位置", p, "#d63384", -16);
}

function drawPath(path) {
  ctx.strokeStyle = "rgba(214,51,132,0.35)";
  ctx.fillStyle = "rgba(214,51,132,0.5)";
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  path.forEach((p, i) => (i ? ctx.lineTo(toPx(p.x), toPx(p.y)) : ctx.moveTo(toPx(p.x), toPx(p.y))));
  ctx.stroke();
  path.forEach((p) => {
    ctx.beginPath(); ctx.arc(toPx(p.x), toPx(p.y), 2.5 * dpr, 0, Math.PI * 2); ctx.fill();
  });
}

function draw() {
  const rho = measurePseudoranges(state.sats, state.receiver, state.clockBiasUs, state.noise);
  const sol = solvePosition(state.sats, rho, {
    solveClock: state.solveClock,
    initial: { x: WORLD.w / 2, y: WORLD.h / 2 },
  });

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid();

  // 实线圆：接收机"以为"的距离（被时钟误差拉大/缩小了）
  state.sats.forEach((s, i) => circle(s, rho[i], COLORS[i % COLORS.length], { alpha: 0.85 }));

  // 虚线圆：减掉算出来的时钟误差之后的距离 —— 应该重新交在一点
  if (sol.ok && state.solveClock) {
    state.sats.forEach((s, i) =>
      circle(s, rho[i] - C * sol.clockBiasUs, COLORS[i % COLORS.length], { dashed: true, width: 1.5, alpha: 0.6 })
    );
  }

  if (sol.path) drawPath(sol.path);
  drawReceiver(state.receiver);
  if (sol.ok) drawEstimate(sol);
  state.sats.forEach(drawSat);

  updateReadout(sol);
}

// ---------- 数值面板 ----------
const $ = (id) => document.getElementById(id);

function fmtDist(km) {
  const m = Math.abs(km) * 1000;
  return m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`;
}

function updateReadout(sol) {
  $("clockVal").textContent = `${state.clockBiasUs.toFixed(1)} μs`;
  $("clockDist").textContent = `≈ 每个距离都多算了 ${fmtDist(C * state.clockBiasUs)}`;
  $("noiseVal").textContent = `${state.noiseM} m`;

  if (!sol.ok) {
    $("status").textContent = "⚠️ " + sol.reason;
    $("errVal").textContent = "—";
    $("clockEst").textContent = "—";
    $("iterVal").textContent = "—";
    return;
  }
  $("status").textContent = "";
  $("errVal").textContent = fmtDist(Math.hypot(sol.x - state.receiver.x, sol.y - state.receiver.y));
  $("clockEst").textContent = state.solveClock ? `${sol.clockBiasUs.toFixed(2)} μs` : "（没当未知数解）";
  $("iterVal").textContent = sol.iterations;
}

// ---------- 拖拽 ----------
let dragging = null;

function pick(p) {
  const hitKm = (16 * dpr) / scale;
  if (Math.hypot(p.x - state.receiver.x, p.y - state.receiver.y) < hitKm) return state.receiver;
  return state.sats.find((s) => Math.hypot(p.x - s.x, p.y - s.y) < hitKm) || null;
}

canvas.addEventListener("pointerdown", (e) => {
  dragging = pick(eventToWorld(e));
  if (dragging) canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  const p = eventToWorld(e);
  if (!dragging) {
    canvas.style.cursor = pick(p) ? "grab" : "default";
    return;
  }
  dragging.x = Math.min(WORLD.w, Math.max(0, p.x));
  dragging.y = Math.min(WORLD.h, Math.max(0, p.y));
  draw();
});
const endDrag = () => (dragging = null);
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// ---------- 控件 ----------
$("clock").addEventListener("input", (e) => { state.clockBiasUs = +e.target.value; draw(); });
$("noise").addEventListener("input", (e) => { state.noiseM = +e.target.value; regenNoise(); draw(); });
$("solveClock").addEventListener("change", (e) => { state.solveClock = e.target.checked; draw(); });
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
  state = DEFAULT_STATE();
  $("clock").value = 0; $("noise").value = 0; $("solveClock").checked = true;
  regenNoise(); draw();
});

window.addEventListener("resize", resize);
regenNoise();
resize();
