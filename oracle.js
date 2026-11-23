// oracle.js — an easter egg: rewrites the whole page as Magic: The Gathering "Oracle text"
// (the official rules wording on cards). All text here is original; only the templating style
// is borrowed. Mana symbols are drawn with CSS, not the official icons.
//
// Elements with data-k="key" get ORACLE[key] in Oracle mode and their original HTML otherwise.
// Live result messages in app.js use say(labReportText, oracleText).

const ORACLE = {
  h1: `Quartz-Clock Navigator <span class="cost">{2}{U}</span>`,
  h1t: `Artifact Creature — Phone Scout`,
  lede: `Results are calculated live from your inputs. <i>(Nothing on this page is prerecorded.)</i>`,
  bg: `Whenever a Satellite broadcasts the time, Quartz-Clock Navigator times the signal and multiplies by the speed of light. Draw a circle with that radius around that Satellite. Quartz-Clock Navigator is where the circles cross.<span class="flavor">Light travels 300 m each microsecond. The Satellites keep atomic time. The Navigator keeps quartz time.</span>`,

  e1h: `Clock Drift <span class="cost">{X}{R}</span>`,
  e1t: `Sorcery — Experiment`,
  hyp: `<b>Hypothesis</b> — If X is even a few microseconds, Quartz-Clock Navigator's calculated position is wrong by kilometres. <i>(Each microsecond adds about 300 m to each circle.)</i>`,
  v1: `<span>Choose X</span>the clock error (μs)`,
  v2: `<span>Track</span>distance from the true position (km)`,
  v3: `<span>Hexproof</span>Satellites, true position, noise`,
  d1: `X (clock error)`,

  e2h: `Uniform Shrink <span class="cost">{1}{U}</span>`,
  e2t: `Instant — Experiment`,
  e2p1: `All timings use the same clock, so the clock error is the same for each Satellite. <i>(Every circle is too big by the same distance.)</i> If all circles share a single point, the amount they shrank is the clock error.`,
  e2p2: `<b>Method</b> — {T}: Each circle gets −X km, where X is how far you drag target circle inwards. Activate only while the circles don't share a point.`,
  d2: `Choose X (your guess)`,
  sum2: `Rulings`,
  hint2: `The thick lines show how far each circle is from the best fit point. The graph shows the disagreement for each possible X. Its lowest point is the real clock error.`,

  e3h: `Gauss-Newton, Least Squarer <span class="cost">{2}{U}{U}</span>`,
  e3t: `Legendary Creature — Algorithm`,
  e3p: `Quartz-Clock Navigator can't drag circles. Instead, it casts Gauss-Newton. <i>(Real GPS receivers use similar methods.)</i> Gauss-Newton has:`,
  e3ol: `<li>At the beginning of the first step, put a guess counter on a point. <i>(That's the hollow circle.)</i></li>
    <li>For each Satellite, compare its measured distance with the distance the guess predicts. That Satellite pushes the guess outwards if measured is longer, or inwards if it's shorter.</li>
    <li>Combine the pushes into one move <i>(the thick dashed arrow)</i>, then move the guess counter.</li>
    <li>Repeat this process until the guess stops moving.</li>`,
  stepNext: `Resolve`,
  stepRun: `Resolve all`,
  stepReset: `Mulligan`,
  sum3: `Rulings`,
  e3n: `Gauss-Newton has three unknowns: x, y and the clock error. It needs three Satellites on a flat map. <i>(In 3D it needs four. That's why real GPS needs at least four Satellites.)</i>`,
  hint3: `If the guess counter starts above the Satellites, Gauss-Newton may find the other crossing point. <i>(Two circles can cross in two places.)</i>`,

  e4h: `Open Sandbox <span class="cost">{G}{U}</span>`,
  e4t: `Enchantment`,
  e4p: `You may drag Satellites and the true position any time you could cast an instant. You may change any variable at any time.`,
  e4ul: `<li>Whenever measurement noise increases, position error increases.</li>
    <li>As long as the Satellites are close together, noise causes a much bigger error.</li>
    <li>If "Solve for the clock error" is unticked, the error is large even with no noise.</li>`,
  addSat: `Create a Satellite token`,
  removeSat: `Sacrifice a Satellite`,
  remeasure: `Draw new noise`,
  reset: `Start a new game`,

  e5h: `Supported Hypothesis <span class="cost">{W}</span>`,
  e5t: `Sorcery — Conclusion`,
  e5p: `A clock error of a few microseconds moves the calculated position by kilometres. <i>(This supports the hypothesis.)</i> GPS still works with a quartz clock, because the clock error is the same for each Satellite. Treat it as one more unknown and solve for it with the position. This costs one additional Satellite: four in 3D, not three.`,
  e6h: `Errata <span class="cost">{1}</span>`,
  e6t: `Enchantment — Evaluation`,
  e6p: `This model has the following limitations:`,
  e6ul: `<li>This model is 2D, so it needs only three Satellites.</li>
    <li>The map is 100 km wide. Real Satellites are about 20,000 km away. <i>(The maths is the same.)</i></li>
    <li>Ignore delays from the atmosphere, errors in the Satellites' own clocks and orbits, and relativity.</li>
    <li>In Uniform Shrink, the circles snap to the answer within 3 μs. This makes it easier, but less precise.</li>`,
  e6p2: `Future printings may add a 3D view, atmospheric delay and the relativity correction.<span class="flavor">Satellite clocks run about 38 μs per day fast. Without the fix, the error grows by about 10 km a day.</span>`,
};

// {U} → a small round mana symbol drawn with CSS
function manaify(html) {
  return html.replace(/\{([0-9WUBRGXCT])\}/g, (_, c) => `<span class="ms" data-c="${c}">${c === "T" ? "↷" : c}</span>`);
}

const isOracle = () => document.documentElement.dataset.voice === "oracle";
// Live messages: pick the lab-report or the Oracle wording.
const say = (report, oracle) => (isOracle() ? manaify(oracle) : report);

function applyVoice(v, save) {
  document.documentElement.dataset.voice = v;
  if (save) { try { localStorage.setItem("voice", v); } catch (e) {} }
  document.querySelectorAll("[data-k]").forEach((el) => {
    if (el.dataset.report === undefined) el.dataset.report = el.innerHTML;
    const text = v === "oracle" ? ORACLE[el.dataset.k] : el.dataset.report;
    if (text !== undefined) el.innerHTML = manaify(text);
  });
  document.querySelectorAll("[data-set-voice]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.setVoice === v)));
  if (typeof figures !== "undefined") figures.forEach((f) => f.render()); // refresh live messages
}

function initVoice() {
  let v = "report";
  try { v = localStorage.getItem("voice") || "report"; } catch (e) {}
  document.querySelectorAll("[data-set-voice]").forEach((b) => b.addEventListener("click", () => applyVoice(b.dataset.setVoice, true)));
  applyVoice(v, false);
}
