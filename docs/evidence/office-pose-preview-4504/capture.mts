// #4504 captures. A synthetic pack and fixture agents only (Alpha … Echo): no real names, self-drawn pictures.
// Each strip is drawn so it is told apart at a glance: idle (face), working (laptop), walkUp (back of the head),
// walkSide (profile), pat (pink, hearts), needs (red, "!"). For each case: Alpha's card with the picker (Off); walkUp
// picked; pat picked; Replay; then Alpha crashes with a preview on: drawn calling at the Help desk, not in the preview.
// REPO=<checkout> PW_DIR=<dir with playwright-core> CHROME=<chrome> OUT=<dir> DEV=desk|phone [PW_DPR=3]  npx tsx capture-4504.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const REPO = process.env.REPO!, DEV = (process.env.DEV ?? "desk") as "desk" | "phone";
const OUT = process.env.OUT!; mkdirSync(OUT, { recursive: true });
const { bootFixture, mounted } = await import(join(REPO, "scripts/manual/smoke-fixture/index.mts"));
const NAMES = ["alpha", "beta", "gamma", "delta", "echo"];
const ROSTER = NAMES.map((n, i) => ({ name: `bot-${n}`, displayName: n[0].toUpperCase() + n.slice(1), backend: i % 2 ? "codex" : "claude-code", team: "Studio", status: "running" as const, general: i === 0 }));
const fx = await bootFixture({ port: 0, oldPort: 49158, roster: ROSTER, classic: false });
const fm = fx.fm;
const status = new Map<string, string>(ROSTER.map((r) => [r.name, "running"]));
fm.getInstanceStatus = (n: string) => status.get(n) ?? "running";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const draw = await fx.browser.newPage();
const pack = await draw.evaluate(`(() => {
  const mk = (w, h) => { const cv = document.createElement("canvas"); cv.width = w; cv.height = h; return { cv, c: cv.getContext("2d") }; };
  const b64 = (cv) => cv.toDataURL("image/png").split(",")[1];
  const pose = (kind) => { const s = mk(64, 48);
    for (let f = 0; f < 2; f++) { const c = s.c, o = f * 32, b = kind === "work" ? 0 : f;
      c.fillStyle = kind === "pat" ? "#e868a8" : kind === "needs" ? "#d8382c" : "#3b6fd8"; c.fillRect(o + 8, 22 - b, 16, 22);
      c.fillStyle = "#2a2a2a"; c.fillRect(o + 10, 44, 5, 4); c.fillRect(o + 17 + (kind === "side" ? f * 3 : 0), 44, 5, 4);
      c.fillStyle = "#f2c9a3"; c.fillRect(o + 9, 6 - b, 14, 15);
      c.fillStyle = "#2a2a2a";
      if (kind === "up") c.fillRect(o + 9, 4 - b, 14, 17);
      else if (kind === "side") { c.fillRect(o + 9, 4 - b, 14, 5); c.fillRect(o + 9, 4 - b, 7, 13); c.fillRect(o + 19, 11 - b, 2, 2); c.fillStyle = "#e0a982"; c.fillRect(o + 23, 13 - b, 3, 3); }
      else { c.fillRect(o + 9, 4 - b, 14, 5); c.fillRect(o + 12, 12 - b, 2, 2); c.fillRect(o + 18, 12 - b, 2, 2); }
      if (kind === "work") { c.fillStyle = "#9aa3ad"; c.fillRect(o + 4, 30, 24, 12); c.fillStyle = f ? "#7fe3ff" : "#5fc0e0"; c.fillRect(o + 6, 32, 20, 7); }
      if (kind === "pat") { c.fillStyle = "#ff3d7f"; c.fillRect(o + 2 + f * 2, 2, 4, 4); c.fillRect(o + 25 - f * 2, 1, 4, 4); }
      if (kind === "needs") { c.fillStyle = "#ffd400"; c.fillRect(o + 26, 2 - b, 4, 10); c.fillRect(o + 26, 14 - b, 4, 4); }
    }
    return s; };
  const kinds = ["idle", "work", "side", "up", "pat", "needs"], pics = Object.fromEntries(kinds.map((k) => [k, pose(k)]));
  const st = (src) => ({ src, frames: 2, w: 32, h: 48, fps: 2, dw: 32, dh: 48, ax: 16, ay: 46 });
  const person = { idle: st("idle.png"), working: st("work.png"), walkSide: st("side.png"), walkUp: st("up.png"), walkDown: st("idle.png"), pat: st("pat.png"), needs: st("needs.png") };
  const bg = mk(1280, 720), g = bg.c;
  g.fillStyle = "#e9e4d8"; g.fillRect(0, 0, 1280, 720);
  const room = (x, y, w, h, f, t) => { g.fillStyle = f; g.fillRect(x, y, w, h); g.strokeStyle = "#5b6475"; g.lineWidth = 4; g.strokeRect(x, y, w, h); g.fillStyle = "#222"; g.font = "700 22px sans-serif"; g.fillText(t, x + 12, y + 30); };
  room(80, 30, 500, 300, "#cfe0f5", "Work"); room(700, 30, 500, 300, "#d8efd6", "Lounge");
  room(80, 390, 500, 300, "#f7d6d0", "Help desk"); room(700, 390, 500, 300, "#e3dcf2", "Nap");
  const manifest = { format: 1, id: "synth-poses", background: "bg.png",
    areas: {
      desks: { rect: [80, 30, 500, 300], seats: [[200, 240], [330, 240], [460, 240]] },
      lounge: { rect: [700, 30, 500, 300], seats: [{ x: 820, y: 240, for: ["bot-alpha"] }, [950, 240], [1080, 240]] },
      help: { rect: [80, 390, 500, 300], seats: [[200, 600], [330, 600]] },
      nap: { rect: [700, 390, 500, 300], seats: [[820, 600], [950, 600]] } },
    stateZones: { working: "desks", needs: "help", crashed: "help", stuck: "help", paused: "nap", stopped: "nap", default: "lounge" },
    characters: { default: person } };
  const files = { "bg.png": b64(bg.cv) };
  for (const [k, v] of Object.entries(pics)) files[k + ".png"] = b64(v.cv);
  return { manifest, files };
})()`);
await draw.close();
const added = fm.officeSkins.add(pack, "smoke");
if (!added.ok) throw new Error("pack refused " + JSON.stringify(added).slice(0, 400));
const w = fm.officeStore.replace([{ id: "hq", name: "HQ", skin: pack.manifest.id, members: ROSTER.map((r) => r.name) }]);
if (w && w.ok === false) throw new Error("office refused " + JSON.stringify(w));
const autoSet = fm.officeStore.setAutoSkin(pack.manifest.id); if (autoSet && autoSet.ok === false) throw new Error("setAutoSkin " + JSON.stringify(autoSet));

const report: any = { dev: DEV, cases: {} };
const cases = (["light", "dark"] as const).flatMap((theme) => (["en", "zh-TW"] as const).map((lang) => ({ device: DEV, theme, lang })));
try {
  for (const c of cases) {
    const key = `${c.device}-${c.theme}-${c.lang}`, errors: string[] = [], r: any = {};
    status.set("bot-alpha", "running");
    const { ctx, page, csp } = await fx.page(c as any, { storage: { agend_org_office: "hq", agend_org_office_wander: "0" } });
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    await mounted(page, 30000);
    await page.goto(`${fx.base}/ui/fleet/org`);
    await page.locator(".oc-tools .seg-inline button", { hasText: c.lang === "en" ? "Office" : "辦公室" }).click();
    await page.waitForSelector(".oo-canvas", { timeout: 15000 });
    const shot = async (name: string) => { await page.evaluate(`document.querySelector(".oo-card-preview")?.scrollIntoView({ block: "center" })`).catch(() => {}); await sleep(200); await page.screenshot({ path: join(OUT, `${key}-${name}.png`) }); };
    await sleep(6000);                                          // everyone at their seat
    const alpha = page.locator('button.oo-desk[data-name="bot-alpha"]');
    await alpha.focus(); await alpha.press("Enter"); await page.locator(".oo-card").waitFor();
    const sel = page.locator(".oo-card-preview select");
    r.options = await sel.locator("option").allInnerTexts();
    r.label = (await page.locator(".oo-card-preview label").innerText()).split("\n")[0].trim();
    // #4508 review: the picker's and Replay's height (CSS px) and the select's font size, beside an action button's.
    r.sizes = await page.evaluate(`(() => { const h = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : null; };
      const sel = document.querySelector(".oo-card-preview select");
      return { select: h(".oo-card-preview select"), replay: h(".oo-card-replay"), action: h(".oo-card-actions .btn"), selectFont: sel ? getComputedStyle(sel).fontSize : null }; })()`);
    await sleep(600); await shot("1-card-picker-off");
    await sel.selectOption("walkUp"); await sleep(1200); await shot("2-walkUp");
    await sel.selectOption("pat"); await sleep(1200); await shot("3-pat");
    r.replayEnabled = await page.locator(".oo-card-replay").isEnabled();
    await page.locator(".oo-card-replay").click(); await sleep(300); await shot("4-replay");
    // A preview on (idle), then Alpha crashes: drawn calling at the Help desk, not in the preview.
    await sel.selectOption("idle"); await sleep(500);
    const was = (await page.locator(".oo-card-state").innerText()).trim();
    status.set("bot-alpha", "crashed");
    await page.waitForFunction((w: string) => { const s = (document.querySelector(".oo-card-state")?.textContent || "").trim(); return !!s && s !== w; }, was, { timeout: 30000 }).catch(() => errors.push("crash not seen"));
    r.crashedState = (await page.locator(".oo-card-state").innerText().catch(() => "")).trim();
    await sleep(12000); await shot("5-caller-with-preview-on");
    report.cases[key] = { ...r, errors, csp: await csp() };
    await ctx.close();
  }
} finally { await fx.close(); }
writeFileSync(join(OUT, `report-${DEV}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
