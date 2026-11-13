/**
 * The chat's activity block for a Codex agent (#3787): the real production dashboard in Chromium over the smoke fixture, with
 * the real redacted Codex 0.160.0 rollout (tests/fixtures/chat-activity-3787) as that instance's transcript and the matching
 * chat ledger. Run it against a checkout WITHOUT the change for the "before" pictures and one with it for the "after":
 *
 *   REPO=<checkout> PW_DIR=<dir with node_modules/playwright-core> OUT=<dir> STAGE=before|after [MATRIX=full|quick|desk-dark-en,…] \
 *     npx tsx scripts/manual/smoke/smoke-chat-activity-codex-3787.mts
 *
 * The thread: two answered turns (the second compacted four times) and a third the agent is working on — its prompt, the
 * steps so far, no reply yet. `after` also opens the block of the answered turns and of the live one. Nothing is started: no
 * CLI, no tmux; the transcript is a file, the clock of its records is moved to now.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix, caseName, shotPath } from "../smoke-fixture/index.mts";

const here = new URL(".", import.meta.url).pathname;
const FIX = join(here, "..", "..", "..", "tests", "fixtures", "chat-activity-3787");
const stage = process.env.STAGE === "before" ? "before" : "after";
const level = process.env.LEVEL === "standard" ? "standard" : "verbose";
const lines = readFileSync(join(FIX, "codex-0.160.0-web-chat.jsonl"), "utf8").split("\n").filter(Boolean);
const ledger = JSON.parse(readFileSync(join(FIX, "codex-0.160.0-web-chat.ledger.json"), "utf8")) as Array<{ role: string; text: string; ts: string; anchor: string }>;

// The third turn is still running: its records stop before its reply call, and its reply is not in the chat yet.
const replyAt = lines.findIndex((l, i) => i > lines.findLastIndex((x) => x.includes('"type":"task_started"')) && l.includes('"type":"custom_tool_call"') && l.includes("mcp__agend__reply"));
if (replyAt < 0) throw new Error("the fixture has no third-turn reply call");
const live = lines.slice(0, replyAt);
const rows = ledger.slice(0, 5);

// Move the clock: the last record of the rollout is 40 s ago, every other record and row by the same amount.
const last = Date.parse(JSON.parse(live[live.length - 1]!).timestamp);
const shift = Date.now() - 40_000 - last;
const moved = (iso: string) => new Date(Date.parse(iso) + shift).toISOString();
const rollout = live.map((l) => { const e = JSON.parse(l); e.timestamp = moved(e.timestamp); return JSON.stringify(e); }).join("\n") + "\n";

const fx = await bootFixture({ port: Number(process.env.HP || 56120), instances: 4, classic: false });
try {
  const name = fx.instances.find((i) => !i.general)!.name;
  const cfg = fx.fm.fleetConfig.instances[name];
  cfg.backend = "codex";
  cfg.tool_progress = level;
  const path = join(fx.dir, "rollout-codex.jsonl");
  writeFileSync(path, rollout);
  const logSource = fx.fm.logSource.bind(fx.fm);
  fx.fm.logSource = (n: string) => (n === name ? { backend: "codex", path, format: "codex" } : logSource(n));
  fx.fm.getInstanceExecutionState = (n: string) => (n === name ? "working" : "idle");
  for (const r of rows) {
    fx.fm.emitSseEvent("message", { instance: name, sender: r.role === "user" ? "web-user" : name, role: r.role, text: r.text, ts: moved(r.ts), anchor: r.anchor });
  }
  mkdirSync(join(process.env.OUT ?? "/tmp/smoke-out", "chat-activity-codex-3787"), { recursive: true });
  const seen: string[] = [];
  for (const c of matrix()) {
    const { ctx, page } = await fx.page(c, { path: `/ui/chat/${encodeURIComponent(name)}` });
    page.on("pageerror", (e: Error) => seen.push(`${caseName(c)}: ${e.message}`));
    try {
      if (c.device === "desk") await page.setViewportSize({ width: 1366, height: 1300 });   // more of the thread in one picture
      await page.locator("#msgIn").waitFor({ timeout: 15000 });
      await page.waitForTimeout(2500);                      // history, the first read of the steps, the live line's clock
      // the thread's own scroller, found from its last row: the newest part is what the picture is about
      const toEnd = () => page.evaluate(() => {
        const last = [...document.querySelectorAll(".msg, .act-block")].pop();
        let p = last?.parentElement ?? null;
        while (p && !(p.scrollHeight > p.clientHeight + 5 && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
        if (p) p.scrollTop = p.scrollHeight;
      });
      if (stage === "after") {
        // open every block: the answered turns', and the live one (the steps of the turn the agent is on)
        for (let i = 0; i < 4; i++) {
          const closed = page.locator("details.act-block:not([open]) > summary").first();
          if (!(await closed.count())) break;
          await closed.click(); await page.waitForTimeout(150);
        }
        await page.waitForTimeout(400);
      }
      await toEnd(); await page.waitForTimeout(400);
      await page.screenshot({ path: shotPath("chat-activity-codex-3787", c, stage) });
      if (stage === "after") {
        // the first answered turn: the commands it ran, two of them failed
        await page.locator("details.act-block").first().scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
        await page.screenshot({ path: shotPath("chat-activity-codex-3787", c, "after-first-turn") });
      }
      const blocks = await page.locator("details.act-block").count(), status = await page.locator(".act-title").allTextContents();
      console.log(`${caseName(c)} ${stage}: ${blocks} blocks; titles: ${JSON.stringify(status.slice(0, 4))}`);
    } finally { await ctx.close(); }
  }
  if (seen.length) { console.error("page errors:\n" + seen.join("\n")); process.exitCode = 1; }
} finally { await fx.close(); }
