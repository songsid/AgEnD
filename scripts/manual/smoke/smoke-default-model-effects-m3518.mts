// Real application, synthetic config/runtime snapshots only. No provider, tmux or Fleet starts.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { bootFixture, caseName, type MatrixCase } from "../smoke-fixture/index.mts";
const out = process.env.OUT || ".artifacts/m3518/captures";
mkdirSync(out, { recursive: true });
const roster = [
  { name: "example-claude", displayName: "Example Claude", backend: "claude-code", general: true, status: "running" },
  { name: "example-paused", displayName: "Example paused", backend: "claude-code", status: "paused" },
  { name: "example-stopped", displayName: "Example stopped", backend: "claude-code", status: "stopped" },
  { name: "example-own", displayName: "Example own model", backend: "claude-code", status: "running" },
  { name: "example-codex", displayName: "Example Codex", backend: "codex", status: "running" },
  { name: "example-grok", displayName: "Example Grok", backend: "grok", status: "running" },
  { name: "example-muse", displayName: "Example Muse", backend: "muse", status: "running" },
] as any;
const fx = await bootFixture({ port: 0, roster, classic: false, host: true });
// A catalog read is fixture data too: passive model discovery must never invoke a vendor CLI here.
fx.fm.ensureModelCatalog = async () => undefined;
fx.fm.modelCatalogForWeb = fx.fm.modelCatalogFor = () => [
  { id: "sonnet", label: "Sonnet" }, { id: "haiku", label: "Haiku" }, { id: "opus", label: "Opus" },
];
const results: unknown[] = [];
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
const cases: MatrixCase[] = [
  { device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" },
  { device: "phone", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" },
];
try {
  for (const c of cases) {
    const name = caseName(c), fm = fx.fm;
    const config = fm.getRawFleetConfig();
    config.defaults = { backend: "claude-code", model: "sonnet" };
    delete config.instances["example-claude"].backend;
    config.instances["example-own"].model = "opus";
    writeFileSync(join(fx.dir, "fleet.yaml"), JSON.stringify(config));
    fm.loadConfig(join(fx.dir, "fleet.yaml"));
    fm.lifecycle.isPaused = (n: string) => n === "example-paused";
    const runtime = structuredClone(fm.fleetConfig.instances["example-claude"]);
    fm.lifecycle.daemons.set("example-claude", { getConfigSnapshot: () => runtime });
    fm.stopInstance = fm.startInstanceUnattended = fm.startClassicInstanceUnattended = async () => { throw Error("capture forbids lifecycle starts/stops"); };
    const p = await fx.page(c, { path: process.env.SETTINGS_PATH || "/settings/agent-defaults" });
    const pageErrors: string[] = [], writes: string[] = [];
    p.page.on("pageerror", (e: Error) => pageErrors.push(e.message));
    p.page.on("request", (r: any) => { if (r.method() !== "GET") writes.push(new URL(r.url()).pathname); });
    await p.page.waitForSelector("#g-model");
    await p.page.waitForFunction(() => document.querySelector("#g-model")?.closest(".field")?.textContent?.includes("3/4"));
    await p.page.selectOption("#g-model", "haiku");
    await p.page.waitForSelector("#g-default-adoption");
    assert.equal(await p.page.inputValue("#g-default-adoption"), "next-start");
    assert.equal(writes.length, 0);
    assert.ok(!(await p.page.locator(".s-pending .note").innerText()).includes(c.lang === "en" ? "Restart this Agent" : "重新啟動此 Agent"));
    const modelField = p.page.locator(".field").filter({ has: p.page.locator("#g-model") });
    assert.match(await modelField.innerText(), /3/);
    await p.page.locator("#g-model").scrollIntoViewIfNeeded();
    await p.page.screenshot({ path: join(out, `${name}-matching-backend.png`) });
    await p.page.locator(".s-default-adoption").evaluate((el: HTMLElement) => el.scrollIntoView({ block: "center" }));
    await p.page.screenshot({ path: join(out, `${name}-next-restart-choice.png`) });
    const size = await p.page.locator("#g-default-adoption").boundingBox();
    assert.ok(size && size.width > 44 && (c.device !== "phone" || size.height >= 44), JSON.stringify({ name, size }));
    await p.page.selectOption("#g-default-adoption", "restart");
    await p.page.locator(".s-pending .btn-primary").click();
    const dialog = p.page.getByRole("dialog");
    await dialog.waitFor(); assert.equal(writes.length, 0);
    const prompt = await dialog.innerText();
    assert.ok(prompt.includes("1") && prompt.includes("Example Claude"));
    assert.equal(await dialog.getByRole("button", { name: c.lang === "en" ? "Restart now" : "立即重啟", exact: true }).count(), 1);
    await p.page.screenshot({ path: join(out, `${name}-restart-confirm.png`) });
    await dialog.getByRole("button", { name: c.lang === "en" ? "Cancel" : "取消", exact: true }).click();
    assert.equal(writes.length, 0);
    await p.page.selectOption("#g-default-adoption", "next-start");
    await p.page.locator(".s-pending .btn-primary").click();
    await p.page.waitForSelector(".s-step.next-start");
    await p.page.waitForFunction(() => document.querySelectorAll(".s-step.next-start").length >= 3);
    assert.equal(runtime.model, "sonnet");
    assert.ok((await p.page.locator(".s-step.next-start .s-op-name").allTextContents()).includes("Example Claude"));
    assert.equal(fm.fleetConfig.instances["example-codex"].model, undefined);
    assert.equal(fm.fleetConfig.instances["example-grok"].model, undefined);
    assert.equal(fm.fleetConfig.instances["example-muse"].model, undefined);
    assert.ok(!(await p.page.locator(".s-op").innerText()).includes(c.lang === "en" ? "Restart this Agent" : "重新啟動此 Agent"));
    await p.page.locator(".s-op").scrollIntoViewIfNeeded();
    await p.page.screenshot({ path: join(out, `${name}-saved-next-restart.png`) });
    assert.equal(await p.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(pageErrors, []); assert.deepEqual(await p.csp(), []);
    results.push({ name, head, dirty: !!dirty, counter: "3/4", nextStart: true, cancelWroteNothing: true, runtimeStillOld: true, otherBackendsUntouched: true, width: size?.width, height: size?.height, writes, errors: pageErrors });
    await p.ctx.close();
  }
  writeFileSync(join(out, "result.json"), JSON.stringify({ head, dirty: !!dirty, scope: "synthetic config and runtime snapshots; no actual CLI model switching or restart", results }, null, 2));
  console.log(`PASS ${results.length} cases`);
} finally { await fx.close(); }
