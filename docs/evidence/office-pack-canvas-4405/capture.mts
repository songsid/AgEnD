// #4405 captures (scratch). A synthetic 5120×2880 pack canvas (zero real names): the Office on a phone at Fit and after
// six − presses, and on a desktop. LABEL=before|after.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const REPO = process.env.REPO!, LABEL = process.env.LABEL ?? "after", OUT = join(process.env.OUT!, LABEL);
mkdirSync(OUT, { recursive: true });
const { bootFixture, mounted } = await import(join(REPO, "scripts/manual/smoke-fixture/index.mts"));
const ROSTER = [
  { name: "bot-alpha", displayName: "Alpha", backend: "claude-code", team: "Studio", status: "running" as const, general: true },
  { name: "bot-beta", displayName: "Beta", backend: "codex", team: "Studio", status: "running" as const },
];
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 49047), roster: ROSTER, classic: false });
const fm = fx.fm;
const page0 = await fx.browser.newPage();
const pack = await page0.evaluate(`(() => {
  const mk = (w, h) => { const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const c = cv.getContext("2d"); c.imageSmoothingEnabled = false; return { cv, c }; };
  const b64 = (cv) => cv.toDataURL("image/png").split(",")[1];
  // 2560×1440 px picture for a 5120×2880 canvas (drawn at 2 units a pixel): four big rooms and a corner mark each.
  const bg = mk(2560, 1440), g = bg.c;
  g.fillStyle = "#1d2230"; g.fillRect(0, 0, 2560, 1440);
  const room = (x, y, w, h, f, t) => { g.fillStyle = f; g.fillRect(x, y, w, h); g.strokeStyle = "#9fb3d9"; g.lineWidth = 8; g.strokeRect(x + 4, y + 4, w - 8, h - 8); g.fillStyle = "#eef2fa"; g.font = "700 72px sans-serif"; g.fillText(t, x + 40, y + 110); };
  room(80, 80, 1120, 560, "#27365a", "NW room"); room(1360, 80, 1120, 560, "#2b4a3c", "NE room");
  room(80, 800, 1120, 560, "#4a2f36", "SW room"); room(1360, 800, 1120, 560, "#3b3354", "SE room");
  g.fillStyle = "#ffd166"; for (const [x, y] of [[0, 0], [2496, 0], [0, 1376], [2496, 1376]]) g.fillRect(x, y, 64, 64);
  const sh = mk(2 * 64, 80);
  for (let f = 0; f < 2; f++) { const c = sh.c, o = f * 64; c.fillStyle = "#3b82f6"; c.fillRect(o + 20, 40 - f * 2, 24, 30); c.fillStyle = "#f2c9a3"; c.fillRect(o + 20, 18 - f * 2, 24, 20); }
  const manifest = { format: 1, id: "big-canvas", scale: 2, canvas: [5120, 2880], matte: "#11141c", background: "bg.png",
    areas: { desks: { rect: [160, 160, 2240, 1120], seats: [[800, 900], [1400, 900]] }, lounge: { rect: [2720, 1600, 2240, 1120], seats: [[3600, 2300], [4200, 2300]] } },
    stateZones: { working: "desks", idle: "lounge", default: "lounge" },
    characters: { default: { idle: { src: "sheet.png", frames: 2, w: 64, h: 80, fps: 2, dw: 256, dh: 320, ax: 32, ay: 75 } } } };
  return { manifest, files: { "bg.png": b64(bg.cv), "sheet.png": b64(sh.cv) } };
})()`);
await page0.close();
const added = fm.officeSkins.add(pack, "smoke");
if (!added.ok) throw new Error("refused " + JSON.stringify(added));
const s = fm.officeStore.setAutoSkin("big-canvas"); if (!s.ok) throw new Error("setAutoSkin " + JSON.stringify(s));
const report: any = { label: LABEL, cases: {} };
const cases = [{ device: "phone", theme: "dark", lang: "zh-TW" }, { device: "desk", theme: "dark", lang: "en" }] as const;
try {
  for (const c of cases) {
    const key = `${c.device}-${c.theme}-${c.lang}`, errors: string[] = [];
    const { ctx, page, csp } = await fx.page(c as any);
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    await mounted(page, 30000);
    await page.goto(`${fx.base}/ui/fleet/org`);
    await page.locator(".oc-tools .seg-inline button", { hasText: c.lang === "en" ? "Office" : "辦公室" }).click();
    await page.waitForSelector(".oo-canvas", { timeout: 15000 }); await page.waitForTimeout(2500);
    const pct = async () => (await page.locator(".oo-zoom-pct").innerText()).trim();
    await page.screenshot({ path: join(OUT, `${key}-1-fit.png`) });
    const fit = await pct();
    for (let i = 0; i < 6; i++) { await page.locator(".oo-zoom-out").click(); await page.waitForTimeout(150); }
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, `${key}-2-zoomed-out.png`) });
    const out = await pct();
    report.cases[key] = { errors, csp: await csp(), fitPct: fit, afterSixOutPct: out };
    await ctx.close();
  }
} finally { await fx.close(); }
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
