// solver.js — the GPS positioning mechanism itself (pure maths, no drawing).
// Units: distance in km, time in μs (microseconds).

// Speed of light: about 0.3 km per microsecond.
// So a clock that is off by 1 μs puts every distance off by ~300 m.
const C = 0.299792458; // km/μs

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Simulate the "pseudoranges" the phone measures.
 * pseudorange = true distance + distance caused by the phone's clock error + noise.
 * Note: the SAME clock error is added to EVERY satellite. That is what makes it solvable.
 */
function measurePseudoranges(sats, receiver, clockBiasUs, noiseKm = []) {
  return sats.map((s, i) => dist(s, receiver) + C * clockBiasUs + (noiseKm[i] || 0));
}

/** Solve A·x = b (A is n×n) by Gaussian elimination. Returns null if A is singular. */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    // partial pivoting: use the row with the largest value in this column
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
 * ONE step of Gauss-Newton. Split out so the page can show each step.
 *
 * guess = { x, y, d }, where d is the current guess of "distance caused by clock error" (km).
 * For each satellite we compute:
 *   predicted = pseudorange the guess predicts = |satellite − guess| + d
 *   residual  = measured − predicted   (positive: measured is longer → move away from this satellite)
 *   (ux, uy)  = unit vector from the satellite towards the guess (the direction the residual "pushes")
 * Least squares then combines every satellite's push into one correction, delta.
 */
function gaussNewtonStep(sats, rho, guess, solveClock = true) {
  const n = solveClock ? 3 : 2;
  const d = solveClock ? guess.d || 0 : 0;

  const rows = sats.map((s, i) => {
    const R = Math.max(dist(s, guess), 1e-9);
    const predicted = R + d;
    return {
      R,
      ux: (guess.x - s.x) / R,
      uy: (guess.y - s.y) / R,
      measured: rho[i],
      predicted,
      residual: rho[i] - predicted,
    };
  });
  const rms = Math.sqrt(rows.reduce((a, r) => a + r.residual ** 2, 0) / rows.length);

  if (sats.length < n) {
    return { ok: false, rows, rms, reason: `Needs at least ${n} satellites (you have ${sats.length})` };
  }

  // H: the Jacobian. Each row = [∂pseudorange/∂x, ∂/∂y, (∂/∂d = 1)]
  const H = rows.map((r) => (solveClock ? [r.ux, r.uy, 1] : [r.ux, r.uy]));

  // Normal equations: (HᵀH)·Δ = Hᵀr
  const HtH = Array.from({ length: n }, () => new Array(n).fill(0));
  const Htr = new Array(n).fill(0);
  for (let i = 0; i < H.length; i++) {
    for (let a = 0; a < n; a++) {
      Htr[a] += H[i][a] * rows[i].residual;
      for (let b = 0; b < n; b++) HtH[a][b] += H[i][a] * H[i][b];
    }
  }

  const delta = solveLinear(HtH, Htr);
  if (!delta) {
    return { ok: false, rows, rms, reason: "Satellite geometry too poor (e.g. all in a line) to solve" };
  }

  const step = { x: delta[0], y: delta[1], d: solveClock ? delta[2] : 0 };
  return {
    ok: true,
    rows,
    rms,
    delta: step,
    size: Math.hypot(step.x, step.y, step.d),
    next: { x: guess.x + step.x, y: guess.y + step.y, d: d + step.d },
  };
}

/**
 * Repeat Gauss-Newton steps until the guess stops moving.
 *
 * Unknowns: x, y and (optionally) d = C × clock error (km).
 * Model for each satellite i:  ρ_i ≈ |s_i − p| + d
 *
 * solveClock = false pretends the phone's clock is perfect (solves only x, y).
 * Used to show how wrong you get if you don't treat the clock as an unknown.
 */
function solvePosition(sats, rho, opts = {}) {
  const {
    solveClock = true,
    initial = { x: 50, y: 33 },
    maxIter = 20,
    tol = 1e-7,
  } = opts;

  let guess = { x: initial.x, y: initial.y, d: 0 };
  const path = [{ x: guess.x, y: guess.y }];
  let iterations = 0;

  for (; iterations < maxIter; iterations++) {
    const st = gaussNewtonStep(sats, rho, guess, solveClock);
    if (!st.ok) return { ok: false, reason: st.reason, path };
    guess = st.next;
    path.push({ x: guess.x, y: guess.y });
    if (st.size < tol) { iterations++; break; }
  }

  const { x, y, d } = guess;
  const residuals = sats.map((s, i) => rho[i] - (dist(s, { x, y }) + d));

  // TODO (depth layer: geometry / DOP):
  //   At the final position, invert HtH; sqrt of the sum of its diagonal = GDOP.
  //   When satellites bunch together GDOP grows → the same noise gives a bigger position error.

  return { ok: true, x, y, clockBiasUs: d / C, path, residuals, iterations };
}

// Lets node `require` this file for tests; skipped in the browser.
if (typeof module !== "undefined") {
  module.exports = { C, dist, measurePseudoranges, solveLinear, gaussNewtonStep, solvePosition };
}
