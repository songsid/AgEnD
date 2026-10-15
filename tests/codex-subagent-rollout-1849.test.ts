/**
 * #1849: a codex instance finished its turn, the reply went out, and the instance stayed `working` (the working emoji
 * never cleared, the hang warning came after 10 minutes). Its footer read `Context 28% left · Main [default]`.
 *
 * `Main [default]` is codex's active-agent label (tui `active_agent_label`, appended to the footer with ` · ` once the
 * session has more than one thread, i.e. after `spawn_agent`). That footer already reads idle. What kept the instance
 * busy was the transcript: a subagent's rollout carries the parent's cwd and is the newest file while the subagent
 * works, so the rollout source followed it and read the subagent's turn as this CLI's open turn (#1641 makes an open
 * turn outrank the pane, and refuses stuck recovery).
 *
 * Fixtures: tests/fixtures/codex-01621-subagent-1849 — codex 0.162.1 run offline against a mock Responses API: the
 * idle pane after a spawn, and the session_meta / turn records of the main and subagent rollouts (cwd replaced).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexBackend } from "../src/backend/codex.js";
import { CodexRolloutSource } from "../src/transcript-sources.js";
import { TranscriptTurnLedger } from "../src/transcript-turns.js";
import { resetSharedRolloutIndexesForTests } from "../src/rollout-index.js";

const FIX = fileURLToPath(new URL("./fixtures/codex-01621-subagent-1849/", import.meta.url));
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");

describe("the #1849 footer reads idle", () => {
  const b = new CodexBackend("/tmp/codex-1849-probe");
  const pane = (footer: string) => ["• Done.", "", "› Ask Codex to do anything", "", footer].join("\n");
  it.each([
    ["with the warning suffix (the report)", "  Context 28% left · Main [default]                ⚠ 1 warning · f2 to view"],
    ["without it", "  Context 28% left · Main [default]"],
  ])("%s", (_name, footer) => {
    expect(b.getReadyPattern().test(pane(footer))).toBe(true);
    expect(b.getBusyPattern().test(pane(footer))).toBe(false);
    expect(b.isDeliveryInputReadyPane(pane(footer))).toBe(true);
    expect(b.isPeriodicRedrawIdlePane(pane(footer))).toBe(true);
  });

  it("the real codex 0.162.1 pane after a spawn", () => {
    const real = fixture("idle-main-default.pane.txt");
    expect(real).toContain("Context 100% left · Main [default]");
    expect(b.getReadyPattern().test(real)).toBe(true);
    expect(b.getBusyPattern().test(real)).toBe(false);
    expect(b.isPeriodicRedrawIdlePane(real)).toBe(true);
  });
});

describe("CodexRolloutSource never follows a subagent's rollout (#1849)", () => {
  let root: string;
  let work: string;
  let day: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agend-1849-"));
    work = join(root, "work");
    day = join(root, "sessions", "2026", "10", "15");
    mkdirSync(day, { recursive: true });
    resetSharedRolloutIndexesForTests(0);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const lines = (name: string) => fixture(name).replaceAll("__CWD__", work);
  const write = (name: string, content: string, mtimeSec: number) => {
    const path = join(day, name);
    writeFileSync(path, content);
    utimesSync(path, mtimeSec, mtimeSec);
    return path;
  };

  async function run(subMeta: string) {
    const now = Math.floor(Date.now() / 1000);
    const main = write("rollout-main.jsonl", lines("main-session-meta.jsonl"), now - 60);
    const source = new CodexRolloutSource(work, join(root, "sessions"));
    const ledger = new TranscriptTurnLedger();
    const poll = async () => {
      const events = await source.poll();
      ledger.observe([...(events.turns ?? []), ...source.takeTurns()]);
    };
    await poll();
    // The main turn: it spawns, answers and ends.
    appendFileSync(main, lines("main-turn.jsonl"));
    utimesSync(main, now - 30, now - 30);
    await poll();
    // The subagent keeps working after the main turn ended: its rollout is the newest file, its turn still open.
    const [subStart] = lines("subagent-turn.jsonl").trim().split("\n");
    write("rollout-sub.jsonl", `${subMeta}\n${subStart}\n`, now);
    await poll();
    return { source, ledger, main };
  }

  it("the real subagent rollout: the main stays followed and no turn is open", async () => {
    const { source, ledger, main } = await run(lines("subagent-session-meta.jsonl").trim());
    expect(source.currentPath()).toBe(main);
    expect(ledger.openSince()).toBeNull();
  });

  it("either marker alone is enough: thread_source, or source.subagent", async () => {
    const meta = JSON.parse(lines("subagent-session-meta.jsonl"));
    const onlyThreadSource = structuredClone(meta);
    onlyThreadSource.payload.source = "cli";
    const onlySource = structuredClone(meta);
    delete onlySource.payload.thread_source;
    for (const variant of [onlyThreadSource, onlySource]) {
      const { source, ledger, main } = await run(JSON.stringify(variant));
      expect(source.currentPath()).toBe(main);
      expect(ledger.openSince()).toBeNull();
      rmSync(join(day, "rollout-sub.jsonl"));
    }
  });

  it("a newer rollout of the CLI's own (no subagent marker) is still followed", async () => {
    const meta = JSON.parse(lines("subagent-session-meta.jsonl"));
    meta.payload.source = "cli";
    meta.payload.thread_source = "user";
    const { source, ledger } = await run(JSON.stringify(meta));
    expect(source.currentPath()).toBe(join(day, "rollout-sub.jsonl"));
    expect(ledger.openSince()).not.toBeNull();
  });
});
