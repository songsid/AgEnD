// #2293 from defaults (fleet decision a78ebdc5): global search, in a fresh profile driven only through visible UI.
// The fleet's real search index (its worker, search.db in the scratch home) is fed through the fleet's own paths: chat
// rows through emitSseEvent, a message between agents through indexCrossInstance, a task through the index's record.
// - desk: the sidebar's "Search" row (with its Ctrl K hint) → the dialog, its hint → type → results grouped by agent
//   with badges → ↓ / Enter on a chat row → that chat, at the message, flashed; Ctrl+K again → recent searches →
//   a message between agents → the index's copy with both chats to open; Esc closes; Ctrl+F in a chat → narrowed to it.
// - phone: the header's search button → the dialog full screen → type → tap a result → the chat at the message.
// No account, no network, no CLI: the fixture (../smoke-fixture/) stubs the lifecycle.
// Output: 2293/<case>-*.png and result-<engine>.json.
//   PW_DIR=… REPO=<checkout> OUT=<dir> MATRIX=quick npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2293-search.mts
//   PW_ENGINE=webkit: the same in WebKit (see README: the Playwright image).
import { writeFileSync } from "node:fs";
import { bootFixture, demoAccount, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const REPO = process.env.REPO!;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48810), instances: 6 });
const fm = fx.fm;
const { chatDoc, taskDoc } = await import(REPO + "/src/search/search-docs.ts");
const agents = fx.instances.filter((i: any) => !i.general).map((i: any) => i.name);
const [A, B, C] = agents;
fm.getInstanceStatus = () => "running";

fm.startSearchIndex(fm.fleetConfig);
for (let i = 0; i < 200 && fm.searchIndex?.status() !== "ready"; i++) await new Promise(r => setTimeout(r, 50));
if (fm.searchIndex?.status() !== "ready") throw new Error(`search index not ready: ${fm.searchIndex?.status()}`);

const account = demoAccount();
const mine = `${account.adapterId}:${account.userId}`;
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const say = (instance: string, role: "user" | "agent", text: string, minutesAgo: number) =>
  fm.emitSseEvent("message", { instance, sender: role === "user" ? account.username : instance, role, text, ts: at(minutesAgo), ...(role === "user" ? { from: mine } : {}) });
// The conversation to find: asked of A days ago, buried under later talk.
say(A, "user", "Please move the nginx reverse proxy on staging to TLS 1.3 and reload it.", 3 * 24 * 60);
say(A, "agent", "Done — nginx on staging now only offers TLS 1.3; config tested and reloaded.", 3 * 24 * 60 - 4);
for (let i = 0; i < 40; i++) say(A, i % 2 ? "agent" : "user", i % 2 ? `Build ${i} is green.` : `Run build ${i}, please.`, 3 * 24 * 60 - 10 - i * 30);
say(B, "user", "請把 nginx 的 access log 保留天數改成 30 天", 26 * 60);
say(B, "agent", "已調整 nginx access log 輪替：保留 30 天，壓縮舊檔。", 26 * 60 - 3);
say(C, "user", "Is the CDN in front of nginx caching the API?", 90);
fm.indexCrossInstance({ messageId: "xmsg-smoke-1", from: A, to: C, kind: "task", correlationId: "cid-smoke-1",
  taskSummary: "Check nginx cache headers", content: "Could you check that nginx sends Cache-Control: no-store on /api/*? Report back with curl output.", ts: at(120) });
fm.searchIndex.record(taskDoc({ id: "smoke-task-1", title: "Rotate the nginx TLS certificate before Nov 1", description: "Staging and production; use the ACME client.",
  status: "claimed", assignee: B, created_by: A, created_at: at(600), updated_at: at(300) }));
// A chat row the history no longer holds (another process's), kept by the index: opens as its copy.
fm.searchIndex.record(chatDoc({ instance: C, boot: "0ldb00", id: 7, role: "agent", sender: C, text: "nginx upstream keepalive raised to 64 (old session).", ts: at(9 * 24 * 60) }));
await new Promise(r => setTimeout(r, 600));

const r: any = { engine: process.env.PW_ENGINE ?? "chromium", agents: [A, B, C], cases: {} };
// WebKit's own console lines, accepted exactly and counted: "Refused to apply a stylesheet …" once per screenshot
// (Playwright styles the page for a shot; the CSP refuses it) and once per <select> it draws (its internal sheet — the
// filters' Agent and Team; renders identically). Each case requires exactly shots + selects drawn; SHOTS=0 takes none.
const SHOTS = process.env.SHOTS !== "0";
const SHEET = "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";
const WEBKIT_OWN = new Set(['Viewport argument key "interactive-widget" not recognized and ignored.', SHEET]);
const errorsOf = (list: string[]) => r.engine !== "webkit" ? list : list.filter((e) => !WEBKIT_OWN.has(e.replace(/ @ \S+$/, "")));
const ok = (c: any, k: string, v: boolean) => { c[k] = v; if (!v) c.failed = [...(c.failed ?? []), k]; };

for (const c of matrix(process.env.MATRIX ?? "quick")) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  const p = await freshPage(fx, c, { account });
  const page = p.page;
  let shots = 0, selects = 0;
  const shot = async (label: string) => { if (!SHOTS) return; shots++; await page.screenshot({ path: shotPath("2293", c as any, label), caret: "initial" }); };
  const dlg = page.locator("dialog.search-dlg");
  const input = dlg.locator(".search-input");
  const search = async (text: string) => {
    const answered = page.waitForResponse((x: any) => x.url().includes("/ui/search?") && x.url().includes(encodeURIComponent(text).replace(/%20/g, "+")));
    await input.fill(text);
    const resp = await answered;
    await dlg.locator(".search-row").first().waitFor();
    return resp.status();
  };
  try {
    ok(res, "mounted", await mounted(page) && errorsOf(p.errors).length === 0);
    // The page's own rule (app-shell isMacLike): ⌘ on a Mac platform, Ctrl elsewhere.
    const mod = await page.evaluate(() => (/Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? "Meta" : "Control"));
    if (c.device === "desk") {
      const row = page.locator(".side-nav .side-search");
      ok(res, "rowHint", /Ctrl K|⌘K/.test((await row.textContent()) ?? ""));
      await row.click();
    } else {
      await page.locator(".panel-head .sb-search").click();
    }
    await dlg.waitFor();
    ok(res, "inputFocused", await input.evaluate((el: HTMLElement) => document.activeElement === el));
    ok(res, "hintShown", await dlg.locator(".search-hint").count() === 1);
    if (c.device === "phone") {
      const box = await dlg.boundingBox();
      ok(res, "fullScreen", !!box && box.width >= 389 && box.height >= 800);
    }
    await shot("empty");
    ok(res, "search200", await search("nginx") === 200);
    const groups = await dlg.locator(".search-group").evaluateAll((els: HTMLElement[]) => els.map(e => e.getAttribute("aria-label")));
    ok(res, "groupedByAgent", groups.length >= 3);
    const badges = new Set(await dlg.locator(".search-badge").allTextContents());
    ok(res, "threeSources", badges.size === 3);
    ok(res, "marked", (await dlg.locator(".search-snippet mark").count()) >= 5);
    await shot("results");
    if (c.device === "desk") {
      // Narrow to A's TLS request with a second word, then the keyboard: ↓↑ and Enter.
      await search("TLS 1.3");
      await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowUp");
      const first = dlg.locator(".search-row").first();
      ok(res, "activeFirst", (await first.getAttribute("aria-selected")) === "true");
      await page.keyboard.press("Enter");
    } else {
      await search("TLS 1.3");
      await dlg.locator(".search-row").first().click();
    }
    await dlg.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    ok(res, "closedOnOpen", await dlg.count() === 0);
    await page.waitForURL((u: URL) => u.pathname === `/ui/chat/${encodeURIComponent(A)}` && u.hash.startsWith("#m="), { timeout: 5000 });
    const target = page.locator(".msg.flash");
    ok(res, "jumpedFlashed", await target.first().waitFor({ timeout: 4000 }).then(() => true, () => false));
    ok(res, "flashedIsTheRequest", ((await target.first().textContent()) ?? "").includes("TLS 1.3"));
    await shot("jumped");
    if (c.device === "desk") {
      // Ctrl+F in this chat: the dialog, narrowed to this agent; the recent search is offered.
      await page.locator("#msgIn").click();
      const teamsRead = page.waitForResponse((x: any) => x.url().endsWith("/ui/teams"));
      await page.keyboard.press(`${mod}+f`);
      await dlg.waitFor();
      // The Team select comes once the teams are read (the fixture has teams): counted after it is drawn.
      ok(res, "teamsRead", (await teamsRead).status() === 200);
      await dlg.locator(".search-filters select").nth(1).waitFor();
      ok(res, "ctrlFNarrowed", (await dlg.locator(".search-filters select").first().inputValue()) === A);
      selects += await dlg.locator(".search-filters select").count();
      ok(res, "recentOffered", (await dlg.locator(".search-recent-item").allTextContents()).some(t => t.includes("TLS 1.3")));
      await shot("ctrlf-filters");
      await page.keyboard.press("Escape");
      ok(res, "escCloses", await dlg.waitFor({ state: "detached", timeout: 3000 }).then(() => true, () => false));
      // Ctrl+K: everywhere; a message between agents opens as the index's copy.
      await page.keyboard.press(`${mod}+k`);
      await dlg.waitFor();
      await search("Cache-Control");
      await dlg.locator(".search-row", { has: page.locator(".search-badge.xmsg") }).first().click();
      await dlg.locator(".search-detail .search-ctx-line.here").waitFor();
      ok(res, "xmsgCopy", ((await dlg.locator(".search-ctx-line.here").textContent()) ?? "").includes("curl output"));
      ok(res, "bothChats", (await dlg.locator(".search-detail-actions .btn").count()) === 2);
      await shot("xmsg-copy");
      await dlg.locator(".search-detail-head .chip-btn").click();
      await search("keepalive");
      await dlg.locator(".search-row").first().click();
      await dlg.locator(".search-detail .search-note").waitFor();
      await shot("gone-copy");
      // A click outside closes.
      await page.mouse.click(5, 5);
      ok(res, "clickOutsideCloses", await dlg.waitFor({ state: "detached", timeout: 3000 }).then(() => true, () => false));
    }
    ok(res, "noPageErrors", errorsOf(p.errors).length === 0);
    if (r.engine === "webkit") { res.sheets = p.errors.filter((e: string) => e.startsWith(SHEET)).length; res.shots = shots; res.selects = selects; ok(res, "sheetPerShotAndSelect", res.sheets === shots + selects); }
    res.errors = errorsOf(p.errors);
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 300)}`];
    await shot("error").catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((c: any) => !c.failed);
writeFileSync(shotPath("2293", "result", "x").replace(/-x\.png$/, `-${r.engine}.json`), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1));
fm.searchIndex?.close();
await fx.close(); process.exit(r.pass ? 0 : 1);
