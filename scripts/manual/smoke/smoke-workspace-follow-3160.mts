// Recorded real CLI streams -> production source/monitor/daemon wiring -> real local-admin listener -> Chromium.
// No live daemon, CLI, fleet or tmux is started here. capture.mjs supplies the separately witnessed CLI records.
// REPO=<checkout> PW_DIR=<playwright-core dir> OUT=<PNG directory> npx tsx scripts/manual/smoke/smoke-workspace-follow-3160.mts
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const REPO = process.env.REPO!, OLD_REF = process.env.OLD_REF || "4ae56b6e5ca5c8f5935380bc615f94ada5e45008";
const fx = await bootFixture({ port: Number(process.env.HP || 49062), instances: 2, classic: false });
const { Daemon } = await import("../../../src/daemon.js");
const { FollowLog } = await import("../../../src/workspace-follow.js");
const { TranscriptTurnLedger } = await import("../../../src/transcript-turns.js");
const { CodexRolloutSource } = await import("../../../src/transcript-sources.js");
const { RolloutIndex } = await import("../../../src/rollout-index.js");
const fm = fx.fm as any, name = fx.instances.find(i => !i.general)!.name;
const status = fm.getUiStatus(); fm.getUiStatusSync = () => status;
fm.emitSseEvent("message", { instance: name, sender: "web-user", role: "user", text: "Check the file, find the reference and update the value.", ts: "2026-11-06T18:00:00Z" });
fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text: "I’m checking the source and making the small change.", ts: "2026-11-06T18:00:10Z" });
const results: Record<string, unknown> = { oldRef: OLD_REF, browser: fx.browser.version(), cases: [] };
const cases = ["desk", "phone"].flatMap(device => ["en", "zh-TW"].map(lang => ({ device, lang, theme: device === "phone" ? "dark" : "light" })))
  .filter(c => !process.env.CASES || process.env.CASES.split(",").includes(`${c.device}-${c.lang}`)) as any[];
const modes = (process.env.MODES || "current,old-css,old-panel").split(",");
const backends = (process.env.BACKENDS || "claude,codex").split(",");
const check = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
const old = (path: string) => execFileSync("git", ["-C", REPO, "show", `${OLD_REF}:src/ui/${path}`], { encoding: "utf8", maxBuffer: 16 << 20 });

async function producer(backend: string, tag: string) {
  const base = join(fx.dir, tag), work = join(base, "work"), day = join(base, "sessions/2026/11/07"), instanceDir = join(base, "instance");
  mkdirSync(join(work, "src"), { recursive: true }); mkdirSync(day, { recursive: true }); mkdirSync(instanceDir);
  const initial = "// NEEDLE fixture\nconst value = 1;\nconsole.log(value);\n// fourth line\n" + Array.from({ length: 160 }, (_, i) => `// Context ${i + 5}`).join("\n") + "\n";
  writeFileSync(join(work, "src/a.ts"), initial); writeFileSync(join(work, "src/manual.ts"), "// My pinned file\nexport const keep = true;\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", work, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", ...args]);
  git("init", "-q"); git("add", "."); git("commit", "-qm", "baseline");
  // Existing user edits belong to Changes, but must not be attributed to Claude's exact current edit.
  const current = initial.replace("// Context 80", "// My own edit at 80"); writeFileSync(join(work, "src/a.ts"), current);
  writeFileSync(join(work, ".env"), "FOLLOW_PRIVATE_CANARY_3160"); writeFileSync(join(base, "outside.txt"), "FOLLOW_OUTSIDE_CANARY_3160");
  fm.fleetConfig.instances[name].working_directory = work; fm.fleetConfig.instances[name].backend = backend === "claude" ? "claude-code" : "codex";
  const fixture = backend === "claude" ? "claude-2.1.319.jsonl" : "codex-0.164.0.jsonl";
  const entries = readFileSync(join(REPO, "tests/fixtures/workspace-follow-3160", fixture), "utf8").replaceAll("__WORK__", work).replaceAll("__BASE__", base).trim().split("\n").map(l => JSON.parse(l));
  const intro: any[] = [], groups: any[][] = [], byId = new Map<string, any[]>();
  for (const entry of entries) {
    const p = entry.payload, blocks = entry.message?.content;
    const use = backend === "codex" ? (["function_call", "custom_tool_call"].includes(p?.type) ? p : null) : Array.isArray(blocks) ? blocks.find((b: any) => b.type === "tool_use") : null;
    const done = backend === "codex" ? (["function_call_output", "custom_tool_call_output"].includes(p?.type) ? p : null) : Array.isArray(blocks) ? blocks.find((b: any) => b.type === "tool_result") : null;
    if (use) { const group = [entry]; groups.push(group); byId.set(use.call_id || use.id, group); }
    else if (done) byId.get(done.call_id || done.tool_use_id)?.push(entry);
    else if (!groups.length) intro.push(entry);
  }
  const file = join(day, "rollout-follow.jsonl");
  writeFileSync(file, backend === "codex" ? JSON.stringify(intro.find(e => e.type === "session_meta")) + "\n" : "");
  const source = backend === "codex" ? new CodexRolloutSource(work, join(base, "sessions"), Date.now(), new RolloutIndex(join(base, "sessions"), { ttlMs: 0 })) : null;
  source?.reset();
  const d: any = Object.create(Daemon.prototype);
  Object.assign(d, { instanceDir, logger: fm.logger, config: {}, backend: { binaryName: backend === "claude" ? "claude" : "codex" }, followLog: new FollowLog(), transcriptTurns: new TranscriptTurnLedger() });
  d.transcriptMonitor = d.buildTranscriptMonitor(source);
  if (backend === "claude") d.transcriptMonitor.resolveTranscriptPath = async () => file;
  await d.transcriptMonitor.pollIncrement();
  const append = async (records: any[]) => { appendFileSync(file, records.map(e => JSON.stringify(e) + "\n").join("")); await d.transcriptMonitor.pollIncrement(); };
  await append(intro.filter(e => e.type !== "session_meta"));
  fm.daemons.set(name, { workspaceFollow: (...args: any[]) => d.workspaceFollow(...args) });
  return { async step(index: number) { if (index === 2) writeFileSync(join(work, "src/a.ts"), current.replace("value = 1", "value = 2")); await append(groups[index]!); }, stop: () => d.transcriptMonitor.stop() };
}

try {
  for (const backend of backends) for (const mode of modes) for (const c of cases) {
    const tag = `${mode}-${backend}-${c.device}-${c.lang}`, driver = await producer(backend, tag);
    const o = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(name)}` });
    const errors: string[] = [], answers: { op: string; text: string }[] = [];
    o.page.on("pageerror", (e: any) => errors.push(String(e)));
    o.page.on("response", async (res: any) => { if (res.url().includes("/ui/workspace?")) try { answers.push({ op: new URL(res.url()).searchParams.get("op")!, text: await res.text() }); } catch {} });
    if (mode === "old-css") {
      for (const asset of ["app.css", "workspace.css"]) await o.page.route(`**/assets/${asset}*`, (route: any) => route.fulfill({ status: 200, contentType: "text/css", body: old(`shared/${asset}`) }));
      await o.page.reload();
    } else if (mode === "old-panel") { await o.page.route("**/ui/js/workspace-panel.js*", (route: any) => route.fulfill({ status: 200, contentType: "text/javascript", body: old("workspace-panel.js") })); await o.page.reload(); }
    await o.page.waitForSelector(".p-chat");
    await o.page.evaluate(() => { const b = [...document.querySelectorAll(".p-chat .panel-head button")].find(e => ["More actions", "更多動作"].includes(e.getAttribute("aria-label") || "")) as HTMLButtonElement; b.click(); });
    await o.page.getByRole("menuitem", { name: c.lang === "en" ? "Files & changes" : "檔案與變更", exact: true }).click();
    await o.page.waitForSelector(".ws-summary");
    const geometry = async () => o.page.evaluate(() => { const p = document.querySelector(".ws-panel")!.getBoundingClientRect(); return { x: p.x, width: p.width, vw: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth }; });
    const before = await geometry(); check(before.overflow <= 1, `${tag} page overflow`);
    check(c.device !== "phone" || before.x === 0 && before.width === before.vw, `${tag} phone sheet`);
    check(!answers.some(a => a.op === "follow"), `${tag} default-off polled`);
    if (mode === "current") await o.page.screenshot({ path: shotPath("workspace-follow-3160", tag, "before") });
    if (mode !== "old-panel") {
      await o.page.click(".ws-follow"); await driver.step(0);
      await o.page.waitForSelector(".ws-line.hl-read");
      check(await o.page.locator(".ws-line.hl-read").count() === 3, `${tag} read range`);
      check(await o.page.locator(".ws-follow").getAttribute("aria-pressed") === "true", `${tag} auto scroll paused Follow`);
      // A genuine browser scroll pauses immediately. A new search updates only the strip until Resume.
      await o.page.evaluate(() => { document.querySelector(".ws-body")!.scrollTop = 250; });
      await o.page.waitForFunction(() => document.querySelector(".ws-follow")!.getAttribute("aria-pressed") === "false");
      await driver.step(1); await o.page.waitForFunction(() => document.querySelectorAll(".ws-step").length === 2);
      check(await o.page.locator(".ws-viewer-head .ws-path").textContent() === "src/a.ts", `${tag} paused search moved file`);
      // Hold automatic directory navigation, then turn Follow off: the accepted file must remain after response.
      let entered!: () => void, release!: () => void, continued!: () => void, held = false;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const resumed = new Promise<void>(resolve => { continued = resolve; });
      const matchDir = (url: string) => { const q = new URL(url); return q.pathname === "/ui/workspace" && q.searchParams.get("op") === "list" && q.searchParams.get("path") === "src"; };
      const holdDirectory = async (route: any) => { const hold = !held && matchDir(route.request().url()); if (hold) { held = true; entered(); await gate; } await route.continue(); if (hold) continued(); };
      await o.page.route("**/ui/workspace?**", holdDirectory);
      await o.page.click(".ws-follow");
      await Promise.race([started, o.page.waitForTimeout(15000).then(() => { throw Error(`${tag} directory hold not reached`); })]);
      await o.page.click(".ws-follow");
      const directoryResponse = o.page.waitForResponse((r: any) => matchDir(r.url()));
      release(); await resumed; await o.page.unroute("**/ui/workspace?**", holdDirectory);
      await (await directoryResponse).finished(); await o.page.waitForTimeout(100);
      check(await o.page.locator(".ws-viewer-head .ws-path").textContent() === "src/a.ts", `${tag} cancelled directory replaced accepted view`);
      check(await o.page.locator(".ws-follow").getAttribute("aria-pressed") === "false", `${tag} cancelled directory resumed Follow`);
      await o.page.click(".ws-follow"); await o.page.waitForSelector(".ws-entries");
      await driver.step(2); await o.page.waitForSelector(".ws-line.hl-edit");
      const highlighted = await o.page.locator(".ws-line.hl-edit").evaluateAll((els: Element[]) => els.map(e => Number(e.getAttribute("data-line"))));
      check(highlighted.includes(2) && (backend !== "claude" || highlighted.length === 1), `${tag} edit highlights ${highlighted}`);
      check((await o.page.locator(".ws-text").textContent()).includes("value = 2"), `${tag} completed edit did not refresh bytes`);
      if (mode === "current") await o.page.screenshot({ path: shotPath("workspace-follow-3160", tag, "after-edit") });
      await o.page.click(".ws-viewer-head button"); await o.page.waitForSelector(".ws-entries");
      await o.page.locator(".ws-entry-btn", { hasText: "manual.ts" }).click(); await o.page.waitForSelector(".ws-text");
      await driver.step(3); await driver.step(4); await o.page.waitForFunction(() => !!document.querySelector(".ws-step.is-hidden"));
      check(await o.page.locator(".ws-viewer-head .ws-path").textContent() === "src/manual.ts", `${tag} manual pin lost`);
      check(await o.page.locator(".ws-step.is-hidden").isDisabled(), `${tag} secret entry enabled`);
      const rail = await o.page.evaluate(() => {
        const el = document.querySelector(".ws-history") as HTMLElement;
        el.scrollLeft = el.scrollWidth;
        return { scrollable: el.scrollWidth >= el.clientWidth, lastReachable: el.lastElementChild!.getBoundingClientRect().right <= el.getBoundingClientRect().right + 1 };
      });
      check(rail.scrollable && rail.lastReachable, `${tag} history chip cannot be reached`);
      if (mode === "current") await o.page.screenshot({ path: shotPath("workspace-follow-3160", tag, "paused") });
    } else {
      check(await o.page.locator(".ws-follow").count() === 0, `${tag} old module was not old`);
      await o.page.locator(".ws-panel [role=tab]").nth(1).click(); await o.page.waitForSelector(".ws-entry");
    }
    const after = await geometry(); check(after.overflow <= 1, `${tag} after overflow`);
    await o.page.locator(".ws-panel .pv-panel-close:visible").click();
    const count = answers.filter(a => a.op === "follow").length; await o.page.waitForTimeout(1300);
    check(answers.filter(a => a.op === "follow").length === count, `${tag} polling continued after close`);
    check(!answers.some(a => /FOLLOW_PRIVATE_CANARY|FOLLOW_OUTSIDE_CANARY|outside\.txt/.test(a.text)), `${tag} content/outside leak`);
    check(!answers.some(a => a.op === "follow" && /NEEDLE|old_string|new_string/.test(a.text)), `${tag} pattern/edit text leaked into metadata`);
    check(errors.length === 0 && (await o.csp()).length === 0, `${tag} page/CSP errors ${errors}`);
    (results.cases as unknown[]).push({ tag, result: "PASS", before, after, followRequests: count });
    console.log(`${tag} PASS`); await o.ctx.close(); driver.stop();
  }
} finally { mkdirSync(join(REPO, ".artifacts"), { recursive: true }); writeFileSync(process.env.RESULTS || join(REPO, ".artifacts/follow3160-browser.json"), JSON.stringify(results, null, 2)); await fx.close(); }
console.log(`ALL PASS: ${(results.cases as unknown[]).length} cases`);
