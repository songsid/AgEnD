// M-3633 captures (scratch, never committed). LABEL=before|after; REPO=<checkout>. One synthetic pack (zero real names):
// one shared 4-row sheet cut with row/col for both sets (idle, working, pat once, stand), card preset rpg with
// layout.gap 48 and motion pop 420 ms. Before: the pack is refused, so the built-in default style is shot instead.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const REPO = process.env.REPO!, LABEL = process.env.LABEL ?? "after", OUT = join(process.env.OUT!, LABEL);
mkdirSync(OUT, { recursive: true });
const { bootFixture, mounted } = await import(join(REPO, "scripts/manual/smoke-fixture/index.mts"));
const ROSTER = [
  { name: "bot-alpha", displayName: "Alpha", backend: "claude-code", team: "Studio", status: "running" as const, general: true },
  { name: "bot-beta", displayName: "Beta", backend: "codex", team: "Studio", status: "running" as const },
  { name: "bot-gamma", displayName: "Gamma", backend: "kiro-cli", team: "Studio", status: "running" as const },
];
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 49046), roster: ROSTER, classic: false });
const fm = fx.fm;
const orig = fm.getUiStatus.bind(fm);
fm.getUiStatus = (...a: unknown[]) => { const s = orig(...a);
  for (const i of s?.instances ?? []) { i.status = "running"; i.execution_state = i.name === "bot-alpha" ? "working" : "idle"; if (i.name === "bot-alpha") i.state = "working"; }
  return s; };
const report: any = { label: LABEL, repo: REPO, cases: {} };
const page0 = await fx.browser.newPage();
const pack = await page0.evaluate(`(() => {
  const mk = (w, h) => { const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const c = cv.getContext("2d"); c.imageSmoothingEnabled = false; return { cv, c }; };
  const b64 = (cv) => cv.toDataURL("image/png").split(",")[1];
  const bg = mk(1280, 720), g = bg.c;
  g.fillStyle = "#1d2230"; g.fillRect(0, 0, 1280, 720);
  for (let y = 90; y < 720; y += 30) { g.fillStyle = (y / 30) % 2 ? "#232a3a" : "#262e40"; g.fillRect(0, y, 1280, 30); }
  g.fillStyle = "#30394f"; g.fillRect(0, 0, 1280, 90);
  const zone = (x, y, w, h, f, b, t) => { g.fillStyle = f; g.fillRect(x, y, w, h); g.strokeStyle = b; g.lineWidth = 3; g.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3); g.fillStyle = "#dde4f3"; g.font = "600 18px sans-serif"; g.fillText(t, x + 16, y + 30); };
  zone(60, 140, 560, 440, "#23304a", "#4a6fa8", "Work (sheet row 1)");
  zone(680, 140, 540, 440, "#233a33", "#3f8a70", "Lounge (sheet row 0)");
  // One shared sheet: 8 columns x 4 rows of 64x80. Columns 0-3 = set A, 4-7 = set B (cut with col).
  // Row 0 idle (2 frames), row 1 working (4), row 2 pat (4, once), row 3 stand (1).
  const W = 64, H = 80, sh = mk(8 * W, 4 * H);
  const person = (ox, oy, coat, o) => { const c = sh.c, y = oy + (o.bob || 0);
    c.fillStyle = "rgba(0,0,0,.3)"; c.beginPath(); c.ellipse(ox + 32, oy + 75, 14, 4, 0, 0, 7); c.fill();
    c.fillStyle = "#2b3040"; c.fillRect(ox + 24, y + 62, 6, 12); c.fillRect(ox + 34, y + 62, 6, 12);
    c.fillStyle = coat; c.fillRect(ox + 20, y + 40, 24, 23);
    const al = o.arms || 0; c.fillRect(ox + 14, y + 42 - al, 6, 14); c.fillRect(ox + 44, y + 42 - al, 6, 14);
    c.fillStyle = "#3a2a20"; c.fillRect(ox + 18, y + 12, 28, 10);
    c.fillStyle = "#f2c9a3"; c.fillRect(ox + 20, y + 20, 24, 20);
    c.fillStyle = "#1b1e28"; if (o.happy) { c.fillRect(ox + 24, y + 28, 5, 2); c.fillRect(ox + 35, y + 28, 5, 2); } else { c.fillRect(ox + 25, y + 27, 4, 5); c.fillRect(ox + 35, y + 27, 4, 5); }
    if (o.heart) { c.fillStyle = "#ff5c8a"; c.fillRect(ox + 46, y + 4, 4, 4); c.fillRect(ox + 52, y + 4, 4, 4); c.fillRect(ox + 46, y + 8, 10, 4); c.fillRect(ox + 48, y + 12, 6, 3); }
    if (o.laptop) { c.fillStyle = "#1f242e"; c.fillRect(ox + 14, y + 50, 36, 14); c.fillStyle = o.laptop; c.fillRect(ox + 16, y + 52, 32, 10); }
    if (o.label) { c.fillStyle = "rgba(10,12,18,.85)"; c.fillRect(ox + 1, oy + 1, 26, 11); c.fillStyle = "#fff"; c.font = "700 9px monospace"; c.fillText(o.label, ox + 3, oy + 10); } };
  for (const [base, coat] of [[0, "#3b82f6"], [4, "#10b981"]]) {
    for (let f = 0; f < 2; f++) person((base + f) * W, 0, coat, { bob: f ? -2 : 0, label: "I" + f });
    for (let f = 0; f < 4; f++) person((base + f) * W, H, coat, { laptop: ["#62d2ff", "#7ee0ff", "#9aeaff", "#7ee0ff"][f], arms: f % 2 ? 3 : 0, label: "W" + f });
    for (let f = 0; f < 4; f++) person((base + f) * W, 2 * H, coat, { happy: true, heart: f > 0, bob: -[0, 4, 6, 2][f], arms: f > 0 ? 8 : 0, label: "P" + f });
    person(base * W, 3 * H, coat, { label: "ST" });
  }
  const files = { "bg.png": b64(bg.cv), "sheet.png": b64(sh.cv) };
  const S = { src: "sheet.png", w: W, h: H, dw: 112, dh: 140, ax: 32, ay: 75 };
  const set = (col) => ({
    idle: { ...S, frames: 2, fps: 2, row: 0, col },
    working: { ...S, frames: 4, fps: 6, row: 1, col },
    pat: { ...S, frames: 4, fps: 3, row: 2, col, once: true },
    stand: { ...S, frames: 1, fps: 1, row: 3, col },
  });
  const manifest = { format: 1, id: "sheet-cells", scale: 1, matte: "#1d2230", background: "bg.png",
    areas: { desks: { rect: [60, 140, 560, 440], seats: [[200, 420], [340, 420], [480, 420]] },
             lounge: { rect: [680, 140, 540, 440], seats: [[820, 420], [960, 420], [1100, 420]] } },
    stateZones: { working: "desks", idle: "lounge", default: "lounge" },
    characters: { default: set(0), setB: set(4) }, byInstance: { "bot-beta": "setB" },
    card: { preset: "rpg", layout: { gap: 48, avatarSize: "lg" }, motion: { enter: "pop", ms: 420 } } };
  return { manifest, files };
})()`);
await page0.close();
const added = fm.officeSkins.add(pack, "smoke");
report.pack = added.ok ? { ok: true } : { ok: false, refusal: added };
if (added.ok) { const s = fm.officeStore.setAutoSkin("sheet-cells"); if (!s.ok) throw new Error("setAutoSkin " + JSON.stringify(s)); }
// Every fillText on the Office canvas with its place on the page (CSS px): the people's name tags among them.
const RECORD = `(() => { const w = window; w.__texts = []; const orig = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (s, x, y) { if (this.canvas && this.canvas.classList && this.canvas.classList.contains("oo-canvas")) {
    const m = this.getTransform(), d = w.devicePixelRatio || 1, r = this.canvas.getBoundingClientRect(); w.__texts.push({ s: String(s), top: r.top + (m.d * y + m.f) / d, at: performance.now() }); }
    return orig.apply(this, arguments); }; })();`;
async function openOffice(page: any, lang: string) {
  await page.goto(`${fx.base}/ui/fleet/org`);
  await page.locator(".oc-tools .seg-inline button", { hasText: lang === "en" ? "Office" : "辦公室" }).click();
  await page.waitForSelector(".oo-canvas", { timeout: 15000 }); await page.waitForTimeout(2500);
}
// The areas' name corners (M-3633's AREA_LABEL: 320 × 44 logical from each area's top left) on the page, from the view.
const LABELS = [[60, 140], [680, 140]];
const cases = [{ device: "desk", theme: "dark", lang: "en" }, { device: "desk", theme: "light", lang: "zh-TW" }, { device: "phone", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "en" }] as const;
try {
  for (const c of cases) {
    const key = `${c.device}-${c.theme}-${c.lang}`, errors: string[] = [];
    const { ctx, page, csp } = await fx.page(c as any);
    await page.addInitScript({ content: RECORD });
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    await mounted(page, 30000); await openOffice(page, c.lang);
    const person = page.locator("button.oo-desk[data-name=bot-beta]");
    await person.focus(); await person.press("Enter");
    await page.locator(".oo-card").waitFor(); await page.waitForTimeout(900);
    await page.screenshot({ path: join(OUT, `${key}-card.png`) });
    const m = await page.evaluate((labels: number[][]) => {
      const card = document.querySelector(".oo-card") as HTMLElement, r = card.getBoundingClientRect(), vh = innerHeight;
      const cv = (document.querySelector(".oo-canvas") as HTMLElement).getBoundingClientRect();
      const mv = document.querySelector("[data-k]") as Element | null;
      const k = mv ? Number(mv.getAttribute("data-k")) : NaN, vx = mv ? Number(mv.getAttribute("data-x")) : NaN, vy = mv ? Number(mv.getAttribute("data-y")) : NaN;
      const lab = labels.map(([x, y]) => ({ x: cv.left + vx + x * k, y: cv.top + vy + y * k, w: 320 * k, h: 44 * k }));
      const over = lab.map((l) => Math.max(0, Math.min(r.right, l.x + l.w) - Math.max(r.left, l.x)) * Math.max(0, Math.min(r.bottom, l.y + l.h) - Math.max(r.top, l.y)));
      const t0 = performance.now() - 400, seen = ((window as any).__texts as any[]).filter((x) => x.at >= t0);
      const people = ["Alpha", "Beta", "Gamma"].map((n) => { const hits = seen.filter((x) => x.s === n); const last = hits[hits.length - 1]; return { n, bottom: last ? Math.round(last.top) : null }; });
      const sheet = card.classList.contains("sheet");
      const act = card.querySelector(".oo-card-actions") as HTMLElement | null, ar = act ? act.getBoundingClientRect() : null;
      return { sheet, card: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, vh, sheetShare: sheet ? Math.round((r.height / vh) * 100) : null,
        labelOverlapPx: over.map(Math.round), peopleAboveSheet: sheet ? people.filter((p) => p.bottom !== null && p.bottom <= r.top).map((p) => p.n) : null, people,
        actionsInView: ar ? ar.top >= r.top - 1 && ar.bottom <= Math.min(vh, r.bottom) + 1 : null, scrolls: card.scrollHeight > card.clientHeight + 1 || ((card.querySelector(".oo-card-body") as HTMLElement | null)?.scrollHeight ?? 0) > ((card.querySelector(".oo-card-body") as HTMLElement | null)?.clientHeight ?? 0) + 1 };
    }, LABELS);
    report.cases[key] = { errors, csp: await csp(), ...m };
    await ctx.close();
  }
} finally { await fx.close(); }
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
