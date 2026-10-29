// #2848 a guest's chat of an agent whose messages are all hidden from it says why, and a cross-instance line marked as
// the channel's (posted to the agent's topic) shows. On the realistic fixture: a guest scoped to two agents with no
// chat yet — one gets only unmarked cross-instance lines (as an older version kept them), the other a marked line and
// an unmarked one. Desktop, light (en) and dark (zh-TW); an admin's page of the first as the control.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2848-guest-hidden.mts
import { bootFixture, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2848-guest-hidden";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48390), webYaml: "  guests:\n    enabled: true" });
const fm = fx.fm;
const { tokenEpoch } = await import(process.env.REPO + "/src/web-session.ts");
const empty = fx.instances.map(i => i.name).filter(n => fm.webChatHistory.list(n).length === 0);
if (empty.length < 2) throw new Error("the fixture has fewer than two agents with no chat");
const [hidden, mixed] = empty as [string, string];
fm.guestScope = () => new Set([hidden, mixed]);
const owner = { adapterId: "discord", userId: "424242424242424242" };
fm.webPrefs.setProfileName(`person:${owner.adapterId}:${owner.userId}`, "Alice");
fm.initializeWebSessions();
const line = (instance: string, text: string, channel?: true) =>
  fm.emitSseEvent("message", { instance, sender: "lead", role: "status", text, ts: new Date().toISOString(), ...(channel ? { channel } : {}) });
line(hidden, `lead → ${hidden}:\nAn older cross-instance line, kept before #2848.`);
line(hidden, `${hidden} → lead:\nAnother one, its reply.`);
line(mixed, `lead → ${mixed}:\nPosted to the topic: a guest sees this.`, true);
line(mixed, `lead → ${mixed}:\nNot posted to the topic: a guest never sees this.`);

const results: any[] = [];
for (const c of [{ theme: "light", lang: "en" }, { theme: "dark", lang: "zh-TW" }] as const) {
  const sid = fm.webSessions.create({ tier: "guest", surface: "local", label: "smoke", tokenEpoch: tokenEpoch(fm.webToken), owner }).sessionId;
  fm.webPrefs.write("operator", new Map<string, unknown>([["theme", c.theme], ["lang", c.lang]]));
  const ctx = await fx.browser.newContext({ viewport: VIEWPORTS.desk, deviceScaleFactor: 1, colorScheme: c.theme });
  await ctx.addCookies([{ name: "agend_session", value: sid, url: fx.base }]);
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); } catch {}` });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  const read = () => page.evaluate(`(() => ({ title: document.querySelector(".scroller .empty .empty-title")?.textContent ?? null,
    hint: document.querySelector(".scroller .empty .empty-hint")?.textContent ?? null,
    lines: [...document.querySelectorAll(".thread .msg")].map(m => m.textContent.replace(/\\s+/g, " ").trim().slice(0, 90)) }))()`);
  await page.goto(`${fx.base}/ui/chat/${encodeURIComponent(hidden)}`);
  await page.waitForSelector("#msgIn"); await page.waitForTimeout(1200);
  const a = await read();
  await page.screenshot({ path: shotPath(SMOKE, `desk-${c.theme}-${c.lang}`, "all-hidden") });
  await page.goto(`${fx.base}/ui/chat/${encodeURIComponent(mixed)}`);
  await page.waitForSelector("#msgIn"); await page.waitForTimeout(1200);
  const b = await read();
  await page.screenshot({ path: shotPath(SMOKE, `desk-${c.theme}-${c.lang}`, "marked-line") });
  results.push({ case: `${c.theme}-${c.lang}`, allHidden: a, mixed: b, errors });
  await ctx.close();
}
// Control: an admin sees both kept lines of the first agent.
let admin: any;
{
  const { ctx, page } = await fx.page({ device: "desk", theme: "light", lang: "en" }, { path: `/ui/chat/${encodeURIComponent(hidden)}` });
  await page.waitForSelector("#msgIn"); await page.waitForTimeout(1000);
  admin = await page.evaluate(`[...document.querySelectorAll(".thread .msg")].length`);
  await page.screenshot({ path: shotPath(SMOKE, "desk-light-en", "admin-control") });
  await ctx.close();
}
console.log(JSON.stringify({ hidden, mixed, results, adminLines: admin }, null, 1));
const want = { en: ["Nothing here you can see yet", "between agents"], "zh-TW": ["這裡還沒有你能看到的訊息", "其他 agent"] } as const;
const bad = results.filter(r => {
  const [title, hint] = want[r.case.endsWith("en") ? "en" : "zh-TW"];
  return r.allHidden.title !== title || !String(r.allHidden.hint).includes(hint) || r.allHidden.lines.length !== 0
    || r.mixed.title !== null || r.mixed.lines.length !== 1 || !r.mixed.lines[0].includes("Posted to the topic") || r.errors.length;
});
const ok = !bad.length && admin === 2;
console.log(ok ? "PASS" : `FAIL ${bad.map(b => b.case).join(", ")}${admin === 2 ? "" : ` admin lines ${admin}`}`);
await fx.close();
process.exit(ok ? 0 : 1);
