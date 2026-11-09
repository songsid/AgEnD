// Scratch FleetManager + Chromium only; never starts an agent or calls a vendor.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48971), instances: 2, classic: false });
const file = join(process.env.AGEND_HOME!, "fleet.yaml");
const classicFile = join(process.env.AGEND_HOME!, "classicBot.yaml");
fx.fm.captureClassicSettingsRestoration = () => undefined;
fx.fm.restartClassicInstanceFromSettings = async () => {}; // no CLI runtime in this browser fixture
const disk = () => yaml.load(readFileSync(file, "utf8")) as any;
const seed = () => {
  const cfg = disk();
  cfg.defaults ||= {};
  cfg.defaults.quota_notice = { enabled: true, thresholds: [10], periods: ["weekly"], target: "general", backends: { "kiro-cli": { periods: ["monthly"] } } };
  cfg.instances.worker = { working_directory: process.env.AGEND_HOME!, backend: "codex", display_name: "Quota worker" };
  writeFileSync(file, yaml.dump(cfg));
  writeFileSync(classicFile, yaml.dump({ channels: { fixture: { channelId: "fixture", instanceName: "classic-fixture", name: "Classic fixture", backend: "codex" } } }));
  fx.fm.loadConfig(file);
};
const failures: string[] = [], results: unknown[] = [];
const check = (name: string, value: boolean) => { if (!value) failures.push(name); };
const old = (f: string) => execFileSync("git", ["show", `5a45a0259:src/ui/${f}`], { encoding: "utf8" });
async function page(c: any, skew?: "strings" | "schema" | "panel" | "route") {
  const p = await freshPage(fx, c);
  const errors = p.errors;
  await p.page.addInitScript(() => {
    (window as any).__name = (fn: unknown) => fn; // tsx function-name helper in page.evaluate
    (window as any).__quotaCsp = [];
    document.addEventListener("securitypolicyviolation", e => (window as any).__quotaCsp.push(e.violatedDirective + " " + e.blockedURI));
  });
  if (skew === "strings") await p.page.route("**/ui/js/settings-strings.js*", (r: any) => r.fulfill({ contentType: "text/javascript", body: old("settings-strings.js") }));
  if (skew === "route") await p.page.route("**/assets/app-route.js*", (r: any) => r.fulfill({ contentType: "text/javascript", body: old("shared/app-route.js") }));
  if (skew === "panel") await p.page.route("**/ui/js/panel-settings.js*", (r: any) => r.fulfill({ contentType: "text/javascript", body: old("panel-settings.js") }));
  if (skew === "schema") await p.page.route("**/api/settings/schema*", async (r: any) => { const response = await r.fetch(); const body = await response.json(); delete body.impacts["instance.quota_notice"]; delete body.impacts["defaults.quota_notice"]; await r.fulfill({ response, json: body }); });
  await mounted(p.page, 30_000);
  await p.page.goto(new URL(skew === "panel" || skew === "route" ? "/settings/agent-defaults" : "/settings/notifications", p.page.url()).href);
  await p.page.locator(skew === "panel" ? "#g-auto" : "#qn-scope").waitFor({ timeout: 15_000 });
  return { ...p, errors };
}
const save = async (p: any, language: string, urls = ["fleet/defaults", "fleet/instances/worker", "classic/channels/fixture"]) => {
  const writes = urls.map(url => p.waitForResponse((r: any) => ["PUT", "PATCH"].includes(r.request().method()) && r.url().endsWith("/api/settings/" + url), { timeout: 15_000 }));
  await p.locator(".btn-primary", { hasText: language === "en" ? /^Save/ : /^儲存/ }).last().click();
  for (const response of await Promise.all(writes)) { if (!response.ok()) throw new Error(`${response.status()} ${await response.text()}`); }
  for (let n = 0; n < 100; n++) {
    const result = await p.evaluate(async () => (await import("/assets/app-store.js")).appStore.get().settingsOp);
    if (result?.phase === "done") return;
    if (result?.phase === "failed") throw new Error(JSON.stringify(result));
    await p.waitForTimeout(100);
  }
  throw new Error("Settings apply did not settle");
};
try {
  for (const c of [
    { device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" },
    { device: "phone", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" },
  ] as const) {
    seed(); const p = await page(c, "strings"), tag = `${c.device}-${c.lang}`;
    check(`${tag}: copy with old strings`, (await p.page.locator("#quota-notices").textContent()).includes(c.lang === "en" ? "Quota notices" : "用量提醒"));
    await p.page.locator("#qn-thresholds").fill("25, 10");
    await p.page.locator("#qn-scope").selectOption("agent:worker");
    await p.page.locator("#qn-enabled").selectOption("off");
    await p.page.locator("#qn-scope").selectOption("classic:fixture");
    await p.page.locator("#qn-enabled").selectOption("off");
    await p.page.locator("#qn-scope").selectOption("backend:kiro-cli");
    check(`${tag}: backend inherited config retained`, await p.page.locator("#qn-periods").inputValue() === "monthly");
    await p.page.screenshot({ path: shotPath("smoke-3299-quota-notices", c, "rules") });
    check(`${tag}: no horizontal overflow`, !await p.page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
    await save(p.page, c.lang);
    check(`${tag}: saved thresholds`, JSON.stringify(disk().defaults.quota_notice.thresholds) === "[25,10]");
    check(`${tag}: saved agent off`, disk().instances.worker.quota_notice?.enabled === false);
    check(`${tag}: classic saved`, (yaml.load(readFileSync(classicFile, "utf8")) as any).channels.fixture.quota_notice?.enabled === false);
    check(`${tag}: backend preserved`, disk().defaults.quota_notice.backends["kiro-cli"].periods[0] === "monthly");
    check(`${tag}: no page errors`, !p.errors.length);
    check(`${tag}: no CSP violations`, !(await p.page.evaluate(() => (window as any).__quotaCsp)).length);
    results.push({ tag, errors: p.errors }); await p.ctx.close();
  }
  seed();
  {
    const p = await page({ device: "desk", theme: "light", lang: "en" }, "route");
    check("old route asset: fallback card reachable", await p.page.locator("#quota-notices").count() === 1);
    check("old route asset: no page errors", !p.errors.length); await p.ctx.close();
  }
  {
    const p = await page({ device: "desk", theme: "light", lang: "en" }, "schema");
    check("old schema: controls read-only", await p.page.locator("#qn-thresholds").isDisabled());
    check("old schema: explicit explanation", (await p.page.locator("#quota-notices").textContent()).includes("does not support"));
    check("old schema: no page errors", !p.errors.length); await p.ctx.close();
  }
  {
    const p = await page({ device: "desk", theme: "light", lang: "en" }, "panel");
    const before = disk().defaults.quota_notice;
    await p.page.locator("#g-auto").fill("12"); await save(p.page, "en", ["fleet/defaults"]);
    check("old panel unrelated save retains quota rules", JSON.stringify(disk().defaults.quota_notice) === JSON.stringify(before));
    check("old panel: no page errors", !p.errors.length); await p.ctx.close();
  }
  {
    seed(); const p = await page({ device: "desk", theme: "light", lang: "en" });
    // Real Preact/useDraft remount with retained unsaved fields, as after the
    // create-agent dialog reloads Settings. No agent/CLI is created by this rig.
    await p.page.evaluate(async () => {
      const { html, render } = await import("/assets/app-html.js");
      const { QuotaNoticeSettings } = await import("/ui/js/settings-quota-notice.js");
      const root = document.createElement("div"); root.id = "quota-draft-probe"; document.body.append(root);
      const staged = new Map(), ctx: any = { schema: { impacts: { "instance.quota_notice": "now" } }, drafts: new Map(),
        fleet: { defaults: { quota_notice: { thresholds: [10], periods: ["weekly"] } }, instances: { worker: { backend: "codex" } } },
        classic: { channels: {} }, stage: (k: string, v: any) => staged.set(k, v), unstage: (k: string) => staged.delete(k) };
      let epoch = 0;
      const draw = () => render(html`<${QuotaNoticeSettings} key=${epoch} ctx=${ctx} />`, root);
      (window as any).__quotaDraftProbe = { ctx, staged, reload() {
        ctx.fleet.instances.newAgent = { quota_notice: { enabled: false } };
        ctx.fleet.instances.worker.quota_notice = { enabled: false, periods: ["daily"] };
        ctx.fleet.defaults.quota_notice.periods = ["monthly"]; staged.clear(); epoch++; draw();
      }, close() { render(null, root); root.remove(); } };
      draw();
    });
    const root = p.page.locator("#quota-draft-probe");
    await root.locator("#qn-thresholds").fill("25");
    await root.locator("#qn-scope").selectOption("agent:worker"); await root.locator("#qn-thresholds").fill("5");
    await p.page.waitForFunction(() => Object.values((window as any).__quotaDraftProbe.ctx.drafts.get("quota-notices") || {}).includes("5"));
    await p.page.evaluate(() => (window as any).__quotaDraftProbe.reload());
    await root.locator("#qn-scope").selectOption("agent:newAgent");
    check("draft reload: new agent remains disabled", await root.locator("#qn-enabled").inputValue() === "off");
    await root.locator("#qn-scope").selectOption("agent:worker");
    check("draft reload: edited threshold retained", await root.locator("#qn-thresholds").inputValue() === "5");
    check("draft reload: untouched same-rule enable follows reload", await root.locator("#qn-enabled").inputValue() === "off");
    check("draft reload: untouched same-rule period follows reload", await root.locator("#qn-periods").inputValue() === "daily");
    await root.locator("#qn-scope").selectOption("fleet");
    check("draft reload: fleet edit retained", await root.locator("#qn-thresholds").inputValue() === "25");
    check("draft reload: untouched fleet period follows reload", await root.locator("#qn-periods").inputValue() === "monthly");
    await p.page.waitForFunction(() => (window as any).__quotaDraftProbe.staged.has("quota:defaults"));
    check("draft reload: new agent never staged for deletion", !await p.page.evaluate(() => (window as any).__quotaDraftProbe.staged.has("quota:agent:newAgent")));
    await p.page.evaluate(() => (window as any).__quotaDraftProbe.close());
    check("draft reload: no page errors", !p.errors.length); await p.ctx.close();
  }
  const out = process.env.OUT || "/tmp/quota-notice-smoke"; mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "result.json"), JSON.stringify({ results, failures }, null, 2));
  console.log(JSON.stringify({ results, failures }));
  if (failures.length) process.exitCode = 1;
} finally { await fx.close(); }
