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
async function office(c: any, storage: Record<string, string>) {
  const { ctx, page, csp } = await fx.page(c, { storage: { agend_org_mode: "office", ...storage } });
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
    report.cases[key] = { errors: o.errors, csp: await o.csp(), panel }; }
  catch (e) { report.cases[key] = { failed: String(e).slice(0, 300), errors: o.errors }; await o.page.screenshot({ path: join(OUT, `${key}-FAILED.png`) }); }
  finally { await o.ctx.close(); }
}
try {
  await shoot("desk-display-options", DESK, {}, async (p) => { await p.locator(".oo-display-btn").click(); await p.waitForTimeout(400); });
  await shoot("desk-dialogue-dock", DESK, { agend_org_office_dialogue: "1" }, async (p) => { msg("user", "How is the build?"); await p.waitForTimeout(800); msg("agent", REPLY); await p.waitForTimeout(3500); });
  await shoot("phone-dialogue-dock", PHONE, { agend_org_office_dialogue: "1" }, async (p) => { msg("user", "How is the build?"); await p.waitForTimeout(800); msg("agent", REPLY); await p.waitForTimeout(3500); });
  if (AFTER) for (const [dev, c] of [["desk", DESK], ["phone", PHONE]] as const) {
    await shoot(`${dev}-talk-panel`, c, { agend_org_office_talk: "panel" }, async (p) => { await chatWith(p); msg("user", "How is the build?"); msg("agent", REPLY); await p.waitForTimeout(1200); });
    await shoot(`${dev}-talk-box`, c, { agend_org_office_talk: "box" }, async (p) => { msg("user", "How is the build?"); await p.waitForTimeout(600); msg("agent", REPLY); await p.waitForTimeout(2500); });
    await shoot(`${dev}-talk-bubble`, c, { agend_org_office_talk: "bubble" }, async (p) => { await chatWith(p); msg("agent", REPLY); await p.waitForTimeout(3500); });
  }
} finally { await fx.close(); }
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
