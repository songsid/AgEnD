/** Owned real-shell PR2 journeys. No fleet start, CLI, vendor account or host configuration. */
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
const sources = ["src/web-api.ts", "src/auth-api.ts", "src/ui/chat-workspace.js", "src/ui/chat-workspace-navigation.js", "src/ui/panel-chat.js",
  "src/ui/panel-details.js", "src/ui/panel-log.js", "src/ui/settings-dialogs.js", "src/ui/native-instance-settings.js", "src/ui/agent-details-settings.js", "src/ui/chat-quote.js",
  "src/ui/agent-export-dialog.js", "src/ui/agent-runtime-settings.js", "src/ui/image-lightbox.js",
  ...["app", "app-nav", "app-shell", "app-ctx", "app-session", "app.css", "instance-switch", "instance-nav", "ui-menu", "panel-view", "view-roster-store", "preview-panel", "chat-composer", "chat-workspace-model", "chat-workspace-memory"].map(name => `src/ui/shared/${name.endsWith(".css") ? name : name + ".js"}`)];
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
const retained = process.env.RETAIN || "", oldRef = process.env.OLD_REF || "d2440106a2805187eb50a13c2385144192261f9a";
const oldFiles: Record<string, string> = { css: "src/ui/shared/app.css", shell: "src/ui/shared/app-shell.js", chat: "src/ui/panel-chat.js", fields: "src/ui/settings-dialogs.js", session: "src/ui/shared/app-session.js", context: "src/ui/shared/app-ctx.js" };
const substitutions: Record<string, string[]> = {};
const sourcePath = (path: string) => path.startsWith("/assets/") ? "src/ui/shared/" + path.slice(8) : path.startsWith("/ui/js/") ? "src/ui/" + path.slice(7) : "";
receipt.retained = retained; receipt.oldRef = oldRef; receipt.substitutions = substitutions;
const ctx = await fx.browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: theme, locale: "zh-TW", hasTouch: process.env.COARSE === "1" });
const page = await ctx.newPage();
page.setDefaultTimeout(10000);
try {
  fx.fm.webPrefs.write("operator", new Map([["theme", theme], ["lang", "zh-TW"]]));
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
    if (retained && ((retained === "all" || retained === "js") ? sources.includes(path) && (retained !== "js" || path.endsWith(".js")) : path === oldFiles[retained])) {
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
      panes: [...document.querySelectorAll(".ws-pane")].map(el => { const r = el.getBoundingClientRect(); return { id: el.getAttribute("data-pane"), box: [r.x, r.y, r.width, r.height],
        headerOverflow: (el.querySelector('.panel-head')?.scrollWidth || 0) > (el.querySelector('.panel-head')?.clientWidth || 0),
        statusInside: [...el.querySelectorAll('.ws-pane-head .panel-sub .status')].every(status => { const r = status.getBoundingClientRect(), parent = status.parentElement!.getBoundingClientRect(); return getComputedStyle(status).fontSize === '0px' || (r.left >= parent.left - 1 && r.right <= parent.right + 1); }),
        actionsInside: [...el.querySelectorAll('.ws-pane-head .panel-actions > button, .ws-pane-head .panel-actions > .menu > button')].every(button => { const z = button.getBoundingClientRect(); return z.left >= r.left && z.right <= r.right && (!matchMedia('(pointer: coarse)').matches || (z.width >= 44 && z.height >= 44)); }),
        titles: [...el.querySelectorAll("h1, .panel-title, .panel-head")].map((node: any) => ({ kind: node.tagName + "." + node.className, text: node.textContent, scroll: node.scrollLeft, box: [node.getBoundingClientRect().x, node.getBoundingClientRect().width], sw: node.scrollWidth })),
        tabs: [...el.querySelectorAll(".inst-switch a")].map(a => a.textContent) }; }) }));
    assert.equal(geometry.headers, panes); assert.equal(geometry.textTools, 1); assert.equal(geometry.overflow, false);
    assert.equal(geometry.streams.active, 1); assert.equal(geometry.streams.max, 1); assert.equal(fx.fm.sseClients.size, 1);
    for (const pane of geometry.panes) { assert.equal(pane.headerOverflow, false, JSON.stringify(pane)); assert.equal(pane.actionsInside, true, JSON.stringify(pane)); assert.equal(pane.statusInside, true, JSON.stringify(pane)); }
    const file = `${theme}-zh-TW-${label}.png`; await page.screenshot({ path: join(out, file) }); receipt.cases.push({ label, file, geometry });
  }
  await shot("single", 1);
  await page.locator("#msgIn").fill("尚未送出的草稿");
  if (retained) {
    if (!["css", "all", "js", "server"].includes(retained)) {
      await page.evaluate(async (name: string) => { const { appStore } = await import("/assets/app-store.js"); await appStore.get().chatWorkspace?.open(name); }, b);
      await page.getByText("未能載入分割對話。目前對話不變；請重新整理頁面再試。", { exact: true }).waitFor();
    }
    assert.equal(await page.locator(".chat-workspace").count(), 0);
    assert.equal(await page.locator("#msgIn").inputValue(), "尚未送出的草稿");
    await shot(`retained-${retained}`, 1);
  } else {
  const row = page.locator(".v-li").filter({ has: page.locator(`a[href="/ui/chat/${encodeURIComponent(b)}"]`) }).first();
  await row.hover(); await row.locator(".inst-workspace > button").click();
  await row.getByRole("menuitem", { name: "在旁邊開啟", exact: true }).click();
  await page.locator(".ws-pane-head").nth(1).waitFor();
  assert.equal(await page.locator("#pane-a-msgIn").inputValue(), "尚未送出的草稿");
  await page.locator("#pane-b-msgIn").fill("另一格的草稿");
  await shot("right", 2);
  if (process.env.REVIEW_R1 === "1") {
    // B starts focused. Alt-clicking A's split owns A, not whichever pane was focused before the click.
    await page.locator('[data-pane="a"] .ws-pane-split').click({ modifiers: ["Alt"] });
    const choiceLabel = await page.evaluate(async (name: string) => { const { appStore } = await import("/assets/app-store.js"); return appStore.get().instances.find((it: any) => it.name === name)?.display_name || name; }, fx.instances[0].name);
    await page.locator(".ws-agent-choices").getByRole("button", { name: choiceLabel, exact: true }).click();
    const topology = await page.evaluate(async () => { const { navStore } = await import("/assets/app-nav.js"); const w = navStore.get().workspace; return { a: w.a.route.instance, b: w.b.route.instance, layout: w.layout }; });
    assert.deepEqual(topology, { a, b: fx.instances[0].name, layout: "stack" });
    await shot("alt-split-owner", 2);
    await page.evaluate(async (names: string[]) => { const nav = await import("/assets/app-nav.js"); nav.navigate(`/ui/chat/${encodeURIComponent(names[0])}?compare=${encodeURIComponent(names[1])}&focus=b`, { workspace: true }); }, [a, b]);
    await page.locator("#pane-b-msgIn").waitFor();
    receipt.splitOwner = topology;
  }
  if (process.env.LIFECYCLES === "1") {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable'); await cdp.send('HeapProfiler.collectGarbage');
    const heap = async () => (await cdp.send('Performance.getMetrics')).metrics.find((x: any) => x.name === 'JSHeapUsedSize').value;
    const before = await heap();
    // One composer is mid-composition while the other's state redraws the page; no fake keyboard/vendor call.
    const composing = await page.evaluate(async (names: string[]) => {
      const { store } = await import('/ui/js/panel-chat.js'); const field = document.querySelector('#pane-a-msgIn') as HTMLTextAreaElement;
      const before = store.state.drafts[names[0]];
      field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); field.value = '輸入中的注音候選';
      field.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, inputType: 'insertCompositionText' }));
      store.setDraft(names[1], 'B redraw during composition');
      const { appStore } = await import('/assets/app-store.js'); appStore.set({ connection: appStore.get().connection });
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      const during = { value: field.value, draft: store.state.drafts[names[0]] };
      field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      return { before, during, after: store.state.drafts[names[0]] };
    }, [a, b]);
    assert.equal(composing.during.value, '輸入中的注音候選'); assert.equal(composing.during.draft, composing.before); assert.equal(composing.after, composing.during.value);
    await page.locator('#pane-a-msgIn').fill('尚未送出的草稿'); await page.locator('#pane-b-msgIn').fill('另一格的草稿');
    await page.locator('[data-pane="a"] input[type=file]').setInputFiles({ name: 'owned-a.txt', mimeType: 'text/plain', buffer: Buffer.from('owned fixture only') });
    assert.equal(await page.locator('[data-pane="a"] .file-chip').count(), 1); assert.equal(await page.locator('[data-pane="b"] .file-chip').count(), 0);
    for (let n = 0; n < 50; n++) {
      await page.locator('[data-pane="b"] .ws-pane-close').click(); await page.locator('#msgIn').waitFor();
      assert.equal(await page.locator('#msgIn').inputValue(), '尚未送出的草稿');
      await page.evaluate(async (name: string) => { const { appStore } = await import('/assets/app-store.js'); await appStore.get().chatWorkspace.open(name); }, b);
      await page.locator('#pane-b-msgIn').waitFor();
      assert.equal(await page.locator('#pane-b-msgIn').inputValue(), '另一格的草稿');
      assert.equal(await page.locator('.chat-workspace .panel.p-chat').count(), 2); assert.equal(await page.locator('#main .hd-text').count(), 1);
      assert.equal(await page.locator('[data-pane="a"] .file-chip').count(), 1); assert.equal(await page.locator('[data-pane="b"] .file-chip').count(), 0);
      assert.equal(fx.fm.sseClients.size, 1);
    }
    await cdp.send('HeapProfiler.collectGarbage');
    receipt.lifecycle = { cycles: 50, composing, heapBefore: before, heapAfter: await heap(), filesStayedWithA: true, pageStreams: 1, toolsRoots: 1 };
    await page.evaluate(async (name: string) => { const { store } = await import('/ui/js/panel-chat.js'); store.removeFile(name, 0); }, a);
    await cdp.detach();
  }
  // Actual browser Range → existing quote pill → the other composer's edit history. No send.
  const sends: string[] = [];
  const onRequest = (req: any) => { if (req.method() === "POST" && new URL(req.url()).pathname === "/ui/send") sends.push(req.url()); };
  page.on("request", onRequest);
  await page.locator('[data-pane="a"] .msg .md').first().evaluate((el: HTMLElement, selected: string) => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let node: Text | null = null;
    while (walk.nextNode()) if (walk.currentNode.textContent?.includes(selected)) { node = walk.currentNode as Text; break; }
    if (!node) throw new Error("fixture passage not rendered");
    const range = document.createRange(), at = node.data.indexOf(selected); range.setStart(node, at); range.setEnd(node, at + selected.length);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  }, passage);
  await page.locator(".quote-other").click();
  await page.waitForFunction(() => (document.querySelector("#pane-b-msgIn") as HTMLTextAreaElement)?.value.includes("> "));
  assert.equal(await page.locator("#pane-a-msgIn").inputValue(), "尚未送出的草稿");
  assert.ok((await page.locator("#pane-b-msgIn").inputValue()).includes(passage));
  await shot("quoted", 2); await page.keyboard.press("Control+z");
  assert.equal(await page.locator("#pane-b-msgIn").inputValue(), "另一格的草稿"); assert.deepEqual(sends, []); page.off("request", onRequest);
  await page.locator('[data-pane="a"] .inst-switch a[href*="/ui/log/"]').click();
  await page.locator('[data-pane="a"] .p-log').waitFor();
  await shot("log-and-chat", 2);
  await page.locator('[data-pane="b"] .inst-switch a[href*="/view/"]').click();
  await page.locator('[data-pane="b"] .p-view').waitFor(); await shot("log-and-view", 2);
  // Settings links use each pane's category URL and real, uniquely labelled form.
  await page.evaluate(async (names: string[]) => { const nav = await import("/assets/app-nav.js");
    nav.navigate(`/ui/fleet/agent/${encodeURIComponent(names[0])}?cat=basic`);
    const { appStore } = await import("/assets/app-store.js"); await appStore.get().chatWorkspace.open(names[1]); }, [b, a]);
  await page.locator('[data-pane="b"] [data-agent-category="basic"] input').first().waitFor();
  await page.evaluate(async (names: string[]) => { const nav = await import("/assets/app-nav.js"); nav.navigate(`/ui/fleet/agent/${encodeURIComponent(names[0])}?compare=${encodeURIComponent(names[1])}&paneB=details&catA=basic&catB=basic&focus=b`, { workspace: true }); }, [a, b]);
  await page.locator('[data-pane="a"] [data-agent-category="basic"] input').first().waitFor();
  const formIds = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('.ws-pane input[id], .ws-pane select[id], .ws-pane textarea[id]')];
    return { count: inputs.length, unique: new Set(inputs.map(el => el.id)).size,
      duplicates: inputs.filter((el, i) => inputs.findIndex(other => other.id === el.id) !== i).map(el => el.id),
      ownLabels: [...document.querySelectorAll('.ws-pane label[for]')].every(el => el.closest('.ws-pane')?.querySelector(`#${CSS.escape(el.getAttribute('for')!)}`)) };
  });
  assert.ok(formIds.count > 4); assert.equal(formIds.count, formIds.unique, JSON.stringify(formIds)); assert.equal(formIds.ownLabels, true, JSON.stringify(formIds));
  await shot("two-settings", 2); receipt.forms = formIds;
  if (process.env.SETTINGS_SUSPEND === "1") {
    const originals = await Promise.all([page.locator("#pane-a-ag-desc").inputValue(), page.locator("#pane-b-ag-desc").inputValue()]);
    await page.locator("#pane-a-ag-desc").fill("保留 A 的設定草稿");
    await page.locator("#pane-b-ag-desc").fill("保留 B 的設定草稿");
    let emojiOriginal = "";
    if (process.env.REVIEW_R1 === "1") {
      await page.locator('[data-pane="a"] .s-nav a[href$="cat=channel"]').click();
      await page.locator("#pane-a-se-received").waitFor(); emojiOriginal = await page.locator("#pane-a-se-received").inputValue();
      await page.locator("#pane-a-se-received").fill("🎉"); await page.locator("#pane-b-ag-desc").click();
    }
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.locator(".ws-agent-tabs").waitFor();
    await page.locator(".ws-agent-tabs .seg-item").nth(0).click();
    await page.waitForFunction(() => (document.querySelector("#pane-a-ag-desc") as HTMLInputElement)?.value === "保留 A 的設定草稿");
    if (process.env.REVIEW_R1 === "1") assert.equal(await page.locator("#pane-a-se-received").inputValue(), "🎉");
    await shot("suspended-settings-a", 1);
    await page.locator(".ws-agent-tabs .seg-item").nth(1).click();
    await page.waitForFunction(() => (document.querySelector("#pane-b-ag-desc") as HTMLInputElement)?.value === "保留 B 的設定草稿");
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.locator("#pane-a-ag-desc").waitFor({ state: "attached" });
    assert.equal(await page.locator("#pane-a-ag-desc").inputValue(), "保留 A 的設定草稿");
    assert.equal(await page.locator("#pane-b-ag-desc").inputValue(), "保留 B 的設定草稿");
    await shot("restored-settings", 2);
    if (process.env.REVIEW_R1 === "1") {
      assert.equal(await page.locator("#pane-a-se-received").inputValue(), "🎉");
      await page.locator("#pane-a-se-received").scrollIntoViewIfNeeded();
      await shot("restored-emojis", 2); await page.locator("#pane-a-se-received").fill(emojiOriginal);
      await page.locator('[data-pane="a"] .s-nav a[href$="cat=basic"]').click();
      await page.locator("#pane-a-ag-desc").waitFor();
      receipt.emojiSuspension = { editedValueRetained: true, originalRestoredWithoutApply: true };
    }
    // Restore both fields rather than applying or discarding a write; the remaining journey is unchanged.
    await page.locator("#pane-a-ag-desc").fill(originals[0]); await page.locator("#pane-b-ag-desc").fill(originals[1]);
    await page.waitForFunction(() => !document.querySelector(".ws-pane .s-pending"));
    receipt.settingsSuspension = { bothDraftsRestored: true, hiddenReadersUnmounted: true, applied: false };
  }
  // Restore the second pane to Chat through its own visible tab/menu, without a page navigation.
  await page.evaluate(async (names: string[]) => { const nav = await import("/assets/app-nav.js"); nav.navigate(`/ui/log/${encodeURIComponent(names[0])}?compare=${encodeURIComponent(names[1])}&paneB=chat&focus=a`, { workspace: true }); }, [a, b]);
  await page.locator('[data-pane="a"] .panel-actions > .menu > button').click();
  await page.locator('[data-pane="a"]').getByRole("menuitemradio", { name: "上下排列", exact: true }).click();
  await shot("stack", 2);
  await page.locator('[data-pane="a"] .panel-actions > .menu > button').click();
  await page.locator('[data-pane="a"]').getByRole("menuitemradio", { name: "左右排列", exact: true }).click();
  await page.setViewportSize({ width: 1240, height: 1000 });
  await page.evaluate(async () => { const shell = await import('/assets/app-shell.js'); shell.setSidebarWidth(480); });
  await shot("minimum-width", 2);
  await page.locator('[data-pane="a"] .panel-actions > .menu > button').click();
  await shot("overflow-menu", 2); await page.keyboard.press('Escape');
  // Reload an explicit compare URL and then an ordinary deep link: only the former restores two panes.
  const savedAddress = page.url(); await page.reload(); await page.locator('.ws-pane-head').nth(1).waitFor();
  await shot('reload-compare', 2);
  await page.goto(fx.base + `/ui/chat/${encodeURIComponent(a)}`); await page.locator('#msgIn').waitFor();
  assert.equal(await page.locator('.chat-workspace').count(), 0); await shot('ordinary-deep-link', 1);
  await page.goto(savedAddress); await page.locator('.ws-pane-head').nth(1).waitFor();
  await page.evaluate(async () => { const shell = await import('/assets/app-shell.js'); shell.setSidebarWidth(null); });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.locator(".ws-agent-tabs").waitFor(); await shot("narrow", 1);
  await page.setViewportSize({ width: 390, height: 844 }); await shot("phone", 1);
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
