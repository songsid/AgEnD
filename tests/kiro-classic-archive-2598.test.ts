import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { archiveKiroClassicCopy, assertKiroConversationStopped, prepareKiroCarryForLaunch, restoreKiroClassicArchive, type KiroClassicArchiveInput } from "../src/backend/kiro-classic-archive.js";
import { armKiroTuiMigration, kiroOwnedConversation, resolveKiroIdentity } from "../src/backend/kiro-identity.js";
import { KiroBackend, kiroV1DbPath } from "../src/backend/kiro.js";
import { kiroAgentName, kiroFleetTag } from "../src/backend/kiro-agent.js";
import { sharedKiroV2StoreLane } from "../src/backend/kiro-v2-store.js";

const fsTrace = vi.hoisted(() => ({ paths: new Map<number, string>(), syncs: [] as string[], fail: "" }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    openSync: (...args: any[]) => { const fd = (fs.openSync as any)(...args); fsTrace.paths.set(fd, String(args[0])); return fd; },
    closeSync: (fd: number) => { fsTrace.paths.delete(fd); return fs.closeSync(fd); },
    fsyncSync: (fd: number) => { const path = fsTrace.paths.get(fd) ?? "unknown"; fsTrace.syncs.push(path); if (path === fsTrace.fail) throw new Error("directory fsync failed"); return fs.fsyncSync(fd); },
  };
});
const roots: string[] = [];
const psRoot = mkdtempSync(join(tmpdir(), "archive-ps-stub-")), savedPath = process.env.PATH;
beforeAll(() => {
  writeFileSync(join(psRoot, "ps"), "#!/bin/sh\nprintf '1 offline-fixture\\n'\n"); chmodSync(join(psRoot, "ps"), 0o700);
  process.env.PATH = psRoot + ":" + savedPath;
});
afterEach(() => { fsTrace.syncs = []; fsTrace.fail = ""; vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { sharedKiroV2StoreLane.close(); process.env.PATH = savedPath; rmSync(psRoot, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agend-archive-")); roots.push(root);
  const home = join(root, "agend"), cwd = join(root, "work"), sessionsDir = join(root, "kiro", "sessions", "cli");
  for (const dir of [home, cwd, sessionsDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  vi.stubEnv("AGEND_HOME", home); vi.stubEnv("KIRO_HOME", join(root, "kiro")); vi.stubEnv("XDG_DATA_HOME", join(root, "xdg"));
  const id = "6ca8be1a-6ec5-4cfc-9a2a-ea586133c27e", instance = "archive-test";
  const dbPath = kiroV1DbPath(null); mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath); db.exec("CREATE TABLE conversations_v2 (key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(key,conversation_id))");
  const raw = JSON.stringify({ conversation_id: id, next_message: null, history: [{ user: { content: { Prompt: { prompt: "D5 prompt" } }, images: null }, assistant: { Response: { message_id: "classic-message-1", content: "D5 continuity history" } } }], unknown_field: "原本的對話\nexact bytes" });
  db.prepare("INSERT INTO conversations_v2 VALUES (?,?,?,?,?)").run(cwd, id, raw, 100, 200);
  db.prepare("INSERT INTO conversations_v2 VALUES (?,?,?,?,?)").run(cwd, "other-id", "other value", 101, 201);
  db.prepare("INSERT INTO conversations_v2 VALUES (?,?,?,?,?)").run("/other-cwd", id, "other folder", 102, 202); db.close();
  const identity = { agendHome: home, instance, workingDirectory: cwd, credentialProfile: null };
  const store = { kind: "ok" as const, sessions: [{ id, updatedAt: 100 }], createdAt: () => 1 };
  resolveKiroIdentity({ ...identity, engine: "v1", readStore: () => store, launchedBefore: () => true });
  armKiroTuiMigration(identity);
  resolveKiroIdentity({ ...identity, engine: "v2", readStore: () => store, launchedBefore: () => false });
  const meta = { session_id: id, cwd, created_at: "2026-10-26T05:19:07Z", updated_at: "2026-10-26T05:49:16Z", session_created_reason: "subagent", exported_from_v1: true,
    session_state: { version: "v1", conversation_metadata: {}, rts_model_state: { conversation_id: id }, agent_name: kiroAgentName(instance, kiroFleetTag(home)) } };
  const saveMeta = () => writeFileSync(join(sessionsDir, id + ".json"), JSON.stringify(meta)); saveMeta();
  writeFileSync(join(sessionsDir, id + ".jsonl"), JSON.stringify({ version: "v1", kind: "Prompt", data: { content: [{ kind: "text", data: "D5 prompt" }] } }) + "\n" + JSON.stringify({ version: "v1", kind: "AssistantMessage", data: { message_id: "classic-message-1", content: [{ kind: "text", data: "D5 continuity history" }] } }) + "\n");
  const input: KiroClassicArchiveInput = { ...identity, sessionId: id, sessionsDir, dbPath };
  const rows = () => { const d = new Database(dbPath, { readonly: true }); try { return d.prepare("SELECT key,conversation_id AS id,hex(CAST(value AS BLOB)) AS value,created_at,updated_at FROM conversations_v2 ORDER BY key,conversation_id").all(); } finally { d.close(); } };
  const abandon = () => resolveKiroIdentity({ ...identity, engine: "v2", skipResume: true, readStore: () => store, launchedBefore: () => false });
  const empty = (sid: string, work = "") => { writeFileSync(join(sessionsDir, sid + ".json"), JSON.stringify({ ...meta, session_id: sid, created_at: "2026-10-26T07:17:00Z", session_created_reason: "interactive", exported_from_v1: false, session_state: { ...meta.session_state, rts_model_state: { conversation_id: sid }, agent_name: null } })); writeFileSync(join(sessionsDir, sid + ".jsonl"), work); };
  return { input, root, raw, rows, identity, meta, saveMeta, abandon, empty };
}
const own = (f: ReturnType<typeof fixture>) => kiroOwnedConversation({ ...f.identity, engine: "v2" });

describe("exact frozen classic archive (#2598)", () => {
  it("archives exact bytes privately, removes only the scoped row, and restores it byte-for-byte", () => {
    const f = fixture(), before = f.rows();
    const path = archiveKiroClassicCopy(f.input)!;
    expect(path).toContain("kiro-classic-archives"); expect(statSync(path).mode & 0o777).toBe(0o600);
    const archive = JSON.parse(readFileSync(path, "utf8"));
    expect(archive.sha256).toBe(createHash("sha256").update(JSON.stringify(archive.payload)).digest("hex"));
    expect(Buffer.from(archive.payload.rows[0].valueBase64, "base64").toString()).toBe(f.raw);
    expect(f.rows()).toHaveLength(2); expect(existsSync(join(f.input.sessionsDir, f.input.sessionId + ".jsonl"))).toBe(true);
    expect(archiveKiroClassicCopy(f.input)).toBeNull();
    restoreKiroClassicArchive(f.input, path); expect(f.rows()).toEqual(before);
    restoreKiroClassicArchive(f.input, path); expect(f.rows()).toEqual(before);
  });
  it("a live matching agent or --resume-id blocks, while another instance does not", () => {
    const f = fixture(), agent = kiroAgentName(f.input.instance, kiroFleetTag(f.input.agendHome));
    expect(() => assertKiroConversationStopped(f.input, `123 kiro-cli chat --agent ${agent}`)).toThrow(/still alive/);
    expect(() => assertKiroConversationStopped(f.input, `123 kiro-cli chat --resume-id=${f.input.sessionId}`)).toThrow(/still alive/);
    expect(() => assertKiroConversationStopped(f.input, "123 kiro-cli chat --agent another-agent")).not.toThrow();
    expect(() => assertKiroConversationStopped(f.input, "")).toThrow(/Cannot prove/);
    expect(() => assertKiroConversationStopped(f.input, "garbage")).toThrow(/invalid/);
    expect(() => assertKiroConversationStopped(f.input, "123 node /scratch/tui.js", () => f.input.instance)).toThrow(/may still own/);
    expect(() => assertKiroConversationStopped(f.input, "123 node /scratch/tui.js", () => null)).toThrow(/not proven/);
    expect(() => assertKiroConversationStopped(f.input, "123 node /scratch/tui.js", () => "other-instance")).not.toThrow();
  });
  it("no archive or deletion while own Kiro is alive", () => {
    const f = fixture(), before = f.rows();
    expect(() => archiveKiroClassicCopy(f.input, { stopped: () => { throw new Error("still alive"); } })).toThrow(/still alive/);
    expect(f.rows()).toEqual(before); expect(existsSync(join(f.input.agendHome, "kiro-classic-archives"))).toBe(false);
  });
  it("rechecks stopped state after backup; a late live process keeps the rows", () => {
    const f = fixture(), before = f.rows(); let checks = 0;
    expect(() => archiveKiroClassicCopy(f.input, { stopped: () => { if (++checks === 2) throw new Error("became alive"); } })).toThrow(/became alive/);
    expect(f.rows()).toEqual(before); expect(checks).toBe(2);
  });
  it("rollback keeps every row if interrupted after deletion but before commit", () => {
    const f = fixture(), before = f.rows(); let checkpoints = 0;
    expect(() => archiveKiroClassicCopy(f.input, { checkpoint: () => { if (++checkpoints === 3) throw new Error("deadline"); } })).toThrow(/deadline/);
    expect(f.rows()).toEqual(before);
  });
  it("uses BEGIN IMMEDIATE with a bounded busy timeout against another writer", () => {
    const f = fixture(), before = f.rows(), writer = new Database(f.input.dbPath); writer.exec("BEGIN IMMEDIATE");
    try { expect(() => archiveKiroClassicCopy(f.input, { timeoutMs: 20 })).toThrow(/locked/); } finally { writer.exec("ROLLBACK"); writer.close(); }
    expect(f.rows()).toEqual(before);
  });
  it("corrupt pre-existing archive is never trusted as a backup", () => {
    const f = fixture(), path = archiveKiroClassicCopy(f.input)!; restoreKiroClassicArchive(f.input, path);
    const before = f.rows(); writeFileSync(path, "{}");
    expect(() => archiveKiroClassicCopy(f.input)).toThrow(/Archive/); expect(f.rows()).toEqual(before);
  });
  it("restore refuses conflicting newer rows rather than overwriting them", () => {
    const f = fixture(), path = archiveKiroClassicCopy(f.input)!, db = new Database(f.input.dbPath);
    db.prepare("INSERT INTO conversations_v2 VALUES (?,?,?,?,?)").run(f.input.workingDirectory, f.input.sessionId, "newer", 300, 400); db.close();
    const before = f.rows(); expect(() => restoreKiroClassicArchive(f.input, path)).toThrow(/different classic row/); expect(f.rows()).toEqual(before);
  });
  it("a broken V2 copy keeps classic intact", () => {
    const f = fixture(), before = f.rows(); f.meta.exported_from_v1 = false; f.saveMeta();
    expect(() => archiveKiroClassicCopy(f.input)).toThrow(/matching carried/); expect(f.rows()).toEqual(before);
  });
});

describe("upgrade launch after ambiguous (2 matches) abandoned the pin", () => {
  it("re-pins the original carry before discovery, archives classic, and ignores two empty sessions", async () => {
    const f = fixture(); f.abandon(); f.empty("empty-1"); f.empty("empty-2"); expect(own(f)).toBeNull();
    const b = new KiroBackend(join(f.root, "instance"), { version: "2.34.0", source: "version", supportsLegacyUi: true, supportsTui: true, supportsV3: true,
      agentEngines: ["v1", "v2", "v3"], supportsEffortFlag: true, supportsInstanceAgent: true });
    const config = { instanceName: f.input.instance, instanceDir: join(f.root, "instance"), workingDirectory: f.input.workingDirectory,
      mcpServers: {}, kiroUi: "tui" as const, model: "claude-sonnet-4.6" };
    await b.prepareLaunch(config); b.writeConfig(config); const command = b.buildCommand(config);
    expect(command).toContain(`--resume-id '${f.input.sessionId}'`); expect(command).toContain("--agent-engine=v2");
    expect(command).not.toContain("--resume-picker"); expect(command).toContain("--model 'claude-sonnet-4.6'"); expect(own(f)).toBe(f.input.sessionId);
    expect(f.rows()).toHaveLength(2); for (const id of ["empty-1", "empty-2"]) expect(statSync(join(f.input.sessionsDir, id + ".jsonl")).size).toBe(0);
    expect(b.transcriptLaunch()).toEqual({ engine: "v2", sessionId: f.input.sessionId });
  });
  it("the first armed carry is permitted before its V2 copy exists; only the following launch archives", async () => {
    const f = fixture(), stateDir = join(f.input.agendHome, "kiro-identity", "instances");
    const statePath = join(stateDir, readdirSync(stateDir).find(n => n.endsWith(".json"))!);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    for (const key of Object.keys(state.keys)) if (state.keys[key].engine === "v2") delete state.keys[key];
    writeFileSync(statePath, JSON.stringify(state));
    rmSync(join(f.input.agendHome, "kiro-identity", "claims", "v2", f.input.sessionId));
    rmSync(join(f.input.sessionsDir, f.input.sessionId + ".json")); rmSync(join(f.input.sessionsDir, f.input.sessionId + ".jsonl"));
    armKiroTuiMigration(f.identity);
    const b = new KiroBackend(join(f.root, "instance"), { version: "2.34.0", source: "version", supportsLegacyUi: true, supportsTui: true, supportsV3: true,
      agentEngines: ["v1", "v2", "v3"], supportsEffortFlag: true, supportsInstanceAgent: true });
    const config = { instanceName: f.input.instance, instanceDir: join(f.root, "instance"), workingDirectory: f.input.workingDirectory,
      mcpServers: {}, kiroUi: "tui" as const, model: "claude-sonnet-4.6" };
    await b.prepareLaunch(config); b.writeConfig(config);
    expect(b.buildCommand(config)).toContain(`--resume-id '${f.input.sessionId}'`);
    expect(f.rows()).toHaveLength(3); expect(existsSync(join(f.input.agendHome, "kiro-classic-archives"))).toBe(false);
    expect(b.retainedResumeBlock()).toMatchObject({ reason: expect.stringContaining("kept") });
  });
  it("a replacement with work holds before any re-pin or deletion", () => {
    const f = fixture(); f.abandon(); f.empty("empty-1"); f.empty("worked", "not empty"); const before = f.rows();
    expect(() => prepareKiroCarryForLaunch(f.input)).toThrow(); expect(own(f)).toBeNull(); expect(f.rows()).toEqual(before);
  });
  it("incomplete original proof holds the actual backend before a fresh command can be built", async () => {
    const f = fixture(); f.abandon(); f.empty("empty-1"); f.empty("empty-2"); rmSync(join(f.input.sessionsDir, f.input.sessionId + ".jsonl"));
    const b = new KiroBackend(join(f.root, "instance"), { version: "2.34.0", source: "version", supportsLegacyUi: true, supportsTui: true, supportsV3: true,
      agentEngines: ["v1", "v2", "v3"], supportsEffortFlag: true, supportsInstanceAgent: true });
    const config = { instanceName: f.input.instance, instanceDir: join(f.root, "instance"), workingDirectory: f.input.workingDirectory, mcpServers: {}, kiroUi: "tui" as const };
    await b.prepareLaunch(config); expect(() => b.writeConfig(config)).toThrow(/kept/); expect(() => b.buildCommand(config)).toThrow(/kept/);
    expect(own(f)).toBeNull(); expect(f.rows()).toHaveLength(3);
  });
});

describe("review: complete ownership, history and durable first archive", () => {
  it.each([["v1", "engine"], ["v1", "credentialProfile"], ["v2", "engine"], ["v2", "workingDirectory"]])("refuses an inconsistent %s record's %s even with the original key and claim", (engine, field) => {
    const f = fixture(), dir = join(f.input.agendHome, "kiro-identity", "instances"), path = join(dir, readdirSync(dir).find(n => n.endsWith(".json"))!);
    const state = JSON.parse(readFileSync(path, "utf8"));
    for (const record of Object.values(state.keys) as any[]) if (record.engine === engine) record[field] = field === "engine" ? "v3" : "different";
    writeFileSync(path, JSON.stringify(state)); const before = f.rows();
    expect(() => archiveKiroClassicCopy(f.input)).toThrow(/record/); expect(f.rows()).toEqual(before);
  });
  it("a valid JSONL prefix missing the last classic turn is not a complete carry", () => {
    const f = fixture(), classic = JSON.parse(f.raw), db = new Database(f.input.dbPath);
    classic.history.push({ user: { content: { Prompt: { prompt: "second prompt" } } }, assistant: { Response: { message_id: "last-classic-turn", content: "must be carried too" } } });
    db.prepare("UPDATE conversations_v2 SET value=? WHERE key=? AND conversation_id=?").run(JSON.stringify(classic), f.input.workingDirectory, f.input.sessionId); db.close();
    const before = f.rows(); expect(() => archiveKiroClassicCopy(f.input)).toThrow(/complete frozen/); expect(f.rows()).toEqual(before);
  });
  it("matching message ids alone cannot hide missing or changed assistant/user content", () => {
    const f = fixture(), log = join(f.input.sessionsDir, f.input.sessionId + ".jsonl"), records = readFileSync(log, "utf8").trim().split("\n").map(x => JSON.parse(x));
    records[1].data.content[0].data = "truncated answer"; writeFileSync(log, records.map(x => JSON.stringify(x)).join("\n") + "\n");
    expect(() => archiveKiroClassicCopy(f.input)).toThrow(/complete frozen/); expect(f.rows()).toHaveLength(3);
  });
  it("complete tool inputs, success/error outputs and cancelled-tool prompts are covered", () => {
    const f = fixture(), classic = JSON.parse(f.raw), log = join(f.input.sessionsDir, f.input.sessionId + ".jsonl");
    const records = readFileSync(log, "utf8").trim().split("\n").map(x => JSON.parse(x));
    const append = (user: any, assistant: any, userKind: string, userData: any, blocks: any[]) => {
      classic.history.push({ user: { content: user }, assistant });
      records.push({ version: "v1", kind: userKind, data: userData }, { version: "v1", kind: "AssistantMessage", data: { message_id: Object.values(assistant)[0] && (Object.values(assistant)[0] as any).message_id, content: blocks } });
    };
    const call = (n: number) => ({ id: "tool-" + n, name: "read_file", args: { path: "README.md" } });
    const tool = (n: number) => ({ ToolUse: { message_id: "assistant-" + n, content: "", tool_uses: [call(n)] } });
    const block = (n: number) => [{ kind: "toolUse", data: { toolUseId: call(n).id, name: call(n).name, input: call(n).args } }];
    append({ Prompt: { prompt: "read it" } }, tool(2), "Prompt", { content: [{ kind: "text", data: "read it" }] }, block(2));
    append({ ToolUseResults: { tool_use_results: [{ tool_use_id: "tool-2", status: "Success", content: [{ Text: "saved output" }] }] } }, tool(3), "ToolResults", { results: { "tool-2": { result: { Success: { items: [{ Text: "saved output" }] } } } } }, block(3));
    append({ ToolUseResults: { tool_use_results: [{ tool_use_id: "tool-3", status: "Error", content: [{ Text: "read failed" }] }] } }, tool(4), "ToolResults", { results: { "tool-3": { result: { Error: { Custom: "read failed" } } } } }, block(4));
    append({ CancelledToolUses: { prompt: "cancel and inspect", tool_use_results: [{ tool_use_id: "tool-4", status: "Error", content: [{ Text: "cancelled" }] }] } }, { Response: { message_id: "final-assistant", content: "done" } }, "ToolResults", { content: [{ kind: "text", data: "cancel and inspect" }], results: { "tool-4": { result: "Cancelled" } } }, [{ kind: "text", data: "done" }]);
    const db = new Database(f.input.dbPath); db.prepare("UPDATE conversations_v2 SET value=? WHERE key=? AND conversation_id=?").run(JSON.stringify(classic), f.input.workingDirectory, f.input.sessionId); db.close();
    const write = () => writeFileSync(log, records.map(x => JSON.stringify(x)).join("\n") + "\n"); write();
    const saved = records[4].data.results["tool-2"].result.Success.items; records[4].data.results["tool-2"].result.Success.items = [];
    write(); expect(() => archiveKiroClassicCopy(f.input)).toThrow(/complete frozen/); expect(f.rows()).toHaveLength(3);
    records[4].data.results["tool-2"].result.Success.items = saved; write(); expect(archiveKiroClassicCopy(f.input)).toBeTruthy(); expect(f.rows()).toHaveLength(2);
  });
  it("first-use directory entries are synced through AGEND_HOME before deletion", () => {
    const f = fixture(), base = join(f.input.agendHome, "kiro-classic-archives"); let checked = false;
    archiveKiroClassicCopy(f.input, { checkpoint: () => {
      if (!fsTrace.syncs.some(x => x.endsWith(".tmp"))) return;
      const homeSync = fsTrace.syncs.indexOf(f.input.agendHome), baseSync = fsTrace.syncs.lastIndexOf(base), tempSync = fsTrace.syncs.findIndex(x => x.endsWith(".tmp"));
      expect(homeSync).toBeGreaterThanOrEqual(0); expect(baseSync).toBeGreaterThan(homeSync); expect(tempSync).toBeGreaterThan(baseSync); checked = true;
    } }); expect(checked).toBe(true);
  });
  it("failure to sync a newly created archive ancestor aborts before source deletion", () => {
    const f = fixture(), before = f.rows(); fsTrace.fail = f.input.agendHome;
    expect(() => archiveKiroClassicCopy(f.input)).toThrow(/directory fsync/); expect(f.rows()).toEqual(before);
    fsTrace.fail = ""; fsTrace.syncs = [];
    expect(archiveKiroClassicCopy(f.input)).toBeTruthy(); expect(fsTrace.syncs).toContain(f.input.agendHome);
  });
});
