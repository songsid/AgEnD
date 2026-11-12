/** Owned real-shell PR4 real-window handoff and retained-asset journeys. No fleet start, CLI, vendor account or host configuration. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadavg } from "node:os";
import { bootFixture } from "../smoke-fixture/index.mts";
const repo = resolve(process.env.REPO!), out = resolve(process.env.OUT!);
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const dirty = git("status", "--porcelain", "--untracked-files=no");
assert.ok(!dirty || process.env.DIAGNOSTIC_DIRTY === "1", "final evidence requires clean tracked source");
const sources = ["src/web-api.ts", "src/auth-api.ts", "src/ui/chat-workspace.js", "src/ui/chat-workspace-navigation.js", "src/ui/chat-workspace-gestures.js", "src/ui/panel-chat.js", "src/ui/chat-store.js", "src/ui/chat-popout.js", "src/ui/chat-popout-header.js", "src/ui/chat-popout-transport.js",
  "src/ui/panel-details.js", "src/ui/panel-log.js", "src/ui/settings-dialogs.js", "src/ui/native-instance-settings.js", "src/ui/agent-details-settings.js", "src/ui/chat-quote.js",
  "src/ui/agent-export-dialog.js", "src/ui/agent-runtime-settings.js", "src/ui/image-lightbox.js",
  ...["app", "app-nav", "app-shell", "app-ctx", "app-session", "app.css", "instance-switch", "instance-nav", "ui-menu", "panel-view", "view-roster-store", "preview-panel", "chat-composer", "chat-workspace-model", "chat-workspace-memory", "pane-geometry"].map(name => `src/ui/shared/${name.endsWith(".css") ? name : name + ".js"}`)];
const inputs: Record<string, string[]> = {}, assets: Record<string, string[]> = {};
const record = (map: Record<string, string[]>, path: string, body: string | Buffer) => { const values = map[hash(body)] ??= []; if (!values.includes(path)) values.push(path); };
sources.push("scripts/manual/smoke-fixture/index.mts", "scripts/manual/smoke-fixture/data.mts", "scripts/manual/smoke-fixture/from-defaults.mts");
const initial = new Map(sources.map(path => [path, hash(readFileSync(join(repo, path)))]));
for (const path of sources) { const bytes = readFileSync(join(repo, path)); record(inputs, path, bytes); if (!dirty) assert.equal(hash(bytes), hash(execFileSync("git", ["show", `HEAD:${path}`], { cwd: repo }))); }
record(inputs, "harness", readFileSync(new URL(import.meta.url)));
mkdirSync(out, { recursive: true });
const fx = await bootFixture({ port: Number(process.env.HP || 55896), instances: 3, classic: false });
const receipt: any = { head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirty: !!dirty,
  scope: "Owned scratch FleetManager; actual browser/server/session/stream; fixture terminal and step reads; no CLI or live fleet", inputs, assets, cases: [] };
const errors: string[] = [], blocked: string[] = [], effects: string[] = [], jobs: Promise<unknown>[] = [];
const theme = process.env.THEME || "light";
const language = process.env.LANGUAGE || "zh-TW";
const retained = process.env.RETAIN || "", oldRef = process.env.OLD_REF || "73c338516002d7be511948ed4c729b3f7255aa80";
const scenario = process.env.CASE || "current";
let releaseChild: (() => void) | null = null;
const childGate = new Promise<void>(resolve => { releaseChild = resolve; });
const oldFiles: Record<string, string> = { css: "src/ui/shared/app.css", shell: "src/ui/shared/app-shell.js", chat: "src/ui/panel-chat.js", fields: "src/ui/settings-dialogs.js", session: "src/ui/shared/app-session.js", context: "src/ui/shared/app-ctx.js", model: "src/ui/shared/chat-workspace-model.js", navigation: "src/ui/chat-workspace-navigation.js", sidebar: "src/ui/shared/instance-nav.js", host: "src/ui/chat-workspace.js" };
const substitutions: Record<string, string[]> = {};
const sourcePath = (path: string) => path.startsWith("/assets/") ? "src/ui/shared/" + path.slice(8) : path.startsWith("/ui/js/") ? "src/ui/" + path.slice(7) : "";
receipt.retained = retained; receipt.oldRef = oldRef; receipt.substitutions = substitutions;
const ctx = await fx.browser.newContext({ viewport: process.env.SCREEN === "phone" ? { width: 390, height: 844 } : { width: 1600, height: 1000 }, colorScheme: theme, locale: language, hasTouch: process.env.COARSE === "1" });
const watch = (tab: any) => {
  tab.setDefaultTimeout(10000);
  tab.on("pageerror", (error: Error) => errors.push(error.message));
  tab.on("response", (response: any) => { const url = new URL(response.url()); if (url.origin === fx.base && /^\/(assets|ui\/js)\//.test(url.pathname)) jobs.push(response.body().then((bytes: Buffer) => record(assets, url.pathname, bytes)).catch(() => { (receipt.omittedAssets ||= []).push(url.pathname); })); });
};
ctx.on("page", watch);
ctx.on("request", (request: any) => { const url = new URL(request.url()); if (/\/(send|command|upload|answer)/.test(url.pathname) && request.method() !== "GET") effects.push(url.pathname); });
const page = await ctx.newPage();
page.setDefaultTimeout(10000);
try {
  fx.fm.webPrefs.write("operator", new Map([["theme", theme], ["lang", language]]));
  await ctx.addInitScript(() => {
    const nativeFetch = window.fetch; (window as any).__popoutWrites = [];
    window.fetch = function(input: RequestInfo | URL, init?: RequestInit) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (/\/(send|command|upload|answer)/.test(url.pathname) && (init?.method || (input instanceof Request ? input.method : "GET")) !== "GET") (window as any).__popoutWrites.push(url.pathname);
      return nativeFetch.call(this, input, init);
    };
    localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); localStorage.setItem("agend_usage_rail", "0");
    const Native = window.EventSource; (window as any).__streams = { active: 0, max: 0 };
    window.EventSource = class extends Native {
      private ended = false;
      constructor(url: string | URL, opts?: EventSourceInit) { super(url, opts); const s = (window as any).__streams; s.active++; s.max = Math.max(s.max, s.active); }
      close() { if (!this.ended) { this.ended = true; (window as any).__streams.active--; } super.close(); }
    };
  });
  await ctx.route("**/*", async (route: any) => {
    const url = new URL(route.request().url());
    if (url.origin !== fx.base) { blocked.push(url.origin); return route.abort(); }
    if (retained === "server" && route.request().isNavigationRequest()) {
      const response = await route.fetch(), body = (await response.text()).replace(/ data-chat-(?:workspace|layout-scope)="[^"]*"/g, "");
      record(substitutions, "older-server-without-display-mark.html", body); return route.fulfill({ response, body });
    }
    const path = sourcePath(url.pathname);
    let isChild = url.searchParams.get("presentation") === "popout";
    try { isChild ||= route.request().frame().page() !== page; } catch { assert.ok(route.request().isNavigationRequest()); let prior = route.request().redirectedFrom(); while (prior) { isChild ||= new URL(prior.url()).searchParams.get("presentation") === "popout"; prior = prior.redirectedFrom(); } }

    if (isChild && scenario === "auth") {
      // Browser-managed Cookie cannot be overridden by route.continue; issue an actual no-cookie server read.
      const response = await route.fetch({ headers: { ...route.request().headers(), cookie: "" }, maxRedirects: 0 });
      if (route.request().isNavigationRequest()) receipt.cases.push({ label: "unauthenticated-child-navigation", path: url.pathname, status: response.status() });
      return route.fulfill({ response });
    }
    if (isChild && scenario === "changed" && url.pathname === "/ui/js/chat-popout.js") await childGate;
    const childControls: Record<string, string[]> = { "child-css": ["src/ui/shared/app.css"], "child-app": ["src/ui/shared/app.js"], "child-shell": ["src/ui/shared/app-shell.js"], "child-chat": ["src/ui/panel-chat.js"], "parent-store": ["src/ui/chat-store.js"] };
    if (childControls[retained]?.includes(path) && (isChild || retained === "parent-store")) {
      const bytes = execFileSync("git", ["show", `${oldRef}:${path}`], { cwd: repo }); record(substitutions, path, bytes);
      return route.fulfill({ body: bytes, contentType: path.endsWith(".css") ? "text/css" : "text/javascript" });
    }

    if (retained === "all" && (retained === "css-old-app" ? ["src/ui/shared/app.css", "src/ui/shared/app.js"].includes(path)
      : (retained === "all" || retained === "js") ? sources.includes(path) && (retained !== "js" || path.endsWith(".js")) : path === oldFiles[retained])) {
      try { const bytes = execFileSync("git", ["show", `${oldRef}:${path}`], { cwd: repo }); record(substitutions, path, bytes);
        return route.fulfill({ body: bytes, contentType: path.endsWith(".css") ? "text/css" : "text/javascript" });
      } catch { /* new optional modules do not exist on the control head */ }
    }
    if (url.pathname.startsWith("/api/pane/")) return route.fulfill({ body: "owned@fixture $\nReady.\n", headers: { "Content-Type": "text/plain", "X-Pane-Cols": "96", "X-Pane-Rows": "24" } });
    if (url.pathname === "/ui/steps") return route.fulfill({ json: { enabled: true, supported: true, backend: "codex", steps: [], events: [], key: "owned-fixture", after: null, before: null } });
    return route.continue();
  });
  fx.fm.initializeWebSessions();
  const { tokenEpoch } = await import(repo + "/src/web-session.ts");
  const code = fx.fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fx.fm.webToken) }).display;
  await page.goto(fx.base + "/signin"); await page.locator("#code").waitFor();
  await page.locator("#code").evaluate((input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); input.form!.requestSubmit(); }, code);
  await page.waitForURL(fx.base + "/ui");
  const a = fx.instances[1].name, b = fx.instances[2].name;
  await page.evaluate(async (name: string) => { const nav = await import("/assets/app-nav.js"); nav.navigate(`/ui/chat/${encodeURIComponent(name)}`); }, a);
  await page.locator("#msgIn").waitFor();
  await page.waitForFunction(() => (window as any).__streams?.active === 1);

  const check = (label: string, value: unknown) => receipt.cases.push({ label, value });
  const waitFrames = (tab: any) => tab.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  async function shot(tab: any, label: string, panes: number) {
    await waitFrames(tab);
    const geometry = await tab.evaluate(() => ({ headers: document.querySelectorAll("#main .panel-head").length,
      overflow: document.documentElement.scrollWidth > innerWidth, popout: !!document.querySelector(".shell.chat-popout"),
      sidebar: !!document.querySelector("#sidebar"), streams: (window as any).__streams,
      controls: document.querySelectorAll("#main .hd-text").length,
      headerOverflow: [...document.querySelectorAll("#main .panel-head")].some(el => el.scrollWidth > el.clientWidth),
      touch: [...document.querySelectorAll('.popup-pane-head button, .popup-pane-head .seg-item')].map(el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, coarse: matchMedia('(pointer: coarse)').matches }; }).filter(r => r.width && r.height),
      composerClipped: [...document.querySelectorAll('.composer-box textarea')].some((el: any) => el.value && el.clientHeight < 238 && el.scrollHeight > el.clientHeight + 2),
      oneRow: [...document.querySelectorAll(".popup-pane-head")].every(el => { const title = el.querySelector(".panel-title")!.getBoundingClientRect(), tabs = el.querySelector(".inst-switch")!.getBoundingClientRect(), actions = el.querySelector(".panel-actions")!.getBoundingClientRect(); return Math.abs(title.top + title.height / 2 - tabs.top - tabs.height / 2) < 2 && Math.abs(actions.top + actions.height / 2 - tabs.top - tabs.height / 2) < 2; }),
      panes: [...document.querySelectorAll(".ws-pane")].map(el => { const r = el.getBoundingClientRect(); return { id: el.getAttribute("data-pane"), rect: [r.x, r.y, r.width, r.height], tabs: [...el.querySelectorAll(".inst-switch a")].map(a => a.textContent) }; }) }));
    assert.equal(geometry.headers, panes); assert.equal(geometry.controls, 1); assert.equal(geometry.overflow, false); assert.equal(geometry.headerOverflow, false); assert.equal(geometry.oneRow, true); assert.equal(geometry.composerClipped, false);
    for (const r of geometry.touch) if (r.coarse) assert.ok(r.width >= 44 && r.height >= 44, JSON.stringify(r));
    assert.equal(geometry.streams.active, 1); assert.equal(geometry.streams.max, 1);
    const file = `${theme}-${language}-${label}.png`; await tab.screenshot({ path: join(out, file) }); receipt.cases.push({ label, file, geometry });
  }
  await shot(page, "single-before", 1);
  if (retained === "all" || scenario === "single") { check("baseline", "exact PR3 UI assets on current fixture server"); }
  else {
    await page.evaluate(async (name: string) => { const { appStore } = await import("/assets/app-store.js"); await appStore.get().chatWorkspace?.open(name); }, b);
    await page.locator("#pane-b-msgIn").waitFor(); await page.locator("#pane-b-msgIn").fill("這份草稿移到獨立視窗，還沒有送出。");
    await page.locator('[data-pane="b"] input[type=file]').setInputFiles({ name: "owned-window.txt", mimeType: "text/plain", buffer: Buffer.from("owned draft attachment") });
    const menu = async (id: string, label: string) => {
      const en: Record<string, string> = { "左右排列": "Side by side", "上下排列": "Top and bottom", "自訂移動": "Free floating pane" };
      await page.locator(`[data-pane="${id}"] .ws-pane-head .menu > button`).click();
      await page.getByRole("menuitemradio", { name: language === "en" ? en[label] : label, exact: true }).click(); await waitFrames(page);
    };
    await shot(page, "right", 2);
    if (scenario === "current" && !retained) {
      await page.locator('[data-pane="a"] .inst-switch a').filter({ hasText: language === "en" ? "Log" : "紀錄" }).click(); await shot(page, "log", 2);
      await page.locator('[data-pane="a"] .inst-switch a').filter({ hasText: language === "en" ? "Chat" : "聊天" }).click();
      const sash = page.locator(".ws-sash"), start = await sash.boundingBox(); assert.ok(start);
      await sash.focus(); await page.keyboard.press("ArrowRight"); await shot(page, "sash-keyboard", 2); await page.keyboard.press("Home"); await shot(page, "narrow360", 2); await sash.dblclick();
      await menu("b", "上下排列"); await shot(page, "stacked", 2);
      await menu("b", "左右排列");
      const header = await page.locator('[data-pane="b"] h1').boundingBox(), target = await page.locator('[data-pane="a"]').boundingBox(); assert.ok(header && target);
      await page.mouse.move(header.x + 10, header.y + 10); await page.mouse.down(); await page.mouse.move(target.x + target.width - 10, target.y + target.height / 2, { steps: 12 });
      await page.locator('.ws-drop-target').waitFor(); await shot(page, "drag-edge-preview", 2); await page.keyboard.press("Escape"); await page.mouse.up();
      assert.equal(await page.locator('.ws-drop-target').count(), 0);
      await menu("b", "自訂移動"); await shot(page, "float", 2);
      const head = await page.locator('.ws-floating .ws-pane-head').boundingBox(); assert.ok(head);
      await page.mouse.move(head.x + 25, head.y + 18); await page.mouse.down(); await page.mouse.move(head.x - 80, head.y - 25, { steps: 8 }); await page.mouse.up();
      const corner = await page.locator('.ws-float-resize').boundingBox(); assert.ok(corner);
      await page.mouse.move(corner.x + 5, corner.y + 5); await page.mouse.down(); await page.mouse.move(corner.x + 60, corner.y + 50, { steps: 8 }); await page.mouse.up(); await shot(page, "float-move-resize", 2);
      await menu("b", "左右排列");
    }
    const label = language === "zh-TW" ? "彈出成獨立視窗" : "Pop out into a separate window";
    await page.locator('[data-pane="b"] .ws-pane-head .menu > button').click();
    if (retained === "parent-store") { assert.equal(await page.getByRole("menuitem", { name: label, exact: true }).count(), 0); await shot(page, "retained-parent-store", 2); }
    else {
      assert.equal(await page.getByRole("menuitem", { name: language === "en" ? "Split chat" : "分割對話", exact: true }).count(), 1);
      await shot(page, "layout-menu", 2);
      if (scenario === "blocked") await page.evaluate(() => { window.open = () => null; });
      const pendingPopup = scenario === "blocked" ? null : ctx.waitForEvent("page");
      await page.getByRole("menuitem", { name: label, exact: true }).click();
      if (scenario === "blocked") {
        await page.getByText(language === "zh-TW" ? "瀏覽器封鎖了新視窗。請允許這個網站開啟彈出視窗，再試一次。目前窗格與草稿不變。" : "Your browser blocked the window. Allow pop-ups for this site, then try again. This pane and draft are unchanged.", { exact: true }).waitFor();
        assert.equal(ctx.pages().length, 1); assert.equal(await page.locator("#pane-b-msgIn").inputValue(), "這份草稿移到獨立視窗，還沒有送出。"); await shot(page, "blocked-keeps-source", 2);
      } else {
        const child = await pendingPopup!;
        if (scenario === "changed") { await page.locator("#pane-b-msgIn").fill("載入期間繼續輸入，留在原本窗格。"); releaseChild!(); }
        await child.waitForLoadState("domcontentloaded"); await child.setViewportSize({ width: 760, height: 800 });
        assert.equal(new URL(child.url()).origin, fx.base); assert.ok(!/token|draft|nonce|session/.test(new URL(child.url()).search));
        if (!["current", "cycles"].includes(scenario) || retained) {
          await page.getByText(language === "zh-TW" ? "未能完成移交，原本的窗格與草稿已保留。請先查看新視窗，再試一次。" : "The handoff was not completed. Your original pane and draft have been kept. Check the new window before trying again.", { exact: true }).waitFor({ timeout: 18_000 });
          assert.equal(await page.locator(".ws-pane").count(), 2); assert.equal(await page.locator('[data-pane="b"] .file-chip').count(), 1);
          assert.equal(await page.locator("#pane-b-msgIn").inputValue(), scenario === "changed" ? "載入期間繼續輸入，留在原本窗格。" : "這份草稿移到獨立視窗，還沒有送出。");
          await shot(page, `${scenario || retained}-keeps-source`, 2);
          if (scenario === "auth") {
            assert.ok(receipt.cases.some((c: any) => c.label === "unauthenticated-child-navigation" && c.status === 401));
            assert.equal(await child.locator('.composer-box textarea').count(), 0);
          }
          check("retained-exit", { scenario, retained, childPath: new URL(child.url()).pathname });
        } else {
          await page.locator("#msgIn").waitFor(); await child.locator("#msgIn").waitFor();
          assert.equal(await child.locator("#msgIn").inputValue(), "這份草稿移到獨立視窗，還沒有送出。"); assert.equal(await child.locator(".file-chip").count(), 1);
          const bytes = await child.evaluate(async (name: string) => { const { store } = await import("/ui/js/panel-chat.js"); return await store.state.pendingFiles[name][0].text(); }, b); assert.equal(bytes, "owned draft attachment");
          assert.equal(await child.evaluate(() => window.opener === null), true); assert.equal(await child.locator('.shell.chat-popout').count(), 1); assert.equal(await child.locator('#sidebar').count(), 0);
          assert.equal(await page.evaluate(async (name: string) => { const { store } = await import("/ui/js/panel-chat.js"); return store.state.drafts[name]; }, b), "");
          assert.equal(fx.fm.sseClients.size, 2); await shot(page, "popout-main", 1); await shot(child, "popout-window", 1);
          await child.setViewportSize({ width: 360, height: 800 }); await waitFrames(child); await shot(child, "popout-narrow360", 1);
          assert.equal(await child.locator('.inst-switch a').count(), 1);
          await child.setViewportSize({ width: 760, height: 800 }); await waitFrames(child);
          await child.locator('.inst-switch a').filter({ hasText: language === "en" ? "Log" : "紀錄" }).click(); await shot(child, "popout-log", 1); assert.ok(new URL(child.url()).searchParams.get("presentation") === "popout");
          await child.locator('.inst-switch a').filter({ hasText: language === "en" ? "Chat" : "聊天" }).click(); assert.equal(await child.locator("#msgIn").inputValue(), "這份草稿移到獨立視窗，還沒有送出。");
          await child.reload(); await child.locator("#msgIn").waitFor(); assert.equal(ctx.pages().length, 2); await shot(child, "popout-reload", 1);
          check("independent-windows", { oneStreamPerDocument: true, cookieSignInReused: true, draftAndFileMoved: true, noSend: true });
        }
        await child.close();
        if (scenario === "cycles") {
          for (let n = 1; n < 50; n++) {
            assert.ok(loadavg()[0] <= 12, "PAUSED: host load exceeds leader's campaign limit");
            await page.evaluate(async (name: string) => { const { appStore } = await import("/assets/app-store.js"); await appStore.get().chatWorkspace.open(name); }, b);
            await page.locator("#pane-b-msgIn").waitFor();
            await page.locator('[data-pane="b"] .ws-pane-head .menu > button').click();
            const opened = ctx.waitForEvent("page"); await page.getByRole("menuitem", { name: label, exact: true }).click(); const next = await opened;
            await page.locator("#msgIn").waitFor(); await next.locator("#msgIn").waitFor();
            assert.equal(await next.evaluate(() => window.opener === null), true); await next.close();
            const end = Date.now() + 5000; while (fx.fm.sseClients.size !== 1 && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal(fx.fm.sseClients.size, 1); assert.equal(ctx.pages().length, 1);
          }
          check("50-window-close-reopen", { cycles: 50, sseClientsAfterEveryClose: 1, remainingPages: 1 });
        }
        await page.waitForFunction(() => (window as any).__streams.active === 1);
      }
    }
    const writes = await page.evaluate(() => (window as any).__popoutWrites || []); assert.deepEqual(writes, []);
  }
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []); assert.deepEqual(effects, []);
  receipt.effects = effects; receipt.errors = errors; receipt.external = blocked; receipt.scenario = scenario;
} finally {
  receipt.finalPages = ctx.pages().map((tab: any) => new URL(tab.url()).pathname);
  releaseChild!(); await ctx.close(); await fx.close(); await Promise.allSettled(jobs);
  for (const path of sources) assert.equal(hash(readFileSync(join(repo, path))), initial.get(path), "source changed during capture");
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
}
