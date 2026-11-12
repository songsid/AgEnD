/** Owned real-shell PR3 geometry and retained-asset journeys. No fleet start, CLI, vendor account or host configuration. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { bootFixture } from "../smoke-fixture/index.mts";
const repo = resolve(process.env.REPO!), out = resolve(process.env.OUT!);
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const dirty = git("status", "--porcelain", "--untracked-files=no");
assert.ok(!dirty || process.env.DIAGNOSTIC_DIRTY === "1", "final evidence requires clean tracked source");
const sources = ["src/web-api.ts", "src/auth-api.ts", "src/ui/chat-workspace.js", "src/ui/chat-workspace-navigation.js", "src/ui/chat-workspace-gestures.js", "src/ui/panel-chat.js",
  "src/ui/panel-details.js", "src/ui/panel-log.js", "src/ui/settings-dialogs.js", "src/ui/native-instance-settings.js", "src/ui/agent-details-settings.js", "src/ui/chat-quote.js",
  "src/ui/agent-export-dialog.js", "src/ui/agent-runtime-settings.js", "src/ui/image-lightbox.js",
  ...["app", "app-nav", "app-shell", "app-ctx", "app-session", "app.css", "instance-switch", "instance-nav", "ui-menu", "panel-view", "view-roster-store", "preview-panel", "chat-composer", "chat-workspace-model", "chat-workspace-memory", "pane-geometry"].map(name => `src/ui/shared/${name.endsWith(".css") ? name : name + ".js"}`)];
const inputs: Record<string, string[]> = {}, assets: Record<string, string[]> = {};
const record = (map: Record<string, string[]>, path: string, body: string | Buffer) => { const values = map[hash(body)] ??= []; if (!values.includes(path)) values.push(path); };
const initial = new Map(sources.map(path => [path, hash(readFileSync(join(repo, path)))]));
for (const path of sources) { const bytes = readFileSync(join(repo, path)); record(inputs, path, bytes); if (!dirty) assert.equal(hash(bytes), hash(execFileSync("git", ["show", `HEAD:${path}`], { cwd: repo }))); }
record(inputs, "harness", readFileSync(new URL(import.meta.url)));
mkdirSync(out, { recursive: true });
const fx = await bootFixture({ port: Number(process.env.HP || 55896), instances: 3, classic: false });
const receipt: any = { head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirty: !!dirty,
  scope: "Owned scratch FleetManager; actual browser/server/session/stream; fixture terminal and step reads; no CLI or live fleet", inputs, assets, cases: [] };
const errors: string[] = [], blocked: string[] = [], jobs: Promise<unknown>[] = [];
const theme = process.env.THEME || "light";
const language = process.env.LANGUAGE || "zh-TW";
const retained = process.env.RETAIN || "", oldRef = process.env.OLD_REF || "834fb036f249f9d52acc9837bcc4c3480bd20994";
const oldFiles: Record<string, string> = { css: "src/ui/shared/app.css", shell: "src/ui/shared/app-shell.js", chat: "src/ui/panel-chat.js", fields: "src/ui/settings-dialogs.js", session: "src/ui/shared/app-session.js", context: "src/ui/shared/app-ctx.js", model: "src/ui/shared/chat-workspace-model.js", navigation: "src/ui/chat-workspace-navigation.js", sidebar: "src/ui/shared/instance-nav.js", host: "src/ui/chat-workspace.js" };
const substitutions: Record<string, string[]> = {};
const sourcePath = (path: string) => path.startsWith("/assets/") ? "src/ui/shared/" + path.slice(8) : path.startsWith("/ui/js/") ? "src/ui/" + path.slice(7) : "";
receipt.retained = retained; receipt.oldRef = oldRef; receipt.substitutions = substitutions;
const ctx = await fx.browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: theme, locale: language, hasTouch: process.env.COARSE === "1" });
const page = await ctx.newPage();
page.setDefaultTimeout(10000);
try {
  fx.fm.webPrefs.write("operator", new Map([["theme", theme], ["lang", language]]));
  await ctx.addInitScript(() => {
    localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); localStorage.setItem("agend_usage_rail", "0");
    const Native = window.EventSource; (window as any).__streams = { active: 0, max: 0 };
    window.EventSource = class extends Native {
      private ended = false;
      constructor(url: string | URL, opts?: EventSourceInit) { super(url, opts); const s = (window as any).__streams; s.active++; s.max = Math.max(s.max, s.active); }
      close() { if (!this.ended) { this.ended = true; (window as any).__streams.active--; } super.close(); }
    };
  });
  page.on("pageerror", (error: Error) => errors.push(error.message));
  page.on("response", (response: any) => { const url = new URL(response.url()); if (url.origin === fx.base && /^\/(assets|ui\/js)\//.test(url.pathname)) jobs.push(response.body().then((bytes: Buffer) => record(assets, url.pathname, bytes))); });
  await ctx.route("**/*", async (route: any) => {
    const url = new URL(route.request().url());
    if (url.origin !== fx.base) { blocked.push(url.origin); return route.abort(); }
    if (retained === "server" && route.request().isNavigationRequest()) {
      const response = await route.fetch(), body = (await response.text()).replace(/ data-chat-(?:workspace|layout-scope)="[^"]*"/g, "");
      record(substitutions, "older-server-without-display-mark.html", body); return route.fulfill({ response, body });
    }
    const path = sourcePath(url.pathname);
    if (retained && (retained === "css-old-app" ? ["src/ui/shared/app.css", "src/ui/shared/app.js"].includes(path)
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
  const passage = "先比較兩邊的結果，再決定下一步。";
  for (const name of [a, b]) fx.fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text: passage + "\n\n這份範例只使用隔離的測試資料，不會傳送訊息。", ts: "2026-11-11T08:00:00.000Z" });
  await page.getByText(passage, { exact: false }).first().waitFor();
  async function shot(label: string, panes: number) {
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
    const geometry = await page.evaluate(() => ({ headers: document.querySelectorAll("#main .panel-head").length,
      textTools: document.querySelectorAll("#main .hd-text").length, overflow: document.documentElement.scrollWidth > innerWidth,
      streams: (window as any).__streams, layout: document.querySelector(".chat-workspace")?.getAttribute("data-layout"),
      geometryControls: [...document.querySelectorAll('.ws-sash, .ws-float-resize')].map(el => { const r = el.getBoundingClientRect(); return { coarse: matchMedia('(pointer: coarse)').matches, width: r.width, height: r.height }; }),
      workspace: (() => { const r = document.querySelector(".chat-workspace")?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height] : null; })(),
      panes: [...document.querySelectorAll(".ws-pane")].map(el => { const r = el.getBoundingClientRect(); return { id: el.getAttribute("data-pane"), box: [r.x, r.y, r.width, r.height],
        headerOverflow: (el.querySelector('.panel-head')?.scrollWidth || 0) > (el.querySelector('.panel-head')?.clientWidth || 0),
        statusInside: [...el.querySelectorAll('.ws-pane-head .panel-sub .status')].every(status => { const r = status.getBoundingClientRect(), parent = status.parentElement!.getBoundingClientRect(); return getComputedStyle(status).fontSize === '0px' || (r.left >= parent.left - 1 && r.right <= parent.right + 1); }),
        actionsInside: [...el.querySelectorAll('.ws-pane-head .panel-actions > button, .ws-pane-head .panel-actions > .menu > button')].every(button => { const z = button.getBoundingClientRect(); return z.left >= r.left && z.right <= r.right && (!matchMedia('(pointer: coarse)').matches || (z.width >= 44 && z.height >= 44)); }),
        titles: [...el.querySelectorAll("h1, .panel-title, .panel-head")].map((node: any) => ({ kind: node.tagName + "." + node.className, text: node.textContent, scroll: node.scrollLeft, box: [node.getBoundingClientRect().x, node.getBoundingClientRect().width], sw: node.scrollWidth })),
        tabs: [...el.querySelectorAll(".inst-switch a")].map(a => a.textContent) }; }) }));
    assert.equal(geometry.headers, panes); assert.equal(geometry.textTools, 1); assert.equal(geometry.overflow, false);
    assert.equal(geometry.streams.active, 1); assert.equal(geometry.streams.max, 1); assert.equal(fx.fm.sseClients.size, 1);
    for (const control of geometry.geometryControls) if (control.coarse) assert.ok(control.width >= 44 && control.height >= 44, JSON.stringify(control));
    for (const pane of geometry.panes) { assert.equal(pane.headerOverflow, false, JSON.stringify(pane)); assert.equal(pane.actionsInside, true, JSON.stringify(pane)); assert.equal(pane.statusInside, true, JSON.stringify(pane)); }
    const file = `${theme}-${language}-${label}.png`; await page.screenshot({ path: join(out, file) }); receipt.cases.push({ label, file, geometry });
  }
  await shot("single", 1);
  await page.locator("#msgIn").fill("尚未送出的草稿");
  const settle = async () => page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  const topology = () => page.evaluate(async () => { const { navStore } = await import("/assets/app-nav.js"); return navStore.get().workspace; });
  const menu = async (id: string, label: string) => {
    await page.locator(`[data-pane="${id}"] .ws-pane-head .menu > button`).click();
    const words: Record<string, string> = { "自訂移動": "Free floating pane", "左右排列": "Side by side", "上下排列": "Top and bottom", "移動浮窗": "Move floating pane", "調整浮窗大小": "Resize floating pane" };
    await page.getByRole(["自訂移動", "左右排列", "上下排列"].includes(label) ? "menuitemradio" : "menuitem", { name: language === "en" ? words[label] : label, exact: true }).click(); await settle();
  };
  const box = async (selector: string) => { const r = await page.locator(selector).boundingBox(); assert.ok(r, selector); return r; };
  const within = async () => {
    const r = await box(".chat-workspace"), f = await box(".ws-floating");
    assert.ok(f.x >= r.x - 1 && f.y >= r.y - 1 && f.x + f.width <= r.x + r.width + 1 && f.y + f.height <= r.y + r.height + 1, JSON.stringify({ r, f }));
    assert.ok(f.width >= 420 && f.height >= 360); return f;
  };
  if (["css", "css-old-app", "model", "navigation", "server"].includes(retained)) {
    if (!["css", "server", "model"].includes(retained)) {
      await page.evaluate(async (name: string) => { const { appStore } = await import("/assets/app-store.js"); await appStore.get().chatWorkspace?.open(name); }, b);
      await page.getByText("未能載入分割對話。目前對話不變；請重新整理頁面再試。", { exact: true }).waitFor();
    }
    assert.equal(await page.locator(".chat-workspace").count(), 0); assert.equal(await page.locator("#msgIn").inputValue(), "尚未送出的草稿");
    await shot(`retained-${retained}`, 1);
  } else {
    if (retained) {
      await page.evaluate(async (name: string) => { const { appStore } = await import("/assets/app-store.js"); await appStore.get().chatWorkspace?.open(name); }, b);
    } else {
      // The browser's native drag starts on the existing sidebar row; no synthetic DataTransfer or alternative route.
      const main = await box("#main");
      await page.locator(`.v-li a.inst[href="/ui/chat/${encodeURIComponent(b)}"]`).first().dragTo(page.locator("#main"), { targetPosition: { x: main.width - 20, y: main.height / 3 } });
    }
    await page.locator(".ws-pane-head").nth(1).waitFor();
    assert.equal(await page.locator("#pane-a-msgIn").inputValue(), "尚未送出的草稿");
    await page.locator("#pane-b-msgIn").fill("另一格的草稿"); await shot(retained ? `retained-${retained}` : "right", 2);
    if (!retained) {
      // Keyed composers, not just serialized drafts, survive physical DOM movement.
      await page.evaluate(() => { (window as any).__originalComposers = [...document.querySelectorAll('.composer-box textarea')]; });
      const draftCheck = async () => {
        assert.equal(await page.locator("#pane-a-msgIn").inputValue(), "尚未送出的草稿"); assert.equal(await page.locator("#pane-b-msgIn").inputValue(), "另一格的草稿");
        assert.equal(await page.evaluate(() => (window as any).__originalComposers.every((el: Element) => el.isConnected)), true);
        assert.equal(await page.locator('[data-pane="a"] .file-chip').count(), 1); assert.equal(await page.locator('[data-pane="b"] .file-chip').count(), 0);
      };
      await page.locator('[data-pane="a"] input[type=file]').setInputFiles({ name: 'owned-a.txt', mimeType: 'text/plain', buffer: Buffer.from('owned fixture only') });
      const sash = page.locator(".ws-sash"), equal = (await box('[data-pane="a"]')).width;
      await sash.focus(); await page.keyboard.press("ArrowRight"); await settle(); assert.equal(Math.round((await box('[data-pane="a"]')).width - equal), 16);
      await page.keyboard.press("Shift+ArrowRight"); await settle(); assert.equal(Math.round((await box('[data-pane="a"]')).width - equal), 80);
      await shot("sash-keyboard", 2);
      await page.keyboard.press("Home"); await settle(); assert.equal(Math.round((await box('[data-pane="a"]')).width), 360); await shot("minimum-pane", 2);
      await sash.dblclick(); await settle(); assert.ok(Math.abs((await box('[data-pane="a"]')).width - (await box('[data-pane="b"]')).width) <= 1);
      let sr = await box(".ws-sash"); await page.mouse.move(sr.x + sr.width / 2, sr.y + sr.height / 2); await page.mouse.down(); await page.mouse.move(sr.x + sr.width / 2 + 110, sr.y + sr.height / 2, { steps: 6 });
      assert.ok((await box('[data-pane="a"]')).width > equal + 90); await page.keyboard.press("Escape"); await page.mouse.up(); await settle();
      assert.ok(Math.abs((await box('[data-pane="a"]')).width - equal) <= 1); await draftCheck(); await shot("sash-cancel", 2);
      sr = await box(".ws-sash"); await page.mouse.move(sr.x + sr.width / 2, sr.y + sr.height / 2); await page.mouse.down(); await page.mouse.move(sr.x + sr.width / 2 + 104, sr.y + sr.height / 2, { steps: 6 }); await page.mouse.up(); await settle();
      assert.ok((await box('[data-pane="a"]')).width > equal + 90); await shot("sash-drag", 2); await sash.dblclick();
      await page.setViewportSize({ width: 5120, height: 1000 }); await settle(); await sash.focus(); await page.keyboard.press("Home"); await settle();
      assert.equal(Math.round((await box('[data-pane="a"]')).width), 360); await shot("ultrawide-minimum", 2);
      await page.setViewportSize({ width: 1600, height: 1000 }); await settle(); await sash.dblclick();
      // Header native drag pauses over a real target so its blue preview can be measured before release.
      const root = await box(".chat-workspace"), bh = await box('[data-pane="b"] .ws-pane-head'), ar = await box('[data-pane="a"]');
      await page.mouse.move(bh.x + 30, bh.y + 18); await page.mouse.down(); await page.mouse.move(ar.x + ar.width / 2, ar.y + 12, { steps: 12 }); await page.mouse.move(ar.x + ar.width / 2 + 1, ar.y + 12);
      await page.locator('.ws-drop-target[data-zone="top"]').waitFor();
      const preview = await box(".ws-drop-target"); assert.ok(Math.abs(preview.height - ar.height / 2) <= 1); assert.ok(Math.abs(preview.width - ar.width) <= 1);
      await shot("header-drop-preview", 2); await page.mouse.up(); await page.waitForFunction(() => document.querySelector('.chat-workspace')?.getAttribute('data-layout') === 'stack');
      await draftCheck(); await shot("stacked", 2);
      await menu("b", "自訂移動"); await page.locator('.ws-floating[data-pane="b"]').waitFor();
      const initialFloat = await within(); assert.equal(Math.round(initialFloat.width), 560); assert.equal(Math.round(initialFloat.height), 460); await draftCheck(); await shot("float", 2);
      await page.locator('[data-pane="b"] .ws-pane-head .menu > button').click();
      const layoutMenu = page.locator('[data-pane="b"] .ws-pane-head > .panel-actions > .menu > .menu-list');
      const menuBox = await layoutMenu.boundingBox(); assert.ok(menuBox && menuBox.y + menuBox.height <= initialFloat.y + initialFloat.height, 'the floating menu must stay inside its pane');
      await layoutMenu.locator('button').last().scrollIntoViewIfNeeded(); await shot("float-menu", 2); await page.keyboard.press("Escape");
      let fh = await box('.ws-floating .ws-pane-head'); await page.mouse.move(fh.x + 30, fh.y + 18); await page.mouse.down(); await page.mouse.move(fh.x - 120, fh.y - 50, { steps: 8 }); await page.mouse.up(); await settle();
      const moved = await within(); assert.ok(moved.x < initialFloat.x - 100); await draftCheck(); await shot("float-moved", 2);
      const corner = await box(".ws-float-resize"); await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2); await page.mouse.down(); await page.mouse.move(corner.x + 80, corner.y + 70, { steps: 8 }); await page.mouse.up(); await settle();
      const resized = await within(); assert.ok(resized.width > moved.width + 50 && resized.height > moved.height + 40); await shot("float-resized", 2);
      await menu("b", "移動浮窗"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("Shift+ArrowUp");
      await shot("float-keyboard-preview", 2); await page.keyboard.press("Escape"); await settle(); assert.deepEqual(await within(), resized);
      await menu("b", "調整浮窗大小"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); await settle(); assert.ok((await within()).height > resized.height); await draftCheck();
      await shot("float-keyboard-applied", 2);
      await page.evaluate(async (name: string) => { const { store } = await import('/ui/js/panel-chat.js'); store.removeFile(name, 0); }, a);
      const saved = page.url(); await page.reload(); await page.locator(".ws-floating").waitFor(); await within(); await shot("float-reload", 2);
      assert.match(saved, /layout=float/); assert.doesNotMatch(saved, /token|draft|password/);
      fh = await box('.ws-floating .ws-pane-head'); const bounds = await box('.chat-workspace');
      await page.mouse.move(fh.x + 30, fh.y + 18); await page.mouse.down(); await page.mouse.move(bounds.x + 8, bounds.y + bounds.height / 2, { steps: 12 });
      await page.locator('.ws-drop-target[data-zone="left"]').waitFor(); await shot("float-dock-preview", 2); await page.mouse.up();
      await page.waitForFunction(() => document.querySelector('.chat-workspace')?.getAttribute('data-layout') === 'right'); await shot("float-docked", 2);
      const center = await box('[data-pane="a"]');
      await page.locator('[data-pane="b"] .ws-pane-head').dragTo(page.locator('[data-pane="a"]'), { sourcePosition: { x: 30, y: 18 }, targetPosition: { x: center.width / 2, y: center.height / 2 } });
      await settle(); assert.equal((await topology()).flipped, false); await shot("center-swap", 2);
      // Geometry fallback does not invent a third mounted pane or a phone layout.
      await page.setViewportSize({ width: 1100, height: 900 }); await page.locator('.ws-agent-tabs').waitFor(); await shot("narrow", 1);
      await page.setViewportSize({ width: 390, height: 844 }); await shot("phone", 1);
      receipt.gestures = { nativeSidebar: true, nativeHeader: true, halfPreview: true, pointerSash: true, keyboardSash: true, escapeRestores: true,
        floatMoveResize: true, floatKeyboard: true, boundedReload: true, centerSwap: true, composerDOMRetainedBeforeReload: true, popup: "not in PR3" };
    } else if (["host", "js", "all"].includes(retained)) {
      assert.equal(await page.locator('.ws-geometry').count(), 0); assert.equal(await page.locator('.ws-sash').count(), 0);
      assert.ok(Math.abs((await box('[data-pane="a"]')).width - (await box('[data-pane="b"]')).width) <= 1);
      await page.goto(fx.base + `/ui/chat/${encodeURIComponent(a)}?compare=${encodeURIComponent(b)}&layout=float&floatPane=b`);
      await page.locator('#msgIn').waitFor(); assert.equal(await page.locator('.chat-workspace').count(), 0); await shot(`retained-${retained}-float-refused`, 1);
    } else if (retained === "sidebar") { assert.equal(await page.locator('.ws-sash').count(), 1); }
  }
  await Promise.all(jobs); assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
  for (const [path, digest] of initial) assert.equal(hash(readFileSync(join(repo, path))), digest, `source changed during capture: ${path}`);
  assert.equal(git("rev-parse", "HEAD"), receipt.head);
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ head: receipt.head, dirty: receipt.dirty, cases: receipt.cases.length, oneStream: true, errors, externalRequests: blocked.length }));
} catch (error) {
  await page.screenshot({ path: join(out, "diagnostic.png") }).catch(() => {});
  writeFileSync(join(out, "diagnostic.json"), JSON.stringify({ errors, blocked, url: page.url(), body: await page.locator("body").innerText() }, null, 2));
  throw error;
} finally { await ctx.close(); await fx.close(); }
