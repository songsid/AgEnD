// M-3387 (the user, beta.14): switching a ClassicBot room to restricted mode listed ~50 raw AgEnD tool names. Now the
// switch says what stops by kind with counts, the AI tool's own tools on their own line, the two layers and the
// not-covered sentence, with every name behind "show all". The real app (a real headless browser on the shared smoke fixture:
// the product's web server from an in-process FleetManager, a scratch home, loopback only — no fleet start, no network).
// The room's contact-permissions are answered in the page with the contract's shape; what would stop is the real list:
// every AgEnD MCP tool outside the restricted ceiling (src/channel/mcp-tools.ts, CLASSIC_RESTRICTED_TOOLS) plus Bash.
// Per case: 1-permissions (the room's Permissions: the kinds, then "show all" opened), 2-confirm (Switch to restricted: the
// confirm's words), 2b-confirm-all (its "show all" opened). Synthetic names only; no chat-id shape on any capture.
//   PW_DIR=<playwright-core dir> REPO=<checkout> OUT=<dir> [MATRIX=…] npx tsx scripts/manual/smoke/smoke-restricted-tools-m3387.mts
// ui-gate: {"name": "Restricted switch: what stops, by kind (M-3387)", "hp": 48387}
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";
import { fixtureInstances } from "../smoke-fixture/data.mts";
import { TOOLS } from "../../../src/channel/mcp-tools.ts";
import { CLASSIC_RESTRICTED_TOOLS } from "../../../src/contact-auth-types.ts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-restricted-tools-m3387";
const OUT = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE);
mkdirSync(OUT, { recursive: true });
const r: Record<string, unknown> = {};
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
const CHAT_ID = /-t\d{6,}/;
const PICK = ["general", "docs-site-builder"];
const roster = fixtureInstances().filter((i) => PICK.includes(i.name));
if (roster.length !== PICK.length || roster.some((i) => CHAT_ID.test(i.name))) throw new Error(`roster: ${roster.map((i) => i.name).join(", ")}`);
const fx = await bootFixture({ port: Number(process.env.HP ?? 48387), roster, classic: false });
const ROOM = "docs-site-builder";
const LOST = TOOLS.map((t) => t.name).filter((n) => !CLASSIC_RESTRICTED_TOOLS.includes(n));
const room = { instance: ROOM, revision: 4, classicRoom: true, mode: "legacy", approvers: [], inheritedApprovers: true, eligibleApprovers: [],
  nativeGuard: { state: "not-covered", backend: "codex", version: "0.170.0", reason: "unsupported-version" },
  roomTools: { publicRead: true, allowedMcpTools: [], wouldDisable: [...LOST, "Bash"] }, canManage: false, canSetMode: true, suggestRestricted: true, grants: [], history: [] };

const CASES = matrix(process.env.MATRIX ?? "desk-light-en,phone-dark-zh-TW");
const started = Date.now();
try {
  for (const c of CASES) {
    const cn = caseName(c), zh = c.lang === "zh-TW";
    const { ctx, page } = await fx.page(c, { path: "/ui" });
    await page.addInitScript({ content: "window.__name = (f) => f;" });
    await ctx.route("**/ui/api/instances/**/contact-permissions", (route: any) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(room) }));
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    const body = () => page.evaluate(() => document.body.innerText) as Promise<string>;
    const leaks: string[] = [];
    const shoot = async (name: string, opts: any = {}) => {
      const m = (await body()).match(new RegExp(CHAT_ID.source, "g"));
      if (m) { leaks.push(`${name}: ${[...new Set(m)].join(" ")}`); return; }
      await page.screenshot({ path: shotPath(SMOKE, cn, name), ...opts });
    };
    await page.goto(`${fx.base}/ui/fleet/agent/${encodeURIComponent(ROOM)}?cat=permissions`);
    await page.waitForSelector(".contact-would", { timeout: 20000 }); await page.waitForTimeout(400);
    const would = await page.locator(".contact-would").innerText();
    check(`${cn}:permissions-kinds`, would.includes(zh ? `這個房間會失去的 AgEnD 工具（${LOST.length} 個）` : `AgEnD tools this room loses (${LOST.length})`)
      && would.includes(zh ? "Hub 房間" : "Hub rooms") && would.includes(zh ? "AI 工具本身的工具（1 個）：Bash" : "The AI tool's own tools (1): Bash")
      && !(await page.locator(".contact-would-all").getAttribute("open")), would.slice(0, 600));
    await page.locator(".contact-would-all > summary").click(); await page.waitForTimeout(200);
    await page.locator(".contact-would").scrollIntoViewIfNeeded();
    await shoot("1-permissions", { fullPage: true });
    await page.locator(".contact-mode button").click(); await page.waitForSelector("dialog .confirm-text", { timeout: 5000 }); await page.waitForTimeout(300);
    const dlg = page.locator("dialog");
    const words = (await dlg.locator(".confirm-text").allInnerTexts()).join("\n\n");
    check(`${cn}:confirm-kinds`, words.includes(zh ? `• Fleet 狀態與設定` : "• Fleet status and settings") && words.includes(zh ? "分成兩層" : "Two layers")
      && words.includes(zh ? "不在防護範圍內" : "isn't covered by the guard") && !words.includes("office_pack_upload") && !words.includes("hub_room_post"), words.slice(0, 900));
    await shoot("2-confirm");
    await dlg.locator("details.confirm-more > summary").click(); await page.waitForTimeout(200);
    // Opened, the names are in the dialog's own scroll (no nested scroller): the first ones come into view.
    await dlg.locator("details.confirm-more > summary").evaluate((el: Element) => el.scrollIntoView({ block: "start" }));
    const firstShown = await dlg.locator("details.confirm-more li").first().evaluate((el: Element) => {
      const r = el.getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight; });
    check(`${cn}:confirm-show-all`, (await dlg.locator("details.confirm-more li").count()) === LOST.length + 1 && firstShown);
    await shoot("2b-confirm-all");
    check(`${cn}:no-page-error`, errs.length === 0, errs);
    check(`${cn}:no-chat-id-shape`, leaks.length === 0, leaks);
    await ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  r.seconds = Math.round((Date.now() - started) / 1000);
  const json = JSON.stringify(r, null, 1);
  writeFileSync(join(OUT, "result.json"), CHAT_ID.test(json) ? JSON.stringify({ withheld: "chat-id shape" }) : json);
  for (const f of fail.slice(0, 30)) console.log(`FAIL ${f}: ${JSON.stringify((r[f] as any)?.FAIL ?? r.error ?? "").slice(0, 700)}`);
  console.log(fail.length ? `M-3387 smoke FAILED (${fail.length}) in ${r.seconds}s — ${OUT}` : `M-3387 smoke passed in ${r.seconds}s (${Object.keys(r).length - 1} checks)`);
  await fx.close();
  process.exit(fail.length ? 1 : 0);
}
