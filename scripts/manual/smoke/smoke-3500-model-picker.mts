// Production page/HTTP flow; only the isolated CLI worker and Apply/relaunch boundary are mocked.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, mounted } from "../smoke-fixture/index.mts";
const repo = process.env.REPO!, out = process.env.OUT!;
if (!repo || !out) throw Error("REPO and OUT required"); mkdirSync(out, { recursive: true });
const before = process.env.BEFORE === "1", skew = process.env.SKEW;
const fx = await bootFixture({ port: Number(process.env.PORT || 49772), instances: 3, classic: false });
const fixtureName = fx.instances[1]!.name, name = "demo-agent";
const catalog = { "claude-code": [{ id: "sonnet", label: "Sonnet" }, { id: "opus", label: "Opus" }, { id: "haiku", label: "Haiku" }], codex: [{ id: "gpt-5.5", label: "GPT-5.5" }] };
const original = structuredClone(fx.fm.fleetConfig);
original.instances[name] = structuredClone(original.instances[fixtureName]);
Object.assign(original.instances[name], { backend: "claude-code", model: "sonnet", display_name: "範例 Agent" });
original.defaults = { ...original.defaults, backend: "claude-code", model: "sonnet" };
fx.fm.backendAvailabilityRows = () => ["claude-code", "codex", "kiro-cli", "grok"].map(backend => ({ backend, state: backend === "grok" ? "not_installed" : "usable", path: backend === "grok" ? null : `/fixture/${backend}`, auth: "valid", checkedAt: 1 }));
fx.fm.backendEffortLevels = () => ["low", "high"];
let mode = "success", finish: (() => void) | null = null, probes = 0, lastProbeBackend = "", saves = 0, restarts = 0;
fx.fm.runBackendProbeWorker = async (_key: string, input: any) => {
  probes++; lastProbeBackend = input.backend;
  if (mode === "hold") await new Promise<void>(resolve => { finish = resolve; });
  if (mode === "failure") return null;
  return { models: catalog[input.backend as keyof typeof catalog] || [], apiModels: input.backend === "claude-code" ? [{ id: "claude-extra", label: "Claude Extra" }] : [] };
};
fx.fm.restartSingleInstance = async () => { restarts++; };
fx.fm.saveFleetConfig = () => { saves++; };
const reset = () => {
  fx.fm.fleetConfig = structuredClone(original); fx.fm.webModelCatalogs.clear(); mode = "success";
  writeFileSync(join(fx.dir, "fleet.yaml"), JSON.stringify(original));
  fx.fm.loadConfig(join(fx.dir, "fleet.yaml"), { remember: false });
  mkdirSync(join(fx.dir, "cli-env"), { recursive: true });
  for (const [backend, models] of Object.entries(catalog)) writeFileSync(join(fx.dir, "cli-env", `${backend}.json`), JSON.stringify({ backend, models, probedAt: Date.now() }));
};
reset();
for (let i = 0; i < 35; i++) fx.fm.emitSseEvent("message", { instance: name, sender: i % 2 ? name : "範例使用者", role: i % 2 ? "agent" : "user", text: i % 2 ? `第 ${i} 項已檢查。\n\n| 項目 | 狀態 |\n|---|---|\n| 自動測試 | ✅ 通過 |\n| 文件確認 | ⏳ 待確認 |` : `請幫我整理第 ${i} 項部署檢查。`, ts: new Date(Date.now() - (35 - i) * 60_000).toISOString() });
const records: any[] = [];
try {
  for (const c of matrix()) {
    reset(); (await import(repo + "/src/locale.ts")).setLocale(c.lang); const { page, ctx, csp } = await fx.page(c); const errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push(String(e))); const bodies: any[] = [];
    page.on("response", async (r: any) => { if (r.url().endsWith("/ui/command")) console.log("command", JSON.stringify(await r.json())); });
    page.on("request", (r: any) => { if (r.url().endsWith("/ui/command")) bodies.push(r.postDataJSON()); });
    if (skew) await page.route("**/*", async (route: any) => {
      const url = new URL(route.request().url()); const file = url.pathname === "/assets/app.css" ? "app.css" : url.pathname === "/ui/js/settings-catalog.js" ? "settings-catalog.js" : null;
      if (file) return route.fulfill({ contentType: file.endsWith("css") ? "text/css" : "text/javascript", body: readFileSync(join(skew, file)) });
      return route.continue();
    });
    if (before) await page.route("**/ui/js/*", async (route: any) => {
      const file = new URL(route.request().url()).pathname.split("/").pop()!;
      if (["settings-dialogs.js", "panel-chat.js", "chat-store.js"].includes(file)) return route.fulfill({ contentType: "text/javascript", body: readFileSync(join(process.env.BASELINE!, file)) });
      return route.continue();
    });
    const tag = caseName(c);
    async function shot(label: string) {
      await page.evaluate(async () => { await document.fonts.ready; });
      const geometry = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth, version: document.querySelector(".sidebar-version,.version-pill,.app-version")?.textContent }));
      if (geometry.scroll > geometry.width + 1) throw Error(`overflow ${tag}:${label}`);
      await page.screenshot({ path: join(out, `${tag}-${label}.png`) }); records.push({ tag, label, geometry });
    }
    await page.goto(fx.base + "/settings/agent-defaults"); await mounted(page, ".p-settings"); await page.waitForSelector("#g-model");
    await shot("settings");
    if (!before) {
      const field = page.locator("#g-model").locator(".."); const value = await page.locator("#g-model").inputValue();
      const refresh = field.locator(".model-refresh > button"); mode = "hold";
      const started = probes; await refresh.click(); await page.waitForFunction(() => document.querySelector('.model-refresh > button:disabled'));
      if (probes !== started + 1) throw Error("refresh did not rediscover"); await shot("refresh-busy"); finish!(); mode = "success";
      await page.waitForFunction(() => document.querySelector('.model-refresh [role=status]')); if (await page.locator("#g-model").inputValue() !== value) throw Error("selection changed");
      mode = "failure"; await refresh.click(); await page.waitForSelector(".model-refresh .error-state"); await shot("refresh-error");
      mode = "success"; await field.locator(".error-state button").click(); await page.waitForFunction(() => !document.querySelector('.model-refresh .error-state'));
    }
    await page.goto(fx.base + "/settings/agents"); await page.waitForSelector(".p-settings .s-row");
    const row = page.locator(".p-settings .s-row").filter({ has: page.locator(`.s-name[title="${name}"]`) });
    await row.locator("button").filter({ hasText: /^(Settings|設定)$/ }).click(); await page.waitForSelector("#ag-model");
    await page.locator("#ag-model").scrollIntoViewIfNeeded(); await shot("agent-dialog");
    await page.goto(fx.base + `/ui/chat/${encodeURIComponent(name)}`); await mounted(page, ".p-chat");
    const open = async (command: string) => { await page.locator("#msgIn").fill(`/${command}`); await page.locator("#sendBtn").click(); };
    await open("model"); await page.waitForSelector(".cmd-card .cmd-choices"); await shot("chat-model");
    if (!before) {
      if (await page.locator('.cmd-choices [aria-current="true"]').count() !== 1) throw Error("selected model missing");
      await page.locator('[data-model-action="more"]').click(); await page.waitForFunction(() => document.querySelector('.cmd-choices')?.textContent?.includes('Claude Extra')); await shot("chat-more");
      await open("backend"); await page.waitForSelector(".cmd-choices"); await shot("backend");
      await page.locator('.cmd-choices button').filter({ hasText: /^Codex$/ }).click(); await page.waitForFunction(() => document.querySelector('.cmd-choices')?.textContent?.includes('GPT-5.5')); await shot("backend-model");
      const priorProbes = probes; await page.locator('.cmd-head [data-model-action="refresh"]').click(); await page.waitForFunction(() => !document.querySelector('.cmd-head [data-model-action="refresh"]:disabled'));
      if (probes !== priorProbes + 1 || lastProbeBackend !== "codex" || fx.fm.fleetConfig.instances[name].backend !== "claude-code") throw Error("backend refresh used the wrong target or changed config");
      await page.locator('.cmd-choices button').filter({ hasText: "GPT-5.5" }).click(); await page.waitForFunction(() => document.querySelector('.cmd-choices')?.textContent?.includes('high')); await shot("backend-effort");
      const previousSaves = saves; await page.locator('.cmd-choices button').filter({ hasText: /^high$/ }).click(); await page.waitForSelector('.ui-dialog, [role="dialog"], dialog[open]'); await shot("backend-confirm");
      const text = await page.locator('.ui-dialog, [role="dialog"], dialog[open]').last().textContent(); if (!/fresh|全新/.test(text!)) throw Error("new-session warning missing");
      if (saves !== previousSaves) throw Error("saved before confirmation");
      await page.keyboard.press("Escape");
      if (await page.locator(".cmd-head button").count()) await page.locator(".cmd-head button").last().click();
      await page.locator('.scroller').evaluate((el: any) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
      await page.waitForTimeout(150);
      if (c.device === "phone") {
        const button = page.locator('.jump-latest'); if (await button.count()) {
          const b = await button.boundingBox(), thread = await page.locator('.scroller').boundingBox(), composer = await page.locator('.composer-box').boundingBox();
          if (!b || !thread || !composer || b.y < thread.y + thread.height - 1 || b.y + b.height > composer.y + 1) throw Error("latest overlaps content");
          await shot("phone-latest"); await button.click();
        } else throw Error("latest pill not offered");
        const small = await page.locator('.model-entry-row button').evaluateAll((xs: any[]) => xs.filter(x => { const b = x.getBoundingClientRect(); return b.height < 44 || b.width < 44; }).length); if (small) throw Error("phone controls too small");
      }
      if (bodies.some(b => b.args === "__refresh__" || b.args === "__more__")) throw Error("action became model");
      if (!bodies.some(b => b.action === "more")) throw Error("More action not tested");
    }
    if (errors.length || (await csp()).length) throw Error(JSON.stringify({ errors, csp: await csp() })); await ctx.close();
  }
  writeFileSync(join(out, "results.json"), JSON.stringify({ before, skew: !!skew, probes, saves, restarts, records }, null, 2)); console.log(JSON.stringify({ cases: records.length, probes, saves, restarts }));
} finally { await fx.close(); }
