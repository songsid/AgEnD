// The chat's Full width (the header's ⋯ menu, this browser's choice), from defaults (fleet decision a78ebdc5), through
// visible UI. On a 1600 px desk an agent's wide Markdown table (12 columns) and a long code line: with the option off
// (before) the thread is the 768 px column and the table scrolls inside it; checked (after) the thread and the composer
// take the panel less its padding, the table gets the room, and a person's bubble keeps its cap. Unchecked, it is back.
// Cases: desk light en, desk dark zh-TW. On a phone the item is not in the menu (the column is the screen already).
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [PW_ENGINE=webkit] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-chat-full-width.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "chat-full-width";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = /^(Viewport argument key "interactive-widget" not recognized and ignored\.|Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\.|(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/[a-z-]+|auth\/sessions?|api\/[a-z/-]+)(\?\S*)? due to access control checks\.)/;
const pageErrors = (errors: string[]) => errors.filter((e) => !(ENGINE === "webkit" && WEBKIT_OWN.test(e)));
const fx = await bootFixture({ port: Number(process.env.HP ?? 48870), instances: 3 });
const CHAT = fx.instances.find((i: any) => !i.general)?.name ?? "agend-dev-claude-t1519896892392083558";
const COLS = ["Instance", "Backend", "Model", "Effort", "Context", "Status", "Last reply", "Cache hit", "Tokens in", "Tokens out", "Cost (USD)", "Notes"];
const ROWS = [["web-claude", "claude-code", "opus-5-5", "high", "42%", "running", "2 min ago", "91.4%", "1,204,331", "88,120", "$12.40", "reviewing #2552"],
  ["dev-codex", "codex", "gpt-5.5", "medium", "18%", "idle", "11 min ago", "77.0%", "640,002", "41,980", "$4.12", "waiting on CI"],
  ["kiro-coord", "kiro-cli", "claude-sonnet-5-5", "—", "63%", "running", "just now", "84.9%", "2,018,770", "120,445", "$9.87", "merging the 2.3.2 line"],
  ["qa-bot", "muse", "muse-1.4", "low", "5%", "paused", "1 h ago", "—", "12,400", "3,100", "$0.08", "paused by Han 漢"]];
const TABLE = `Here is the fleet's usage this morning:\n\n| ${COLS.join(" | ")} |\n|${COLS.map(() => " --- ").join("|")}|\n${ROWS.map((r) => `| ${r.join(" | ")} |`).join("\n")}\n\n` +
  "And the command that produced it:\n\n```sh\nagend usage --since 2026-10-24T00:00:00+08:00 --group-by instance --columns backend,model,effort,context,status,cache_hit,tokens_in,tokens_out,cost --format markdown\n```";
const t0 = Date.now() - 10 * 60_000;
fx.fm.emitSseEvent("message", { instance: CHAT, sender: "Han 漢", role: "user", text: "Can you show me the usage per instance as a table?", ts: new Date(t0).toISOString() });
fx.fm.emitSseEvent("message", { instance: CHAT, sender: CHAT, role: "agent", text: TABLE, ts: new Date(t0 + 60_000).toISOString() });
fx.fm.emitSseEvent("message", { instance: CHAT, sender: "Han 漢", role: "user", text: "Thanks — and a short one stays short.", ts: new Date(t0 + 120_000).toISOString() });
const r: any = { engine: ENGINE, cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
const MEASURE = `(() => { const q = (s) => document.querySelector(s), w = (e) => e ? Math.round(e.getBoundingClientRect().width) : null;
  const tbl = q(".p-chat .msg.agent .md .tbl"), users = [...document.querySelectorAll(".p-chat .msg.user .body")];
  return { attr: q(".p-chat").getAttribute("data-width"), cls: q(".p-chat").getAttribute("class"), scroller: w(q(".p-chat .scroller")), thread: w(q(".p-chat .thread")),
    dock: w(q(".p-chat .dock-col")), tbl: w(tbl), tblScrolls: !!tbl && tbl.scrollWidth > tbl.clientWidth + 1, users: users.map(w),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`;
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }] as const) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  const label = c.lang === "en" ? "Full width" : "全寬";
  const p = await freshPage(fx, c as any, { path: `/ui/chat/${CHAT}` }).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page } = p;
  const item = () => page.locator(".p-chat .menu-list [role=menuitemcheckbox]", { hasText: label });
  const menu = async () => { await page.locator(".p-chat .panel-head .menu:not(.chat-card-menu) > button").click(); await item().waitFor({ timeout: 5000 }); };
  try {
    ok(res, "mounted", await mounted(page));
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.locator(".p-chat .msg.agent .md .tbl").waitFor({ timeout: 15000 }); await page.waitForTimeout(600);
    const before = await page.evaluate(MEASURE) as any;
    await page.screenshot({ path: shotPath(SMOKE, tag, "before") });
    await menu();
    ok(res, "itemOffByDefault", (await item().getAttribute("aria-checked")) === "false");
    await item().click(); await page.keyboard.press("Escape"); await page.waitForTimeout(600);
    const after = await page.evaluate(MEASURE) as any;
    await page.screenshot({ path: shotPath(SMOKE, tag, "after") });
    const stored = await page.evaluate(`localStorage.getItem("agend_chat_full_width")`);
    await menu(); await item().click(); await page.keyboard.press("Escape"); await page.waitForTimeout(600);
    const back = await page.evaluate(MEASURE) as any;
    res.measured = { before, after, back, stored };
    ok(res, "before:column", before.attr === null && before.thread === 768 && before.tblScrolls, before);
    // The scroller less the thread's own side padding (2 × --s-5), and the composer alike.
    ok(res, "after:fullWidth", after.attr === "full" && after.thread === after.scroller && after.thread > 1000 && after.dock > before.dock, after);
    ok(res, "after:tableRoom", after.tbl > before.tbl + 200 && !after.tblScrolls, { before: before.tbl, after: after.tbl, scrolls: after.tblScrolls });
    ok(res, "after:bubblesKeepCap", JSON.stringify(after.users) === JSON.stringify(before.users), { before: before.users, after: after.users });
    ok(res, "after:themeClassesKept", after.cls === before.cls, { before: before.cls, after: after.cls });
    ok(res, "after:keptOnThisDevice", stored === "on", stored);
    ok(res, "back:column", back.attr === null && back.thread === 768, back);
    ok(res, "noOverflow", !before.overflow && !after.overflow);
    ok(res, "noPageErrors", pageErrors(p.errors).length === 0, pageErrors(p.errors));
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await page.screenshot({ path: shotPath(SMOKE, tag, "error") }).catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((x: any) => !x.failed);
writeFileSync(shotPath(SMOKE, `result-${ENGINE}`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pass: r.pass, cases: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, { failed: v.failed ?? [], m: v.measured && { before: [v.measured.before.thread, v.measured.before.tbl, v.measured.before.users], after: [v.measured.after.thread, v.measured.after.tbl, v.measured.after.users] } }])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);
