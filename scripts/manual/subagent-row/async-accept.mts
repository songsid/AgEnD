/** Real shell + bounded file reader, saved mock-CLI records only. No CLI/lifecycle/account operations. */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { bootFixture, matrix, caseName } from "../smoke-fixture/index.mts";
import { SubagentService, type SubagentSource } from "../../../src/subagent-service.js";
import { subagentFixture } from "../../../tests/helpers/subagent-fixtures.js";
const repo = process.env.REPO!, out = process.env.OUT!; mkdirSync(out, { recursive: true });
const receipt: any = { scope: "Real Fleet web/admin sign-in and production bounded reader; saved mock CLI mixed records, derived live phases, fixed observation/browser clock. No API response stubs outside SKEW.", source: [], cases: [], skew: [], cleanup: null };
for (const file of ["src/subagent-records.ts", "src/subagent-service.ts", "src/ui/subagent-row.js", "src/ui/panel-chat.js"]) receipt.source.push({ file, sha256: createHash("sha256").update(readFileSync(join(repo, file))).digest("hex") });
const fx = await bootFixture({ port: Number(process.env.HP ?? 48872), instances: 3, classic: false });
let active: SubagentSource | null = null, observedNow = Date.now();
const current = new SubagentService(() => active, undefined, () => observedNow);
const baselineDir = join(fx.dir, "baseline"); mkdirSync(baselineDir);
for (const file of ["subagent-records", "subagent-service"]) {
  let code = execFileSync("git", ["show", `186b104c:src/${file}.ts`], { cwd: repo, encoding: "utf8" });
  if (file === "subagent-records") code = code.replace('"./tool-progress.js"', JSON.stringify(join(repo, "src/tool-progress.ts")));
  writeFileSync(join(baselineDir, file + ".ts"), code);
}
const { SubagentService: Before } = await import(pathToFileURL(join(baselineDir, "subagent-service.ts")).href);
const before = new Before(() => active, undefined, () => observedNow);
function seed(mode: "open" | "completed" | "unknown") {
  const f = subagentFixture("claude-code"), shift = observedNow - f.now;
  for (const [id, c] of f.children) c.records = readFileSync(join(repo, `tests/fixtures/subagents-m2739/claude-full-agent-${id}.jsonl`), "utf8").trim().split("\n").map(s => JSON.parse(s));
  if (mode === "open") {
    f.parent = f.parent.filter((r: any) => r.origin?.kind !== "task-notification");
    for (const c of f.children.values()) { delete (c.meta as any).finished; c.records = c.records.filter((r: any) => !r.timestamp || Date.parse(r.timestamp) <= Date.parse("2026-11-09T07:12:29Z")); }
  }
  const patch = (x: any): any => Array.isArray(x) ? x.map(patch) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "timestamp" && typeof v === "string" ? new Date(Date.parse(v) + shift).toISOString() : patch(v)])) : x;
  const root = join(fx.dir, "records"); rmSync(root, { recursive: true, force: true }); mkdirSync(root);
  const path = join(root, f.sessionId + ".jsonl"); writeFileSync(path, patch(f.parent).map((r: any) => JSON.stringify(r)).join("\n") + "\n");
  if (mode !== "unknown") for (const [id, c] of f.children) {
    const base = join(root, f.sessionId, "subagents", "agent-" + id); mkdirSync(join(base, ".."), { recursive: true });
    writeFileSync(base + ".jsonl", patch(c.records).map((r: any) => JSON.stringify(r)).join("\n") + "\n"); writeFileSync(base + ".meta.json", JSON.stringify(c.meta));
  }
  active = { backend: f.backend, sessionId: f.sessionId, cwd: f.cwd, root, path, owner: mode + "-" + observedNow };
}
try {
  for (const c of matrix()) {
    const name = caseName(c), errors: string[] = []; observedNow = Date.now(); seed("completed"); fx.fm.subagentReader = before;
    const { ctx, page, csp } = await fx.page(c, { path: "/ui/chat/general" }); page.on("pageerror", (e: any) => errors.push(String(e))); await page.clock.setFixedTime(new Date(observedNow));
    await page.locator(".subagent-progress").waitFor(); await page.locator(".subagent-progress>summary").click();
    if (await page.locator(".subagent-report").count()) throw Error("baseline unexpectedly completes mixed stream");
    await page.screenshot({ path: join(out, name + "-before-unknown.png") });
    fx.fm.subagentReader = current; observedNow = Date.now(); seed("open"); await page.clock.setFixedTime(new Date(observedNow)); await page.reload();
    await page.locator(".subagent-progress").waitFor(); const collapsed = await page.locator(".subagent-progress[open]").count(); if (collapsed) throw Error("not collapsed");
    await page.screenshot({ path: join(out, name + "-running-collapsed.png") }); await page.locator(".subagent-progress>summary").click();
    const live = await current.read("general"); if (live.runs.some(r => r.state !== "running") || live.runs.length !== 2) throw Error("parent yield lost running child");
    await page.screenshot({ path: join(out, name + "-running.png") });
    observedNow = Date.now(); seed("completed"); await page.clock.setFixedTime(new Date(observedNow)); await page.reload();
    await page.locator(".subagent-progress>summary").click(); await page.waitForFunction(() => document.querySelectorAll(".subagent-report").length === 2); await page.screenshot({ path: join(out, name + "-completed.png") });
    const style = await page.locator(".subagent-progress").evaluate((e: any) => ({ outsideLedger: !e.closest(".msg"), composer: !!e.parentElement.querySelector(".composer-box"), overflow: document.documentElement.scrollWidth > innerWidth, buttons: e.querySelectorAll("button").length, tap: e.querySelector("summary").getBoundingClientRect().height, inline: e.querySelectorAll("[style]").length }));
    if (!style.outsideLedger || !style.composer || style.overflow || style.buttons || style.inline || style.tap < 44) throw Error(JSON.stringify(style));
    observedNow += 15000; await page.clock.setFixedTime(new Date(observedNow)); await page.waitForFunction(() => !document.querySelector(".subagent-progress"));
    await page.screenshot({ path: join(out, name + "-completed-retired.png") });
    observedNow = Date.now(); seed("unknown"); await page.clock.setFixedTime(new Date(observedNow)); await page.reload(); await page.locator(".subagent-progress>summary").click();
    await page.screenshot({ path: join(out, name + "-unknown.png") }); observedNow += 120000; await page.clock.setFixedTime(new Date(observedNow)); await page.waitForFunction(() => !document.querySelector(".subagent-progress"));
    await page.screenshot({ path: join(out, name + "-unknown-retired.png") });
    const response = page.waitForResponse((r: any) => r.url().includes("/ui/subagents?")); await page.reload(); const answer = await (await response).json(); if (answer.runs.length) throw Error("reopen revived expired rows");
    await page.locator(".composer-box").waitFor(); if (await page.locator(".subagent-progress").count()) throw Error("reopen row");
    await page.screenshot({ path: join(out, name + "-reopened.png") }); const violations = await csp(); if (errors.length || violations.length) throw Error(JSON.stringify({ errors, violations }));
    receipt.cases.push({ name, baseline: "full mixed streams unknown", candidate: "running/completed", retiredCompleted: true, retiredUnknown: true, noReopenRevival: true, parentYieldRetainsRunning: true, style, errors, violations }); await ctx.close();
  }
  for (const mode of ["old-panel", "old-client", "old-server", "missing-module"]) {
    observedNow = Date.now(); seed("completed"); fx.fm.subagentReader = current; const { ctx, page } = await fx.page({ device: "phone", theme: "dark", lang: "zh-TW" }, { path: "/ui/chat/general" }); const errors: string[] = []; page.on("pageerror", (e: any) => errors.push(String(e)));
    if (mode === "old-panel" || mode === "old-client") { const f = mode === "old-panel" ? "panel-chat" : "subagent-row"; const body = execFileSync("git", ["show", `186b104c:src/ui/${f}.js`], { cwd: repo, encoding: "utf8" }); await page.route(`**/ui/js/${f}.js`, (r: any) => r.fulfill({ status: 200, contentType: "text/javascript", body })); }
    if (mode === "old-server") fx.fm.subagentReader = before;
    if (mode === "missing-module") await page.route("**/ui/js/subagent-row.js", (r: any) => r.fulfill({ status: 404, body: "" }));
    await page.reload(); await page.locator(".composer-box").waitFor(); if (mode !== "missing-module") await page.locator(".subagent-progress").waitFor();
    await page.screenshot({ path: join(out, "skew-" + mode + ".png") }); if (errors.length) throw Error(errors.join("\n")); receipt.skew.push({ mode, composer: true, errors }); await ctx.close();
  }
} finally { await fx.close(); receipt.cleanup = { fixtureClosed: true }; writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2)); }
