// solver.js —— GPS 定位的核心机制（纯数学，不碰画图）
// 单位约定：距离 km，时间 μs（微秒）

// 光速：每微秒约 0.3 km（也就是 1 μs 的时钟误差 ≈ 300 m 的距离误差）
const C = 0.299792458; // km/μs

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 模拟接收机"测到"的伪距（pseudorange）。
 * 真实距离 + 接收机时钟误差造成的距离 + 噪声。
 * 注意：同一个时钟误差会加到【每一颗】卫星上 —— 这就是能把它解出来的关键。
 */
function measurePseudoranges(sats, receiver, clockBiasUs, noiseKm = []) {
  return sats.map((s, i) => dist(s, receiver) + C * clockBiasUs + (noiseKm[i] || 0));
}

/** 高斯消元解 A·x = b（A 是 n×n）。奇异时返回 null。 */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    // 选主元
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * 用 Gauss-Newton 迭代，从伪距反推位置（以及时钟误差）。
 *
 * 未知数：x, y，以及（可选）d = C × 时钟误差（单位 km）
 * 对每颗卫星 i，模型是：  ρ_i ≈ |s_i − p| + d
 * 每一轮：在当前猜测处把模型线性化 → 最小二乘求修正量 → 更新猜测。
 *
 * solveClock = false 时，假装接收机时钟是准的（只解 x, y），
 * 用来演示"不把时钟当未知数会错得多离谱"。
 */
function solvePosition(sats, rho, opts = {}) {
  const {
    solveClock = true,
    initial = { x: 50, y: 33 },
    maxIter = 20,
    tol = 1e-7,
  } = opts;

  const nUnknown = solveClock ? 3 : 2;
  if (sats.length < nUnknown) {
    return {
      ok: false,
      reason: `至少需要 ${nUnknown} 颗卫星（现在 ${sats.length} 颗）`,
    };
  }

  let x = initial.x, y = initial.y, d = 0;
  const path = [{ x, y }];
  let iterations = 0;

  for (; iterations < maxIter; iterations++) {
    // H：雅可比矩阵（每行对应一颗卫星），r：残差（测到的 − 模型预测的）
    const H = [], r = [];
    sats.forEach((s, i) => {
      const R = Math.max(dist(s, { x, y }), 1e-9);
      r.push(rho[i] - (R + d));
      const row = [(x - s.x) / R, (y - s.y) / R]; // 距离对 x、y 的偏导 = 从卫星指向你的单位向量
      if (solveClock) row.push(1);                 // 距离对 d 的偏导 = 1
      H.push(row);
    });

    // 正规方程 (HᵀH)·Δ = Hᵀr
    const HtH = Array.from({ length: nUnknown }, () => new Array(nUnknown).fill(0));
    const Htr = new Array(nUnknown).fill(0);
    for (let i = 0; i < H.length; i++) {
      for (let a = 0; a < nUnknown; a++) {
        Htr[a] += H[i][a] * r[i];
        for (let b = 0; b < nUnknown; b++) HtH[a][b] += H[i][a] * H[i][b];
      }
    }

    const delta = solveLinear(HtH, Htr);
    if (!delta) {
      return { ok: false, reason: "卫星几何太差（比如排成一条直线），解不出来", path };
    }

    x += delta[0];
    y += delta[1];
    if (solveClock) d += delta[2];
    path.push({ x, y });

    if (Math.hypot(...delta) < tol) { iterations++; break; }
  }

  const residuals = sats.map((s, i) => rho[i] - (dist(s, { x, y }) + d));

  // TODO（深度层：几何精度 DOP）：
  //   在最终位置再算一次 HtH，求逆矩阵，取对角线之和开根号 = GDOP。
  //   卫星挤在同一侧时 GDOP 会变大 → 同样的噪声，定位误差被放大。

  return {
    ok: true,
    x, y,
    clockBiasUs: d / C,
    path,
    residuals,
    iterations,
  };
}

// 让 node 也能 require 这个文件做测试；浏览器里这几行会被跳过
if (typeof module !== "undefined") {
  module.exports = { C, dist, measurePseudoranges, solveLinear, solvePosition };
}
