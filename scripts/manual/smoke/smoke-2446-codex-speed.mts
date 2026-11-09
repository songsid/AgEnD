// M-2446: Settings → My Agents → a Codex agent's dialog has a Speed choice (Codex default / Standard / Fast) with the
// 2.5× plan-limit hint; a Claude agent's has none. Fast saved through the real page lands in fleet.yaml as
// backend_options.codex.speed: fast, with the agent's other backend options kept; back to "Codex default" removes it.
// Desk light (en), desk dark (zh-TW), phone light (en). SKEW (SKEW=<dir> holding the previous release's
// settings-strings.js, settings-dialogs.js and settings-model.js): the new dialog with a retained old settings-strings
// (the words still render: settings-codex-copy.js owns them); the old dialog + model on the new host (no Speed field,
// nothing broken, an unrelated save keeps backend_options). No page errors anywhere; nothing scrolls sideways.
//   PW_DIR=… REPO=<checkout> OUT=<dir> SKEW=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-2446-codex-speed.mts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2446-codex-speed";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48877), instances: 2, classic: false });
const home = process.env.AGEND_HOME!, fleetPath = join(home, "fleet.yaml");
fx.fm.getInstanceStatus = () => "running";
const CODEX = "codex-worker", CLAUDE = "general";
/** fleet.yaml with a Codex agent that has another backend option of its own (kept across the speed edits). */
const seed = () => {
  const cfg = yaml.load(readFileSync(fleetPath, "utf8")) as any;
  cfg.instances = { [CLAUDE]: cfg.instances[CLAUDE], [CODEX]: { working_directory: home, backend: "codex", display_name: "Codex worker", backend_options: { codex: { credential_profile: "work" } } } };
  writeFileSync(fleetPath, yaml.dump(cfg)); fx.fm.loadConfig(fleetPath);
};
const onDisk = () => (yaml.load(readFileSync(fleetPath, "utf8")) as any).instances[CODEX];
const W = { en: { settings: "Settings", speed: "Speed", hint: "uses plan limits at 2.5×", fast: "Fast", dflt: "Codex default", done: "Done", save: "Save" },
  "zh-TW": { settings: "設定", speed: "速度", hint: "方案額度以 2.5 倍消耗", fast: "快速", dflt: "Codex 預設", done: "完成", save: "儲存" } } as const;
const results: Array<{ name: string; failed: string[]; info?: unknown }> = [];
const record = (name: string, failed: string[], info?: unknown) => { results.push({ name, failed, info }); console.log(`${failed.length ? "FAIL" : "ok  "} ${name}${failed.length ? ` [${failed.join(", ")}]` : ""}${info ? " " + JSON.stringify(info).slice(0, 300) : ""}`); };

async function open(c: { device: "desk" | "phone"; theme: "light" | "dark"; lang: "en" | "zh-TW" }, routes: Array<[string, string]> = []) {
  const p = await freshPage(fx, c);
  const errors: string[] = [];
  p.page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
  if (process.env.DEBUG_NET) p.page.on("response", async (r: any) => { if (/\/api\/settings\//.test(r.url()) && r.request().method() !== "GET") console.log("NET", r.request().method(), r.url().replace(/^https?:\/\/[^/]+/, ""), r.status(), (r.request().postData() || "").slice(0, 200), (await r.text().catch(() => "")).slice(0, 300)); });
  p.page.on("console", (m: any) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  for (const [glob, body] of routes) await p.page.route(glob, (r: any) => r.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body }));
  await mounted(p.page, 30000);
  await p.page.goto(new URL("/settings/agents", p.page.url()).href);
  await p.page.locator(".p-settings .panel-body .col").waitFor({ state: "attached", timeout: 15000 });
  await p.page.waitForTimeout(600);
  return { ...p, errors };
}
/** Open the named agent's dialog from its row. */
async function dialogFor(page: any, label: string, w: typeof W["en"] | typeof W["zh-TW"]) {
  await page.locator(".s-row", { hasText: label }).first().locator(".s-actions button", { hasText: w.settings }).first().click();
  await page.locator("dialog[open] #ag-model").waitFor({ timeout: 10000 });
  await page.waitForTimeout(300);
}
const save = async (page: any, w: typeof W["en"] | typeof W["zh-TW"]) => {
  await page.locator("dialog[open] .btn-primary", { hasText: w.done }).click();
  await page.locator(".btn-primary", { hasText: w.save }).last().click();
  for (let i = 0; i < 40; i++) { await page.waitForTimeout(250); if (!(await page.locator(".btn-primary", { hasText: w.save }).count())) break; }
  await page.waitForTimeout(500);
};
const sideScroll = (page: any) => page.evaluate(`document.documentElement.scrollWidth > innerWidth`) as Promise<boolean>;

for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "en" }] as const) {
  const name = `${c.device}-${c.theme}-${c.lang}`, failed: string[] = [], w = W[c.lang];
  const ok = (k: string, v: boolean) => { if (!v) failed.push(k); };
  seed();
  const p = await open(c);
  await dialogFor(p.page, "General", w);
  ok("a Claude agent has no Speed", (await p.page.locator("dialog[open] #ag-speed").count()) === 0);
  await p.page.locator("dialog[open] .btn", { hasText: c.lang === "en" ? "Cancel" : "取消" }).first().click();
  await dialogFor(p.page, "Codex worker", w);
  const field = p.page.locator("dialog[open] .codex-speed");
  ok("a Codex agent has Speed", (await field.count()) === 1);
  const text = (await field.textContent()) ?? "";
  ok("its label", text.includes(w.speed)); ok("the 2.5× hint", text.includes(w.hint));
  ok("no raw string keys", !/settings\.codex/.test(text));
  ok("starts at Codex default", (await p.page.locator("dialog[open] #ag-speed").inputValue()) === "");
  const opts = await p.page.locator("dialog[open] #ag-speed option").allTextContents();
  ok("three choices", opts.length === 3 && opts.includes(w.fast) && opts.includes(w.dflt));
  await p.page.locator("dialog[open] #ag-speed").selectOption("fast");
  await field.scrollIntoViewIfNeeded();
  await p.page.screenshot({ path: shotPath(SMOKE, c as any, "dialog") });
  ok("no sideways scroll", !(await sideScroll(p.page)));
  await save(p.page, w);
  const after = onDisk();
  ok("fleet.yaml: speed fast", after?.backend_options?.codex?.speed === "fast");
  ok("fleet.yaml: the other option kept", after?.backend_options?.codex?.credential_profile === "work");
  // Back to Codex default: the key goes, the other option stays.
  await dialogFor(p.page, "Codex worker", w);
  ok("reopens at Fast", (await p.page.locator("dialog[open] #ag-speed").inputValue()) === "fast");
  await p.page.locator("dialog[open] #ag-speed").selectOption("");
  await save(p.page, w);
  const back = onDisk();
  ok("fleet.yaml: speed removed", back?.backend_options?.codex?.speed === undefined && back?.backend_options?.codex?.credential_profile === "work");
  ok("no page errors", p.errors.length === 0);
  record(name, failed, { after: after?.backend_options, back: back?.backend_options, errors: p.errors.slice(0, 2) });
  await p.ctx.close();
}

const S = process.env.SKEW;
if (S && existsSync(S)) {
  const c = { device: "desk", theme: "light", lang: "en" } as const, w = W.en, file = (f: string) => readFileSync(join(S, f), "utf8");
  {
    const failed: string[] = []; seed();
    const p = await open(c, [["**/ui/js/settings-strings.js*", file("settings-strings.js")]]);
    await dialogFor(p.page, "Codex worker", w);
    const text = (await p.page.locator("dialog[open] .codex-speed").textContent()) ?? "";
    if (!text.includes(w.speed) || !text.includes(w.hint) || /settings\.codex/.test(text)) failed.push("the new words render");
    await p.page.locator("dialog[open] #ag-speed").selectOption("fast"); await save(p.page, w);
    if (onDisk()?.backend_options?.codex?.speed !== "fast") failed.push("Fast saves");
    if (p.errors.length) failed.push("no page errors");
    await p.page.screenshot({ path: shotPath(SMOKE, c as any, "skew-old-strings") });
    record("SKEW retained old settings-strings + new dialog", failed, { errors: p.errors.slice(0, 2) });
    await p.ctx.close();
  }
  {
    const failed: string[] = []; seed();
    const p = await open(c, [["**/ui/js/settings-dialogs.js*", file("settings-dialogs.js")], ["**/ui/js/settings-model.js*", file("settings-model.js")]]);
    await dialogFor(p.page, "Codex worker", w);
    if (await p.page.locator("dialog[open] #ag-speed").count()) failed.push("no Speed field (old)");
    await p.page.locator("dialog[open] #ag-desc").fill("edited by an old tab"); await save(p.page, w);
    const after = onDisk();
    if (after?.description !== "edited by an old tab") failed.push("the old dialog still saves");
    if (after?.backend_options?.codex?.credential_profile !== "work" || after?.backend_options?.codex?.speed !== undefined) failed.push("backend_options untouched");
    if (p.errors.length) failed.push("no page errors");
    record("SKEW old dialog + model on the new host", failed, { after: after?.backend_options, errors: p.errors.slice(0, 2) });
    await p.ctx.close();
  }
}
const out = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE);
try { writeFileSync(join(out, "result.json"), JSON.stringify(results, null, 2)); } catch { /* the shots made the folder; best effort */ }
await fx.close();
process.exit(results.some((r) => r.failed.length) ? 1 : 0);
