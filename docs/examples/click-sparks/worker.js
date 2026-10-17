// CW1 example: at most 128 particles, no assets, content, DOM or network.
const canvas = agend.canvas;
const ctx = canvas.getContext("2d");
const particles = [];
const colors = ["#ff317c", "#00c7ce", "#ff9800"];
let width = canvas.width, height = canvas.height;
let previousTime = null, previousButtons = 0, burstAt = -Infinity;
function emit(x, y, count, speed) {
  for (let i = 0; i < count; i++) {
    if (particles.length === 128) particles.shift();
    const angle = Math.random() * Math.PI * 2;
    const velocity = speed * (0.35 + Math.random() * 0.65);
    particles.push({ x, y, vx: Math.cos(angle) * velocity,
      vy: Math.sin(angle) * velocity, life: 1, color: colors[i % colors.length] });
  }
}
agend.on("env", e => {
  width = e.width; height = e.height;
  canvas.width = width; canvas.height = height;
});
agend.on("pointer", e => {
  const pressed = (e.buttons & 1) !== 0;
  // Pointer samples are coalesced. A held-button transition also starts a burst.
  const starts = e.kind === "click" || e.kind === "down" ||
    (pressed && !(previousButtons & 1));
  if (starts && e.ts - burstAt >= 180) {
    emit(e.x, e.y, 24, 95); burstAt = e.ts;
  }
  if (pressed && e.kind === "move") emit(e.x, e.y, 3, 22);
  previousButtons = e.buttons;
});
function draw(time) {
  const dt = previousTime === null ? 0 : Math.min(0.05, Math.max(0, (time - previousTime) / 1000));
  previousTime = time;
  ctx.clearRect(0, 0, width, height);
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]; p.life -= dt / 1.2;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 35 * dt;
    ctx.globalAlpha = p.life; ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, 2 + p.life * 2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  agend.frame(draw);
}
agend.frame(draw);
agend.ready();
