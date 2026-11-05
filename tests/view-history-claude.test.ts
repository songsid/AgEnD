/**
 * Claude history in the View (leader cid-claude-history-build; the user, hmsg-a8947a2c / hmsg-b4c7ccdf), server side.
 * Live, through the fleet's own listener, gate and handlers (a scratch AGEND_HOME, no daemon, tmux stubbed):
 * - GET /api/pane/<n>?transcript=1 answers the instance's transcript steps as JSON, never cached — the Log tab's switch
 *   plays no part; the newest VIEW_HISTORY_PAGE steps, `before` for older pages, and one step whole on `step=`;
 * - the View's own access rules, exactly: open reads when web.view_access is open, a session when it is `session`; a
 *   guest only Trusted, in scope, and its reads counted with its screen reads (the same per-second budget);
 * - Claude only (Codex: supported false — it keeps tmux's scrollback); a transcript replaced (a new session) resets;
 * - reading it never touches tmux at all (no capture, no keys: delivery is never affected).
 * And the mapping (view-history.ts): long results and diffs fold, an edit shows its change, turn ends never show.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
import { request } from "node:http";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agend-vh-home-"));
process.env.AGEND_HOME = home;

const { FleetManager } = await import("../src/fleet-manager.js");
const { WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
const { tokenEpoch } = await import("../src/web-session.js");
const { resetGuestPanes, resetTranscriptReads, VIEW_HISTORY_READS } = await import("../src/view-api.js");
const { tmuxExecHelper } = await import("../src/tmux-exec-helper.js");
const { VIEW_HISTORY_PAGE, VIEW_FOLD, viewStep, viewHistoryQuery } = await import("../src/view-history.js");

const ALICE = { adapterId: "discord", userId: "111111111111111111" };
interface Raw { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function raw(port: number, path: string, headers: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const b: Buffer[] = []; res.on("data", (c: Buffer) => { b.push(c); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(b).toString("utf8") }));
    });
    r.on("error", reject); r.end();
  });
}
let fm: any, port = 0, dir: string, transcript: string;
const get = (sid: string | null, path: string) => raw(port, path, sid ? { cookie: `${WEB_SESSION_COOKIE}=${sid}` } : {});
const json = (r: Raw) => JSON.parse(r.body);

// ── A Claude transcript, as Claude writes it ──
const rec = (o: unknown) => `${JSON.stringify(o)}\n`;
const prompt = (text: string, uuid: string) => rec({ type: "user", uuid, message: { role: "user", content: text } });
const reply = (text: string) => rec({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const call = (id: string, name: string, input: unknown, text?: string) =>
  rec({ type: "assistant", message: { role: "assistant", content: [...(text ? [{ type: "text", text }] : []), { type: "tool_use", id, name, input }] } });
const result = (id: string, content: string, isError = false) =>
  rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } });
function conversation(turns: number): string {
  let out = "";
  for (let i = 1; i <= turns; i++) out += prompt(`question number ${i}`, `u${i}`) + reply(`answer number ${i}`);
  out += prompt("The forecast crashes on a city with a space.", "fix");
  out += call("t1", "Bash", { command: "seq 1 20" }, "I'll run the tests first.");
  out += result("t1", Array.from({ length: 20 }, (_, i) => `test ${i + 1} passed`).join("\n"));
  out += call("t2", "Edit", { file_path: "/w/src/forecast.ts", old_string: "q=${city}", new_string: "q=${encodeURIComponent(city)}" });
  out += result("t2", "The file /w/src/forecast.ts has been updated successfully.");
  out += call("t3", "Grep", { pattern: "x" });
  out += result("t3", "<tool_use_error>Error: No such tool available: Grep</tool_use_error>", true);
  out += reply("Fixed: the city is URL-encoded now.");
  return out;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-vh-fleet-"));
  writeFileSync(join(dir, "fleet.yaml"), `health_port: 0\ninstances:\n  a:\n    working_directory: ${dir}\n    backend: claude-code\n  b:\n    working_directory: ${dir}\n    backend: claude-code\n  cx:\n    working_directory: ${dir}\n    backend: codex\n`);
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  fm.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  fm.getInstanceStatus = () => "running";
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  port = (fm.healthServer.address() as { port: number }).port;
  fm.initializeWebSessions?.();
  // No daemon runs: the fleet finds a stopped Claude's transcript where its statusline last named it (log-service's own rule).
  transcript = join(dir, "session.jsonl");
  for (const n of ["a", "b", "cx"]) {
    mkdirSync(join(fm.dataDir, "instances", n), { recursive: true });
    writeFileSync(join(fm.dataDir, "instances", n, "window-id"), "@1");
    writeFileSync(join(fm.dataDir, "instances", n, "statusline.json"), JSON.stringify({ transcript_path: transcript }));
  }
});
afterAll(async () => {
  await new Promise<void>((r) => fm.healthServer?.close(() => r()));
  rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});
let tmux: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetGuestPanes(); resetTranscriptReads();
  writeFileSync(transcript, conversation(60));
  tmux = vi.fn(async (_file: string, args: string[]) => ({ stdout: args.includes("capture-pane") ? "screen\n" : "120x40\n", stderr: "" }));
  vi.spyOn(tmuxExecHelper, "exec").mockImplementation(tmux as never);
});
afterEach(() => { vi.restoreAllMocks(); delete fm.fleetConfig.web; });
const session = (tier: "admin" | "guest", owner?: typeof ALICE) =>
  fm.webSessions.create({ tier, surface: "local", label: tier, tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!), owner }).sessionId as string;
const guests = (level: "chat" | "trusted") => { fm.fleetConfig.web = { guests: { enabled: true, grants: { [`${ALICE.adapterId}:${ALICE.userId}`]: { instances: ["a"], level } } } }; };

describe("GET /api/pane/<n>?transcript=1", () => {
  it("the newest page as JSON, never cached, with the Log tab off; folded results; nothing asked of tmux", async () => {
    expect(fm.fleetConfig.web?.log_tab).toBeUndefined();
    const r = await get(session("admin"), "/api/pane/a?transcript=1");
    expect([r.status, r.headers["content-type"], r.headers["cache-control"]]).toEqual([200, "application/json; charset=utf-8", "private, no-store"]);
    const body = json(r);
    expect([body.view_history, body.supported, body.steps.length, typeof body.before, typeof body.end, typeof body.key]).toEqual([1, true, VIEW_HISTORY_PAGE, "number", "number", "string"]);
    const tail = body.steps.slice(-6);
    expect(tail.map((s: any) => [s.kind, s.tool ?? s.body?.slice(0, 20)])).toEqual([
      ["user", "The forecast crashes"], ["assistant", "I'll run the tests f"], ["tool", "Bash"], ["tool", "Edit"], ["tool", "Grep"], ["assistant", "Fixed: the city is U"],
    ]);
    const bash = tail[2], edit = tail[3], grep = tail[4];
    expect([bash.body, bash.more]).toEqual(["test 1 passed\ntest 2 passed\ntest 3 passed", 17]);
    expect([edit.diff, edit.body]).toEqual([[{ del: ["q=${city}"], add: ["q=${encodeURIComponent(city)}"] }], undefined]);
    expect([grep.status, grep.body]).toEqual(["failed", "Error: No such tool available: Grep"]);
    expect(body.steps.some((s: any) => s.kind === "turn_end" || s.kind === "state")).toBe(false);
    expect(tmux).not.toHaveBeenCalled();
  });
  it("older pages by `before`, each ending where the last began, down to the start; one step whole by `step`", async () => {
    const sid = session("admin");
    const first = json(await get(sid, "/api/pane/a?transcript=1"));
    const second = json(await get(sid, `/api/pane/a?transcript=1&before=${first.before}&key=${first.key}`));
    expect([second.end, second.steps.length > 0, second.before]).toEqual([first.before, true, null]);
    expect(second.steps[0].body).toBe("question number 1");
    const ids = new Set(first.steps.map((s: any) => s.id));
    expect(second.steps.filter((s: any) => ids.has(s.id))).toEqual([]);
    const bash = first.steps.find((s: any) => s.tool === "Bash");
    const whole = json(await get(sid, `/api/pane/a?transcript=1&step=${bash.id}&end=${first.end}&key=${first.key}`));
    expect([whole.step.body.split("\n").length, whole.step.more]).toEqual([20, undefined]);
    // Written since the page was read: the step is still found in the same range.
    appendFileSync(transcript, prompt("a newer question", "late"));
    expect(json(await get(sid, `/api/pane/a?transcript=1&step=${bash.id}&end=${first.end}&key=${first.key}`)).step.id).toBe(bash.id);
  });
  it("a new session's transcript (another file): an old cursor resets to the newest; an old step is not found", async () => {
    const sid = session("admin");
    const first = json(await get(sid, "/api/pane/a?transcript=1"));
    rmSync(transcript); writeFileSync(transcript, prompt("fresh session", "s2") + reply("hello again"));
    const again = json(await get(sid, `/api/pane/a?transcript=1&before=${first.before}&key=${first.key}`));
    expect([again.reset, again.steps.map((s: any) => s.body)]).toEqual([true, ["fresh session", "hello again"]]);
    const step = json(await get(sid, `/api/pane/a?transcript=1&step=${first.steps[0].id}&end=${first.end}&key=${first.key}`));
    expect(step.step).toBeNull();
  });
  it("Claude only: Codex is told there is none (it keeps tmux's scrollback); an unknown agent 404", async () => {
    const sid = session("admin");
    expect(json(await get(sid, "/api/pane/cx?transcript=1"))).toEqual({ view_history: 1, supported: false, reason: "not_running" });
    expect((await get(sid, "/api/pane/zz?transcript=1")).status).toBe(404);
  });
  it("no transcript yet: supported false, said why", async () => {
    rmSync(transcript);
    expect(json(await get(session("admin"), "/api/pane/a?transcript=1"))).toEqual({ view_history: 1, supported: false, reason: "no_transcript" });
  });
});

describe("the View's own access rules", () => {
  it("web.view_access open: an anonymous reader reads it as it reads the screen; `session`: neither without one", async () => {
    expect((await get(null, "/api/pane/a?transcript=1")).status).toBe(200);
    fm.fleetConfig.web = { view_access: "session" };
    const [screen, history] = [await get(null, "/api/pane/a"), await get(null, "/api/pane/a?transcript=1")];
    expect([screen.status, history.status]).toEqual([401, 401]);
    expect((await get(session("admin"), "/api/pane/a?transcript=1")).status).toBe(200);
  });
  it("a guest: Chat-level refused, Trusted in scope reads it, out of scope 404 — and its reads count with its screen's", async () => {
    guests("chat");
    const chat = await get(session("guest", ALICE), "/api/pane/a?transcript=1");
    expect([chat.status, json(chat).error]).toEqual([403, "guest_not_trusted"]);
    guests("trusted");
    const sid = session("guest", ALICE);
    expect((await get(sid, "/api/pane/b?transcript=1")).status).toBe(404);
    const ok = await get(sid, "/api/pane/a?transcript=1");
    expect([ok.status, json(ok).supported, ok.headers["cache-control"]]).toEqual([200, true, "private, no-store"]);
    // The screen's budget is two reads a second per account: one history read and one screen read spend it.
    const screen = await get(sid, "/api/pane/a");
    const over = await get(sid, "/api/pane/a?transcript=1");
    expect([screen.status, over.status, json(over).error]).toEqual([200, 429, "guest_view_rate_limited"]);
  });
});

describe("bounded work", () => {
  it(`at most ${VIEW_HISTORY_READS.reads} reads at once (then 429 with Retry-After); the same read asked again shares the one running`, async () => {
    const own = fm.viewHistory;
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    fm.viewHistory = async function (this: unknown, ...args: unknown[]) { calls++; await gate; return own.apply(this, args); };
    try {
      const sid = session("admin");
      const running = Array.from({ length: VIEW_HISTORY_READS.reads }, (_, i) => get(sid, `/api/pane/a?transcript=1&before=${100 + i}`));
      await vi.waitFor(() => expect(calls).toBe(VIEW_HISTORY_READS.reads));
      const over = await get(sid, "/api/pane/a?transcript=1&before=999");
      expect([over.status, json(over).error, over.headers["retry-after"]]).toEqual([429, "history_busy", "1"]);
      const shared = get(sid, "/api/pane/a?transcript=1&before=100");
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toBe(VIEW_HISTORY_READS.reads);
      release();
      const all = await Promise.all([...running, shared]);
      expect(all.map((r) => r.status)).toEqual(Array(VIEW_HISTORY_READS.reads + 1).fill(200));
      expect((await get(sid, "/api/pane/a?transcript=1")).status).toBe(200);          // the slots are free again
    } finally { fm.viewHistory = own; release(); }
  });
});

describe("the mapping (view-history.ts)", () => {
  const tool = (body: string, extra: Record<string, unknown> = {}) => ({ id: "t", turn: "", ts: 0, kind: "tool" as const, tool: "Bash", subject: "x", status: "done" as const, body, ...extra });
  it("a result over VIEW_FOLD.lines lines keeps VIEW_FOLD.keep and counts the rest; at the limit it is whole; unfolded on request", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`).join("\n");
    expect(viewStep(tool(lines(VIEW_FOLD.lines)), true)).toMatchObject({ body: lines(VIEW_FOLD.lines) });
    expect(viewStep(tool(lines(VIEW_FOLD.lines)), true)!.more).toBeUndefined();
    expect(viewStep(tool(lines(9)), true)).toMatchObject({ body: "l1\nl2\nl3", more: 6 });
    expect(viewStep(tool(lines(9)), false)).toMatchObject({ body: lines(9) });
    // One long line: its start, and it counts as one more.
    const long = viewStep(tool("x".repeat(5000)), true)!;
    expect([long.body!.length, long.more]).toEqual([VIEW_FOLD.chars, 1]);
  });
  it("an edit's change (Edit, MultiEdit, Write) instead of its sentence; a long one folds by rows; arguments cut: the sentence", () => {
    const edit = (tool: string, input: unknown) => viewStep({ id: "e", turn: "", ts: 0, kind: "tool", tool, subject: "f", status: "done", body: "updated", input: JSON.stringify(input) } as never, true)!;
    expect(edit("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c\nd", new_string: "" }] }).diff).toEqual([{ del: ["a"], add: ["b"] }, { del: ["c", "d"], add: [] }]);
    expect(edit("Write", { content: "one\ntwo\n" }).diff).toEqual([{ del: [], add: ["one", "two"] }]);
    const big = edit("Write", { content: Array.from({ length: 30 }, (_, i) => `r${i}`).join("\n") });
    expect([big.diff![0]!.add.length, big.more]).toEqual([VIEW_FOLD.diffKeep, 30 - VIEW_FOLD.diffKeep]);
    const cut = viewStep({ id: "e", turn: "", ts: 0, kind: "tool", tool: "Edit", subject: "f", status: "done", body: "updated", input: '{"old_string":"a', inputCut: 9 } as never, true)!;
    expect([cut.diff, cut.body]).toEqual([undefined, "updated"]);
  });
  it("turn ends and state lines are not drawn; an empty reply neither", () => {
    expect(viewStep({ id: "x", turn: "", ts: 0, kind: "turn_end" } as never, true)).toBeNull();
    expect(viewStep({ id: "x", turn: "", ts: 0, kind: "state", note: "compacted" } as never, true)).toBeNull();
    expect(viewStep({ id: "x", turn: "", ts: 0, kind: "assistant", body: "" } as never, true)).toBeNull();
  });
  it("the query: offsets digits only, a key as dev-ino, a step id of its own characters; anything else is left out", () => {
    const q = (s: string) => viewHistoryQuery(new URLSearchParams(s));
    expect(q("before=12&end=40&key=2128-81&step=toolu_1_1")).toEqual({ before: 12, end: 40, key: "2128-81", step: "toolu_1_1" });
    expect(q("before=-1&end=1e3&key=../x&step=<a>")).toEqual({});
  });
});
