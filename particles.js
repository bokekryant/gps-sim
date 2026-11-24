// particles.js — a field of short dashes that sits *behind* frosted glass.
// The dashes point away from a centre and drift slowly outwards; the centre follows the pointer
// when it is over the glass. The canvas is blurred with CSS, so you only ever see the dashes
// softly, through the glass. Purely decorative: no information is shown here.

// null = draw in the page's ink colour (light/dark aware). Put colours here to try a palette,
// e.g. ["#e0a800", "#e4572e", "#6c5ce7", "#3b6fd8"].
const PARTICLE_PALETTE = null;
const PARTICLE_DENSITY = 1 / 1100;   // dashes per square pixel of glass
const PARTICLE_SPEED = [5, 13];      // px per second, outward drift
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

let inkColour = "#1d1d1f";
function readInk() {
  inkColour = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() || inkColour;
}
readInk();
new MutationObserver(readInk).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

class ParticleField {
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "fx";
    this.canvas.setAttribute("aria-hidden", "true");
    host.prepend(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.w = this.h = 0;
    this.dots = [];
    this.focus = { x: 0, y: 0 };   // where the dashes point away from (eased)
    this.target = null;            // pointer position while it's over the glass
    this.visible = false;

    new ResizeObserver(() => this.resize()).observe(host);
    host.addEventListener("pointermove", (e) => {
      const r = host.getBoundingClientRect();
      this.target = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (REDUCED) { this.focus = { ...this.target }; this.draw(); }
    });
    host.addEventListener("pointerleave", () => {
      this.target = null;
      if (REDUCED) { this.focus = { x: this.w / 2, y: this.h / 2 }; this.draw(); }
    });
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    const first = !this.w;
    this.w = r.width; this.h = r.height; this.dpr = dpr;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    if (first) this.focus = { x: this.w / 2, y: this.h / 2 };
    const n = Math.max(12, Math.round(this.w * this.h * PARTICLE_DENSITY));
    while (this.dots.length < n) this.dots.push(this.spawn(true));
    this.dots.length = n;
    this.draw();
  }

  spawn(anywhere) {
    const reach = Math.hypot(this.w, this.h) / 2;
    // start anywhere (first fill) or close to the centre (respawn), then drift outwards
    const d = anywhere ? Math.sqrt(Math.random()) * reach : Math.random() * reach * 0.25;
    const a = Math.random() * Math.PI * 2;
    return {
      x: this.focus.x + Math.cos(a) * d,
      y: this.focus.y + Math.sin(a) * d,
      v: PARTICLE_SPEED[0] + Math.random() * (PARTICLE_SPEED[1] - PARTICLE_SPEED[0]),
      c: PARTICLE_PALETTE ? PARTICLE_PALETTE[(Math.random() * PARTICLE_PALETTE.length) | 0] : null,
      s: 0.6 + Math.random() * 0.8, // size jitter
    };
  }

  step(dt) {
    // ease the centre towards the pointer (or back to the middle)
    const t = this.target || { x: this.w / 2, y: this.h / 2 };
    const k = 1 - Math.exp(-dt * 3);
    this.focus.x += (t.x - this.focus.x) * k;
    this.focus.y += (t.y - this.focus.y) * k;
    const pad = 20;
    for (let i = 0; i < this.dots.length; i++) {
      const p = this.dots[i];
      const dx = p.x - this.focus.x, dy = p.y - this.focus.y;
      const d = Math.hypot(dx, dy) || 1;
      p.x += (dx / d) * p.v * dt;
      p.y += (dy / d) * p.v * dt;
      if (p.x < -pad || p.y < -pad || p.x > this.w + pad || p.y > this.h + pad) this.dots[i] = this.spawn(false);
    }
  }

  draw() {
    const { ctx, dpr } = this;
    if (!this.w) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.lineCap = "round";
    const reach = Math.hypot(this.w, this.h) / 2;
    for (const p of this.dots) {
      const dx = p.x - this.focus.x, dy = p.y - this.focus.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = Math.min(1, d / reach);           // 0 at the centre, 1 at the edge
      const len = (4 + 15 * f) * p.s;             // longer further out
      const ux = dx / d, uy = dy / d;
      ctx.globalAlpha = Math.min(1, 0.15 + f * 2.4) * 0.9; // fainter around the centre
      ctx.strokeStyle = p.c || inkColour;
      ctx.lineWidth = (1.5 + 1.5 * f) * p.s;
      ctx.beginPath();
      ctx.moveTo(p.x - ux * len / 2, p.y - uy * len / 2);
      ctx.lineTo(p.x + ux * len / 2, p.y + uy * len / 2);
      ctx.stroke();
    }
  }
}

const fields = [];
function initParticles() {
  document.querySelectorAll("[data-particles]").forEach((el) => fields.push(new ParticleField(el)));
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    const f = fields.find((x) => x.host === e.target);
    if (f) f.visible = e.isIntersecting;
  }));
  fields.forEach((f) => io.observe(f.host));
  if (REDUCED) return; // still dashes, no drift

  let last = performance.now();
  function loop(now) {
    const dt = Math.min((now - last) / 1000, 1 / 20);
    last = now;
    if (!document.hidden) for (const f of fields) if (f.visible && f.w) { f.step(dt); f.draw(); }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}
