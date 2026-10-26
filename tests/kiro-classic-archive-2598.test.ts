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

const roots: string[] = [];
const psRoot = mkdtempSync(join(tmpdir(), "archive-ps-stub-")), savedPath = process.env.PATH;
beforeAll(() => {
  writeFileSync(join(psRoot, "ps"), "#!/bin/sh\nprintf '1 offline-fixture\\n'\n"); chmodSync(join(psRoot, "ps"), 0o700);
  process.env.PATH = psRoot + ":" + savedPath;
});
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { sharedKiroV2StoreLane.close(); process.env.PATH = savedPath; rmSync(psRoot, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agend-archive-")); roots.push(root);
  const home = join(root, "agend"), cwd = join(root, "work"), sessionsDir = join(root, "kiro", "sessions", "cli");
  for (const dir of [home, cwd, sessionsDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  vi.stubEnv("AGEND_HOME", home); vi.stubEnv("KIRO_HOME", join(root, "kiro")); vi.stubEnv("XDG_DATA_HOME", join(root, "xdg"));
  const id = "6ca8be1a-6ec5-4cfc-9a2a-ea586133c27e", instance = "archive-test";
  const dbPath = kiroV1DbPath(null); mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath); db.exec("CREATE TABLE conversations_v2 (key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(key,conversation_id))");
  const raw = '{"conversation_id":"'+id+'","history":["原本的對話\\nexact bytes"],"unknown_field":true}';
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
  writeFileSync(join(sessionsDir, id + ".jsonl"), JSON.stringify({ version: "v1", kind: "AssistantMessage", data: { content: [{ kind: "text", data: "D5 continuity history" }] } }) + "\n");
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
