import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const REPO = process.env.REPO!, BASE = process.env.BASE_REF!, OUT = process.env.OUT!;
const { bootFixture, matrix, caseName, shotPath } = await import(REPO + "/scripts/manual/smoke-fixture/index.mts");
const fx = await bootFixture({ port: Number(process.env.HP), instances: 2, classic: false });
fx.fm.refreshSignInIdentities = () => {};
const hub = existsSync(join(REPO, "src/ui/settings-hub.js"));
const rows: any[] = [], failed: string[] = [];
const check = (key: string, ok: boolean, detail?: any) => { rows.push({ key, ok, ...(!ok ? { detail } : {}) }); if (!ok) failed.push(key); };
try {
  for (const phase of ["before", "after", "cached"]) for (const c of matrix("full")) {
    if (phase === "cached" && !(c.device === "phone" && c.theme === "dark")) continue;
    const tag = `${phase}-${caseName(c)}`, { ctx, page, csp } = await fx.page(c);
    const errors: string[] = []; page.on("pageerror", (e: any) => errors.push(String(e)));
    // tsx keeps nested callback names when serializing the browser-only fixture function.
    if (hub) await page.addInitScript("window.__name = (fn) => fn;");
    await page.route("**/api/settings/status-emojis", (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ keys: [], builtins: {}, telegram_allowed: [], suggestions: [] }) }));
    const paths = phase === "before" ? ["settings-dialogs.js", "settings-strings.js", ...(hub ? ["settings-hub.js"] : [])] : phase === "cached" ? ["settings-strings.js"] : [];
    for (const file of paths) {
      const body = execFileSync("git", ["-C", REPO, "show", `${BASE}:src/ui/${file}`], { encoding: "utf8" });
      await page.route(`**/ui/js/${file}*`, (r: any) => r.fulfill({ status: 200, contentType: "text/javascript", body }));
    }
    await page.goto(fx.base + "/settings/agents"); await page.locator(".p-settings").waitFor();
    await page.evaluate(async () => {
      const { showDialog, closeDialog } = await import("/assets/app-shell.js");
      const { BotDialog } = await import("/ui/js/settings-dialogs.js");
      const { DEFAULT_SCHEMA } = await import("/ui/js/settings-model.js");
      (window as any).__uxStages = 0;
      showDialog(BotDialog, { id: "demo", ctx: { fleet: { channels: [{ id: "demo", type: "telegram", group_id: "-1001234567890", bot_token_env: "DEMO_BOT_TOKEN", access: { mode: "pairing", allowed_users: ["42"] } }] },
        schema: DEFAULT_SCHEMA, connections: [{ id: "demo", token_present: true, identity: { username: "DemoBot" } }],
        stage() { (window as any).__uxStages++; }, stageChannels() { (window as any).__uxStages++; }, reload() {} }, onClose: closeDialog });
    });
    const select = page.locator("dialog[open] #bot-mode"); await select.waitFor({ state: "visible" });
    check(tag + ":saved-value", await select.inputValue() === "pairing");
    const label = await select.locator('option[value="pairing"]').textContent();
    check(tag + ":alias-label", label === (phase === "after" ? c.lang === "en" ? "pairing (legacy; same as locked)" : "pairing（舊版；等同 locked）" : "pairing"), label);
    check(tag + ":no-missing-key", !(await page.locator("dialog[open]").innerText()).includes("settings.legacyPairing"));
    await page.screenshot({ path: shotPath("p3-hub-polish", tag, "alias") });
    await page.locator("dialog[open]").getByRole("button", { name: c.lang === "en" ? "Done" : "完成", exact: true }).click();
    await page.locator("dialog[open]").waitFor({ state: "hidden" });
    check(tag + ":no-staged-write", await page.evaluate(() => (window as any).__uxStages) === 0);
    if (hub && phase !== "cached") {
      await page.evaluate(async () => {
        const { setHubClient } = await import("/ui/js/hub-client.js");
        const { html, render } = await import("/assets/app-html.js");
        const { HubConnectCard } = await import("/ui/js/settings-hub.js");
        const pending = { state: "pending", memberOrigin: "https://hub.example.test", fingerprint: { kind: "pairing", digest: "ab".repeat(32) }, localConfirmed: false, ownerConfirmed: null, adminApproved: null };
        let current: any = pending, listener: any;
        setHubClient({ stub: false, pairing: async () => current, subscribe(fn: any) { listener = fn; return () => { listener = null; }; },
          confirmFingerprint: async () => ({ ok: true, pendingConfirmation: true, pairing: current }), exposures: async () => [] });
        const root = document.createElement("div"); root.id = "ux-hub-root";
        (document.querySelector(".p-settings .panel-body .col") || document.querySelector(".p-settings"))!.prepend(root);
        render(html`<${HubConnectCard} />`, root);
        (window as any).__uxPaired = () => {
          current = { state: "paired", binding: "b".repeat(64), link: "online", hub: { hubId: "demo-hub", name: "Demo Hub", memberOrigin: "https://hub.example.test", webOrigin: "https://hub.example.test", fingerprint: { kind: "hub-key", digest: "cd".repeat(32) } } };
          listener(current);
        };
        (window as any).__uxHubCleanup = () => render(null, root);
      });
      await page.locator(".hub-local-confirm").waitFor({ state: "visible" }); await page.locator(".hub-local-confirm").click();
      const notice = page.locator(".s-hub-connect > p[role=status]"); await notice.waitFor({ state: "visible" });
      const waiting = await notice.innerText();
      if (phase === "after") check(tag + ":neutral-pending", waiting === (c.lang === "en" ? "Waiting for your confirmation" : "等待你的確認"), waiting);
      await page.locator("#hub-connect").scrollIntoViewIfNeeded();
      await page.screenshot({ path: shotPath("p3-hub-polish", tag, "waiting") });
      await page.evaluate(() => (window as any).__uxPaired());
      await page.locator(".hub-paired .is-online").waitFor({ state: "visible" });
      if (phase === "after") await notice.waitFor({ state: "hidden" });
      check(tag + ":settled-hint", phase === "after" ? await notice.count() === 0 : await notice.count() === 1);
      check(tag + ":connected-controls", await page.locator(".hub-paired a.btn").count() === 1 && await page.locator(".hub-paired .btn-danger").count() === 1);
      await page.screenshot({ path: shotPath("p3-hub-polish", tag, "connected") });
      await page.evaluate(() => (window as any).__uxHubCleanup());
    }
    check(tag + ":no-horizontal-overflow", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check(tag + ":no-browser-errors", errors.length === 0, errors);
    check(tag + ":no-CSP-errors", (await csp()).length === 0, await csp());
    await ctx.close();
  }
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "result.json"), JSON.stringify({ head: execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), base: BASE, browser: fx.browser.version(), hub, rows, failed }, null, 2));
  await fx.close();
}
console.log(JSON.stringify({ checks: rows.length, failed })); process.exitCode = failed.length ? 1 : 0;
