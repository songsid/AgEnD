/**
 * grok's live line says WHERE grok is — "Reasoning…", "Running a tool…" — not only "Working…". Source (what Multica and
 * Paperclip also use: structured state, never the screen): grok's own `events.jsonl`, written as it happens (a `phase_changed` at
 * each phase; `updates.jsonl` gets a thought only when it ends). Fixture: tests/fixtures/chat-activity-3648/grok-events-phases.jsonl,
 * a real, redacted `events.jsonl` of the preview's `grok-try` (two turns: one complete, one open and reasoning).
 *
 * Counter-proofs: before this change the service answered no `phase` and the page had no word for one, so every test here that
 * reads `phase` fails on the previous code; the safety tests (path, unknown value, missing file, symlink) pin what is NOT shown.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LogService, type LogServiceDeps } from "../src/log-service.js";
import { GROK_EVENTS_TAIL_BYTES, grokPhaseOf, readGrokPhase } from "../src/log-steps-agy-grok.js";
import { grokEventsPath, grokUpdatesPath } from "../src/log-transcript-paths.js";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { installDom } from "./helpers/mini-dom.js";
// @ts-expect-error — a JS module of the app, with no types
import { groupSteps, composeRows } from "../src/ui/chat-activity-groups.js";

type Mod = any;
let thread: Mod, act: Mod, i18n: Mod;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  thread = await import("/ui/js/chat-thread.js");
  act = await import("/ui/js/chat-activity.js");
  await import("/ui/js/chat-strings.js");
  i18n = await import("/assets/app-i18n.js");
  base.restore();
});
let pg: AppPage | null = null;
const dirs: string[] = [];
afterEach(async () => { await pg?.unmount(); pg?.restore(); pg = null; act.forgetActivity(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
void h;

const FIX = join(import.meta.dirname, "fixtures", "chat-activity-3648");
const events = readFileSync(join(FIX, "grok-events-phases.jsonl"), "utf8").split("\n").filter(Boolean);
const SESSION = "01a1ce90-0114-7dc2-9d69-da3fddae4e20";
const ev = (type: string, rest: Record<string, unknown> = {}) => JSON.stringify({ ts: "2026-11-12T07:00:00.000Z", type, ...rest });
const phase = (p: string) => ev("phase_changed", { phase: p });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-228-")); dirs.push(d); return d; };
/** `<tmp>/.grok/sessions/<cwd>/<uuid>/` with an `updates.jsonl` (a prompt) and the given `events.jsonl` lines. */
const session = (lines: string[] | null, id = SESSION) => {
  const dir = join(scratch(), ".grok", "sessions", "%2Fwork", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "updates.jsonl"), JSON.stringify({ timestamp: 1, method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } }, _meta: { agentTimestampMs: 1000 } } }) + "\n");
  if (lines) writeFileSync(join(dir, "events.jsonl"), lines.join("\n") + "\n");
  return { dir, updates: join(dir, "updates.jsonl"), events: join(dir, "events.jsonl") };
};

describe("grokPhaseOf — the real events.jsonl", () => {
  const phases = (lines: string[]) => grokPhaseOf(lines);
  it("the fixture is the real thing: five phase values, a turn_started and a turn_ended", () => {
    const seen = new Set(events.map((l) => JSON.parse(l)).filter((r) => r.type === "phase_changed").map((r) => r.phase));
    expect([...seen].sort()).toEqual(["permission_prompt", "streaming_reasoning", "streaming_text", "tool_execution", "waiting_for_model"]);
    expect(events.filter((l) => l.includes('"turn_ended"'))).toHaveLength(1);
  });
  it("the open turn at the end of the file is reasoning", () => {
    expect(phases(events)).toBe("reasoning");
  });
  it("walking the first turn line by line: waiting → reasoning → tool → permission → … → text → (turn_ended) none", () => {
    const seen: (string | null)[] = [];
    const end = events.findIndex((l) => l.includes('"turn_ended"'));
    for (let i = 1; i <= end + 1; i++) { const p = phases(events.slice(0, i)); if (seen[seen.length - 1] !== p) seen.push(p); }
    expect(seen[0]).toBe("waiting");                                       // turn_started
    expect(seen).toContain("reasoning");
    expect(seen).toContain("tool");
    expect(seen).toContain("permission");
    expect(seen).toContain("text");
    expect(seen[seen.length - 1]).toBeNull();                              // turn_ended: nothing is live
  });
  it("a turn_started with no phase yet is waiting; a finished turn is none; no lines is none", () => {
    expect(phases([ev("turn_started", { turn_number: 1 })])).toBe("waiting");
    expect(phases([ev("turn_started"), phase("streaming_text"), ev("turn_ended", { outcome: "completed" })])).toBeNull();
    expect(phases([])).toBeNull();
    expect(phases([ev("mcp_init_completed"), ev("loop_started")])).toBeNull();
  });
  it("an unknown phase value (a newer grok) is none — never a guessed word — and the next known one is back", () => {
    expect(phases([phase("streaming_reasoning"), phase("compacting_context")])).toBeNull();
    expect(phases([phase("compacting_context"), phase("tool_execution")])).toBe("tool");
    expect(phases([phase("__proto__"), phase("constructor"), phase("toString")])).toBeNull();
  });
  it("damaged lines and lines of other types are skipped, and only `type` / `phase` decide", () => {
    expect(phases([phase("tool_execution"), "{\"ts\":\"x\",\"type\":\"phase_changed\",\"phase\":\"streaming_te", "not json"])).toBe("tool");
    // a record that merely CONTAINS the text of a phase line (a tool argument) is not one
    expect(phases([phase("streaming_reasoning"), ev("tool_started", { tool_name: '{"type":"phase_changed","phase":"tool_execution"}' })])).toBe("reasoning");
    expect(phases([phase("streaming_reasoning"), ev("phase_changed", { phase: 5 })])).toBeNull();
  });
});

describe("grokEventsPath — only the validated session directory's own file", () => {
  it("beside updates.jsonl of a session whose directory is a uuid", () => {
    expect(grokEventsPath(`/h/.grok/sessions/%2Fw/${SESSION}/updates.jsonl`)).toBe(`/h/.grok/sessions/%2Fw/${SESSION}/events.jsonl`);
  });
  it("path escape and other shapes: none", () => {
    for (const p of [
      `/h/.grok/sessions/%2Fw/../../../../etc/updates.jsonl`, `/h/.grok/sessions/%2Fw/${SESSION}/../x/updates.jsonl`, `/h/.grok/sessions/%2Fw/not-a-uuid/updates.jsonl`,
      `/h/.grok/sessions/%2Fw/${SESSION}/transcript.jsonl`, `/h/.grok/sessions/%2Fw/${SESSION}/events.jsonl`, `${SESSION}/updates.jsonl.bak`, "", "updates.jsonl",
    ]) expect(grokEventsPath(p), p).toBeNull();
    expect(grokEventsPath(null)).toBeNull();
    expect(grokEventsPath(undefined)).toBeNull();
  });
});

describe("readGrokPhase — a file read that cannot hurt", () => {
  it("no such file / a directory / a symlink (even to a real events file): none", async () => {
    const s = session(events);
    expect(await readGrokPhase(join(s.dir, "nope.jsonl"))).toBeNull();
    expect(await readGrokPhase(s.dir)).toBeNull();
    const d = scratch(); const link = join(d, "events.jsonl");
    symlinkSync(s.events, link);
    expect(await readGrokPhase(link)).toBeNull();
    expect(await readGrokPhase(s.events)).toBe("reasoning");
    expect(await readGrokPhase(null)).toBeNull();
  });
  it("an empty file is none", async () => {
    const s = session([]);
    writeFileSync(s.events, "");
    expect(await readGrokPhase(s.events)).toBeNull();
  });
  it("a long file: only its end is read (a window starting mid-line loses that line, not the answer)", async () => {
    const filler = Array.from({ length: Math.ceil(GROK_EVENTS_TAIL_BYTES / 60) * 3 }, () => phase("streaming_reasoning"));
    const s = session([ev("turn_started"), ...filler, phase("tool_execution")]);
    expect(await readGrokPhase(s.events)).toBe("tool");
    // the newest line itself is cut by the window: the line before it decides
    const s2 = session([...filler, phase("tool_execution"), "x".repeat(10)]);
    expect(await readGrokPhase(s2.events)).toBe("tool");
  });
});

describe("readGrokPhase — a FIFO in the file's place never blocks (review of #3739, P2-1)", () => {
  it.skipIf(process.platform === "win32")("a FIFO named events.jsonl is refused at once, within a timeout", async () => {
    const s = session(null);
    execFileSync("mkfifo", [s.events]);
    let release: number | null = null;
    try {
      const outcome = await Promise.race([
        readGrokPhase(s.events).then((v) => ({ done: true as const, v })),
        new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), 2000)),
      ]);
      expect(outcome).toEqual({ done: true, v: null });             // without O_NONBLOCK the open waits for a writer: done is false
    } finally {
      // if the open did block, let it go (a writer arrives) so the test run does not keep a stuck thread
      try { release = openSync(s.events, constants.O_RDWR | constants.O_NONBLOCK); } catch { /* nothing to release */ }
      if (release !== null) closeSync(release);
    }
  }, 10_000);
});

describe("readGrokPhase — the session directory must really be the cwd root's own child (review of #3739, P2-2)", () => {
  /** `<root>/.grok/sessions/<cwd>/` for two cwds, each with one real session; `a` is the one asked about. */
  const twoCwds = () => {
    const home = scratch();
    const sessions = join(home, ".grok", "sessions");
    const mk = (cwd: string, id: string, lines: string[]) => {
      const dir = join(sessions, encodeURIComponent(cwd), id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "updates.jsonl"), "{}\n");
      writeFileSync(join(dir, "events.jsonl"), lines.join("\n") + "\n");
      return dir;
    };
    return { home, sessions, mk };
  };
  const OTHER = "01a1ce90-0114-7dc2-9d69-da3fddae4e21";

  it("control: an ordinary session directory is read as before", async () => {
    const { mk } = twoCwds();
    const dir = mk("/work/a", SESSION, [ev("turn_started"), phase("streaming_reasoning")]);
    expect(await readGrokPhase(join(dir, "events.jsonl"))).toBe("reasoning");
  });

  it("<cwd-a>/<uuid> a symlink to another cwd's session: refused (its events are not this cwd's)", async () => {
    const { sessions, mk } = twoCwds();
    const foreign = mk("/work/b", OTHER, [ev("turn_started"), phase("tool_execution")]);
    const linked = join(sessions, encodeURIComponent("/work/a"), SESSION);
    mkdirSync(join(sessions, encodeURIComponent("/work/a")), { recursive: true });
    symlinkSync(foreign, linked, "dir");
    expect(await readGrokPhase(join(linked, "events.jsonl"))).toBeNull();     // without the directory check: "tool"
    expect(await readGrokPhase(join(foreign, "events.jsonl"))).toBe("tool");   // the real one is unharmed
  });

  it("the lookup itself does not pick a symlinked session directory, even when it is the newest", () => {
    const { home, sessions, mk } = twoCwds();
    const own = mk("/work/a", SESSION, [ev("turn_started")]);
    const foreign = mk("/work/b", OTHER, [ev("turn_started")]);
    const linked = join(sessions, encodeURIComponent("/work/a"), "01a1ce90-0114-7dc2-9d69-da3fddae4e22");
    symlinkSync(foreign, linked, "dir");
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(foreign, "updates.jsonl"), future, future);               // the foreign one is the newest of all
    expect(grokUpdatesPath("/work/a", home)).toBe(join(own, "updates.jsonl"));  // without the check: the symlinked one
  });

  it("the directory is swapped for a symlink to another cwd's while the file is being read: refused", async () => {
    const { sessions, mk } = twoCwds();
    const dir = mk("/work/a", SESSION, [ev("turn_started"), phase("streaming_reasoning")]);
    const foreign = mk("/work/b", OTHER, [ev("turn_started"), phase("tool_execution")]);
    void sessions;
    const got = await readGrokPhase(join(dir, "events.jsonl"), {
      afterOpen: () => { renameSync(dir, `${dir}.moved`); symlinkSync(foreign, dir, "dir"); },
    });
    expect(got).toBeNull();                                                    // without the second check: "reasoning" (the opened file)
  });

  it("the directory is replaced by another real directory (another inode) during the read: refused", async () => {
    const { mk } = twoCwds();
    const dir = mk("/work/a", SESSION, [ev("turn_started"), phase("streaming_reasoning")]);
    const got = await readGrokPhase(join(dir, "events.jsonl"), {
      afterOpen: () => {
        renameSync(dir, `${dir}.moved`);
        mkdirSync(dir);
        writeFileSync(join(dir, "events.jsonl"), [ev("turn_started"), phase("tool_execution")].join("\n") + "\n");
      },
    });
    expect(got).toBeNull();
  });

  it("the service: a symlinked session directory shows no phase", async () => {
    const { sessions, mk } = twoCwds();
    const foreign = mk("/work/b", OTHER, [ev("turn_started"), phase("tool_execution")]);
    mkdirSync(join(sessions, encodeURIComponent("/work/a")), { recursive: true });
    const linked = join(sessions, encodeURIComponent("/work/a"), SESSION);
    symlinkSync(foreign, linked, "dir");
    const sv = new LogService({ enabled: () => false, toolProgress: () => "verbose", thinking: () => true, known: () => true, source: () => ({ backend: "grok", path: join(linked, "updates.jsonl"), format: "grok" }), events: () => [], emit: () => {} });
    expect("phase" in ((await sv.steps("x", { chat: true })) as any)).toBe(false);
  });
});

describe("the log service: the chat's answer carries the phase, and nothing else of events.jsonl", () => {
  const svc = (path: string, over: Partial<LogServiceDeps> = {}) => new LogService({ enabled: () => false, toolProgress: () => "verbose", thinking: () => true, known: () => true, source: () => ({ backend: "grok", path, format: "grok" }), events: () => [], emit: () => {}, ...over });
  it("chat: reasoning, then a tool, then none when the turn ends — read fresh at each answer", async () => {
    const s = session([ev("turn_started"), phase("streaming_reasoning")]);
    const sv = svc(s.updates);
    expect(((await sv.steps("x", { chat: true })) as any).phase).toBe("reasoning");
    appendFileSync(s.events, phase("tool_execution") + "\n");
    expect(((await sv.steps("x", { chat: true })) as any).phase).toBe("tool");
    appendFileSync(s.events, ev("turn_ended", { outcome: "completed" }) + "\n");
    expect("phase" in ((await sv.steps("x", { chat: true })) as any)).toBe(false);
  });
  it("the Log tab's own answer (not the chat's) has no phase", async () => {
    const s = session([ev("turn_started"), phase("streaming_reasoning")]);
    const a: any = await svc(s.updates, { enabled: () => true }).steps("x", {});
    expect(a.supported).toBe(true);
    expect("phase" in a).toBe(false);
  });
  it("no events.jsonl, an unknown phase, a non-uuid directory, tool_progress off: no phase, and the steps are unharmed", async () => {
    const none = session(null);
    const a: any = await svc(none.updates).steps("x", { chat: true });
    expect("phase" in a).toBe(false);
    expect(a.steps.map((x: any) => x.kind)).toEqual(["user"]);
    const unknown = session([ev("turn_started"), phase("somewhere_new")]);
    expect("phase" in ((await svc(unknown.updates).steps("x", { chat: true })) as any)).toBe(false);
    // the transcript is not in a uuid directory: the path is not one grok's, so its neighbour is never read
    const odd = session([ev("turn_started"), phase("streaming_reasoning")], "not-a-session-id");
    expect("phase" in ((await svc(odd.updates).steps("x", { chat: true })) as any)).toBe(false);
    const ok = session([ev("turn_started"), phase("streaming_reasoning")]);
    const off: any = await svc(ok.updates, { toolProgress: () => "off" }).steps("x", { chat: true });
    expect("phase" in off).toBe(false);
    expect(off.steps).toEqual([]);
  });
  it("only the phase leaves: a secret in the file's other fields and in other record types is in no part of the answer", async () => {
    const s = session([
      ev("mcp_server_starting", { target: "/bin/bash -c exec /data/instances/SECRET-INSTANCE/wrapper.sh", token: "SECRET-TOKEN-0123" }),
      ev("turn_started", { session_id: "SECRET-SESSION", model_id: "SECRET-MODEL" }),
      ev("tool_started", { tool_name: "SECRET-TOOL" }),
      JSON.stringify({ ts: "x", type: "phase_changed", phase: "tool_execution", note: "SECRET-NOTE", cwd: "/home/SECRET-USER" }),
    ]);
    const a: any = await svc(s.updates).steps("x", { chat: true });
    expect(a.phase).toBe("tool");
    expect(JSON.stringify(a)).not.toMatch(/SECRET/);
  });
  it("another backend's format never looks for an events file", async () => {
    const s = session([ev("turn_started"), phase("streaming_reasoning")]);
    const a: any = await svc(s.updates, { source: () => ({ backend: "antigravity", path: s.updates, format: "antigravity" }) }).steps("x", { chat: true });
    expect("phase" in a).toBe(false);
  });
});

describe("the watch: a change of phase is a tick, a repeat of it is not", () => {
  it("steps_tick when reasoning becomes a tool call — with updates.jsonl untouched — and not while one phase repeats", async () => {
    const s = session([ev("turn_started"), phase("streaming_reasoning")]);
    const ticks: unknown[] = []; let tick: () => void = () => {}; let clock = 0;
    const sv = new LogService({ enabled: () => false, toolProgress: () => "verbose", known: () => true, source: () => ({ backend: "grok", path: s.updates, format: "grok" }), events: () => [], emit: (e, d) => { if (e === "steps_tick") ticks.push(d); }, now: () => clock, setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => {} });
    await sv.steps("x", { chat: true, watch: true });
    const look = async () => { tick(); await new Promise((r) => setTimeout(r, 20)); };
    await look();
    expect(ticks).toHaveLength(0);                                          // nothing moved
    appendFileSync(s.events, phase("streaming_reasoning") + "\n"); await look();
    expect(ticks).toHaveLength(0);                                          // events.jsonl grew, the phase is the same: no tick
    appendFileSync(s.events, phase("tool_execution") + "\n"); await look();
    expect(ticks).toEqual([{ instance: "x" }]);                              // updates.jsonl did not change; the phase did
    await look();
    expect(ticks).toHaveLength(1);
    appendFileSync(s.events, ev("turn_ended", { outcome: "completed" }) + "\n"); await look();
    expect(ticks).toHaveLength(2);                                          // the turn is over: the line must go
    sv.unwatchAll();
  });
  it("the Log tab's watch never reads events.jsonl", async () => {
    const s = session([ev("turn_started"), phase("streaming_reasoning")]);
    const ticks: unknown[] = []; let tick: () => void = () => {};
    const sv = new LogService({ enabled: () => true, known: () => true, source: () => ({ backend: "grok", path: s.updates, format: "grok" }), events: () => [], emit: (e) => { ticks.push(e); }, now: () => 0, setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => {} });
    await sv.steps("x", { watch: true });
    appendFileSync(s.events, phase("tool_execution") + "\n"); tick(); await new Promise((r) => setTimeout(r, 20));
    expect(ticks).toHaveLength(0);
    sv.unwatchAll();
  });
});

describe("the page: the live line says where grok is", () => {
  const PROMPT = 1794462778828;
  const rows = [{ role: "user", boot: "b", id: "web-1", anchor: "web-1", text: "go", ts: new Date(PROMPT).toISOString() }];
  const prompt = { id: "u1", kind: "user", ts: PROMPT, anchor: { messageId: "web-1" } };
  const ctx = () => ({ paths: null, thinking: true });
  const mount = () => {
    pg = page({ storage: { agend_tour_done: "1" } });
    const doc = pg.document as any;
    const scroller = doc.createElement("div"), list = doc.createElement("div");
    scroller.append(list); doc.body.append(scroller);
    const th = thread.createThread(list, scroller, {
      t: (k: string) => i18n.t(k), tf: (k: string, ...a: unknown[]) => i18n.t(k, ...a), isUser: (x: any) => x.role === "user", onJump() {}, onEmpty() {},
      setPreviewOptIn() {}, copyText: async () => true, download() {}, toggleWrap() {},
      activity: { mount: (node: unknown, g: unknown) => act.mountActivity(node, g, ctx) },
    });
    return { list, th };
  };
  const title = async (steps: any[], o: Record<string, unknown>) => {
    const { list, th } = mount();
    th.render(composeRows(rows, groupSteps(rows, steps, { now: Date.now(), complete: true, busy: true, ...o })));
    await settle();
    return list.querySelector(".act-title").textContent as string;
  };
  it("each phase has its word, on an empty live group", async () => {
    for (const [p, key] of [["waiting", "ph_waiting"], ["reasoning", "ph_reasoning"], ["tool", "ph_tool"], ["permission", "ph_permission"], ["text", "ph_text"]] as const) {
      expect(await title([prompt], { phase: p })).toBe(i18n.t(`act.${key}`));
      await pg?.unmount(); pg?.restore(); pg = null;
    }
  });
  it("zh-TW: 推理中… / 執行工具中…", () => {
    const was = i18n.lang();
    expect(i18n.tIn("zh-TW", "act.ph_reasoning")).toBe("推理中…");
    expect(i18n.tIn("zh-TW", "act.ph_tool")).toBe("執行工具中…");
    expect(i18n.tIn("zh-TW", "act.ph_waiting")).not.toBe(i18n.tIn("en", "act.ph_waiting"));
    expect(i18n.lang()).toBe(was);
  });
  it("counter-proof: no phase (not grok, or a value not known) is the plain Working… line", async () => {
    expect(await title([prompt], {})).toBe(i18n.t("act.working"));
    await pg?.unmount(); pg?.restore(); pg = null;
    expect(await title([prompt], { phase: "somewhere_new" })).toBe(i18n.t("act.working"));
  });
  it("with steps: a finished call and the phase reasoning say Reasoning…; a call still running keeps its own line", async () => {
    const done = { id: "t1", kind: "tool", ts: PROMPT + 1000, tool: "read_file", cat: "read", status: "done", input: { path: "a.txt" } };
    expect(await title([prompt, done], { phase: "reasoning" })).toBe(i18n.t("act.ph_reasoning"));
    await pg?.unmount(); pg?.restore(); pg = null;
    const running = { ...done, status: "running" };
    expect(await title([prompt, running], { phase: "tool" })).not.toBe(i18n.t("act.ph_tool"));
  });
  it("the feed: an answer's phase reaches the live group, and an answer without one clears it", async () => {
    const answer = (extra: Record<string, unknown>) => ({ enabled: true, supported: true, level: "verbose", thinking: false, steps: [prompt], key: "1-1", after: 10, before: null, ev: 0, ...extra });
    let next: any = answer({ phase: "reasoning" });
    const feed = act.observeActivity("grok-228", { fetcher: async () => ({ ok: true, status: 200, json: async () => next }), changed() {}, working: () => true, setTimer: () => 0, clearTimer: () => {}, shown: () => true, now: () => PROMPT + 5000 });
    feed.start(); await settle(); await settle();
    const live = (r: any[]) => r.find((x) => x.role === "activity")?.group;
    expect(live(feed.compose(rows))).toMatchObject({ phase: "reasoning", busy: true });
    next = answer({ phase: "bogus" });
    feed.nudge(); await settle(); await settle();
    expect(live(feed.compose(rows)).phase).toBeUndefined();
    feed.stop();
  });
});
