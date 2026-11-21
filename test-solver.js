// Run with: node test-solver.js
const { measurePseudoranges, solvePosition } = require("./solver.js");

const sats = [{ x: 14, y: 10 }, { x: 50, y: 5 }, { x: 86, y: 12 }];
const rx = { x: 42, y: 46 };
let fails = 0;
const check = (name, cond, info) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`, info ?? "");
  if (!cond) fails++;
};

for (const bias of [0, 10, -25, 50]) {
  const rho = measurePseudoranges(sats, rx, bias);
  const s = solvePosition(sats, rho, { solveClock: true, initial: { x: 50, y: 33 } });
  const err = Math.hypot(s.x - rx.x, s.y - rx.y) * 1000;
  check(`3 sats, solving clock, bias=${bias}μs`, s.ok && err < 0.01 && Math.abs(s.clockBiasUs - bias) < 1e-6,
    `error ${err.toFixed(4)} m, clock found ${s.clockBiasUs.toFixed(4)} μs, ${s.iterations} iterations`);

  const n = solvePosition(sats, rho, { solveClock: false, initial: { x: 50, y: 33 } });
  const errN = Math.hypot(n.x - rx.x, n.y - rx.y) * 1000;
  console.log(`      without solving clock: error ${errN.toFixed(0)} m`);
}

const two = solvePosition(sats.slice(0, 2), [1, 2], { solveClock: true });
check("2 sats while solving clock → error", !two.ok, two.reason);

process.exit(fails ? 1 : 0);
