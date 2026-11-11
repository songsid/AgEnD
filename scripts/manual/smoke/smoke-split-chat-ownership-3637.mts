/** PR1 real-shell parity, one page stream, and retained-module controls. No agent/CLI is started. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { bootFixture, matrix, caseName, VIEWPORTS } from "../smoke-fixture/index.mts";
import { seedUsage } from "../smoke-fixture/seed.mts";

const repo = resolve(process.env.REPO!), out = resolve(process.env.OUT!);
const mode = process.env.MODE || "current", baseline = process.env.BASELINE_REF;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
assert.equal(git("status", "--porcelain", "--untracked-files=no"), "", "capture requires clean tracked source");
const head = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");
const sources = ["src/ui/panel-chat.js", "src/ui/chat-store.js", "src/ui/panel-log.js", "src/ui/panel-details.js", "src/ui/agent-details-settings.js", "src/ui/image-lightbox.js",
  ...["app-ctx", "app-nav", "app-shell", "chat-composer", "instance-switch", "panel-view", "preview-panel", "preview-panel-actions"].map(n => `src/ui/shared/${n}.js`)];
const inputs: Record<string, string[]> = {}, assets: Record<string, string[]> = {};
const record = (map: Record<string, string[]>, key: string, bytes: string | Buffer) => { const digest = sha(bytes); const paths = map[digest] ??= []; if (!paths.includes(key)) paths.push(key); };
for (const source of sources) { const bytes = readFileSync(join(repo, source)); assert.equal(sha(bytes), sha(execFileSync("git", ["show", `${head}:${source}`], { cwd: repo }))); record(inputs, source, bytes); }
record(inputs, "harness", readFileSync(new URL(import.meta.url)));
const substitutions = new Map<string, Buffer>(), hits: Record<string, number> = {};
const retained = mode === "old-shell" ? ["app-ctx.js", "app-shell.js", "app-nav.js", "app.css"]
  : mode === "old-chat" ? ["panel-chat.js", "chat-store.js", "chat-composer.js", "instance-switch.js", "image-lightbox.js"] : [];
for (const file of retained) {
  assert.ok(baseline, "retained control requires BASELINE_REF");
  const path = ["panel-chat.js", "chat-store.js", "image-lightbox.js"].includes(file) ? `src/ui/${file}` : `src/ui/shared/${file}`;
  const bytes = execFileSync("git", ["show", `${baseline}:${path}`], { cwd: repo });
  substitutions.set(file === "app.css" ? "/assets/app.css" : path.includes("/shared/") ? `/assets/${file}` : `/ui/js/${file}`, bytes);
}
mkdirSync(out, { recursive: true });
const fx = await bootFixture({ port: Number(process.env.HP || 54970), instances: 3, classic: false });
const receipt: any = { head, tree, mode, baseline: baseline || null, scope: "Real authenticated shell; owned pane/steps display fixtures; no tmux, CLI, vendor, live fleet or backend transcript E2E", inputs, assets, substitutions: {}, cases: [] };
try {
  await seedUsage(fx);
  const name = fx.instances[1].name;
  fx.fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text: "第一個步驟已完成。\n\n```ts\nconst pane = 'unchanged';\n```\n\n可以在這裡比較聊天、檢視、紀錄和設定。", ts: "2026-11-11T08:00:00.000Z" });
  for (const c of matrix()) {
    const jobs: Promise<unknown>[] = [], blocked: string[] = [], errors: string[] = [];
    const ctx = await fx.browser.newContext({ viewport: VIEWPORTS[c.device], deviceScaleFactor: 1, colorScheme: c.theme, locale: c.lang === "zh-TW" ? "zh-TW" : "en-US", isMobile: c.device === "phone", hasTouch: c.device === "phone" });
    const page = await ctx.newPage();
    {
      fx.fm.webPrefs.write("operator", new Map<string, unknown>([["theme", c.theme], ["lang", c.lang]]));
      await ctx.addInitScript(() => {
        localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); localStorage.setItem("agend_usage_rail", "0");
        const Native = window.EventSource; (window as any).__sources = { active: 0, max: 0 };
        window.EventSource = class extends Native {
          private ended = false;
          constructor(url: string | URL, opts?: EventSourceInit) { super(url, opts); const n = (window as any).__sources; n.active++; n.max = Math.max(n.max, n.active); }
          close() { if (!this.ended) { this.ended = true; (window as any).__sources.active--; } super.close(); }
        };
      });
      page.on("pageerror", (error: Error) => errors.push(error.message));
      page.on("response", (response: any) => {
        const url = new URL(response.url());
        if (url.origin === fx.base && (/^\/(assets|ui\/js)\//.test(url.pathname) || /text\/html/.test(response.headers()["content-type"] || ""))) {
          jobs.push(response.body().then((body: Buffer) => record(assets, url.pathname, body)));
        }
      });
      await ctx.route("**/*", async (route: any) => {
        const url = new URL(route.request().url());
        if (url.origin !== fx.base) { blocked.push(url.origin); return route.abort(); }
        const old = substitutions.get(url.pathname);
        if (old) { hits[url.pathname] = (hits[url.pathname] || 0) + 1; return route.fulfill({ body: old, contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript" }); }
        if (url.pathname.startsWith("/api/pane/")) return route.fulfill({ body: "cairn@fixture $\n第一個步驟已完成。\nReady for the next message.\n", headers: { "Content-Type": "text/plain", "X-Pane-Cols": "96", "X-Pane-Rows": "24" } });
        if (url.pathname === "/ui/steps") return route.fulfill({ json: { enabled: true, supported: true, backend: "codex", steps: [], events: [], key: "owned-fixture", after: null, before: null } });
        return route.continue();
      });
    }
    fx.fm.initializeWebSessions();
    const { tokenEpoch } = await import(repo + "/src/web-session.ts");
    const code = fx.fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fx.fm.webToken) }).display;
    await page.goto(fx.base + "/signin"); await page.locator("#code").waitFor();
    await page.locator("#code").evaluate((input: HTMLInputElement, code: string) => {
      input.value = code; input.dispatchEvent(new Event("input", { bubbles: true })); input.form!.requestSubmit();
    }, code);
    await page.waitForURL(fx.base + "/ui");
    try {
      for (const [panel, path] of [["chat", `/ui/chat/${encodeURIComponent(name)}`], ["view", `/view/${encodeURIComponent(name)}`], ["log", `/ui/log/${encodeURIComponent(name)}`], ["details", `/ui/fleet/agent/${encodeURIComponent(name)}`]]) {
        await page.evaluate(async (path: string) => { const nav = await import("/assets/app-nav.js"); nav.navigate(path); }, path);
        await page.locator(`.p-${panel}`).waitFor(); await page.locator(`.p-${panel} .inst-switch`).waitFor();
        await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
        await page.waitForTimeout(200);
        const geometry = await page.evaluate(() => {
          const selectors = ["#main", ".panel-head", ".panel-title", ".inst-switch", ".composer-box", ".scroller", ".panel-body"];
          const boxes = Object.fromEntries(selectors.map(selector => { const el = document.querySelector(selector); const r = el?.getBoundingClientRect(); return [selector, r ? [r.x, r.y, r.width, r.height].map(n => Math.round(n * 100) / 100) : null]; }));
          return { boxes, headers: document.querySelectorAll("#main .panel-head").length, labels: [...document.querySelectorAll(".inst-switch a")].map(el => el.textContent), overflow: document.documentElement.scrollWidth > innerWidth, sources: (window as any).__sources };
        });
        assert.equal(geometry.headers, 1); assert.equal(geometry.overflow, false); assert.equal(geometry.sources.active, 1); assert.equal(geometry.sources.max, 1);
        assert.equal(fx.fm.sseClients.size, 1, "the same page retains one server stream across in-page tabs");
        const file = `${caseName(c)}-${panel}.png`; await page.screenshot({ path: join(out, file) });
        receipt.cases.push({ case: caseName(c), panel, file, geometry });
      }
      await Promise.all(jobs); assert.deepEqual(blocked, []); assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  }
  for (const [path, bytes] of substitutions) { assert.ok(hits[path] > 0, `substitution not exercised: ${path}`); record(receipt.substitutions, path, bytes); }
  assert.equal(git("rev-parse", "HEAD"), head); assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
  receipt.hits = hits; writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ mode, head, cases: receipt.cases.length, oneStream: true, externalRequests: 0, substitutions: hits }));
} finally { await fx.close(); }
