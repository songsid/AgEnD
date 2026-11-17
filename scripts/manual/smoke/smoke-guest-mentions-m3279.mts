// Actual web HTTP/session/history/rendering, synthetic cache and inert agents. Headless Linux only; STAGE=before pins the fallback.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const before = process.env.STAGE === "before", smoke = `smoke-guest-mentions-m3279-${before ? "before" : "after"}`;
const fx = await bootFixture({ port: Number(process.env.HP ?? 49160), classic: false, webYaml: "  guests:\n    enabled: true", roster: [
  { name: "agent-alpha", displayName: "Example helper", backend: "codex" },
  { name: "agent-beta", displayName: "Other helper", backend: "claude-code" },
] });
const { tokenEpoch } = await import(process.env.REPO + "/src/web-session.ts");
const ids = ["900000000000000001", "900000000000000002"];
const owner = { adapterId: "discord", userId: "900000000000000099" };
fx.fm.guestScope = () => new Set(["agent-alpha"]);
fx.fm.seenUsers.record(ids[0], "Avery"); fx.fm.seenUsers.record(ids[1], "Blair");
fx.fm.emitSseEvent("message", { instance: "agent-alpha", sender: "Example helper", role: "agent", text: `Hello <@${ids[0]}> and <@!${ids[1]}>. The update is ready.`, ts: new Date().toISOString(), channel: true });
const results: any[] = [];
try {
  for (const tier of ["admin", "guest"] as const) {
    const sid = fx.fm.webSessions.create({ tier, surface: "local", label: "fixture", tokenEpoch: tokenEpoch(fx.fm.webToken), ...(tier === "guest" ? { owner } : {}) }).sessionId;
    fx.fm.webPrefs.write("operator", new Map<string, unknown>([["theme", "dark"], ["lang", "en"]]));
    const ctx = await fx.browser.newContext({ viewport: VIEWPORTS.desk, colorScheme: "dark" });
    await ctx.addCookies([{ name: "agend_session", value: sid, url: fx.base }]);
    await ctx.addInitScript({ content: 'window.__name = f => f; localStorage.setItem("agend_tour_done","1"); localStorage.setItem("agend_firstrun_dismissed","1");' });
    const page = await ctx.newPage(), responses: number[] = [], errors: string[] = [];
    page.on("response", (res: any) => { if (new URL(res.url()).pathname === "/ui/mentions") responses.push(res.status()); });
    page.on("pageerror", (e: any) => errors.push(String(e)));
    try {
      await page.goto(`${fx.base}/ui/chat/agent-alpha`);
      await page.waitForSelector(".thread .mention");
      const expected = before && tier === "guest" ? ["@user", "@user"] : ["@Avery", "@Blair"];
      await page.waitForFunction((labels: string[]) => JSON.stringify([...document.querySelectorAll(".thread .mention")].map(n => n.textContent)) === JSON.stringify(labels), expected);
      const actual = await page.locator(".thread .mention").allTextContents();
      const outOfScope = await page.request.get(fx.base + "/ui/history?instance=agent-beta");
      if (tier === "guest" && outOfScope.status() !== 404) throw Error("guest scope widened");
      if (!before && tier === "guest" && responses.length) throw Error("guest queried mention directory");
      if (errors.length) throw Error(errors.join(" | "));
      await page.screenshot({ path: shotPath(smoke, "desk-dark-en", tier) });
      if (!before && tier === "guest") {
        fx.fm.emitSseEvent("message", { instance: "agent-alpha", sender: "Example helper", role: "agent", text: "Unknown <@900000000000000003>.", ts: new Date().toISOString(), channel: true });
        const liveLabels = ["@Avery", "@Blair", "@user"];
        await page.waitForFunction((labels: string[]) => JSON.stringify([...document.querySelectorAll(".thread .mention")].map(n => n.textContent)) === JSON.stringify(labels), liveLabels);
        await page.reload();
        await page.waitForFunction((labels: string[]) => JSON.stringify([...document.querySelectorAll(".thread .mention")].map(n => n.textContent)) === JSON.stringify(labels), liveLabels);
        if (responses.length) throw Error("guest live/reloaded page queried mention directory");
      }
      results.push({ tier, actual, lookupResponses: responses, outOfScope: outOfScope.status(), pageErrors: errors, ...(!before && tier === "guest" ? { liveAndReloadUnknownFallback: true } : {}) });
    } finally { await ctx.close(); }
  }
} finally {
  await fx.close();
  console.log(JSON.stringify({ stage: before ? "before" : "after", results }));
  writeFileSync(join(process.env.OUT!, `${smoke}.json`), JSON.stringify(results, null, 2) + "\n");
}
