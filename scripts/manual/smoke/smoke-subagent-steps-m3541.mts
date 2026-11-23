/**
 * M-3541: background subagents in the web chat — the Subagents row and the steps list — on the real production dashboard
 * in Chromium over the smoke fixture. The scrubbed Claude Code 2.1.330 session (tests/fixtures/subagents-m3541) is one
 * instance's transcript, with its clock moved so that now is 7 s after the second subagent started (it is working). Run it
 * on a checkout without the change for "before" and with it for "after":
 *
 *   REPO=<checkout> FIX=<dir of tests/fixtures/subagents-m3541> PW_DIR=<dir with node_modules/playwright-core> OUT=<dir> \
 *     STAGE=before|after [MATRIX=quick|full|desk-dark-en,…] npx tsx scripts/manual/smoke/smoke-subagent-steps-m3541.mts
 *
 * Nothing is started: no CLI, no tmux, no account. The transcript and the subagent files are files.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix, caseName, shotPath } from "../smoke-fixture/index.mts";
import { SubagentService } from "../../../src/subagent-service.js";

const FIX = process.env.FIX!, stage = process.env.STAGE === "before" ? "before" : "after";
const SID = "49347c54-abf7-4d58-a5ab-928deaf3af33", IDS = ["a8e6fb7bda14b1cca", "ac284c031f1115d8e"];
const AT = Date.parse("2026-11-23T07:35:45Z"), shift = Date.now() - AT;
const move = (l: string) => { const e = JSON.parse(l); if (e.timestamp) e.timestamp = new Date(Date.parse(e.timestamp) + shift).toISOString(); return e; };
const read = (n: string) => readFileSync(join(FIX, n), "utf8").trim().split("\n");
const upTo = (lines: string[]) => lines.filter((l) => { const t = JSON.parse(l).timestamp; return !t || Date.parse(t) <= AT; });

const fx = await bootFixture({ port: Number(process.env.HP || 0), instances: 4, classic: false });
try {
  const name = fx.instances.find((i) => !i.general)!.name;
  const cfg = fx.fm.fleetConfig.instances[name]; cfg.backend = "claude-code"; cfg.working_directory = "/rig/work"; cfg.tool_progress = "verbose";
  const root = join(fx.dir, "claude-projects"), path = join(root, `${SID}.jsonl`);
  mkdirSync(join(root, SID, "subagents"), { recursive: true });
  const parent = upTo(read("claude-parent.jsonl"));
  writeFileSync(path, parent.map((l) => JSON.stringify(move(l))).join("\n") + "\n");
  for (const id of IDS) {
    const rs = upTo(read(`claude-agent-${id}.jsonl`)); if (!rs.length) continue;
    writeFileSync(join(root, SID, "subagents", `agent-${id}.jsonl`), rs.map((l) => JSON.stringify(move(l))).join("\n") + "\n");
    const meta = JSON.parse(readFileSync(join(FIX, `claude-agent-${id}.meta.json`), "utf8"));
    if (!parent.some((l) => l.includes(`<task-id>${id}</task-id>`))) delete meta.finished;   // finished once notified
    writeFileSync(join(root, SID, "subagents", `agent-${id}.meta.json`), JSON.stringify(meta));
  }
  const logSource = fx.fm.logSource.bind(fx.fm);
  fx.fm.logSource = (n: string) => (n === name ? { backend: "claude-code", path, format: "claude" } : logSource(n));
  fx.fm.subagentReader = new SubagentService((n) => (n === name ? { backend: "claude-code", sessionId: SID, cwd: "/rig/work", path, root, owner: "m3541" } : null));
  fx.fm.getInstanceExecutionState = (n: string) => (n === name ? "working" : "idle");
  const first = move(parent.find((l) => l.includes('"kind":"human"'))!);
  fx.fm.emitSseEvent("message", { instance: name, sender: "web-user", role: "user", text: "Please look at the two attached pictures.", ts: first.timestamp });
  fx.fm.emitSseEvent("message", { instance: name, sender: name, role: "assistant", text: "Two subagents are describing the pictures; I'll report when they finish.", ts: new Date(AT - 6000 + shift).toISOString() });
  mkdirSync(join(process.env.OUT ?? "/tmp/smoke-out", "subagent-steps-m3541"), { recursive: true });
  const seen: string[] = [];
  for (const c of matrix()) {
    const { ctx, page } = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(name)}` });
    page.on("pageerror", (e: Error) => seen.push(`${caseName(c)}: ${e.message}`));
    try {
      await page.locator("#msgIn").waitFor({ timeout: 15000 });
      await page.waitForTimeout(2500);
      for (let i = 0; i < 4; i++) {
        const closed = page.locator("details.act-block:not([open]) > summary").first();
        if (!(await closed.count())) break; await closed.click(); await page.waitForTimeout(150);
      }
      const row = page.locator(".subagent-progress > summary");
      if (await row.count()) { await row.click(); await page.waitForTimeout(200); }
      await page.screenshot({ path: shotPath("subagent-steps-m3541", c, stage) });
      const marks = await page.locator(".act-block .log-status").allTextContents();
      const runs = await page.locator(".subagent-item strong").allTextContents();
      console.log(caseName(c), stage, JSON.stringify({ subagents: runs, stepMarks: marks }));
    } finally { await ctx.close(); }
  }
  if (seen.length) { console.error("page errors:", seen); process.exitCode = 1; }
} finally { await fx.close(); }
