// #3008 ② (alpha.3; the user's simplified form hmsg-33c3d609; quality rules c7e5d374): the no-chat e2e of connections
// from outside. An isolated web-only coordinator (the shared fixture: web server only, a scratch AGEND_HOME, NO Discord
// or Telegram), its public link through the REAL gateway with only the tunnel stubbed — no cloudflared, no trycloudflare
// (the leader's rule for this host): the browser's https://<HOST>/* is carried to the gateway's local port with that
// Host, as the tunnel would.
// - This computer's admin (`agend web --code`, here) opens Settings → Access & security: the card says to set up an app
//   first, the switch can't be turned on. "Set up authenticator app" shows the QR code and the key; the code is
//   computed from the key shown (as the phone would); Continue → set up.
// - The switch on → the link opens; the card says where ("Open at https://<HOST>/signin. A quick link …").
// - Another browser (desk or phone) through the link: the sign-in page asks for the authenticator code; a wrong code
//   says to check the phone's clock; the right one signs in (/ui). An agent asks for a Windows agent (#2973's path):
//   the remote owner sees it in Needs you (polling — the link has no stream) and approves it → one agent created.
//   This computer's Notices say who signed in from outside.
// - 5 wrong codes from a third browser → "Too many wrong codes. Try again in 15 minutes."; the host's card shows the wait.
// - The switch off → the link closes; the remote browser's session has ended.
// - First, the setup page (the real SetupHost, scratch, the fleet spawn a spy — no fleet starts; alpha.3, the user's
//   hmsg-7c8fd0e5): "Web only" with nothing typed names the first agent `general` and shows the General note; a typed
//   directory makes it `agent-1` without the note (and clearing it brings `general` back); Create → the host confirms →
//   fleet.yaml has `general` with general_topic: true (the fleet's ticked General) and no channel.
// - Stale tab (SKEW=<dir with app.js app-shell.js app-stream.js app.css instance-nav.js from before this change>): the
//   host's Settings page with those still loaded draws the card and sets it up the same.
// Desk and phone (the host's page and the remote one); the fleet speaks zh-TW, the pages are English. No page errors.
//   PW_DIR=… REPO=<checkout> OUT=<dir> PW_DPR=2 FONTCONFIG_FILE=/etc/fonts/fonts.conf [SKEW=<dir>] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-web-outside-3008.mts
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

process.env.AGEND_WINDOWS_CLI = "1";
// The host's confirmation (what `agend settings confirm` does) refuses an agent's session: this smoke may run inside one.
delete process.env.AGEND_INSTANCE_NAME;
const SMOKE = "smoke-web-outside-3008";
const REPO = process.env.REPO!;
const HOST = "outside-smoke.trycloudflare.com";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48943), classic: false, instances: 3, webYaml: "  verified_authority:\n    enabled: true" });
const fm = fx.fm as any;
(await import(REPO + "/src/locale.ts")).setLocale("zh-TW");
const { hotp, base32Decode, totpStep } = await import(REPO + "/src/web-remote-access.ts");
const { PublicWebLink } = await import(REPO + "/src/public-web-link.ts");
const { TunnelPurposeLane } = await import(REPO + "/src/tunnel/purpose-lane.ts");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean; failed: string[]; info?: unknown }> = [];
const token = fm.getDashboardAccess().token as string;
const hostCode = async () => (await (await fetch(`${fx.base}/auth/issue-code`, { method: "POST", headers: { "x-agend-token": token, origin: fx.base } })).json()).code as string;

// The tunnel, stubbed: it "publishes" the real gateway at https://HOST.
let gatewayPort = 0, tunnelStarts = 0;
fm.initializeWebSessions();
fm.tunnelPurposeLane = new TunnelPurposeLane({
  start: async (_p: unknown, ctx: any) => { tunnelStarts++; gatewayPort = Number(new URL(ctx.origin).port); ctx.onCandidateHost(HOST);
    return { ok: true as const, handle: { pageUrl: `https://${HOST}/signin`, onUnexpectedExit: () => () => {} } }; },
  stop: async () => ({ confirmed: true as const }),
} as never);
// No preview tunnel either (it is a second, real tunnel manager): nothing here may start or stop a process.
fm.publicWebLink = new PublicWebLink({ ...fm.publicWebLinkDeps(), ensure: async () => ({ path: "/stub/cloudflared", source: "agend" }), provider: () => ({}) as never, createPreview: () => null });

const skew = process.env.SKEW;
// A browser of its own per case (one crash or close never takes the next case with it).
const pw = createRequire(process.env.PW_DIR + "/")("playwright-core");
let browser: any = null;
async function freshBrowser() {
  await browser?.close().catch(() => {});
  browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
  return browser;
}
async function context(c: { width: number; height: number; phone: boolean }) {
  const ctx = await browser.newContext({ viewport: { width: c.width, height: c.height }, deviceScaleFactor: Number(process.env.PW_DPR ?? 1), isMobile: c.phone, hasTouch: c.phone, locale: "en-US" });
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done","1"); localStorage.setItem("agend_firstrun_dismissed","1"); localStorage.setItem("agend_lang","en"); } catch {}` });
  // Through the link: https://HOST/* → the gateway's port with that Host (the gateway pins it). No stream over the link.
  await ctx.route(`https://${HOST}/**`, async (route: any) => {
    const req = route.request(), u = new URL(req.url());
    try {
      if (/text\/event-stream/.test(req.headers().accept ?? "")) { await route.abort(); return; }
      const response = await route.fetch({ url: `http://127.0.0.1:${gatewayPort}${u.pathname}${u.search}`, headers: { ...req.headers(), host: HOST } });
      await route.fulfill({ response });
    } catch {
      // The link closed (its gateway is gone) or the page did: the request fails, as through a dead tunnel — never left
      // hanging.
      await route.abort("connectionrefused").catch(() => {});
    }
  });
  return ctx;
}
async function stale(page: any) {
  if (!skew) return;
  for (const f of ["app.js", "app-shell.js", "app-stream.js", "app.css", "instance-nav.js"]) {
    let body: string; try { body = readFileSync(join(skew, f), "utf8"); } catch { continue; }
    let first = true;
    await page.route(`**/assets/${f}*`, (r: any) => { if (!first) return r.continue(); first = false;
      return r.fulfill({ status: 200, contentType: f.endsWith(".css") ? "text/css" : "text/javascript", body }); });
  }
}
const code = (key: Buffer, offset = 0) => hotp(key, totpStep(Date.now()) + offset);

const cases = [
  { device: "desk", width: 1366, height: 900, phone: false },
  { device: "phone", width: 390, height: 844, phone: true },
] as const;

// ── The setup page: web only's first agent is the General ──
{
  const { SetupHost } = await import(REPO + "/src/setup-host.ts");
  const { requestSettingsConfirmation } = await import(REPO + "/src/settings-control.ts");
  const yaml = (await import("js-yaml")).default;
  for (const c of cases) {
    const name = `setup-${c.device}`, failed: string[] = [], info: Record<string, unknown> = {};
    const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
    const dir = mkdtempSync(join(tmpdir(), "smoke-3008-setup-"));
    let spawned = 0;
    const host = new SetupHost({ dataDir: dir, configPath: join(dir, "fleet.yaml"), port: 0, spawnFleet: () => { spawned++; }, log: () => {} });
    await freshBrowser();
    const ctx = await browser.newContext({ viewport: { width: c.width, height: c.height }, isMobile: c.phone, hasTouch: c.phone, locale: "en-US" });
    try {
      const { port, path, code: setupCode } = await host.start();
      const page = await ctx.newPage(), errors: string[] = [];
      page.on("pageerror", (e: any) => errors.push(String(e)));
      await page.goto(`http://127.0.0.1:${port}${path}`);
      await page.fill("#code", setupCode); await page.click("#go");
      await page.waitForSelector("#pickWeb", { timeout: 10000 });
      await page.click("#pickWeb"); await sleep(300);
      const shown = async () => ({ name: await page.inputValue("#name"), note: await page.evaluate(() => !document.getElementById("generalNote")!.hidden) });
      info.web = await shown();
      info.noteText = await page.evaluate(() => document.getElementById("generalNote")!.textContent);
      need(info.noteText === "This agent is the General: you talk to it in the web chat, and it hands work to the agents you add later.", `web only's own General note (${info.noteText})`);
      need(JSON.stringify(info.web) === JSON.stringify({ name: "general", note: true }), `web only names it general with the note (${JSON.stringify(info.web)})`);
      await page.fill("#dir", "/home/demo/project"); await sleep(200);
      info.typed = await shown();
      need(JSON.stringify(info.typed) === JSON.stringify({ name: "agent-1", note: false }), `a typed directory makes agent-1 (${JSON.stringify(info.typed)})`);
      await page.fill("#dir", ""); await sleep(200);
      info.cleared = await shown();
      need(JSON.stringify(info.cleared) === JSON.stringify({ name: "general", note: true }), `cleared: general again (${JSON.stringify(info.cleared)})`);
      await page.screenshot({ path: shotPath(SMOKE, name, "general"), fullPage: true });
      await page.click("#preview");
      await page.waitForFunction(() => !document.getElementById("planOut")!.hidden, null, { timeout: 10000 }).catch(() => failed.push("no review"));
      await page.click("#finish");
      await page.waitForFunction(() => /agend settings confirm /.test(document.getElementById("finishMsg")!.textContent || ""), null, { timeout: 10000 }).catch(() => failed.push("no host confirmation asked"));
      const id = /confirm (\S+)/.exec(await page.evaluate(() => document.getElementById("finishMsg")!.textContent || ""))?.[1] ?? "";
      const inspection: any = await requestSettingsConfirmation(dir, { action: "inspect", id });
      const decided: any = await requestSettingsConfirmation(dir, { action: "confirm", ticket: inspection.ticket });
      need(decided?.pending_change?.state === "applied", `applied (${decided?.pending_change?.state})`);
      const written = existsSync(join(dir, "fleet.yaml")) ? yaml.load(readFileSync(join(dir, "fleet.yaml"), "utf8")) as any : null;
      info.written = written?.instances;
      need(written?.instances?.general?.general_topic === true && Object.keys(written.instances).length === 1, `fleet.yaml: general, ticked (${JSON.stringify(written?.instances)})`);
      need(written?.channel === undefined && written?.channels === undefined, "no chat connection written");
      need(spawned === 0, "no fleet started");
      need(errors.length === 0, `no page errors (${errors.slice(0, 2).join(" | ")})`);
    } catch (e) { failed.push(String(e).slice(0, 300)); }
    finally { await ctx.close(); await host.shutdown(false, "smoke done").catch(() => {}); }
    results.push({ name, ok: !failed.length, failed, info });
    console.log(`${failed.length ? "FAIL" : "PASS"} ${name}${failed.length ? " — " + failed.join("; ") : ""}\n     ${JSON.stringify(info).slice(0, 500)}`);
  }
}
for (const c of cases) for (const mode of ["live", ...(skew ? ["stale"] : [])] as const) {
  const name = `${c.device}${mode === "stale" ? "-stale" : ""}`, failed: string[] = [], info: Record<string, unknown> = {};
  const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
  let hostCtx: any = null;
  const errors: string[] = [];
  try {
    await freshBrowser();
    hostCtx = await context(c);
    const host = await hostCtx.newPage();
    host.on("pageerror", (e: any) => errors.push(`host: ${e}`));
    if (mode === "stale") await stale(host);
    // Fresh each round: nothing set up, the switch off.
    fm.webRemoteAccess().remove();
    await host.goto(`${fx.base}/signin`); await host.waitForSelector("#code");
    await host.fill("#code", await hostCode()); await host.click("#go"); await host.waitForURL(`${fx.base}/ui`);
    await host.goto(`${fx.base}/settings/access`); await host.waitForSelector("#outsideCard", { timeout: 15000 });
    need(await host.locator("#outSwitch").isDisabled(), "the switch can't be turned on before an app is set up");
    need((await host.locator("#outNeedApp").textContent()) === "Set up an authenticator app first. Signing in from outside will ask for its code.", "string 3");
    await host.click("#outSetUp"); await host.waitForSelector("#outQr", { timeout: 15000 });
    const key = base32Decode((await host.locator("#outKey").textContent())!.replace(/\s/g, ""));
    need(!!key && key.length >= 16, "the key is shown");
    await host.locator("#outQr").screenshot({ path: shotPath(SMOKE, name, "qr") });
    await host.screenshot({ path: shotPath(SMOKE, name, "enroll"), fullPage: true });
    await host.fill("#outCode", code(key!)); await host.click("#outConfirm");
    await host.waitForSelector("#outSetUpOn", { timeout: 15000 });
    await host.check("#outSwitch");
    await host.waitForSelector("#outOpenAt", { timeout: 20000 }).catch(() => failed.push("the link never said it is open"));
    info.openAt = await host.locator("#outOpenAt").textContent().catch(() => null);
    need(info.openAt === `Open at https://${HOST}/signin. A quick link gets a new address each time it opens.`, `string 9 (${info.openAt})`);
    await host.screenshot({ path: shotPath(SMOKE, name, "on"), fullPage: true });

    // Through the link.
    const remoteCtx = await context(c), remote = await remoteCtx.newPage();
    remote.on("pageerror", (e: any) => errors.push(`remote: ${e}`));
    await remote.goto(`https://${HOST}/signin`); await remote.waitForSelector("#code");
    need((await remote.locator("label[for=code]").textContent()) === "Authenticator code", "string 11 (label)");
    await remote.screenshot({ path: shotPath(SMOKE, name, "remote-signin") });
    await remote.fill("#code", code(key!, 3)); await remote.click("#go");
    await remote.waitForFunction(() => (document.getElementById("msg")?.textContent ?? "").length > 0);
    need((await remote.locator("#msg").textContent()) === "That code didn't work. Check that your phone's clock is right and try the newest code.", "string 12");
    await sleep(1100);
    await remote.fill("#code", code(key!, 1)); await remote.click("#go");
    await remote.waitForURL(`https://${HOST}/ui`, { timeout: 15000 }).catch(() => failed.push("the right code did not sign in"));
    // An agent's Windows request: the remote owner decides it in Needs you.
    const before = Object.values(fm.fleetConfig.instances).filter((x: any) => x.runtime === "windows").length;
    const view = await fm.requestWindowsCreate("planner", { runtime: "windows", topic_name: `remote-${name}`, backend: "codex", directory: `C:\\agend-3008-e2e\\${name}`, sandbox: "read-only" });
    need(view.state === "pending", `the request waits (${view.state})`);
    await remote.goto(`https://${HOST}/ui/needs`); await remote.waitForSelector(".p-needs", { timeout: 15000 });
    await remote.waitForSelector(".n-proposals .n-item", { timeout: 20000 }).catch(() => failed.push("the request never appeared in the remote Needs you"));
    await remote.locator(".n-proposals button", { hasText: "Approve" }).first().click().catch(() => failed.push("no Approve"));
    await remote.waitForSelector(".n-proposals a.btn", { timeout: 15000 }).catch(() => failed.push("no result after Approve"));
    info.created = Object.values(fm.fleetConfig.instances).filter((x: any) => x.runtime === "windows").length - before;
    need(info.created === 1, `exactly one agent created from outside (${info.created})`);
    await remote.screenshot({ path: shotPath(SMOKE, name, "remote-approved"), fullPage: true });
    const notices = (fm.webNoticesFeed()?.view().items ?? []).map((n: any) => n.text);
    need(notices.some((t: string) => t.startsWith("有人從外面登入：")), "the host's Notices say who signed in (the fleet's language)");

    // 5 wrong codes from a third browser: the wait, said in the page's words.
    const thirdCtx = await context(c), third = await thirdCtx.newPage();
    await third.goto(`https://${HOST}/signin`); await third.waitForSelector("#code");
    for (let n = 0; n < 5; n++) { await third.fill("#code", "000000"); await third.click("#go"); await sleep(300); }
    info.paused = await third.locator("#msg").textContent();
    need(info.paused === "Too many wrong codes. Try again in 15 minutes.", `string 13 (${info.paused})`);
    await third.screenshot({ path: shotPath(SMOKE, name, "paused") });
    await thirdCtx.close();
    await host.reload(); await host.waitForSelector("#outPaused", { timeout: 15000 }).catch(() => failed.push("the host's card does not show the wait"));

    // Off: the link closes, the remote session ends.
    await host.uncheck("#outSwitch");
    await host.waitForSelector("#outOpenAt", { state: "detached", timeout: 15000 }).catch(() => failed.push("the card still says open"));
    const after = await Promise.race([remote.evaluate(async () => (await fetch("/ui/agent-proposals")).status).catch(() => -1), sleep(10_000).then(() => -2)]);
    need(after !== 200, `the remote session ended (${after})`);
    await Promise.race([remoteCtx.close(), sleep(10_000)]);
    need(errors.length === 0, `no page errors (${errors.slice(0, 3).join(" | ")})`);
  } catch (e) { failed.push(String(e).slice(0, 300)); }
  results.push({ name, ok: !failed.length, failed, info });
  console.log(`${failed.length ? "FAIL" : "PASS"} ${name}${failed.length ? " — " + failed.join("; ") : ""}\n     ${JSON.stringify(info).slice(0, 500)}`);
  await hostCtx?.close().catch(() => {});
}
await browser?.close().catch(() => {});
console.log(`tunnel starts (stubbed): ${tunnelStarts}`);
writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, "result.json"), JSON.stringify(results, null, 2));
await fx.close();
process.exit(results.every(r => r.ok) ? 0 : 1);
