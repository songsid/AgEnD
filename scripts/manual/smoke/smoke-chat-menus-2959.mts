/** Owned read-only shell/menu rehearsal. One Chromium/context at a time; only explicit own-favourite writes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadavg } from "node:os";
import { bootFixture } from "../smoke-fixture/index.mts";

const repo = resolve(process.env.REPO!), out = resolve(process.env.OUT!);
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
const digest = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const dirty = !!git("status", "--porcelain", "--untracked-files=no");
assert.ok(!dirty || process.env.DIAGNOSTIC_DIRTY === "1", "capture requires clean tracked inputs");
assert.ok(loadavg()[0] <= 10, "browser campaign waits for 1-min load <=10 and its owned serial slot");
const oldRef = "3f02d04404f40596e9ee25b908f3bb9c793d70dd", retain = process.env.RETAIN || "";
const theme = process.env.THEME || "light", language = process.env.LANGUAGE || "zh-TW", phone = process.env.SCREEN === "phone";
const narrow = process.env.NARROW === "1";
const files = ["src/ui/chat-workspace.js", "src/ui/chat-quote.js", "src/ui/panel-chat.js", "src/ui/shared/instance-nav.js", "src/ui/shared/ui-menu.js", "src/ui/shared/identity-color.js", "src/ui/shared/app.css"];
const inputs: Record<string, string[]> = {}, assets: Record<string, string[]> = {}, substitutions: Record<string, string[]> = {};
const record = (m: Record<string, string[]>, path: string, b: string | Buffer) => { const a = m[digest(b)] ||= []; if (!a.includes(path)) a.push(path); };
const sources = [...files, "src/web-api.ts", "src/web-session.ts", "src/auth-api.ts", "src/fleet-manager.ts", "src/ui/shared/tokens.css", "src/ui/shared/app.js", "src/ui/shared/app-shell.js", "src/ui/shared/app-nav.js", "src/ui/shared/app-store.js", "src/ui/shared/app-prefs.js", "src/ui/shared/app-i18n.js", "src/ui/shared/app-themes.js", "src/ui/shared/view-strings.js", "src/ui/model-picker.js", "scripts/manual/smoke-fixture/index.mts", "scripts/manual/smoke-fixture/data.mts", "scripts/manual/smoke-fixture/from-defaults.mts"];
for (const path of sources) record(inputs, path, readFileSync(join(repo, path)));
record(inputs, "harness", readFileSync(new URL(import.meta.url))); mkdirSync(out, { recursive: true });
const receipt: any = { head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirty, oldRef, retain, theme, language, phone, narrow,
  scope: "Owned scratch FleetManager, real cookie/HTTP/SSE and production UI; mocked status model/display-name/colour/reply inputs and recorded chat text, no Fleet start/CLI/vendor/AD/live operation", inputs, assets, substitutions, cases: [], errors: [], effects: [], external: [], preferences: [], previews: [] };
const fx = await bootFixture({ port: Number(process.env.HP || 56042), instances: 6, classic: false });
let ctx: any;
const jobs: Promise<unknown>[] = [];
const tr = (en: string, zh: string) => language === "en" ? en : zh;
try {
  receipt.browserVersion = fx.browser.version();
  const status = fx.fm.getUiStatus.bind(fx.fm), a = fx.instances[1].name, b = fx.instances[2].name;
  const passage = tr("Compare this passage in the other pane.", "把這段文字放到另一格比較。");
  const colors = ["preset:lime", "preset:orange", "#aaddff", "#ffbb11", "preset:violet", "preset:cyan"];
  fx.fm.getUiStatus = (...args: any[]) => { const s = status(...args); return { ...s, instances: s.instances.map((it: any, i: number) => ({ ...it, model: "Opus 5.5", effort: "auto", color: { person: colors[i % colors.length] }, color_show: { person: ["name", "bar", "ring"] }, ...(it.name === a ? { display_name: "Cairn" } : {}), ...(it.name === b ? { display_name: "AgEnD Leader", last_reply: new Date(Date.now() - 120000).toISOString() } : {}) })) }; };
  for (const name of [a, b]) fx.fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text: passage, ts: "2026-11-12T06:00:00.000Z" });
  fx.fm.webPrefs.write("operator", new Map([["theme", theme], ["lang", language], ["nav.favorites", [a]]]));
  ctx = await fx.browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: narrow ? 1200 : 1600, height: 1000 }, colorScheme: theme, locale: language, hasTouch: phone });
  await ctx.addInitScript({ content: "window.__name = (f) => f;" }); // tsx's keepNames helper inside serialized browser callbacks
  await ctx.addInitScript(() => {
    const Original = window.EventSource; (window as any).__streams = { active: 0, max: 0 };
    window.EventSource = class extends Original {
      ended = false;
      constructor(url: string | URL, opts?: EventSourceInit) { super(url, opts); const c = (window as any).__streams; c.active++; c.max = Math.max(c.max, c.active); }
      close() { if (!this.ended) { this.ended = true; (window as any).__streams.active--; } super.close(); }
    };
    localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); localStorage.setItem("agend_prefs_synced", "1");
  });
  const page = await ctx.newPage(); page.setDefaultTimeout(10000);
  page.on("pageerror", (e: Error) => receipt.errors.push(e.message));
  page.on("response", (r: any) => { const u = new URL(r.url()); if (u.origin === fx.base && /\.(js|css)$/.test(u.pathname)) jobs.push(r.body().then((b: Buffer) => record(assets, u.pathname, b)).catch(() => (receipt.omitted ||= []).push(u.pathname))); });
  ctx.on("request", (r: any) => { const u = new URL(r.url()); if (u.origin !== fx.base && !["data:", "blob:"].includes(u.protocol)) receipt.external.push(u.origin); if (r.method() !== "GET") { if (u.pathname === "/ui/prefs") { const v = r.postDataJSON(); receipt.preferences.push(Object.keys(v.set || {})); } else if (u.pathname === "/api/settings/status-emojis/preview" && r.method() === "POST") receipt.previews.push({ path: u.pathname, method: r.method() }); else if (u.pathname !== "/auth/login") receipt.effects.push({ path: u.pathname, method: r.method() }); } });
  await page.route("**/*", async (route: any) => {
    const u = new URL(route.request().url());
    if (u.origin !== fx.base && !["data:", "blob:"].includes(u.protocol)) return route.abort();
    const path = u.pathname.startsWith("/assets/") ? "src/ui/shared/" + u.pathname.slice(8) : u.pathname.startsWith("/ui/js/") ? "src/ui/" + u.pathname.slice(7) : "";
    const selected = retain === "all" ? files : retain === "css" ? ["src/ui/shared/app.css"] : retain ? ["src/ui/" + (retain === "host" ? "chat-workspace.js" : retain === "quote" ? "chat-quote.js" : `shared/${retain}.js`)] : [];
    if (selected.includes(path)) { const bytes = execFileSync("git", ["show", `${oldRef}:${path}`], { cwd: repo }); record(substitutions, path, bytes); return route.fulfill({ body: bytes, contentType: path.endsWith(".css") ? "text/css" : "text/javascript" }); }
    return route.continue();
  });
  const { tokenEpoch } = await import(repo + "/src/web-session.ts"); fx.fm.initializeWebSessions();
  const code = fx.fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fx.fm.webToken) }).display;
  await page.goto(fx.base + "/signin");
  await page.locator("#code").evaluate((el: HTMLInputElement, value: string) => { el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); el.form!.requestSubmit(); }, code);
  await page.waitForURL(fx.base + "/ui");
  await page.evaluate(async (name: string) => (await import("/assets/app-nav.js")).navigate(`/ui/chat/${encodeURIComponent(name)}`), a);
  await page.locator("#msgIn").waitFor(); await page.waitForFunction(() => (window as any).__streams?.active === 1);
  const check = (label: string, value: unknown) => receipt.cases.push({ label, value });
  async function contrastProbe() {
    const rows = await page.locator("a.inst.id-name").evaluateAll((els: HTMLElement[]) => {
      const channels = (text: string) => { const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d")!; canvas.width = canvas.height = 1;
        ctx.fillStyle = text; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
      const mix = (fg: number[], bg: number[], a: number) => fg.map((v, i) => v * a + bg[i] * (1 - a));
      const background = (el: Element | null): number[] => { if (!el) return [255, 255, 255]; const css = getComputedStyle(el).backgroundColor;
        const alpha = css === "transparent" ? 0 : css.match(/\/\s*([\d.]+)\s*\)/)?.[1] ?? css.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/)?.[1] ?? 1;
        return mix(channels(css), background(el.parentElement), Number(alpha)); };
      const lum = (c: number[]) => c.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0);
      return els.map(el => { const name = el.querySelector(".inst-name")!, fg = channels(getComputedStyle(name).color), bg = background(el), l = [lum(fg), lum(bg)].sort((a, b) => b - a);
        return { name: name.textContent, foreground: fg, background: bg, ratio: (l[0] + .05) / (l[1] + .05), active: el.classList.contains("active"), fresh: el.classList.contains("replied"), barWidth: getComputedStyle(el, "::before").width }; });
    });
    assert.ok(rows.length >= 4); if (!retain && theme === "light") for (const row of rows) assert.ok(row.ratio >= 4.5, `${row.name}: ${row.ratio}`);
    check("rendered-name-contrast", rows);
  }
  async function shot(label: string) {
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
    assert.ok(loadavg()[0] <= 10, "host load exceeded10: close owned resources and pause");
    const geometry = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, streams: (window as any).__streams,
      panes: [...document.querySelectorAll<HTMLElement>(".ws-pane")].map(el => ({ id: el.dataset.pane, width: el.getBoundingClientRect().width })),
      menus: [...document.querySelectorAll<HTMLElement>('[role="menu"]')].map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, clipped: r.left < 0 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.top < 0 }; }) }));
    assert.equal(geometry.overflow, false); assert.equal(geometry.streams.active, 1); assert.equal(geometry.streams.max, 1);
    if (!retain) for (const m of geometry.menus) assert.equal(m.clipped, false);
    const file = `${theme}-${language}-${label}.png`; await page.screenshot({ path: join(out, file) }); receipt.cases.push({ label, file, geometry });
  }
  if (phone) { await page.locator("#sbOpen").click(); }
  await page.mouse.move(phone ? 380 : 1000, 800); await contrastProbe(); await shot("sidebar-rest");
  if (retain === "all") {
    check("control", "exact pre-change UI inputs on current fixture server");
    if (!phone) {
      const target = page.locator(".v-li").filter({ has: page.locator(`a.inst[href$="/${encodeURIComponent(b)}"]`) }).first();
      await target.locator(".inst-workspace > button").click(); await shot("sidebar-menu-before");
      await target.getByRole("menuitem", { name: tr("Open beside", "在旁邊開啟"), exact: true }).click();
      await page.locator('[data-pane="b"] textarea').waitFor();
      await page.locator('[data-pane="a"] .msg .md').first().evaluate((el: HTMLElement, selected: string) => {
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let node: Text | null = null;
        while (walk.nextNode()) if (walk.currentNode.textContent?.includes(selected)) { node = walk.currentNode as Text; break; }
        if (!node) throw new Error("recorded passage missing");
        const range = document.createRange(), at = node.data.indexOf(selected); range.setStart(node, at); range.setEnd(node, at + selected.length);
        getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
      }, passage);
      await page.locator(".quote-pop").waitFor(); await shot("quote-options-before");
      await page.locator('[data-pane="b"] textarea').click();
      await page.locator('[data-pane="b"] .panel-actions > .menu > button').click(); await shot("pane-menu-before");
    }
  }
  else {
    const row = (name: string) => page.locator(".v-li").filter({ has: page.locator(`a.inst[href$="/${encodeURIComponent(name)}"]`) }).first();
    if (!retain || ["css", "ui-menu"].includes(retain)) {
      const r = row(a), button = r.locator(".inst-row-menu > button");
      if (!retain) {
        const slot = await button.boundingBox(); assert.ok(slot);
        assert.equal(await r.locator(".inst-star, .inst-gear").count(), 0);
        assert.equal(await button.locator(".inst-menu-star").isVisible(), !phone);
        if (phone) assert.ok(slot.width >= 44 && slot.height >= 44);
      }
      await r.hover(); await shot("sidebar-hover"); await button.focus(); await button.press("ArrowDown");
      const list = r.locator('[role="menu"]'); await list.waitFor();
      assert.equal(await list.getByRole("menuitem").first().textContent(), tr("Remove from favorites", "移出最愛")); await shot("sidebar-menu");
      if (!retain && phone) for (const rect of await list.locator("button").evaluateAll((els: HTMLButtonElement[]) => els.map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })))) assert.ok(rect.width >= 44 && rect.height >= 44);
      await list.press("Escape"); assert.equal(await button.evaluate((el: HTMLElement) => document.activeElement === el), true); check("row-keyboard", "ArrowDown opens; Escape returns to the single slot");
      if (!retain && !phone) {
        const target = row(b); await target.locator(".inst-row-menu > button").click();
        await target.getByRole("menuitem", { name: tr("Add to favorites", "加入最愛"), exact: true }).click();
        await page.waitForFunction((name: string) => [...document.querySelectorAll(".v-li")].some(el => el.querySelector(".inst-name") && el.querySelector(`a.inst.inst-favorite[href$="/${encodeURIComponent(name)}"]`)), b);
        assert.equal(await row(b).locator(".inst-row-menu > button").evaluate((el: HTMLElement) => document.activeElement === el), true);
        await row(b).locator(".inst-row-menu > button").click(); await row(b).getByRole("menuitem", { name: tr("Remove from favorites", "移出最愛"), exact: true }).click();
        check("favourites", "actual own preference add/remove through the first menu item");
      }
    }
    if (!phone) {
      // Native sidebar action, using the same production Menu as the pane header.
      const target = row(b), trigger = target.locator(retain === "instance-nav" ? ".inst-workspace > button" : ".inst-row-menu > button");
      await trigger.click(); await target.getByRole("menuitem", { name: tr("Open beside", "在旁邊開啟"), exact: true }).click();
      await page.locator('[data-pane="b"] textarea').waitFor(); await page.locator('[data-pane="b"] textarea').fill("保留草稿，不送出。");
      if (narrow) {
        const sash = await page.locator(".ws-sash").boundingBox(), box = await page.locator(".chat-workspace").boundingBox(); assert.ok(sash && box);
        await page.mouse.move(sash.x + sash.width / 2, sash.y + sash.height / 2); await page.mouse.down();
        await page.mouse.move(box.x + box.width - 360 - sash.width / 2, sash.y + sash.height / 2, { steps: 8 }); await page.mouse.up();
        const width = await page.locator('[data-pane="b"]').evaluate((el: HTMLElement) => el.getBoundingClientRect().width);
        assert.ok(width >= 359 && width <= 362, `narrow pane: ${width}`); check("real-sash-minimum", { width });
      }
      if (!retain || retain === "quote" || retain === "host" || retain === "css") {
        await page.locator('[data-pane="a"] .msg .md').first().evaluate((el: HTMLElement, selected: string) => {
          const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let node: Text | null = null;
          while (walk.nextNode()) if (walk.currentNode.textContent?.includes(selected)) { node = walk.currentNode as Text; break; }
          if (!node) throw new Error("recorded passage missing");
          const range = document.createRange(), at = node!.data.indexOf(selected); range.setStart(node!, at); range.setEnd(node!, at + selected.length);
          getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
        }, passage);
        const pop = page.locator(".quote-pop"); await pop.waitFor();
        const rows = await pop.locator("button").evaluateAll((els: HTMLButtonElement[]) => els.map(el => ({ label: el.textContent, icon: !!el.querySelector("svg"), weight: getComputedStyle(el).fontWeight, color: getComputedStyle(el).color, height: el.getBoundingClientRect().height, whiteSpace: getComputedStyle(el).whiteSpace })));
        if (!retain) {
          assert.equal(rows.length, 2); assert.equal(rows[1].label, tr("Quote into the other pane (AgEnD Leader)", "引用到另一格（AgEnD Leader）"));
          assert.ok(rows.every(r => r.icon && r.whiteSpace === "nowrap")); assert.equal(rows[0].weight, rows[1].weight); assert.equal(rows[0].color, rows[1].color); assert.equal(rows[0].height, rows[1].height);
        }
        check("selection-quote-rows", rows); await shot("quote-options"); await pop.locator(".quote-other").click();
        await page.waitForFunction((text: string) => (document.querySelector('[data-pane="b"] textarea') as HTMLTextAreaElement)?.value.includes(text), passage);
        check("cross-pane-quote", "actual selection edits the other composer's draft; effect inventory proves no send");
      }
      await page.locator('[data-pane="b"] .panel-actions > .menu > button').click();
      const list = page.locator('[data-pane="b"] .panel-actions > .menu [role="menu"]'); await list.waitFor();
      if (!retain) {
        assert.equal(await list.getByRole("menuitem", { name: tr("Split chat", "分割對話"), exact: true }).count(), 1);
        const rows = await list.locator("button").evaluateAll((els: HTMLButtonElement[]) => els.map(el => ({ text: el.textContent, icon: !!el.querySelector(".icon"), height: el.getBoundingClientRect().height })));
        assert.ok(rows.length > 10); for (const r of rows) assert.equal(r.icon, true, String(r.text)); check("pane-icon-rows", rows);
        await shot("pane-layout");
        const model = list.getByRole("menuitem").filter({ hasText: tr("Model and effort…", "模型與強度…") }); await model.scrollIntoViewIfNeeded();
        assert.match(await model.textContent() || "", /Opus 5.5.*auto/); await shot("pane-model");
        const appearance = list.locator(".menu-heading", { hasText: tr("Appearance", "外觀") }); if (await appearance.count()) { await appearance.scrollIntoViewIfNeeded(); await shot("pane-appearance"); }
        const deletion = list.locator(".menu-item.danger").last(); if (await deletion.count()) { await deletion.scrollIntoViewIfNeeded(); await shot("pane-delete"); }
        await model.click();
        await page.locator('[data-pane="b"] [data-agent-category="runtime"] [id$="ag-model"]').waitFor(); await shot("model-settings");
        check("settings-only", "model/effort opens the existing focused Agent Settings runtime category; automatic status-emoji preview is inventoried separately, no command or settings write");
      } else { await shot("retained-pane-menu"); check("skew", { retained: retain, linked: true }); }
    }
  }
  await Promise.all(jobs); assert.deepEqual(receipt.errors, []); assert.deepEqual(receipt.effects, []); assert.deepEqual(receipt.external, []);
  for (const keys of receipt.preferences) assert.deepEqual(keys, ["nav.favorites"]);
} finally { await ctx?.close(); await fx.close(); for (const path of sources) assert.ok(inputs[digest(readFileSync(join(repo, path)))]?.includes(path), `source changed: ${path}`); writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"); }
console.log(JSON.stringify({ out, checkpoints: receipt.cases.length, errors: receipt.errors.length }));
