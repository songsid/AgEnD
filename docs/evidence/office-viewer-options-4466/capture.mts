// #4466 captures: Office viewer options. Synthetic pack and fixture agents only (Alpha … Echo): no real names.
// For each case: the ⚙ menu with the two new switches; names+levels and the minimap hidden; Alpha's card with ✎, the
// field, the new name on the card and the tag; Alpha's card open while Alpha is told to walk (crashed → Help desk):
// still in place 10 s later, and walked off once the card closes.
// REPO=<checkout> PW_DIR=<dir with playwright-core> CHROME=<chrome> OUT=<dir> DEV=desk|phone [PW_DPR=3 for the phone]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const REPO = process.env.REPO!, DEV = (process.env.DEV ?? "desk") as "desk" | "phone";
const OUT = process.env.OUT!; mkdirSync(OUT, { recursive: true });
const { bootFixture, mounted } = await import(join(REPO, "scripts/manual/smoke-fixture/index.mts"));
const NAMES = ["alpha", "beta", "gamma", "delta", "echo"];
const ROSTER = NAMES.map((n, i) => ({ name: `bot-${n}`, displayName: n[0].toUpperCase() + n.slice(1), backend: i % 2 ? "codex" : "claude-code", team: "Studio", status: "running" as const, general: i === 0 }));
const fx = await bootFixture({ port: 0, oldPort: 49166, roster: ROSTER, classic: false });
const fm = fx.fm;
const status = new Map<string, string>();
const asleep = () => { for (const r of ROSTER) status.set(r.name, r.name === "bot-alpha" ? "running" : "paused"); };
fm.getInstanceStatus = (n: string) => status.get(n) ?? "running";
const LV = Object.fromEntries(ROSTER.map((r, i) => [r.name, { level: 4 + i * 3, workTokens: 50000 * (i + 1) ** 3, estimated: false, today: { workTokens: 1200 * (i + 1), requests: 3 + i }, firstSeen: "2026-10-01" }]));
fm.officeLevels = async () => LV; fm.officeLevelsSnapshot = () => LV;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const draw = await fx.browser.newPage();
const pack = await draw.evaluate(`(() => {
  const mk = (w, h) => { const cv = document.createElement("canvas"); cv.width = w; cv.height = h; return { cv, c: cv.getContext("2d") }; };
  const b64 = (cv) => cv.toDataURL("image/png").split(",")[1];
  const sheet = mk(2 * 32, 48);
  for (let f = 0; f < 2; f++) { const c = sheet.c, o = f * 32; c.fillStyle = "#3b6fd8"; c.fillRect(o + 8, 22 - f, 16, 24); c.fillStyle = "#f2c9a3"; c.fillRect(o + 9, 6 - f, 14, 15); c.fillStyle = "#2a2a2a"; c.fillRect(o + 9, 4 - f, 14, 5); }
  const bg = mk(1280, 720), g = bg.c;
  g.fillStyle = "#e9e4d8"; g.fillRect(0, 0, 1280, 720);
  const room = (x, y, w, h, f, t) => { g.fillStyle = f; g.fillRect(x, y, w, h); g.strokeStyle = "#5b6475"; g.lineWidth = 4; g.strokeRect(x, y, w, h); g.fillStyle = "#222"; g.font = "700 22px sans-serif"; g.fillText(t, x + 12, y + 30); };
  room(80, 30, 500, 300, "#cfe0f5", "Work"); room(700, 30, 500, 300, "#d8efd6", "Lounge");
  room(80, 390, 500, 300, "#f7d6d0", "Help desk"); room(700, 390, 500, 300, "#e3dcf2", "Nap");
  const manifest = { format: 1, id: "synth-names", background: "bg.png",
    areas: {
      desks: { rect: [80, 30, 500, 300], seats: [[180, 250], [300, 250], [420, 250], [540, 250]] },
      lounge: { rect: [700, 30, 500, 300], seats: [[800, 250], [920, 250], [1040, 250], [1160, 250]] },
      help: { rect: [80, 390, 500, 300], seats: [[200, 620], [320, 620], [440, 620]] },
      nap: { rect: [700, 390, 500, 300], seats: [[800, 620], [920, 620], [1040, 620], [1160, 620]] } },
    stateZones: { working: "desks", needs: "help", crashed: "help", stuck: "help", paused: "nap", stopped: "nap", default: "lounge" },
    characters: { default: { idle: { src: "sheet.png", frames: 2, w: 32, h: 48, fps: 2, dw: 32, dh: 48, ax: 16, ay: 46 } } } };
  return { manifest, files: { "bg.png": b64(bg.cv), "sheet.png": b64(sheet.cv) } };
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
    const key = `${c.device}-${c.theme}-${c.lang}`, errors: string[] = [], zh = c.lang === "zh-TW", r: any = {};
    asleep();
    const { ctx, page, csp } = await fx.page(c as any, { storage: { agend_org_office: "hq" } });
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    await mounted(page, 30000);
    await page.goto(`${fx.base}/ui/fleet/org`);
    await page.locator(".oc-tools .seg-inline button", { hasText: zh ? "辦公室" : "Office" }).click();
    await page.waitForSelector(".oo-canvas", { timeout: 15000 });
    await sleep(4000);
    const shot = async (name: string) => { await page.screenshot({ path: join(OUT, `${key}-${name}.png`) }); };
    const count = (sel: string) => page.locator(sel).count();
    // A desk: ⚙ Display options opens a pop-up. A phone: ⋯ opens the Office sheet, closed with Escape.
    const opener = page.locator(".oo-options:visible, .oo-display-btn:visible, .oo-more-btn:visible").first();
    const menu = async (open: boolean) => {
      if ((await count(".oo-display-pop, .oo-sheet")) === Number(open)) return;
      if (!open && (await count(".oo-sheet"))) await page.keyboard.press("Escape"); else await opener.click();
      await sleep(400);
    };
    const miniShown = () => page.locator(".oo-mini").isVisible();
    // The minimap shows only when the whole scene is not in view: zoom in until it does. A phone has none (app.css).
    for (let i = 0; DEV === "desk" && i < 6 && !(await miniShown()); i++) { await page.locator(".oo-zoom-in").click(); await sleep(800); }
    await shot("0-start");
    r.miniBefore = await miniShown();
    await menu(true); await shot("1-options-menu");
    await page.locator(".oo-hide-names input").check(); await page.locator(".oo-hide-mini input").check();
    await sleep(300); await shot("2-options-ticked");
    await menu(false); await sleep(800); await shot("3-names-and-minimap-hidden");
    r.miniHidden = await count(".oo-mini");
    await menu(true);
    await page.locator(".oo-hide-names input").uncheck(); await page.locator(".oo-hide-mini input").uncheck();
    await menu(false); await sleep(800);
    r.miniBack = await miniShown();
    await page.locator(".oo-fit:visible, .oo-zone-all:visible").first().click(); await sleep(800);

    const alpha = page.locator('button.oo-desk[data-name="bot-alpha"]');
    await alpha.focus(); await alpha.press("Enter");
    await page.locator(".oo-card").waitFor();
    await sleep(600); await shot("4-card-pencil");
    await page.locator(".oo-card-rename-btn").click();
    const field = page.locator(".oo-card-rename");
    await field.fill("陽奈"); await sleep(200); await shot("5-rename-field");
    await field.press("Enter"); await sleep(800);
    r.cardName = (await page.locator(".oo-card .oo-card-name").innerText()).trim();
    r.deskName = (await alpha.innerText()).trim();
    await shot("6-renamed");

    // Card still open: Alpha is told to go to the Help desk, and must stay put until the card closes.
    status.set("bot-alpha", "crashed");
    const word = zh ? "當掉" : "rash";
    await page.waitForFunction((w: string) => (document.querySelector(".oo-card-state")?.textContent || "").includes(w), word, { timeout: 30000 });
    r.cardState = (await page.locator(".oo-card-state").innerText()).trim();
    await sleep(500); await shot("7-carded-0s");
    await sleep(10000); await shot("8-carded-10s");
    await page.locator(".oo-card-close").click();
    await page.locator(".oo-card").waitFor({ state: "hidden" });
    await sleep(10000); await shot("9-closed-walked");
    report.cases[key] = { ...r, errors, csp: await csp() };
    await ctx.close();
  }
} finally { await fx.close(); }
writeFileSync(join(OUT, `report-${DEV}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
