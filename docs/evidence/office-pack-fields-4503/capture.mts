// #4503 captures. A synthetic pack and fixture agents only (Alpha … Echo): no real names, self-drawn pictures.
//   Work: Beta at a standing desk facing right, Gamma at one facing up, Delta at a plain desk (typing, for contrast).
//   Train: seat 0 is Alpha's workplace (`worker`); Platform A's `queue` puts Alpha's wait at the yellow mark, off the
//   platform. Echo (working at the last desk) rides by its own choice (office_set ride) and waits on the platform.
//   Then Alpha crashes on board.
// REPO=<checkout> PW_DIR=<dir with playwright-core> CHROME=<chrome> OUT=<dir> DEV=desk|phone [PW_DPR=3]  npx tsx capture-4503.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const REPO = process.env.REPO!, DEV = (process.env.DEV ?? "desk") as "desk" | "phone";
const OUT = process.env.OUT!; mkdirSync(OUT, { recursive: true });
const { bootFixture, mounted } = await import(join(REPO, "scripts/manual/smoke-fixture/index.mts"));
const NAMES = ["alpha", "beta", "gamma", "delta", "echo"];
const ROSTER = NAMES.map((n, i) => ({ name: `bot-${n}`, displayName: n[0].toUpperCase() + n.slice(1), backend: i % 2 ? "codex" : "claude-code", team: "Studio", status: "running" as const, general: i === 0 }));
const WORKING = ["bot-alpha", "bot-beta", "bot-gamma", "bot-delta", "bot-echo"];
const fx = await bootFixture({ port: 0, oldPort: 49158, roster: ROSTER, classic: false });
const fm = fx.fm;
const status = new Map<string, string>(ROSTER.map((r) => [r.name, "running"]));
fm.getInstanceStatus = (n: string) => status.get(n) ?? "running";
// Working, as the server reports it (a page-store override raced the status pushes: a worker flickered to idle).
const working = new Set(WORKING);
fm.getInstanceExecutionState = (n: string) => (working.has(n) ? "working" : "idle");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const draw = await fx.browser.newPage();
const pack = await draw.evaluate(`(() => {
  const mk = (w, h) => { const cv = document.createElement("canvas"); cv.width = w; cv.height = h; return { cv, c: cv.getContext("2d") }; };
  const b64 = (cv) => cv.toDataURL("image/png").split(",")[1];
  // One 2-frame strip a pose: blue body, skin head; the hair and face say which way they look.
  const pose = (kind) => { const s = mk(64, 48);
    for (let f = 0; f < 2; f++) { const c = s.c, o = f * 32, b = kind === "work" ? 0 : f;
      c.fillStyle = "#3b6fd8"; c.fillRect(o + 8, 22 - b, 16, 22);
      c.fillStyle = "#2a2a2a"; c.fillRect(o + 10, 44, 5, 4); c.fillRect(o + 17 + (kind === "side" ? f * 3 : 0), 44, 5, 4);
      c.fillStyle = "#f2c9a3"; c.fillRect(o + 9, 6 - b, 14, 15);
      c.fillStyle = "#2a2a2a";
      if (kind === "up") c.fillRect(o + 9, 4 - b, 14, 17);                       // the back of the head
      else if (kind === "side") { c.fillRect(o + 9, 4 - b, 14, 5); c.fillRect(o + 9, 4 - b, 7, 13); c.fillRect(o + 19, 11 - b, 2, 2); c.fillStyle = "#e0a982"; c.fillRect(o + 23, 13 - b, 3, 3); }
      else { c.fillRect(o + 9, 4 - b, 14, 5); c.fillRect(o + 12, 12 - b, 2, 2); c.fillRect(o + 18, 12 - b, 2, 2); }
      if (kind === "work") { c.fillStyle = "#9aa3ad"; c.fillRect(o + 4, 30, 24, 12); c.fillStyle = f ? "#7fe3ff" : "#5fc0e0"; c.fillRect(o + 6, 32, 20, 7); }
    }
    return s; };
  const pics = { idle: pose("idle"), work: pose("work"), side: pose("side"), up: pose("up"), down: pose("idle") };
  const st = (src) => ({ src, frames: 2, w: 32, h: 48, fps: 2, dw: 32, dh: 48, ax: 16, ay: 46 });
  const person = { idle: st("idle.png"), working: st("work.png"), walkSide: st("side.png"), walkUp: st("up.png"), walkDown: st("down.png") };
  const bg = mk(1280, 720), g = bg.c;
  g.fillStyle = "#e9e4d8"; g.fillRect(0, 0, 1280, 720);
  const room = (x, y, w, h, f, t) => { g.fillStyle = f; g.fillRect(x, y, w, h); g.strokeStyle = "#5b6475"; g.lineWidth = 4; g.strokeRect(x, y, w, h); g.fillStyle = "#222"; g.font = "700 22px sans-serif"; g.fillText(t, x + 12, y + 30); };
  room(80, 30, 500, 230, "#cfe0f5", "Work"); room(700, 30, 500, 230, "#d8efd6", "Lounge");
  room(80, 450, 500, 240, "#f7d6d0", "Help desk"); room(700, 450, 500, 240, "#e3dcf2", "Nap");
  g.fillStyle = "#8b6b4a"; g.fillRect(200, 150, 18, 60); g.fillRect(286, 130, 40, 16);   // a counter (right of Beta), a board (above Gamma)
  g.fillStyle = "#fff"; g.fillRect(288, 112, 36, 18);
  g.fillStyle = "#8b6b4a"; g.fillRect(400, 205, 40, 14); g.fillRect(520, 205, 40, 14);   // plain desks
  g.fillStyle = "#b9b2a3"; g.fillRect(60, 312, 1160, 56);
  g.strokeStyle = "#6b6252"; g.lineWidth = 3; for (const y of [322, 342, 358]) { g.beginPath(); g.moveTo(60, y); g.lineTo(1220, y); g.stroke(); }
  g.fillStyle = "#8a8170"; g.fillRect(80, 280, 80, 26); g.fillRect(1120, 372, 80, 26);
  g.fillStyle = "#f4d03f"; g.fillRect(314, 290, 32, 12);                                // the queue mark
  g.fillStyle = "#222"; g.font = "600 14px sans-serif"; g.fillText("Platform A", 84, 276); g.fillText("Queue", 350, 300); g.fillText("Platform B", 1124, 412);
  const car = mk(2 * 200, 90), front = mk(200, 90);
  for (let f = 0; f < 2; f++) { const c = car.c, o = f * 200; c.fillStyle = "#c0392b"; c.fillRect(o + 4, 20, 192, 62); c.fillStyle = "#fbe7c6"; for (let i = 0; i < 4; i++) c.fillRect(o + 16 + i * 46, 28, 34, 22); c.fillStyle = "#333"; c.fillRect(o + 20 + f * 4, 80, 24, 8); c.fillRect(o + 156 - f * 4, 80, 24, 8); }
  front.c.fillStyle = "#a93226"; front.c.fillRect(4, 56, 192, 26); front.c.fillStyle = "#f4d03f"; front.c.fillRect(4, 56, 192, 4);
  const strip = (src, frames) => ({ src, frames, w: 200, h: 90, fps: 4, dw: 200, dh: 90, ax: 100, ay: 80 });
  const manifest = { format: 1, id: "synth-fields", background: "bg.png",
    areas: {
      desks: { rect: [80, 30, 500, 230], seats: [{ x: 180, y: 200, for: ["bot-beta"], standFacing: "right" }, { x: 306, y: 200, for: ["bot-gamma"], standFacing: "up" }, { x: 420, y: 200, for: ["bot-delta"] }, [540, 200]] },
      lounge: { rect: [700, 30, 500, 230], seats: [[800, 200], [920, 200], [1040, 200], [1160, 200]] },
      help: { rect: [80, 450, 500, 240], seats: [[200, 620], [320, 620], [440, 620]] },
      nap: { rect: [700, 450, 500, 240], seats: [[800, 620], [920, 620], [1040, 620]] } },
    stateZones: { working: "desks", needs: "help", crashed: "help", stuck: "help", paused: "nap", stopped: "nap", default: "lounge" },
    characters: { default: person },
    vehicles: [{ id: "loop-line", label: "Loop line", sprites: { right: strip("car.png", 2) }, fronts: { right: strip("front.png", 1) },
      path: [[160, 336], [1160, 336], [1160, 352], [160, 352]], speed: 60,
      stops: [{ at: 3, seconds: 8, platform: [120, 300], queue: [[330, 300]] }, { at: 1, seconds: 8, platform: [1160, 392] }],
      seats: [{ dx: -46, dy: 4, worker: "bot-alpha" }, { dx: 0, dy: 4 }, { dx: 46, dy: 4 }] }] };
  const files = { "bg.png": b64(bg.cv), "car.png": b64(car.cv), "front.png": b64(front.cv) };
  for (const [k, v] of Object.entries(pics)) files[k + ".png"] = b64(v.cv);
  return { manifest, files };
})()`);
await draw.close();
const added = fm.officeSkins.add(pack, "smoke");
if (!added.ok) throw new Error("pack refused " + JSON.stringify(added).slice(0, 400));
const w = fm.officeStore.replace([{ id: "hq", name: "HQ", skin: pack.manifest.id, members: ROSTER.map((r) => r.name) }]);
if (w && w.ok === false) throw new Error("office refused " + JSON.stringify(w));
const autoSet = fm.officeStore.setAutoSkin(pack.manifest.id); if (autoSet && autoSet.ok === false) throw new Error("setAutoSkin " + JSON.stringify(autoSet));

// The lap (speed 60): run 0→1 16.7 s, stop at B 8 s, 0.27 s, run 2→3 16.7 s, stop at A (41.6–49.6 s), 0.27 s.
const run = (1000 / 60) * 1000, turn = (16 / 60) * 1000, LAP = 2 * run + 2 * turn + 16000, AT_A = 2 * run + turn + 8000;
const phase = () => Date.now() % LAP;
const until = async (ms: number) => { while (Math.abs(phase() - ms) > 150) await sleep(100); };
const report: any = { dev: DEV, cases: {} };
const cases = (["light", "dark"] as const).flatMap((theme) => (["en", "zh-TW"] as const).map((lang) => ({ device: DEV, theme, lang })));
try {
  for (const c of cases) {
    const key = `${c.device}-${c.theme}-${c.lang}`, errors: string[] = [];
    status.set("bot-alpha", "running");
    working.add("bot-alpha");
    const r = fm.officeActs.handle("bot-echo", "office_set", { ride: "loop-line", seconds: 3600 });
    if (!r.act) throw new Error(`ride echo: ${JSON.stringify(r)}`);
    const { ctx, page, csp } = await fx.page(c as any, { storage: { agend_org_office: "hq" } });
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    await mounted(page, 30000);
    await page.goto(`${fx.base}/ui/fleet/org`);
    await page.locator(".oc-tools .seg-inline button", { hasText: c.lang === "en" ? "Office" : "辦公室" }).click();
    await page.waitForSelector(".oo-canvas", { timeout: 15000 });
    const shot = async (name: string) => { await page.screenshot({ path: join(OUT, `${key}-${name}.png`) }); };
    // Wait for the train to be well away from A, so everyone has walked to their place and stands waiting.
    while (phase() < AT_A - 14000 || phase() > AT_A - 3000) await sleep(200);
    await sleep(2500);
    await shot("1-standing-desks-and-queue");
    // A burst from the stop: the worker leaves the queue, crosses to the platform, boards (when, within a 1 s tick).
    await until(AT_A + 200);
    for (const k of ["a", "b", "c", "d", "e"]) { await shot(`2${k}-train-in`); await sleep(500); }
    await until(AT_A + 6500); await shot("3-on-board");
    await until((AT_A + 8000 + turn + 5000) % LAP); await shot("4-riding");
    working.delete("bot-alpha");
    status.set("bot-alpha", "crashed");
    const word = c.lang === "en" ? "Crashed" : "已當掉";
    await page.waitForFunction((w: string) => document.body.innerText.includes(w) || /\bHelp\s*1\b/i.test(document.body.innerText), word, { timeout: 30000 }).catch(() => errors.push("crash not seen"));
    await sleep(800); await shot("5-worker-calls-gets-off");
    await sleep(10000); await shot("6-caller-at-help-desk");
    report.cases[key] = { errors, csp: await csp() };
    await ctx.close();
  }
} finally { await fx.close(); }
writeFileSync(join(OUT, `report-${DEV}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
