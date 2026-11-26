/**
 * M-3749 capture: the Needs-you item for MCP servers missing after a credential-profile switch, on the real dashboard
 * (smoke fixture: scratch FleetManager, web server only; no fleet start, CLI or tmux), plus the agent's notice and the
 * chat list line in EN and zh-TW. Run: REPO=$PWD OUT=<dir> PW_DIR=<playwright-core dir> CHROME=<chrome> tsx <this file>.
 */
/** M-3749 capture: the Needs-you item for MCP servers missing after a switch, on the real dashboard. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootFixture, matrix, caseName } from "./smoke-fixture/index.mts";
import { publicRoster } from "./smoke-fixture/public-roster.mts";
import { deriveNeedsYou } from "../../src/needs-you.js";
import { NeedsYouHub } from "../../src/needs-you-hub.js";
import { setLocale, t } from "../../src/locale.js";
const out = resolve(process.env.OUT!); mkdirSync(out, { recursive: true });
const fx = await bootFixture({ roster: publicRoster(3), port: 0, instances: 3, classic: false });
const fm = fx.fm, name = fx.instances[1]?.name ?? fx.instances[0].name;
const since = Date.now() - 4 * 60_000;
const input = { name, mcpMissing: { names: ["m365", "outline"], from: "default", to: "work", since } };
fm.needsYouItems = () => deriveNeedsYou({ prompts: [], instances: [input], deliveries: [], ownerOf: () => undefined });
const texts: Record<string, any> = {};
for (const lang of ["en", "zh-TW"] as const) {
  setLocale(lang);
  const hub: any = Object.create(NeedsYouHub.prototype); hub.ctx = { t };
  texts[lang] = {
    agentNotice: t("inst.mcp_missing", "default", "work", ["m365", "outline"].join(t("needs.mcp_missing_sep"))),
    chatLine: hub.lineTitle(fm.needsYouItems()[0]),
  };
}
setLocale("en");
const shots: string[] = [];
try {
  for (const c of matrix("desk-light-en,desk-dark-zh-TW,phone-dark-en,phone-light-zh-TW")) {
    const { page, ctx } = await fx.page(c);
    await page.goto(fx.base + "/ui/needs"); await page.waitForTimeout(800);
    fm.emitSseEvent("needs", { items: fm.needsYouItems() });
    const word = c.lang === "en" ? "MCP servers missing" : "缺少 MCP 伺服器";
    await page.waitForFunction((w: string) => document.body.innerText.includes(w), word, { timeout: 8000 });
    await page.evaluate(() => document.fonts.ready);
    const shown = await page.evaluate(() => [...document.querySelectorAll(".n-actions")].map(el => (el.parentElement as HTMLElement).innerText.replace(/\s+/g, " ").trim()));
    (texts.web ??= {} as Record<string, unknown>)[caseName(c)] = shown;
    const file = `mcp-missing-${caseName(c)}.png`;
    await page.screenshot({ path: join(out, file), fullPage: false });
    shots.push(file);
    await ctx.close();
  }
} finally { await fx.close(); }
writeFileSync(join(out, "texts.json"), JSON.stringify(texts, null, 2));
console.log(JSON.stringify({ instance: name, shots, texts }, null, 2));
