/**
 * `agend-agent task …` does what the `task` tool does.
 *
 *  1. Parity: every field of every action in ACTION_FIELDS can be sent from the command line (a field added to the tool and not to
 *     the CLI fails here), and the arguments a command sends are the tool's own.
 *  2. Every action, through the REAL client (agent-cli.ts, transpiled and run as its own process) and the REAL /agent endpoint
 *     (handleAgentRequest on a FleetManager with a scheduler database): the token check, the tool profile, the dashboard switch,
 *     the board's rules — a `version` conflict, one card in progress, who may edit a card — are the ones a tool call meets.
 *  3. Mistakes in the command line fail before any request.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { handleAgentRequest, type AgentEndpointContext } from "../src/agent-endpoint.js";
import { loadFleetConfig } from "../src/config.js";
import { FleetManager } from "../src/fleet-manager.js";
import { SchedulerDb } from "../src/scheduler/db.js";
import type { Actor } from "../src/scheduler/task-board.js";
import { ACTION_FIELDS } from "../src/task-board-tool.js";
import { withoutTaskCommands } from "../src/dashboard-permissions.js";

const run = promisify(execFile);
const ANN: Actor = { kind: "person", name: "Ann" };
const MODULES = ["agent-cli", "cli-flags", "agent-token-header", "agent-file-read", "instance-names", "web-asset-parts", "bundled-skills", "web-experimental", "task-attach-client", "task-file-limits"];

let root: string, dir: string, server: Server, port = 0, recording: Server, recordPort = 0;
const recorded: Array<{ op: string; args: Record<string, unknown> }> = [];
const staged: Array<Record<string, unknown>> = [];
let fm: FleetManager, db: SchedulerDb, boards = 0;

beforeAll(async () => {
  // The client: the real source, in a private module tree. Only loopback servers are reachable.
  root = mkdtempSync(join(tmpdir(), "agend-cli-task-333-"));
  for (const name of MODULES) {
    const source = readFileSync(join(import.meta.dirname, "../src/" + name + ".ts"), "utf8");
    writeFileSync(join(root, name + ".js"), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
  }
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  // A request-recording stub, for what the command line sends.
  recording = createServer((req, res) => {
    let body = ""; req.on("data", c => { body += c; });
    req.on("end", () => {
      const msg = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      // a file the client stages (an internal `upload`) is answered as the fleet answers it, and not recorded as the
      // command's own request: the write that follows it is.
      if (msg.op === "task" && msg.args?.action === "upload") { staged.push(msg.args); res.end(JSON.stringify(JSON.stringify({ upload: "a".repeat(31) + "1", name: msg.args.name, size: 1, done: true }))); return; }
      recorded.push(msg); res.end('"ok"');
    });
  });
  await new Promise<void>(r => recording.listen(0, "127.0.0.1", r));
  recordPort = (recording.address() as { port: number }).port;

  // The fleet: lead, dev-a and dev-b on the board; `min` has a tool profile without `task`; `off` has the task board switched off.
  dir = mkdtempSync(join(tmpdir(), "agend-cli-task-fleet-333-"));
  const inst = (name: string, extra = "") => `  ${name}:\n    working_directory: ${dir}\n    backend: claude-code\n    agent_mode: cli\n${extra}`;
  writeFileSync(join(dir, "fleet.yaml"), `health_port: 0\ninstances:\n${inst("lead")}${inst("dev-a")}${inst("dev-b")}${inst("min", "    tool_set: minimal\n")}${inst("off", "    dashboard:\n      task_board: false\n")}`);
  fm = new FleetManager(dir);
  const quiet = () => {};
  (fm as unknown as { logger: unknown }).logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => (fm as unknown as { logger: unknown }).logger };
  (fm as unknown as { fleetConfig: unknown }).fleetConfig = loadFleetConfig(join(dir, "fleet.yaml"));
  for (const name of ["lead", "dev-a", "dev-b", "min", "off"]) {
    mkdirSync(join(dir, "instances", name), { recursive: true });
    writeFileSync(join(dir, "instances", name, "agent.token"), `token-${name}`, { mode: 0o600 });
    fm.agentCredentials.issue(name, `token-${name}`);
  }
  server = createServer((req, res) => handleAgentRequest(req, res, fm as unknown as AgentEndpointContext));
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  (fm as unknown as { taskBoardWaker?: { stop(): void } }).taskBoardWaker?.stop();
  for (const s of [server, recording]) await new Promise<void>(r => s.close(() => r()));
  try { db.close(); } catch { /* closed */ }
  rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  recorded.length = 0;
  staged.length = 0;
  // A database of its own for each test: card numbers count from 1 again.
  try { db?.close(); } catch { /* closed */ }
  db = new SchedulerDb(join(dir, `scheduler-${++boards}.db`));
  (fm as unknown as { scheduler: unknown }).scheduler = { db };
  // The board as the fleet wires it: the card limit, the instances' task board switch, comment and progress routing.
  (fm as unknown as { attachTaskBoard(d: SchedulerDb): void }).attachTaskBoard(db);
});

/** `agend-agent <words>` as `instance`, against the real endpoint (or the recording stub). stdout, and whether it exited 0. */
async function cli(instance: string, words: string[], to: "fleet" | "recording" = "fleet"): Promise<{ out: string; ok: boolean; json: any }> {
  const env = { HOME: root, AGEND_HOME: dir, AGEND_PORT: String(to === "fleet" ? port : recordPort), AGEND_INSTANCE_NAME: instance };
  let out: string, ok = true;
  try { out = (await run(process.execPath, [join(root, "agent-cli.js"), ...words], { cwd: root, env, timeout: 15000 })).stdout.trim(); }
  catch (e) { out = String((e as { stdout?: string }).stdout ?? "").trim(); ok = false; }
  let json: unknown; try { json = JSON.parse(out); } catch { json = undefined; }
  return { out, ok, json };
}
const task = (instance: string, ...words: string[]) => { expect(words.every((w) => typeof w === "string")).toBe(true); return cli(instance, ["task", ...words]); };
/** A card on the board (a plain `create` with none of the board's fields is the tool's old task, as with the tool): its number. */
const card = async (instance: string, title: string, ...more: string[]) => { const r = await task(instance, "create", title, "--size", "M", ...more); const code = /^ok ([MS]-\d+) /.exec(r.out)?.[1]; expect(code, r.out).toBeTruthy(); return code!; };
const sent = async (...words: string[]) => { recorded.length = 0; const r = await cli("lead", ["task", ...words], "recording"); expect(r.ok).toBe(true); expect(recorded).toHaveLength(1); return recorded[0]!.args; };

describe("the command line sends the tool's own arguments (parity with ACTION_FIELDS)", () => {
  // Words for each action that between them name every field the action takes. A field in ACTION_FIELDS with no words here fails the last test.
  const SENDS: Record<string, string[][]> = {
    create: [["create", "T", "D", "high", "dev-a", "--depends-on", "S-1,S-2", "--depends-on", "S-3", "--project", "Game", "--parent", "M-1", "--scope", "s", "--acceptance", "a, b", "--acceptance", "c",
      "--context", "ctx", "--needs-review", "--size", "m", "--dispatcher", "lead"]],
    update: [["update", "M-1", "claimed", "high", "--title", "t", "--description", "d", "--assignee", "x", "--depends-on", "S-1", "--result", "r", "--scope", "s", "--acceptance", "a", "--check", "1,2", "--check", "4", "--uncheck", "3",
      "--context", "c", "--state", "s", "--log", "l", "--comment", "c", "--no-needs-review", "--size", "S", "--dispatcher", "none", "--version", "3", "--project", "none", "--reply-to", "c12", "--attach", "./a.md"]],
    // Comment threads: change a comment of your own (its number is the c12 `get --detail` shows).
    edit_comment: [["edit-comment", "M-1", "c12", "new words"], ["edit-comment", "M-1", "--comment-id", "12", "--comment", "newer words"]],
    move: [["move", "M-1", "blocked", "why", "--comment", "c", "--version", "2"], ["move", "M-1", "done", "the result"], ["move", "M-1", "--status", "claimed"], ["move", "M-1", "review", "r", "--attach", "./a.md"]],
    claim: [["claim", "M-1"]],
    done: [["done", "M-1", "finished"]],
    get: [["get", "M-1", "--detail"]],
    list: [["list", "dev-a", "open,claimed", "true", "--project", "Game", "--parent", "M-1", "--stale", "--detail", "--limit", "5", "--cursor", "next"]],
    mine: [["mine"]],
    projects: [["projects"]],
    create_project: [["create-project", "Game", "all the game's work"]],
    move_project: [["move-project", "2", "M-1", "M-2"]],
    watch: [["watch", "M-1", "dev-b"]],
    unwatch: [["unwatch", "M-1", "dev-b"]],
    // the files are read and staged by the client; the write carries their ids (`uploads`) in place of the paths.
    attach: [["attach", "M-1", "./a.md", "--comment", "c", "--version", "2"]],
  };
  beforeAll(() => { writeFileSync(join(root, "a.md"), "# hello\n"); });
  const EXPECT: Record<string, Record<string, unknown>> = {
    create: { action: "create", title: "T", description: "D", priority: "high", assignee: "dev-a", depends_on: ["S-1", "S-2", "S-3"], project: "Game", parent: "M-1", scope: "s", acceptance: ["a, b", "c"], context: "ctx", needs_review: true, size: "M", dispatcher: "lead" },
    attach: { action: "attach", id: "M-1", comment: "c", version: 2, uploads: ["a".repeat(31) + "1"] },
    update: { action: "update", id: "M-1", status: "claimed", priority: "high", title: "t", description: "d", assignee: "x", depends_on: ["S-1"], result: "r", scope: "s", acceptance: ["a"], check: [1, 2, 4], uncheck: [3], context: "c", state: "s", log: "l", comment: "c", needs_review: false, size: "S", dispatcher: "none", version: 3, project: "none", reply_to: "c12", uploads: ["a".repeat(31) + "1"] },
    list: { action: "list", filter_assignee: "dev-a", filter_status: ["open", "claimed"], verbose: true, project: "Game", parent: "M-1", stale: true, detail: true, limit: 5, cursor: "next" },
    create_project: { action: "create_project", name: "Game", description: "all the game's work" },
    move_project: { action: "move_project", project: "2", ids: ["M-1", "M-2"] },
    watch: { action: "watch", id: "M-1", watcher: "dev-b" },
    unwatch: { action: "unwatch", id: "M-1", watcher: "dev-b" },
  };
  it("each command sends the fields it names, typed as the tool takes them (lists, whole numbers, booleans)", async () => {
    for (const [action, rows] of Object.entries(SENDS)) {
      for (const words of rows) {
        const args = await sent(...words);
        const want = EXPECT[action];
        if (want) expect(args).toEqual(want);
        else expect(args.action).toBe(action);
      }
    }
    expect(await sent("move", "M-1", "blocked", "why", "--comment", "c", "--version", "2")).toEqual({ action: "move", id: "M-1", to: "blocked", reason: "why", comment: "c", version: 2 });
    expect(await sent("move", "M-1", "done", "the result")).toEqual({ action: "move", id: "M-1", to: "done", result: "the result" });
    expect(await sent("move", "M-1", "--status", "claimed")).toEqual({ action: "move", id: "M-1", status: "claimed" });
    expect(await sent("get", "M-1", "--detail")).toEqual({ action: "get", id: "M-1", detail: true });
    expect(await sent("done", "M-1", "finished")).toEqual({ action: "done", id: "M-1", result: "finished" });
    expect(await sent("mine")).toEqual({ action: "mine" });
  });
  it("no field of any action is left without a way to send it", async () => {
    const reached: Record<string, Set<string>> = {};
    for (const [action, rows] of Object.entries(SENDS)) {
      for (const words of rows) {
        const args = await sent(...words);
        for (const key of Object.keys(args)) (reached[action] ??= new Set()).add(key);
      }
    }
    for (const [action, fields] of Object.entries(ACTION_FIELDS)) {
      // `attach` (paths) reaches the fleet as `uploads` (the ids the client staged the files under).
      const missing = fields.filter((f) => !reached[action]?.has(f === "attach" ? "uploads" : f));
      expect({ action, missing }).toEqual({ action, missing: [] });
    }
    // And the other way: every action the tool has is one the CLI has.
    expect(Object.keys(SENDS).sort()).toEqual(Object.keys(ACTION_FIELDS).sort());
  });
  it("what the commands always meant is unchanged: positional create / list / update / move / comment", async () => {
    expect(await sent("create", "Title", "desc", "urgent", "dev-a")).toEqual({ action: "create", title: "Title", description: "desc", priority: "urgent", assignee: "dev-a" });
    expect(await sent("list", "dev-a", "done,cancelled", "true")).toEqual({ action: "list", filter_assignee: "dev-a", filter_status: ["done", "cancelled"], verbose: true });
    expect(await sent("update", "M-3", "claimed", "high")).toEqual({ action: "update", id: "M-3", status: "claimed", priority: "high" });
    expect(await sent("comment", "M-3", "looks good")).toEqual({ action: "update", id: "M-3", comment: "looks good" });
    expect(await sent("create", "--", "--not a flag", "--nor this")).toEqual({ action: "create", title: "--not a flag", description: "--nor this" });
    expect(await sent("update", "M-3", "--comment=a=b")).toEqual({ action: "update", id: "M-3", comment: "a=b" });
    // A text that was always a positional stays one: not shaped like an option.
    expect(await sent("comment", "M-3", "--- summary ---")).toEqual({ action: "update", id: "M-3", comment: "--- summary ---" });
    expect(await sent("comment", "M-3", "-- note")).toEqual({ action: "update", id: "M-3", comment: "-- note" });
    expect(await sent("comment", "M-3", "--version-bump needed")).toEqual({ action: "update", id: "M-3", comment: "--version-bump needed" });   // one quoted text, not an option
    expect(await sent("comment", "M-3", "--Draft v2")).toEqual({ action: "update", id: "M-3", comment: "--Draft v2" });
    expect(await sent("create", "--- not a rule")).toEqual({ action: "create", title: "--- not a rule" });
  });
});

describe("a mistake in the command line fails before any request", () => {
  it.each([
    [["update", "M-1", "--bogus", "x"], "Unknown task option: --bogus"],
    [["comment", "M-1", "--version-bump", "needed"], "Unknown task option: --version-bump"],
    [["update", "M-1", "--comment"], "Missing value for --comment"],
    [["update", "M-1", "--version", "two"], "--version takes a whole number"],
    [["update", "M-1", "--check", "1,x"], "--check takes a whole number"],
    [["create", "T", "--size", "XL"], "--size is S, M or L"],
    [["create", "T", "--priority", "soon"], "--priority is one of low, normal, high, urgent"],
    [["update", "M-1", "--needs-review=false"], "--needs-review takes no value"],
    [["list", "--cursor"], "Missing value for --cursor"],
  ])("%j", async (words, message) => {
    const r = await cli("lead", ["task", ...words], "recording");
    expect(r.ok).toBe(false);
    expect(r.json.error).toContain(message);
    expect(recorded).toEqual([]);
  });
});

describe("every action, through the real endpoint: the tool's rules", () => {
  it("create / create-project / projects / move-project / list / get: an agent's day, by command", async () => {
    expect((await task("lead", "create-project", "Game", "all the game's work")).out).toMatch(/^ok project \d+ Game$/);
    const projects = (await task("lead", "projects")).out;
    expect(projects).toMatch(/^\d+ Game — 0 main tasks/);
    const gameId = projects.split(" ")[0]!;
    const made = await task("lead", "create", "Leaderboard", "weekly top 100", "high", "dev-a", "--project", "Game", "--scope", "in: top 100; out: seasons", "--acceptance", "resets Monday", "--acceptance", "top 100 shown",
      "--context", "src/leaderboard.ts", "--needs-review", "--size", "M", "--dispatcher", "lead");
    expect(made.out).toMatch(/^ok M-\d+ Leaderboard \[to do\] @dev-a \(v1\)\nIn project \d+ Game\.\nTell the person: #M-\d+ \(opens the card\) is in project Game\.$/);
    const code = made.out.split(" ")[1]!;
    const card = db.board.getCard(code);
    expect(card).toMatchObject({ goal: "weekly top 100", scope: "in: top 100; out: seasons", context: "src/leaderboard.ts", priority: "high", size: "M", needsReview: true, assignee: "dev-a", dispatcher: { kind: "instance", name: "lead" } });
    expect(card.acceptance.map((a: { text: string }) => a.text)).toEqual(["resets Monday", "top 100 shown"]);
    expect(card.projectId).toBe(Number(gameId));
    // A sub task, with a dependency on another.
    const sub1 = (await task("lead", "create", "API", "--parent", code, "--assignee", "dev-a")).out;
    expect(sub1).toMatch(/^ok S-\d+ API \[to do\] @dev-a \(v1\)$/);
    const s1 = sub1.split(" ")[1]!;
    const sub2 = (await task("lead", "create", "Review", "--parent", code, "--assignee", "dev-b", "--depends-on", s1)).out;
    expect(sub2).toMatch(/^ok S-\d+ Review \[to do\] @dev-b \(v1\)$/);
    expect(db.board.getCard(sub2.split(" ")[1]!).deps).toHaveLength(1);
    // list by project and by parent, as text (--detail), as pages (--limit / --cursor).
    expect((await task("lead", "list", "--project", "Game", "--detail")).out).toContain(`${code} [to do] Leaderboard @dev-a`);
    expect((await task("lead", "list", "--parent", code, "--detail")).out.split("\n")).toHaveLength(2);
    const page1 = (await task("lead", "list", "--parent", code, "--limit", "1")).json;
    expect(page1.tasks).toHaveLength(1);
    expect(page1.next_cursor).toBeTruthy();
    const page2 = (await task("lead", "list", "--parent", code, "--limit", "1", "--cursor", page1.next_cursor)).json;
    expect(page2.tasks).toHaveLength(1);
    expect(page2.tasks[0].code).not.toBe(page1.tasks[0].code);
    // get --detail reads the whole card.
    const got = (await task("dev-a", "get", code, "--detail")).out;
    expect(got).toContain("Leaderboard");
    expect(got).toContain("resets Monday");
    // move-project: out of the project and back, each card on its own.
    expect((await task("lead", "move-project", "none", code)).out).toBe(`moved 1 of 1 to no project\nok ${code} → no project (v${card.version + 1})`);
    expect((await task("lead", "move-project", gameId, code, "M-99")).out).toContain(`moved 1 of 2 to project ${gameId} Game`);
    expect((await task("lead", "move-project", gameId, "M-99")).out).toContain("M-99: not moved");
  });

  it("claim / update / move / comment / done / mine: the writes, and the version a write was made on", async () => {
    const main = await card("lead", "Leaderboard", "--assignee", "dev-a", "--acceptance", "resets Monday", "--acceptance", "top 100");
    const sub = await card("lead", "API", "--parent", main, "--assignee", "dev-a");
    expect((await task("dev-a", "mine")).out).toContain(sub);
    await task("dev-a", "claim", sub);   // the tool's claim answers with the small ack
    expect(db.board.getCard(sub).status).toBe("claimed");
    // update: fields as flags — one write.
    const updated = await task("dev-a", "update", sub, "--state", "done: handler\nnext: tests", "--log", "handler in", "--comment", "cache it 30 s", "--title", "API v2", "--size", "S", "--priority", "high");
    expect(updated.out).toMatch(new RegExp(`^ok ${sub} API v2 \\[in progress\\] @dev-a \\(v\\d+\\)`));
    const after = db.board.getCard(sub);
    expect(after).toMatchObject({ title: "API v2", size: "S", priority: "high" });
    expect(after.state).toBe("done: handler\nnext: tests");
    // acceptance: tick and untick items by number; the main task's checklist is replaced or ticked.
    expect((await task("lead", "update", main, "--check", "1,2")).out).toContain(main);
    expect(db.board.getCard(main).acceptance.every((a: { done: boolean }) => a.done)).toBe(true);
    await task("lead", "update", main, "--uncheck", "2");
    expect(db.board.getCard(main).acceptance.map((a: { done: boolean }) => a.done)).toEqual([true, false]);
    await task("lead", "update", main, "--acceptance", "only this");
    expect(db.board.getCard(main).acceptance.map((a: { text: string }) => a.text)).toEqual(["only this"]);
    // The version: a write on a version that is not the card's now is refused, and nothing is written.
    const stale = db.board.getCard(sub).version - 1;
    const refused = await task("dev-a", "update", sub, "--log", "should not land", "--version", String(stale));
    expect(refused.json.error).toMatch(/changed meanwhile/);
    expect(JSON.stringify(db.board.detail(sub).logs)).not.toContain("should not land");
    const refusedMove = await task("dev-a", "move", sub, "done", "r", "--version", String(stale));
    expect(refusedMove.json.error).toMatch(/changed meanwhile/);
    expect(db.board.getCard(sub).status).toBe("claimed");
    // The right version goes through.
    const v = db.board.getCard(sub).version;
    expect((await task("dev-a", "update", sub, "--log", "tests in", "--version", String(v))).out).toContain(`(v${v + 1})`);
    // comment (the old command), with a version too.
    expect((await task("lead", "comment", sub, "looks good")).out).toContain(sub);
    // move: blocked wants a reason; done wants a result; --comment rides along.
    expect((await task("dev-a", "move", sub, "blocked")).json.error).toMatch(/reason/);
    expect((await task("dev-a", "move", sub, "blocked", "which cache size?", "--comment", "asked")).out).toMatch(/in progress → blocked/);
    expect((await task("lead", "move", sub, "claimed", "30 s")).out).toMatch(/blocked → in progress|→ in progress/);
    expect((await task("dev-a", "done", sub, "src/api.ts; tests pass")).json).toMatchObject({ status: "done" });   // the tool's done: the small ack, with the board's notes
    expect(db.board.getCard(sub).status).toBe("done");
  });

  it("watch / unwatch: yourself by default, another instance only on a card you may edit", async () => {
    const code = await card("dev-a", "Mine");
    expect((await task("dev-a", "watch", code)).out).toContain("watchers: dev-a");
    expect((await task("dev-a", "watch", code, "dev-b")).out).toContain("watchers: dev-a, dev-b");
    expect((await task("dev-a", "unwatch", code, "dev-b")).out).toContain("watchers: dev-a");
    expect((await task("dev-a", "unwatch", code)).out).toContain("watchers: none");
    // A card it does not hold: it may follow it itself, not put somebody else on it.
    const theirs = await card("lead", "Theirs", "--assignee", "dev-b");
    expect((await task("dev-a", "watch", theirs)).out).toContain("watchers: dev-a");
    const other = await task("dev-a", "watch", theirs, "lead");
    expect(other.json.error ?? other.out).toMatch(/may edit|cannot|only/i);
  });

  it("the board's rules are the tool's: one card at a time, the card's owner, fields an action does not take", async () => {
    const a = await card("lead", "First", "--assignee", "dev-a");
    const b = await card("lead", "Second", "--assignee", "dev-a");
    const c = await card("lead", "Theirs", "--assignee", "dev-b");
    expect((await task("dev-a", "move", a, "claimed")).out).toMatch(/in progress/);
    expect((await task("dev-a", "move", b, "claimed")).json.error).toMatch(/already have .* in progress\. One card at a time/);
    expect((await task("dev-a", "claim", b)).json.error).toMatch(/One card at a time/);
    expect((await task("dev-a", "move", c, "claimed")).json.error).toBe(`${c} is assigned to dev-b; you cannot take it`);
    expect((await task("dev-a", "update", c, "--comment", "hi")).ok).toBe(true);   // anyone may comment; the rule is on edits
    expect((await task("dev-a", "update", c, "--title", "mine now")).json.error).toMatch(/cannot|may not|only/i);
    expect(db.board.getCard(c).title).toBe("Theirs");
    // The fleet names the fields an action does not take, and writes nothing.
    const before = db.board.getCard(a).version;
    expect((await task("dev-a", "claim", a, "--size", "S")).json.error).toBe(`claim does not take "size". Nothing was changed. claim takes: id.`);
    expect((await task("dev-a", "mine", "--detail")).json.error).toContain("mine does not take \"detail\"");
    expect((await task("dev-a", "get", a, "--log", "x")).json.error).toContain("get does not take \"log\"");
    expect((await task("dev-a", "done", a, "--version", "1")).json.error).toContain("done does not take \"version\"");
    expect(db.board.getCard(a).version).toBe(before);
  });

  it("a file a refused write did not use is given back to the fleet — the real client against the real endpoint; a write that went through keeps it on the card", async () => {
    writeFileSync(join(root, "rel.md"), "# rel");
    const a = await card("dev-a", "Files");
    const store = db.board.files() as unknown as { staged: Map<string, unknown> };
    for (let attempt = 0; attempt < 3; attempt++) {
      const stale = await task("dev-a", "attach", a, "./rel.md", "--version", "99");
      expect(stale.json.error, `attempt ${attempt}`).toBeTruthy();
      expect(store.staged.size, "given back").toBe(0);
    }
    const ok = await task("dev-a", "attach", a, "./rel.md", "--comment", "here");
    expect(ok.out).toMatch(/attached to M-\d+: rel\.md/);
    expect(store.staged.size).toBe(0);
    expect(db.board.attachments(db.board.getCard(a).uuid).map((f) => f.name)).toEqual(["rel.md"]);
  });
  it("an instance without the task tool, or with the board off, is refused by the endpoint — the CLI is no way around it", async () => {
    const minimal = await task("min", "mine");
    expect(minimal.json.error).toMatch(/task/);
    expect(minimal.json.error).toMatch(/tool_set|profile|minimal/i);
    const off = await task("off", "create", "x");
    expect(off.json.error).toMatch(/task_board/);
    expect(db.board.listCards({}).cards).toHaveLength(0);
  });
});

describe("the instructions an agent in CLI mode reads", () => {
  const md = readFileSync(join(import.meta.dirname, "../src/agent-cli-instructions.md"), "utf8");
  it("name every action's command, and every flag the client takes", () => {
    for (const action of Object.keys(ACTION_FIELDS)) {
      const word = action.replaceAll("_", "-");
      expect(md, word).toMatch(new RegExp(`^agend-agent task ${word}\\b`, "m"));
    }
    expect(md).toMatch(/^agend-agent task comment /m);
    const taskLines = md.split("\n").filter((l) => l.startsWith("agend-agent task ")).join("\n");
    for (const flag of ["--project", "--parent", "--scope", "--acceptance", "--context", "--needs-review", "--size", "--dispatcher", "--depends-on", "--stale", "--detail", "--limit", "--cursor",
      "--title", "--description", "--priority", "--assignee", "--state", "--log", "--comment", "--check", "--uncheck", "--version", "--result", "--reply-to"]) {
      expect(taskLines, flag).toContain(flag);
    }
  });
  it("with the task board off, none of those commands is left in what the agent is told", () => {
    const off = withoutTaskCommands(md);
    expect(off).not.toMatch(/^\s*agend-agent task\b/m);
    expect(off).not.toContain("--acceptance");
    expect(off).not.toContain("move-project");
  });
});
