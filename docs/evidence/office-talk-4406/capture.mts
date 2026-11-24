// #4406 captures (scratch). Office talk ways on the real UI with the smoke fixture; zero real names. LABEL=before|after.
// Messages are published as the fleet publishes them (fm.emitSseEvent "message"), as smoke-2861 does.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const REPO = process.env.REPO!, LABEL = process.env.LABEL ?? "after", OUT = join(process.env.OUT!, LABEL), AFTER = LABEL !== "before";
mkdirSync(OUT, { recursive: true });
const { bootFixture, mounted } = await import(join(REPO, "scripts/manual/smoke-fixture/index.mts"));
const ROSTER = [
  { name: "bot-alpha", displayName: "Alpha", backend: "claude-code", team: "Studio", status: "running" as const, general: true },
  { name: "bot-beta", displayName: "Beta", backend: "codex", team: "Studio", status: "running" as const },
];
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 49048), roster: ROSTER, classic: false });
const fm = fx.fm;
const REPLY = "The build is green again. I moved the flaky check behind the retry and wrote down why in the notes, so the next run tells us if it comes back. Anything else for today?";
const msg = (role: "user" | "agent", text: string) => fm.emitSseEvent("message", { instance: "bot-alpha", role, sender: role === "user" ? "Alex" : "bot-alpha", text, ts: new Date().toISOString() });
const report: any = { label: LABEL, cases: {} };
// Every fillText on the Office canvas with its size on the page (CSS px): font px × the transform's scale ÷ devicePixelRatio.
const RECORD = `(() => { const w = window; w.__texts = []; const orig = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (s, x, y) { if (this.canvas && this.canvas.classList && this.canvas.classList.contains("oo-canvas")) {
    const m = this.getTransform(), px = parseFloat((/([0-9.]+)px/.exec(this.font) || [0, 0])[1]); const d = w.devicePixelRatio || 1; w.__texts.push({ s: String(s), css: px * Math.hypot(m.a, m.b) / d, top: (m.d * y + m.f) / d, left: (m.a * x + m.e) / d }); }
    return orig.apply(this, arguments); }; })();`;
const TAPS = ".ot-tool, .ot-send, .ot-link, .ot-full, .ot-close, .ot-bar .btn, .ot-more, textarea.ot-input";
async function office(c: any, storage: Record<string, string>) {
  const { ctx, page, csp } = await fx.page(c, { storage: { agend_org_mode: "office", ...storage } });
  await page.addInitScript({ content: RECORD });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(String(e)));
  await mounted(page, 30000);
  await page.goto(`${fx.base}/ui/fleet/org`);
  await page.waitForSelector(".oo-canvas", { timeout: 15000 }); await page.waitForTimeout(2000);
  return { ctx, page, csp, errors };
}
async function chatWith(page: any) {
  const person = page.locator("button.oo-desk[data-name=bot-alpha]");
  await person.focus(); await person.press("Enter");
  await page.locator(".oo-card").waitFor();
  await page.locator(".oo-card-chat").click(); await page.waitForTimeout(600);
}
const DESK = { device: "desk", theme: "dark", lang: "en" }, PHONE = { device: "phone", theme: "dark", lang: "zh-TW" };
async function shoot(key: string, c: any, storage: Record<string, string>, act: (page: any) => Promise<void>) {
  const o = await office(c, storage);
  try { await act(o.page); await o.page.screenshot({ path: join(OUT, `${key}.png`) });
    const panel = await o.page.evaluate(() => [...document.querySelectorAll(".ot-msg")].map((e) => (e.textContent || "").trim().slice(0, 40)));
    const taps = await o.page.evaluate((sel: string) => [...document.querySelectorAll(sel)].filter((e) => (e as HTMLElement).offsetParent !== null)
      .map((e) => { const r = e.getBoundingClientRect(); return { t: ((e.textContent || "").trim() || e.getAttribute("aria-label") || e.className).slice(0, 14), w: Math.round(r.width), h: Math.round(r.height), inView: r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0 && r.bottom <= innerHeight + 0.5 }; }), TAPS);
    const small = taps.filter((x: any) => x.w < 44 || x.h < 44), clipped = taps.filter((x: any) => !x.inView);
    const replyText = await o.page.evaluate((r: string) => ((window as any).__texts as any[]).filter((x) => x.s.length > 3 && r.includes(x.s)).slice(-6).map((x) => Math.round(x.css * 10) / 10), REPLY);
    const replyRows = await o.page.evaluate((r: string) => { const cv = document.querySelector(".oo-canvas") as HTMLCanvasElement; const rc = cv.getBoundingClientRect();
      const rows = ((window as any).__texts as any[]).filter((x) => x.s.length > 3 && r.includes(x.s)).slice(-6);
      return rows.length ? { canvasH: Math.round(rc.height), canvasW: Math.round(rc.width), minTop: Math.round(Math.min(...rows.map((x) => x.top))), maxTop: Math.round(Math.max(...rows.map((x) => x.top))), minLeft: Math.round(Math.min(...rows.map((x) => x.left))) } : null; }, REPLY);
    const inputFont = await o.page.evaluate(() => { const e = document.querySelector("textarea.ot-input") as HTMLElement | null; return e ? getComputedStyle(e).fontSize : null; });
    const state = await o.page.evaluate(() => document.querySelector(".ot-state")?.textContent ?? null);
    const full = await o.page.evaluate(() => { const e = document.querySelector(".ot-full") as HTMLElement | null; if (!e || e.offsetParent === null) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), inView: r.left >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5 }; });
    report.cases[key] = { errors: o.errors, csp: await o.csp(), panel: panel.length, taps: taps.length, small, clipped, replyTextCssPx: replyText, replyRows, inputFont, state, openFullChat: full }; }
  catch (e) { report.cases[key] = { failed: String(e).slice(0, 300), errors: o.errors }; await o.page.screenshot({ path: join(OUT, `${key}-FAILED.png`) }); }
  finally { await o.ctx.close(); }
}
try {
  await shoot("desk-display-options", DESK, {}, async (p) => { await p.locator(".oo-display-btn").click(); await p.waitForTimeout(400); });
  await shoot("desk-zh-display-options", { device: "desk", theme: "light", lang: "zh-TW" }, {}, async (p) => { await p.locator(".oo-display-btn").click(); await p.waitForTimeout(400); });
  await shoot("desk-dialogue-dock", DESK, { agend_org_office_dialogue: "1" }, async (p) => { msg("user", "How is the build?"); await p.waitForTimeout(800); msg("agent", REPLY); await p.waitForTimeout(3500); });
  await shoot("phone-dialogue-dock", PHONE, { agend_org_office_dialogue: "1" }, async (p) => { msg("user", "How is the build?"); await p.waitForTimeout(800); msg("agent", REPLY); await p.waitForTimeout(3500); });
  if (AFTER) for (const [dev, c] of [["desk", DESK], ["phone", PHONE]] as const) {
    await shoot(`${dev}-talk-panel`, c, { agend_org_office_talk: "panel" }, async (p) => { await chatWith(p); msg("user", "How is the build?"); msg("agent", REPLY); await p.waitForTimeout(1200); });
    await shoot(`${dev}-talk-box`, c, { agend_org_office_talk: "box" }, async (p) => { msg("user", "How is the build?"); await p.waitForTimeout(600); msg("agent", REPLY); await p.waitForTimeout(2500); });
    await shoot(`${dev}-talk-bubble`, c, { agend_org_office_talk: "bubble" }, async (p) => { await chatWith(p); msg("agent", REPLY); await p.waitForTimeout(3500); });
  }
  // A short phone (a landscape-ish 390 × 520 window): the stage leaves little room over the heads.
  if (AFTER) await shoot("phone-short-talk-bubble", PHONE, { agend_org_office_talk: "bubble" }, async (p) => { await p.setViewportSize({ width: 390, height: 520 }); await p.waitForTimeout(800); await chatWith(p); msg("agent", REPLY); await p.waitForTimeout(3500); });
} finally { await fx.close(); }
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
