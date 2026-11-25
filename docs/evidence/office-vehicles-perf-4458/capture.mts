// #4458 captures. Synthetic packs and fixture agents only (Alpha … Echo): no real names.
//   MODE=train  a 1280×720 pack with a train: riders on board, the car front over them, a rider who calls and gets off.
//   MODE=plain  a 5120×2880 pack (4096×2304 pictures), no vehicles: Fit, and zoomed in.
// REPO=<checkout> PW_DIR=<dir with playwright-core> CHROME=<chrome> OUT=<dir> LABEL=before|after DEV=desk|phone
// [PW_DPR=3 for the phone]  npx tsx capture-4458.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const REPO = process.env.REPO!, MODE = process.env.MODE ?? "train", LABEL = process.env.LABEL ?? "after", DEV = (process.env.DEV ?? "desk") as "desk" | "phone";
const OUT = join(process.env.OUT!, LABEL); mkdirSync(OUT, { recursive: true });
const { bootFixture, mounted } = await import(join(REPO, "scripts/manual/smoke-fixture/index.mts"));
const NAMES = ["alpha", "beta", "gamma", "delta", "echo"];
const ROSTER = NAMES.map((n, i) => ({ name: `bot-${n}`, displayName: n[0].toUpperCase() + n.slice(1), backend: i % 2 ? "codex" : "claude-code", team: "Studio", status: "running" as const, general: i === 0 }));
const fx = await bootFixture({ port: 0, oldPort: 49158, roster: ROSTER, classic: false });
const fm = fx.fm;
const status = new Map<string, string>(ROSTER.map((r) => [r.name, "running"]));
fm.getInstanceStatus = (n: string) => status.get(n) ?? "running";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const draw = await fx.browser.newPage();
const pack = await draw.evaluate(`((mode) => {
  const mk = (w, h) => { const cv = document.createElement("canvas"); cv.width = w; cv.height = h; return { cv, c: cv.getContext("2d") }; };
  const b64 = (cv) => cv.toDataURL("image/png").split(",")[1];
  const sheet = mk(2 * 32, 48);
  for (let f = 0; f < 2; f++) { const c = sheet.c, o = f * 32; c.fillStyle = "#3b6fd8"; c.fillRect(o + 8, 22 - f, 16, 24); c.fillStyle = "#f2c9a3"; c.fillRect(o + 9, 6 - f, 14, 15); c.fillStyle = "#2a2a2a"; c.fillRect(o + 9, 4 - f, 14, 5); }
  const person = { idle: { src: "sheet.png", frames: 2, w: 32, h: 48, fps: 2, dw: 32, dh: 48, ax: 16, ay: 46 } };
  if (mode === "train") {
    const bg = mk(1280, 720), g = bg.c;
    g.fillStyle = "#e9e4d8"; g.fillRect(0, 0, 1280, 720);
    const room = (x, y, w, h, f, t) => { g.fillStyle = f; g.fillRect(x, y, w, h); g.strokeStyle = "#5b6475"; g.lineWidth = 4; g.strokeRect(x, y, w, h); g.fillStyle = "#222"; g.font = "700 22px sans-serif"; g.fillText(t, x + 12, y + 30); };
    room(80, 30, 500, 230, "#cfe0f5", "Work"); room(700, 30, 500, 230, "#d8efd6", "Lounge");
    room(80, 450, 500, 240, "#f7d6d0", "Help desk"); room(700, 450, 500, 240, "#e3dcf2", "Nap");
    g.fillStyle = "#b9b2a3"; g.fillRect(60, 312, 1160, 56);               // the track bed
    g.strokeStyle = "#6b6252"; g.lineWidth = 3; for (const y of [322, 342, 358]) { g.beginPath(); g.moveTo(60, y); g.lineTo(1220, y); g.stroke(); }
    g.fillStyle = "#8a8170"; g.fillRect(80, 280, 80, 26); g.fillRect(1120, 372, 80, 26);   // the platforms
    g.fillStyle = "#222"; g.font = "600 14px sans-serif"; g.fillText("Platform A", 84, 298); g.fillText("Platform B", 1124, 390);
    const car = mk(2 * 200, 90), front = mk(200, 90);
    for (let f = 0; f < 2; f++) { const c = car.c, o = f * 200; c.fillStyle = "#c0392b"; c.fillRect(o + 4, 20, 192, 62); c.fillStyle = "#fbe7c6"; for (let i = 0; i < 4; i++) c.fillRect(o + 16 + i * 46, 28, 34, 22); c.fillStyle = "#333"; c.fillRect(o + 20 + f * 4, 80, 24, 8); c.fillRect(o + 156 - f * 4, 80, 24, 8); }
    front.c.fillStyle = "#a93226"; front.c.fillRect(4, 56, 192, 26); front.c.fillStyle = "#f4d03f"; front.c.fillRect(4, 56, 192, 4);
    const strip = (src, frames) => ({ src, frames, w: 200, h: 90, fps: 4, dw: 200, dh: 90, ax: 100, ay: 80 });
    const manifest = { format: 1, id: "synth-train", background: "bg.png",
      areas: {
        desks: { rect: [80, 30, 500, 230], seats: [[180, 200], [300, 200], [420, 200], [540, 200]] },
        lounge: { rect: [700, 30, 500, 230], seats: [[800, 200], [920, 200], [1040, 200], [1160, 200]] },
        help: { rect: [80, 450, 500, 240], seats: [[200, 620], [320, 620], [440, 620]] },
        nap: { rect: [700, 450, 500, 240], seats: [[800, 620], [920, 620], [1040, 620]] } },
      stateZones: { working: "desks", needs: "help", crashed: "help", stuck: "help", paused: "nap", stopped: "nap", default: "lounge" },
      characters: { default: person },
      vehicles: [{ id: "loop-line", label: "Loop line", sprites: { right: strip("car.png", 2) }, fronts: { right: strip("front.png", 1) },
        path: [[160, 336], [1160, 336], [1160, 352], [160, 352]], speed: 60,
        stops: [{ at: 3, seconds: 8, platform: [120, 300] }, { at: 1, seconds: 8, platform: [1160, 392] }],
        seats: [{ dx: -46, dy: 4 }, { dx: 0, dy: 4 }, { dx: 46, dy: 4 }] }] };
    return { manifest, files: { "bg.png": b64(bg.cv), "sheet.png": b64(sheet.cv), "car.png": b64(car.cv), "front.png": b64(front.cv) } };
  }
  // plain: 4096×2304 pictures on a 5120×2880 canvas (scale 1.25), fine detail to show sharpness when zoomed in.
  const bg = mk(4096, 2304), g = bg.c;
  g.fillStyle = "#f3efe6"; g.fillRect(0, 0, 4096, 2304);
  g.strokeStyle = "#c9c1b0"; g.lineWidth = 1; for (let x = 0; x <= 4096; x += 16) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, 2304); g.stroke(); } for (let y = 0; y <= 2304; y += 16) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(4096, y + 0.5); g.stroke(); }
  const room = (x, y, w, h, f, t) => { g.fillStyle = f; g.fillRect(x, y, w, h); g.strokeStyle = "#4a5263"; g.lineWidth = 6; g.strokeRect(x, y, w, h);
    g.fillStyle = "#222"; g.font = "700 48px sans-serif"; g.fillText(t, x + 30, y + 70);
    g.font = "12px sans-serif"; for (let i = 0; i < 6; i++) g.fillText("Fine print line " + (i + 1) + ": the quick brown fox jumps over the lazy dog 0123456789", x + 30, y + 110 + i * 16);
    for (let i = 0; i < 8; i++) { g.fillStyle = "#8b6b4a"; g.fillRect(x + 60 + i * 200, y + h - 260, 140, 70); g.strokeStyle = "#3b2b1a"; g.lineWidth = 2; g.strokeRect(x + 60 + i * 200, y + h - 260, 140, 70); } };
  room(120, 120, 1800, 900, "#dbe7f5", "Work"); room(2176, 120, 1800, 900, "#dcefd9", "Lounge");
  room(120, 1284, 1800, 900, "#f6dcd5", "Help desk"); room(2176, 1284, 1800, 900, "#e5def2", "Nap");
  g.fillStyle = "#222"; g.font = "12px sans-serif";                    // fine print at the centre, where a zoom lands
  for (let i = 0; i < 8; i++) { g.fillText("Fine print " + (i + 1) + ": the quick brown fox 0123456789", 2110, 1080 + i * 16); g.fillText("Detail " + (i + 1) + " 0123456789", 1830, 1080 + i * 16); }
  const fg = mk(4096, 2304);
  fg.c.fillStyle = "rgba(60,70,90,0.85)"; for (const x of [1980, 2060]) fg.c.fillRect(x, 0, 40, 2304);   // two pillars between the rooms
  fg.c.fillStyle = "#fff"; fg.c.font = "11px sans-serif"; for (let y = 60; y < 2304; y += 120) fg.c.fillText("pillar " + y, 1984, y);
  const s = 1.25, R = (x, y, w, h) => [x * s, y * s, w * s, h * s].map(Math.round);
  const manifest = { format: 1, id: "synth-big", canvas: [5120, 2880], background: "bg.png", foreground: "fg.png",
    areas: {
      desks: { rect: R(120, 120, 1800, 900), seats: [[600, 1100], [900, 1100], [1200, 1100], [1500, 1100]] },
      lounge: { rect: R(2176, 120, 1800, 900), seats: [[3200, 1100], [3500, 1100], [3800, 1100]] },
      help: { rect: R(120, 1284, 1800, 900), seats: [[600, 2700], [900, 2700]] },
      nap: { rect: R(2176, 1284, 1800, 900), seats: [[3200, 2700], [3500, 2700]] } },
    stateZones: { working: "desks", needs: "help", crashed: "help", paused: "nap", stopped: "nap", default: "lounge" },
    characters: { default: { idle: { ...person.idle, dw: 128, dh: 192 } } } };
  return { manifest, files: { "bg.png": b64(bg.cv), "fg.png": b64(fg.cv), "sheet.png": b64(sheet.cv) } };
})(${JSON.stringify(MODE)})`);
await draw.close();
const added = fm.officeSkins.add(pack, "smoke");
if (!added.ok) throw new Error("pack refused " + JSON.stringify(added).slice(0, 400));
const id = pack.manifest.id;
const w = fm.officeStore.replace([{ id: "hq", name: "HQ", skin: id, members: ROSTER.map((r) => r.name) }]);
if (w && w.ok === false) throw new Error("office refused " + JSON.stringify(w));
const autoSet = fm.officeStore.setAutoSkin(id); if (autoSet && autoSet.ok === false) throw new Error("setAutoSkin " + JSON.stringify(autoSet));

const report: any = { label: LABEL, mode: MODE, dev: DEV, cases: {} };
const ride = () => {
  for (const n of ["bot-alpha", "bot-beta", "bot-gamma"]) {
    const r = fm.officeActs.handle(n, "office_set", { ride: "loop-line", seconds: 3600 });
    if (!r.act) throw new Error(`ride ${n}: ${JSON.stringify(r)}`);
  }
};
const cases = (["light", "dark"] as const).flatMap((theme) => (["en", "zh-TW"] as const).map((lang) => ({ device: DEV, theme, lang })));
try {
  for (const c of MODE === "train" ? cases : [{ device: DEV, theme: "light" as const, lang: "en" as const }]) {
    const key = `${c.device}-${c.theme}-${c.lang}`, errors: string[] = [];
    status.set("bot-beta", "running"); status.set("bot-delta", "running");
    if (MODE === "train") { status.set("bot-delta", "running"); ride(); }
    const { ctx, page, csp } = await fx.page(c as any, { storage: { agend_org_office: "hq" } });
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    await mounted(page, 30000);
    await page.goto(`${fx.base}/ui/fleet/org`);
    await page.locator(".oc-tools .seg-inline button", { hasText: c.lang === "en" ? "Office" : "辦公室" }).click();
    await page.waitForSelector(".oo-canvas", { timeout: 15000 });
    const pct = async () => (await page.locator(".oo-zoom-pct").innerText().catch(() => "?")).trim();
    const shot = async (name: string) => { await page.screenshot({ path: join(OUT, `${key}-${name}.png`) }); };
    if (MODE === "train") {
      await sleep(45000);                                   // walk to the platform, wait for a stop, board
      // Where the train is depends on the clock alone: its lap is run 0→1, stop at 1, run 1→2, run 2→3, stop at 3, run 3→0.
      const run = (1000 / 60) * 1000, turn = (16 / 60) * 1000, LAP = 2 * run + 2 * turn + 16000;
      const phase = () => Date.now() % LAP;
      while (Math.abs(phase() - 4500) > 150) await sleep(100);   // 4.5 s after leaving Platform A, heading right
      const zin = page.locator(".oo-zoom-in"), zout = page.locator(".oo-zoom-out");
      for (let i = 0; i < 2; i++) { await zin.click(); await sleep(150); }
      await sleep(600); await shot("1-riding-zoomed");
      const zoomed = await pct();
      for (let i = 0; i < 2; i++) { await zout.click(); await sleep(150); }
      await sleep(400); await shot("2-riding");
      status.set("bot-beta", "crashed");                    // a rider calls between stops: off at once, walks to the Help desk
      const t0 = Date.now(), word = c.lang === "en" ? "Crashed" : "已當掉";
      // A desk shows the count (Crashed / 已當掉); a phone has no count, but the Help area chip appears under the office.
      await page.waitForFunction((w: string) => document.body.innerText.includes(w) || /\bHelp\s*1\b/i.test(document.body.innerText), word, { timeout: 30000 });
      const seen = Date.now() - t0, seenPhase = phase();
      await sleep(800); await shot("3-caller-gets-off");
      await sleep(10000); await shot("4-caller-at-help-desk");
      report.cases[key] = { errors, csp: await csp(), zoomed, crashSeenMs: seen, crashSeenAtPhaseMs: Math.round(seenPhase) };
    } else {
      await sleep(4000); await shot("1-fit");
      const fit = await pct();
      if (process.env.PERF) {                               // at Fit: main-thread busy share, CPU 4× slower, 3 × 10 s
        const cdp = await ctx.newCDPSession(page), M = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x: any) => [x.name, x.value]));
        await cdp.send("Performance.enable"); await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 }); await sleep(3000);
        const runs: any[] = [];
        for (let k = 0; k < 3; k++) {
          const m0 = await M();
          const frames = Number(await page.evaluate(`new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 10000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); })`));
          const m1 = await M(), dt = m1.Timestamp - m0.Timestamp;
          runs.push({ busyPct: Math.round(((m1.TaskDuration - m0.TaskDuration) / dt) * 1000) / 10, scriptMsPerS: Math.round(((m1.ScriptDuration - m0.ScriptDuration) / dt) * 1000), rafPerS: Math.round(frames / 10) });
        }
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        report.perf = runs;
      }
      const zin = page.locator(".oo-zoom-in");
      for (let i = 0; i < Number(process.env.PRESSES ?? 8); i++) { await zin.click(); await sleep(200); }
      await sleep(2000); await shot("2-zoomed");
      report.cases[key] = { errors, csp: await csp(), fit, zoomed: await pct() };
    }
    await ctx.close();
  }
} finally { await fx.close(); }
writeFileSync(join(OUT, `report-${MODE}-${DEV}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
