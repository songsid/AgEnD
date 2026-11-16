/**
 * M-3239: a beta.7 rehearsal stalled 1.5 h. Its agent ended a turn at 08:20:53Z on a question in its own pane ("send the summary
 * now, or re-run first?") and sent no fleet message, so nobody saw it; and the board's one-hour quiet notice never came,
 * because at 09:14Z Claude compacted its context on its own, idle, and the pane's spinner for those 85 s counted as work.
 *
 * 1. For an agent whose transcript tells its turns (Claude, Codex), progress is a tool call or an answer, not the spinner.
 * 2. A turn that ends on a question, with no fleet message, tells the dispatcher of each card it holds — quoting it.
 *
 * Transcript lines: tests/fixtures/turn-question-m3239/SOURCES.md.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  judgeAssignee, livenessSettings, questionNotices, sendsFleetMessage, stillStopped, turnQuestion, TurnWatch,
  LIVENESS_STARTUP_GRACE_MS, type LivenessCard,
} from "../src/dispatcher-liveness.js";
import { claudeTranscriptRecord, codexToolRecord } from "../src/transcript-records.js";
import { getLocale, setLocale } from "../src/locale.js";
import { FleetManager } from "../src/fleet-manager.js";

const priorLocale = getLocale();
afterAll(() => setLocale(priorLocale));
afterEach(() => { vi.useRealTimers(); });

const at = (iso: string) => Date.parse(iso);
const lines = (file: string) => readFileSync(new URL(`./fixtures/turn-question-m3239/${file}`, import.meta.url), "utf8")
  .trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
const QUESTION = "Do you want me to send the leader the summary and notes now and leave that browser re-check out, or re-run it into a new folder, with no deletion, first?";

/** Feed transcript records into a TurnWatch the way the daemon's monitor does, each at its own timestamp. */
function feedClaude(w: TurnWatch, records: Array<Record<string, any>>): void {
  for (const r of records) claudeTranscriptRecord(r, (...ev: any[]) => {
    const now = at(r.timestamp);
    if (ev[0] === "tool_use") w.tool(ev[1], ev[2], now);
    else if (ev[0] === "tool_result") w.result(now);
    else if (ev[0] === "assistant_text") w.text(ev[1], now);
  });
}
function feedCodex(w: TurnWatch, records: Array<Record<string, any>>): void {
  for (const r of records) {
    const events = { toolUses: [] as Array<{ name: string; input: unknown }>, toolResults: [] as unknown[], assistantTexts: [] as string[] };
    codexToolRecord(r, events as unknown as Parameters<typeof codexToolRecord>[1]);
    const now = at(r.timestamp);
    for (const u of events.toolUses) w.tool(u.name, u.input, now);
    for (const _ of events.toolResults) w.result(now);
    for (const t of events.assistantTexts) w.text(t, now);
  }
}

describe("M-3239 (1): the missed quiet notice — Claude compacting on its own is not progress", () => {
  function fleet() {
    const d = mkdtempSync(join(tmpdir(), "m3239-"));
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d) as unknown as Record<string, any>;
    fm.fleetConfig = { defaults: {}, instances: { "dev-b": { working_directory: d } } };
    fm.startedAt = at("2026-11-16T05:00:00Z");
    return { fm, done: () => rmSync(d, { recursive: true, force: true }) };
  }
  /** The pane's edges as the daemon sent them that afternoon (instance_state, with the transcript's last activity). */
  function replay(fm: Record<string, any>, turnEvidence: boolean) {
    const edge = (iso: string, state: string, activity: string | null) => {
      vi.setSystemTime(at(iso));
      fm.cacheInstanceExecutionState("dev-b", { state, ...(turnEvidence ? { turnEvidence: true, turnActivityAt: activity ? at(activity) : null } : {}) });
    };
    edge("2026-11-16T08:20:05Z", "working", "2026-11-16T08:08:53Z");
    edge("2026-11-16T08:20:55Z", "idle", "2026-11-16T08:20:53.370Z");      // the turn ends on its question
    edge("2026-11-16T09:14:42Z", "working", "2026-11-16T08:20:53.370Z");   // Claude's auto-compaction, idle (85 s)
    edge("2026-11-16T09:16:09Z", "idle", "2026-11-16T08:20:53.370Z");
  }
  const card = { claimedAt: at("2026-11-16T07:09:25.393Z"), updatedAt: at("2026-11-16T07:09:25.392Z") };
  const S = livenessSettings(null);

  it("the quiet clock runs from the question, so the notice comes at 09:21 — not after the compaction's 10:16", () => {
    vi.useFakeTimers();
    const { fm, done } = fleet();
    try {
      replay(fm, true);
      vi.setSystemTime(at("2026-11-16T09:21:00Z"));
      const f = fm.livenessFacts("dev-b");
      expect(f.lastWorkingAt).toBe(at("2026-11-16T08:20:53.370Z"));
      expect(judgeAssignee(f, card, S, Date.now())).toMatchObject({ kind: "quiet", since: at("2026-11-16T08:20:53.370Z") });
      expect(judgeAssignee(f, card, S, at("2026-11-16T09:20:53Z"))).toBeNull();
    } finally { done(); }
  });

  it("a later compaction does not read as 'working again' once the notice is out", () => {
    const facts = { process: "running" as const, execution: { state: "working" as const, since: at("2026-11-16T10:30:00Z") },
      lastWorkingAt: at("2026-11-16T08:20:53.370Z"), turnEvidence: true };
    expect(stillStopped({ kind: "quiet", since: at("2026-11-16T08:20:55Z") }, facts, card)).toBe(true);
    expect(stillStopped({ kind: "quiet", since: at("2026-11-16T08:20:55Z") }, { ...facts, lastWorkingAt: at("2026-11-16T10:30:05Z") }, card)).toBe(false);
  });

  it("a backend without transcript evidence keeps the pane's working edge as its progress", () => {
    vi.useFakeTimers();
    const { fm, done } = fleet();
    try {
      replay(fm, false);
      expect(fm.lastWorkingAt.get("dev-b")).toBe(at("2026-11-16T09:14:42Z"));
      vi.setSystemTime(at("2026-11-16T09:21:00Z"));
      expect(judgeAssignee(fm.livenessFacts("dev-b"), card, S, Date.now())).toBeNull();     // unchanged: its spinner is all it has
    } finally { done(); }
  });

  it("a fleet restart (Fable F1): transcript work at boot counts, and a resumed agent is not quiet from its card's claim", () => {
    vi.useFakeTimers();
    const { fm, done } = fleet();
    try {
      fm.startedAt = at("2026-11-16T10:00:00Z");
      const c7 = { claimedAt: at("2026-11-16T07:00:00Z"), updatedAt: at("2026-11-16T07:00:00Z") };
      const edge = (iso: string, state: string) => {
        vi.setSystemTime(at(iso));
        fm.cacheInstanceExecutionState("dev-b", { state, turnEvidence: true, turnActivityAt: at(iso) });
      };
      edge("2026-11-16T10:00:30Z", "working");               // resumed at once …
      edge("2026-11-16T10:03:00Z", "idle");                  // … and now waits on CI
      vi.setSystemTime(at("2026-11-16T10:06:00Z"));
      expect(fm.lastWorkingAt.get("dev-b")).toBe(at("2026-11-16T10:03:00Z"));
      expect(judgeAssignee(fm.livenessFacts("dev-b"), c7, S, Date.now())).toBeNull();
      expect(judgeAssignee(fm.livenessFacts("dev-b"), c7, S, at("2026-11-16T11:03:00Z"))).toMatchObject({ kind: "quiet", since: at("2026-11-16T10:03:00Z") });
      // Nothing in its transcript since the restart: quiet counts from the fleet's start, never from the claim.
      fm.lastWorkingAt.delete("dev-b");
      expect(judgeAssignee(fm.livenessFacts("dev-b"), c7, S, at("2026-11-16T10:59:59Z"))).toBeNull();
      expect(judgeAssignee(fm.livenessFacts("dev-b"), c7, S, at("2026-11-16T11:00:00Z"))).toMatchObject({ kind: "quiet", since: at("2026-11-16T10:00:00Z") });
      // Older than this fleet: not progress (a line from before the restart).
      fm.noteTurnActivity("dev-b", at("2026-11-16T09:59:59Z"));
      expect(fm.lastWorkingAt.has("dev-b")).toBe(false);
      // The floor is no progress: an episode told before the restart is still stopped.
      expect(stillStopped({ kind: "quiet", since: at("2026-11-16T08:00:00Z") }, fm.livenessFacts("dev-b"), c7)).toBe(true);
    } finally { done(); }
  });
});

describe("M-3239 (2): the turn as the transcript tells it", () => {
  it("Claude: the rehearsal turn ends on its question, having messaged no one; the compaction after it is no turn", () => {
    const all = lines("claude-rehearsal.jsonl");
    const w = new TurnWatch();
    w.begin(at("2026-11-16T08:20:35Z"));
    feedClaude(w, all.filter((r) => r.timestamp < "2026-11-16T09"));
    const turn = w.end()!;
    expect(turn.messaged).toBe(false);
    expect(turnQuestion(turn.text)).toBe(QUESTION);
    expect(w.activityAt).toBe(at("2026-11-16T08:20:53.370Z"));
    w.begin(at("2026-11-16T09:14:42Z"));
    feedClaude(w, all.filter((r) => r.timestamp >= "2026-11-16T09"));
    expect(w.end()).toEqual({ startedAt: at("2026-11-16T09:14:42Z"), text: "", messaged: false });
    expect(w.activityAt).toBe(at("2026-11-16T08:20:53.370Z"));            // no progress from the compaction
  });

  it("Codex: the final answer after its last call is the turn's text; its commentary before the call is not", () => {
    const w = new TurnWatch();
    w.begin(at("2026-11-16T09:24:50Z"));
    feedCodex(w, lines("codex-question.rollout.jsonl"));
    const turn = w.end()!;
    expect(turn.messaged).toBe(false);
    expect(turn.text).not.toMatch(/I’ll check/);
    expect(turnQuestion(turn.text)).toBe("Should I re-run it into a new folder first, or send the summary now?");
  });

  it("Codex: a turn whose code-mode script called send_to_instance messaged someone — nothing to tell", () => {
    const w = new TurnWatch();
    w.begin(at("2026-11-16T09:24:50Z"));
    feedCodex(w, lines("codex-messaged.rollout.jsonl"));
    expect(w.end()!.messaged).toBe(true);
  });

  it("the fleet's message tools, by Claude's and Codex's names; any other tool is not a message", () => {
    for (const n of ["mcp__agend__reply", "mcp__agend__send_to_instance", "mcp__agend__report_result", "mcp__agend__delegate_task",
      "mcp__agend__request_information", "mcp__agend__broadcast", "mcp__agend_agend_dev_sol_t1__report_result"]) expect(sendsFleetMessage(n, {})).toBe(true);
    for (const n of ["mcp__agend__task", "mcp__agend__list_instances", "mcp__other__reply", "Bash", "reply"]) expect(sendsFleetMessage(n, {})).toBe(false);
    expect(sendsFleetMessage("exec", "await tools.mcp__agend_x_t1__reply({text:'hi'})")).toBe(true);
    expect(sendsFleetMessage("exec", "await tools.mcp__agend_x_t1__task({action:'get'})")).toBe(false);
  });
});

describe("M-3239 (2): a question, and no false alarm on a normal finish", () => {
  it("normal finishes ask nothing", () => {
    for (const text of [
      ".", "Done — #4037 merged at 4ca66795; M-3219 is in review.\n\n.",
      "Why did it fail? The lightbox swipe was measured mid-slide. Fixed in #4042.",              // a question answered, earlier
      "Pushed `curl 'https://x.test/a?b=1'` and https://github.com/o/r/pull/1?tab=checks — CI green.",
      "| Check | Result |\n|---|---|\n| ready? | yes |",
      "```\nread -p 'Continue?'\n```\nThe script no longer prompts.",
      "Asked the leader whether to cut beta.8 now; waiting for the answer.",
    ]) expect(turnQuestion(text), text).toBeNull();
  });
  it("a question in the last paragraph is quoted as said (full-width too), bold markers and all", () => {
    expect(turnQuestion("Summary.\n\nShould I open the PR now?\n")).toBe("Should I open the PR now?");
    expect(turnQuestion("排練通過。\n\n要現在送出摘要，還是先重跑？")).toBe("要現在送出摘要，還是先重跑？");
    expect(turnQuestion("Two options.\n\n**Which do you want?**")).toBe("**Which do you want?**");
    expect(turnQuestion(`Done.\n\n${"x".repeat(500)} ok?`)!.length).toBe(400);
  });
});

describe("M-3239 (2): who is told", () => {
  const card = (code: string, assignee: string, dispatcher: LivenessCard["dispatcher"]): LivenessCard =>
    ({ uuid: `u-${code}`, code, title: `Work ${code}`, assignee, dispatcher, claimedAt: 1, updatedAt: 1 });
  const lead = { kind: "instance" as const, name: "lead" };
  const isAgent = (n: string) => n === "lead" || n === "other-lead";

  it("each agent dispatcher once, naming its cards and quoting the question; a person, itself or a non-agent is not", () => {
    setLocale("en");
    const cards = [card("M-1", "dev-b", lead), card("M-2", "dev-b", lead), card("M-3", "dev-b", { kind: "instance", name: "other-lead" }),
      card("M-4", "dev-b", { kind: "person", name: "lead" }), card("M-5", "dev-b", { kind: "instance", name: "dev-b" }),
      card("M-6", "dev-b", { kind: "instance", name: "gone" }), card("M-7", "dev-c", lead), card("M-8", "dev-b", null)];
    const got = questionNotices(cards, "dev-b", "Send now, or re-run first?", 42, isAgent);
    expect(got.map((n) => [n.dispatcher, n.key])).toEqual([["lead", "task-question:lead:dev-b:42"], ["other-lead", "task-question:other-lead:dev-b:42"]]);
    expect(got[0]!.message).toBe('[Task board] M-1 "Work M-1", M-2 "Work M-2" — its assignee dev-b ended its turn on a question and sent it to no one; '
      + 'it is only on its own screen: "Send now, or re-run first?" Answer it with send_to_instance. Read it with: task get M-1');
  });
  it("in the fleet's language", () => {
    setLocale("zh-TW");
    expect(questionNotices([card("M-1", "dev-b", lead)], "dev-b", "要現在送出嗎？", 1, isAgent)[0]!.message)
      .toBe("[Task board] M-1 \"Work M-1\"：接手的 dev-b 這一輪最後問了一個問題，但沒有發給任何人，只留在它自己的畫面上：「要現在送出嗎？」請用 send_to_instance 回答它。查看：task get M-1");
  });
});

describe("M-3239: the wiring", () => {
  it("daemon: the idle edge, after the transcript settles, sends the turn's text — not when it messaged, nor when the turn went on", async () => {
    vi.useFakeTimers();
    const { Daemon } = await import("../src/daemon.js");
    const sent: any[] = [];
    const d = Object.assign(Object.create(Daemon.prototype), {
      name: "dev-b", instanceState: "working", turnWatch: new TurnWatch(), turnEndTimer: null, turnActivitySentAt: 0,
      backend: { binaryName: "claude" }, transcriptMonitor: { following: () => true },
      broadcastFleetMessage: (m: any) => sent.push(m),
    }) as any;
    const edge = (state: string) => { d.instanceState = state; d.noteTurnEdge(state); };
    edge("working"); d.turnWatch.text("Done. Should I open the PR?", Date.now());
    edge("idle"); edge("working"); await vi.advanceTimersByTimeAsync(10_000);   // went on: nothing yet
    expect(sent).toEqual([]);
    edge("idle"); await vi.advanceTimersByTimeAsync(4_999);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([expect.objectContaining({ type: "turn_ended", instanceName: "dev-b", text: "Done. Should I open the PR?" })]);
    edge("working"); d.turnWatch.tool("mcp__agend__reply", { text: "Should I?" }, Date.now()); d.turnWatch.text("Asked. Anything else?", Date.now());
    edge("idle"); await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(1);
    d.backend = { binaryName: "kiro-cli" };                                         // no transcript evidence: no notice
    edge("working"); d.turnWatch.text("Should I?", Date.now()); edge("idle"); await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(1);
  });

  it("fleet: a quiet question turn tells the dispatcher once; a turn that sent a message, or a normal finish, tells no one", async () => {
    setLocale("en");
    const { Scheduler } = await import("../src/scheduler/index.js");
    const d = mkdtempSync(join(tmpdir(), "m3239-wire-"));
    try {
      writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
      const fm = new FleetManager(d) as unknown as Record<string, any>;
      fm.fleetConfig = { defaults: {}, instances: { lead: { working_directory: d }, "dev-b": { working_directory: d } } };
      const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
      fm.scheduler = scheduler;
      const made = scheduler.db.board.createCards({ kind: "instance", name: "lead" }, { cards: [{ title: "beta.7 rehearsal", assignee: "dev-b" }] }) as unknown as { cards: Array<{ uuid: string; code: string }> };
      scheduler.db.updateTask(made.cards[0]!.uuid, { status: "claimed" }, { kind: "instance", name: "dev-b" });
      let lastSent: number | null = null;
      fm.deliveryOutbox = { isOpen: true, latestSentAt: () => lastSent };
      const told: Array<[string, string, string]> = [];
      fm.admitTaskBoardNotice = (to: string, text: string, key: string) => { told.push([to, text, key]); return true; };
      fm.onTurnEndedQuietly("dev-b", 1000, "All green.\n\nShould I send the summary now?");
      expect(told).toHaveLength(1);
      expect(told[0]![0]).toBe("lead");
      expect(told[0]![1]).toContain(`${made.cards[0]!.code} "beta.7 rehearsal" — its assignee dev-b ended its turn on a question`);
      expect(told[0]![1]).toContain('"Should I send the summary now?"');
      lastSent = 1500;                                                     // it replied during the turn
      fm.onTurnEndedQuietly("dev-b", 1000, "Should I send the summary now?");
      fm.onTurnEndedQuietly("dev-b", 2000, "Summary sent. PR #1 is open.");
      expect(told).toHaveLength(1);
      fm.fleetConfig.defaults = { task_board: { liveness: { enabled: false } } };
      fm.onTurnEndedQuietly("dev-b", 3000, "Should I?");
      expect(told).toHaveLength(1);
      scheduler.db.close();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

