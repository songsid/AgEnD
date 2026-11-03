// alpha.2 (M-2300; junsion's §6 and §10 steps 4–6; quality rules c7e5d374): an isolated web-only coordinator (the shared
// fixture: web server only, a scratch AGEND_HOME, NO Discord or Telegram) — an agent asks for a Windows agent, the request
// waits in the web's Needs you, the owner approves there, and the agent is created exactly once.
// - The owner signs in with the host's own code (POST /auth/issue-code with the web token: what `agend web --code` does)
//   in a real browser on this computer: decision 28c2d3a3's verified owner.
// - The agent's request is the real #2973 path: FleetManager.requestWindowsCreate (what the MCP create_instance handler
//   calls for runtime "windows"), with "Use this PC's Windows CLIs" on (AGEND_WINDOWS_CLI=1). Creating a Windows agent
//   writes its profile and fleet.yaml entry only (no CLI runs until it is sent a message), in the scratch home.
// - Judged: before, nothing waits; the request appears in Needs you by the stream's ping (no reload) with what it would do
//   and the Needs you count; no agent exists yet; Approve → applied, one new Windows agent (fleet.yaml and its profile
//   store), "Open chat" to it; a second approval answers 409, nothing more created; another admin session (not the
//   owner: an ordinary sign-in code) sees nothing; a stale tab (app.js, app-shell.js, app-stream.js from the alpha before
//   this change) still lists it and approves it; desk and phone; no page errors.
//   PW_DIR=… REPO=<checkout> OUT=<dir> PW_DPR=2 FONTCONFIG_FILE=/etc/fonts/fonts.conf [SKEW=<dir with old app.js app-shell.js app-stream.js>] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-web-agent-proposals-m2300.mts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

process.env.AGEND_WINDOWS_CLI = "1";
const SMOKE = "smoke-web-agent-proposals-m2300";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48923), classic: false, instances: 3, webYaml: "  verified_authority:\n    enabled: true" });
const fm = fx.fm as any;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean; failed: string[]; info?: unknown }> = [];
const windowsAgents = () => Object.entries(fm.fleetConfig.instances).filter(([, c]: any) => c.runtime === "windows").map(([n]) => n);
const token = fm.getDashboardAccess().token as string;
const hostCode = async () => (await (await fetch(`${fx.base}/auth/issue-code`, { method: "POST", headers: { "x-agend-token": token, origin: fx.base } })).json()).code as string;
const ask = (dir: string) => fm.requestWindowsCreate("planner", { runtime: "windows", topic_name: dir, backend: "codex", directory: `C:\\agend-m2300-e2e\\${dir}`, sandbox: "read-only" });

for (const c of [{ device: "desk", width: 1366, height: 900 }, { device: "phone", width: 390, height: 844 }] as const) {
  // live: the stream's ping; stale: a tab from before this change (its app.js, app-shell.js and app-stream.js); poll:
  // a page whose stream never connects (/ui/events refused), on /ui/poll only (#2997 review). None is reloaded.
  for (const mode of ["live", "poll", ...(process.env.SKEW ? ["stale"] : [])] as const) {
    const stale = mode === "stale", name = `${c.device}${mode === "live" ? "" : "-" + mode}`, failed: string[] = [], info: Record<string, unknown> = {};
    const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
    const ctx = await fx.browser.newContext({ viewport: { width: c.width, height: c.height }, deviceScaleFactor: Number(process.env.PW_DPR ?? 1), isMobile: c.device === "phone", hasTouch: c.device === "phone" });
    await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done","1"); localStorage.setItem("agend_firstrun_dismissed","1"); localStorage.setItem("agend_lang","en"); } catch {}` });
    const page = await ctx.newPage(), errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push(String(e)));
    if (mode === "poll") await page.route("**/ui/events*", (r: any) => r.abort());
    if (stale) for (const f of ["app.js", "app-shell.js", "app-stream.js"]) {
      const body = readFileSync(join(process.env.SKEW!, f), "utf8"); let first = true;
      await page.route(`**/assets/${f}*`, (r: any) => { if (!first) return r.continue(); first = false; return r.fulfill({ status: 200, contentType: "text/javascript", body }); });
    }
    try {
      await page.goto(`${fx.base}/signin`); await page.waitForSelector("#code");
      await page.fill("#code", await hostCode()); await page.click("#go"); await page.waitForURL(`${fx.base}/ui`);
      await page.goto(`${fx.base}/ui/needs`); await page.waitForSelector(".p-needs", { timeout: 15000 }); await sleep(800);
      const before = windowsAgents().length;
      need((await page.locator(".n-proposals").count()) === 0, "nothing waits before the request");
      const view = await ask(`builder-${name}`);
      info.pending = { id: view.id, state: view.state, summary: view.summary };
      need(view.state === "pending", `the request is pending (${view.state})`);
      need(windowsAgents().length === before, "no agent exists before the owner decides");
      // It arrives by itself, never by a reload: the stream's ping (live), the status frame's revision (a stale tab's own
      // stream), or /ui/poll's status frame (poll: every 5 s).
      await page.waitForSelector(".n-proposals .n-item", { timeout: 15000 }).catch(() => failed.push("the request never appeared in Needs you (no reload)"));
      const lines = await page.locator(".n-proposals .n-detail li").allTextContents();
      info.lines = lines;
      need(lines.some((l: string) => /agend-m2300-e2e/.test(l)), `its folder is shown (${JSON.stringify(lines)})`);
      need((await page.locator(".n-proposals .n-title strong").first().textContent()) === "Request from planner", "who asked is shown");
      await page.screenshot({ path: shotPath(SMOKE, name, "request") });
      await page.locator(".n-proposals button", { hasText: "Approve" }).first().click();
      await page.waitForSelector(".n-proposals a.btn", { timeout: 15000 }).catch(() => failed.push("no result with the new agent's chat"));
      const created = windowsAgents().length - before;
      info.created = created; info.result = await page.locator(".n-proposals .n-title strong").first().textContent();
      need(created === 1, `exactly one Windows agent created (${created})`);
      const href = await page.locator(".n-proposals a.btn").first().getAttribute("href").catch(() => null);
      need(!!href && href.startsWith("/ui/chat/"), `"Open chat" to the new agent (${href})`);
      await page.screenshot({ path: shotPath(SMOKE, name, "approved") });
      // A second approval of the same request: refused as no longer pending, nothing more created.
      const again = await page.evaluate(async (id: string) => {
        const csrf = (document.cookie.match(/agend_csrf=([^;]+)/) || [])[1];
        const r = await fetch(`/ui/agent-proposals/${id}`, { method: "POST", headers: { "Content-Type": "application/json", ...(csrf ? { "x-agend-csrf": decodeURIComponent(csrf) } : {}) }, body: JSON.stringify({ decision: "confirm" }) });
        return { status: r.status, body: await r.json().catch(() => null) };
      }, view.id);
      info.again = { status: again.status, error: again.body?.error, state: again.body?.view?.state };
      need(again.status === 409 && windowsAgents().length - before === 1, `a second approval answers 409, nothing more (${JSON.stringify(info.again)})`);
      // Another admin session (an ordinary sign-in code, not the host's): sees nothing to act on.
      const other = await fx.browser.newContext({ viewport: { width: c.width, height: c.height } });
      const op = await other.newPage();
      const ordinary = fm.webLoginCodes.issue({ tier: "admin", epoch: (await import(process.env.REPO + "/src/web-session.ts")).tokenEpoch(token) }).display;
      await op.goto(`${fx.base}/signin`); await op.waitForSelector("#code"); await op.fill("#code", ordinary); await op.click("#go"); await op.waitForURL(`${fx.base}/ui`);
      const pend = await ask(`other-${name}`);
      const seen = await op.evaluate(async () => (await fetch("/ui/agent-proposals")).json());
      need(seen.owner === false && seen.proposals.length === 0, `a non-owner admin reads nothing (${JSON.stringify(seen).slice(0, 80)})`);
      await op.goto(`${fx.base}/ui/needs`); await op.waitForSelector(".p-needs"); await sleep(800);
      need((await op.locator(".n-proposals").count()) === 0, "a non-owner admin's Needs you lists no request");
      await op.screenshot({ path: shotPath(SMOKE, name, "not-owner") });
      await other.close();
      fm.settingsGate().store.withdraw?.(pend.id, "agent:planner");                     // tidy: that one is not decided here
      need(errors.length === 0, `no page errors (${errors.slice(0, 2).join(" | ")})`);
    } catch (e) { failed.push(String(e).slice(0, 200)); }
    results.push({ name, ok: !failed.length, failed, info });
    console.log(`${failed.length ? "FAIL" : "PASS"} ${name}${failed.length ? " — " + failed.join("; ") : ""}\n     ${JSON.stringify(info).slice(0, 600)}`);
    await ctx.close();
  }
}
writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, "result.json"), JSON.stringify(results, null, 2));
await fx.close();
process.exit(results.every(r => r.ok) ? 0 : 1);
