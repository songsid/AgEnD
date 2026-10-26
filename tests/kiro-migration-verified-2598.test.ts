/** Offline two-launch workflow. Native launch/lifecycle boundaries are all stubbed. */
import Database from "better-sqlite3";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyKiroMigration, kiroMigrationPrompt, planKiroMigration, type KiroMigrateDeps } from "../src/kiro-migrate.js";
import { armKiroTuiMigration, kiroOwnedConversation, resolveKiroIdentity } from "../src/backend/kiro-identity.js";
import { archiveKiroClassicCopy } from "../src/backend/kiro-classic-archive.js";
import { verifyKiroMigrationStore } from "../src/backend/kiro-migration-verify.js";
import { KiroSessionSource } from "../src/transcript-sources.js";
import { Daemon } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";
import { sharedKiroV2StoreLane } from "../src/backend/kiro-v2-store.js";
import * as backendTypes from "../src/backend/types.js";
import * as kiro from "../src/backend/kiro.js";
import { kiroAgentName, kiroFleetTag } from "../src/backend/kiro-agent.js";
import { hasPausedMarker, readPauseReason } from "../src/pause-marker.js";
import { t } from "../src/locale.js";
import type { FleetConfig } from "../src/types.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "kiro-verified-")); vi.stubEnv("AGEND_HOME", root); vi.stubEnv("XDG_DATA_HOME", join(root, "xdg")); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const id = "6ca8be1a-6ec5-4cfc-9a2a-ea586133c27e", model = "claude-sonnet-4.6";
function fixture() {
  const cwd = join(root, "work"), sessions = join(root, "kiro", "sessions", "cli"), dbPath = join(root, "classic.sqlite");
  mkdirSync(cwd); mkdirSync(sessions, { recursive: true }); vi.stubEnv("KIRO_HOME", join(root, "kiro"));
  const db = new Database(dbPath); db.exec("CREATE TABLE conversations_v2(key TEXT,conversation_id TEXT,value TEXT,created_at INTEGER,updated_at INTEGER,PRIMARY KEY(key,conversation_id)); CREATE INDEX idx_conversations_v2_key_updated ON conversations_v2(key,updated_at)");
  db.prepare("INSERT INTO conversations_v2 VALUES (?,?,?,?,?)").run(cwd, id, JSON.stringify({ conversation_id: id, next_message: null, model_info: { model_id: model }, history: [{ user: { content: { Prompt: { prompt: "D5 prompt" } } }, assistant: { Response: { message_id: "D5-assistant", content: "D5 memory" } } }] }), 1, 2); db.close();
  const identity = { agendHome: root, instance: "wiki", workingDirectory: cwd, credentialProfile: null };
  const store = { kind: "ok" as const, sessions: [{ id, updatedAt: 2 }], createdAt: () => 1 };
  resolveKiroIdentity({ ...identity, engine: "v1", readStore: () => store, launchedBefore: () => true });
  const agent = kiroAgentName("wiki", kiroFleetTag(root));
  const meta = { session_id: id, cwd, exported_from_v1: true, session_created_reason: "subagent", created_at: "2026-10-26T05:19:07Z",
    session_state: { version: "v1", conversation_metadata: {}, agent_name: agent, rts_model_state: { conversation_id: id, model_info: { model_id: model } } } };
  const log = join(sessions, id + ".jsonl"), metaPath = join(sessions, id + ".json");
  const save = () => { writeFileSync(metaPath, JSON.stringify(meta)); writeFileSync(log, JSON.stringify({ version: "v1", kind: "Prompt", data: { content: [{ kind: "text", data: "D5 prompt" }] } }) + "\n" + JSON.stringify({ version: "v1", kind: "AssistantMessage", data: { message_id: "D5-assistant", content: [{ kind: "text", data: "D5 memory" }] } }) + "\n"); };
  const input = { ...identity, sessionId: id, dbPath, sessionsDir: sessions };
  const fleet = { defaults: {}, instances: { wiki: { backend: "kiro-cli", working_directory: cwd, model } } } as unknown as FleetConfig;
  const steps: string[] = []; let released = false, live = true;
  const verifyInput = (archived: boolean) => ({ ...input, archived, model, outboxDbPath: join(root, "absent-outbox.db"), knownInstances: ["wiki"] });
  const d: KiroMigrateDeps = {
    agendHome: root, fleetConfig: () => fleet, saveFleetConfig: vi.fn(), status: () => "running",
    reserve: () => ({ current: () => live, release: () => { released = true; } }),
    preflight: vi.fn(async () => { steps.push("preflight"); return model; }),
    restart: vi.fn(async () => {
      steps.push("restart");
      if (!kiroOwnedConversation({ ...identity, engine: "v2" })) { resolveKiroIdentity({ ...identity, engine: "v2", readStore: () => store, launchedBefore: () => false }); save(); }
      else archiveKiroClassicCopy(input, { stopped: () => {} });
    }),
    verify: vi.fn(async (_name, session, expected, archived) => {
      steps.push(archived ? "plain-verify" : "carry-verify"); expect(session).toBe(id); expect(expected).toBe(model);
      return verifyKiroMigrationStore(verifyInput(archived));
    }),
    stop: vi.fn(async () => { steps.push("stop"); }),
  };
  return { cwd, sessions, dbPath, identity, input, meta, metaPath, log, agent, save, fleet, d, steps, verifyInput,
    released: () => released, supersede: () => { live = false; } };
}
function plan(f: ReturnType<typeof fixture>) { const result = planKiroMigration(f.d, "wiki", false); if (!result.ok) throw new Error(result.error); return result.plan; }

describe("single-confirm verified migration", () => {
  it("carries once, archives on the plain restart, verifies both, and releases the lane", async () => {
    const f = fixture(); const out = await applyKiroMigration(f.d, plan(f));
    expect(out).toEqual({ ok: true, text: t("kiro_migrate.verified", "wiki", id, model, "clean") });
    expect(f.steps).toEqual(["preflight", "restart", "carry-verify", "restart", "plain-verify"]);
    expect(f.d.restart).toHaveBeenCalledTimes(2); expect(f.released()).toBe(true); expect(f.d.stop).not.toHaveBeenCalled();
    const db = new Database(f.dbPath); try { expect(db.prepare("SELECT count(*) n FROM conversations_v2").get()).toEqual({ n: 0 }); } finally { db.close(); }
    expect(kiroOwnedConversation({ ...f.identity, engine: "v2" })).toBe(id);
  });
  it.each(["busy", "unsupported version", "model unknown"])("preflight %s leaves everything untouched", async reason => {
    const f = fixture(); f.d.preflight = vi.fn(async () => { throw new Error(reason); });
    expect((await applyKiroMigration(f.d, plan(f))).ok).toBe(false);
    expect(f.fleet.instances.wiki.kiro_ui).toBeUndefined(); expect(f.d.saveFleetConfig).not.toHaveBeenCalled(); expect(f.d.restart).not.toHaveBeenCalled(); expect(f.released()).toBe(true);
  });
  it.each([1, 2])("failed verification %s stops without a success claim or fresh/classic fallback", async failure => {
    const f = fixture(), original = f.d.verify; let calls = 0;
    f.d.verify = vi.fn(async (name: string, session: string, expected: string, archived: boolean) => { if (++calls === failure) throw new Error("wrong model or pin"); return original(name, session, expected, archived); });
    const out = await applyKiroMigration(f.d, plan(f)); expect(out.ok).toBe(false); expect(out.text).toContain("wrong model or pin");
    expect(f.d.stop).toHaveBeenCalledOnce(); expect(f.d.restart).toHaveBeenCalledTimes(failure); expect(f.fleet.instances.wiki.kiro_ui).toBe("tui"); expect(f.released()).toBe(true);
  });
  it("restart failure is a failure and explicitly stops, not a successful queued migration", async () => {
    const f = fixture(); f.d.restart = vi.fn(async () => { throw new Error('Session id "'+id+'" is ambiguous (2 matches).'); });
    expect((await applyKiroMigration(f.d, plan(f))).ok).toBe(false); expect(f.d.stop).toHaveBeenCalledOnce(); expect(f.d.verify).not.toHaveBeenCalled();
  });
  it("an explicit stop/replacement while verification awaits never triggers the second restart", async () => {
    const f = fixture(); f.d.verify = vi.fn(async () => { f.supersede(); return { forensic: "clean" }; });
    expect((await applyKiroMigration(f.d, plan(f))).ok).toBe(false); expect(f.d.restart).toHaveBeenCalledOnce(); expect(f.d.stop).not.toHaveBeenCalled();
  });
  it("a changed effective model during preflight refuses before writing", async () => {
    const f = fixture(); f.d.preflight = vi.fn(async () => { f.fleet.instances.wiki.model = "different"; return model; });
    expect((await applyKiroMigration(f.d, plan(f))).ok).toBe(false); expect(f.d.saveFleetConfig).not.toHaveBeenCalled();
  });
  it("a failed stop is reported honestly, with history still pinned", async () => {
    const f = fixture(); f.d.verify = vi.fn(async () => { throw new Error("failed reader"); }); f.d.stop = vi.fn(async () => { throw new Error("stop timeout"); });
    const out = await applyKiroMigration(f.d, plan(f)); expect(out.ok).toBe(false); expect(out.text).toContain(t("kiro_migrate.stop_unconfirmed"));
    expect(kiroOwnedConversation({ ...f.identity, engine: "v2" })).toBe(id);
  });
  it("the admin sees sudo/password risk, both verification launches, and that stopped targets will start", () => {
    const f = fixture(), text = kiroMigrationPrompt(plan(f), false);
    expect(text).toContain("sudo"); expect(text).toContain("password"); expect(text).toContain("plain restart"); expect(text).toContain("confirming starts");
  });
});

describe("real store/transcript proof", () => {
  async function carried() { const f = fixture(); armKiroTuiMigration(f.identity); await f.d.restart("wiki"); return f; }
  it("pins the actual progress source to the carried JSONL and reads a new tool event", async () => {
    const f = await carried(); const lane = { acquire: () => ({ read: vi.fn(() => { throw new Error("TUI must not read classic"); }), close() {} }) } as never;
    const source = new KiroSessionSource(f.cwd, undefined, 1, f.dbPath, lane, () => ({ engine: "v2", sessionId: id }));
    try {
      await source.initialize(); expect(source.currentPath()).toBe(f.log);
      appendFileSync(f.log, JSON.stringify({ version: "v1", kind: "AssistantMessage", data: { content: [{ kind: "toolUse", data: { toolUseId: "new-tool", name: "read_file", input: { path: "README.md" } } }] } }) + "\n");
      const events = await source.poll(); expect(events?.toolUses).toEqual([expect.objectContaining({ name: "read_file", input: { path: "README.md" } })]);
    } finally { source.close(); }
  });
  it("a matching complete carried store gives a real forensic verdict; metadata mismatch refuses", async () => {
    const f = await carried(); expect(verifyKiroMigrationStore(f.verifyInput(false))).toEqual({ forensic: "clean" });
    f.meta.session_state.rts_model_state.model_info.model_id = "wrong"; f.save();
    expect(() => verifyKiroMigrationStore(f.verifyInput(false))).toThrow(/metadata\/model/);
  });
  it("a missing archive or still-indexed classic duplicate cannot pass plain-restart verification", async () => {
    const f = await carried(); expect(() => verifyKiroMigrationStore(f.verifyInput(true))).toThrow();
    const archive = archiveKiroClassicCopy(f.input, { stopped: () => {} })!;
    expect(verifyKiroMigrationStore(f.verifyInput(true))).toEqual({ forensic: "clean" });
    const payload = JSON.parse(readFileSync(archive, "utf8")).payload, row = payload.rows[0], db = new Database(f.dbPath);
    db.prepare("INSERT INTO conversations_v2 VALUES (?,?,?,?,?)").run(row.key, row.id, Buffer.from(row.valueBase64, "base64").toString(), row.createdAt, row.updatedAt); db.close();
    expect(() => verifyKiroMigrationStore(f.verifyInput(true))).toThrow(/still indexed/);
  });
  it("a malformed transcript is refused rather than a clean reader proof", async () => {
    const f = await carried(); writeFileSync(f.log, "{partial"); expect(() => verifyKiroMigrationStore(f.verifyInput(false))).toThrow(/reader/);
  });
});

const d5Idle = readFileSync("tests/fixtures/kiro-2.34.0-tui-d5/idle.pane.txt", "utf8");
const d5Picker = readFileSync("tests/fixtures/kiro-2.34.0-tui-d5/model-picker.pane.txt", "utf8");
const realPane = (agent: string) => d5Idle.replace("agend-audit-2598", agent);
function fakeDaemon(agent: string, transcript: string, pane?: string) {
  const d = Object.create(Daemon.prototype) as any;
  const owner = { bootId: "test", spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 0 };
  Object.assign(d, { processStatus: "running", spawning: false, runtimeMonitorsFrozen: false, interactionOwner: () => owner,
    backend: { binaryName: "kiro-cli", transcriptLaunch: () => ({ engine: "v2", sessionId: id }), readSteerComposer: () => "idle", agentSwitch: () => ({ agent }) },
    tmux: { capturePane: vi.fn(async () => pane ?? realPane(agent)) },
    logTranscriptPath: () => transcript, paneAuthoritativelyIdle: () => true,
  }); return { d, owner };
}
describe("actual daemon and fleet boundaries, native operations stubbed", () => {
  it("the live bottom pair provides the model; stale ownership and picker/history screens do not", async () => {
    const { d, owner } = fakeDaemon("our-agent", "/scratch/owned.jsonl");
    expect(await d.kiroMigrationObservation()).toEqual({ sessionId: id, model, transcript: "/scratch/owned.jsonl" });
    d.tmux.capturePane = async () => { owner.spawnGeneration++; return realPane("our-agent"); };
    // The real owner reader supplies snapshots, not a reference to a mutable tracker.
    d.interactionOwner = () => ({ ...owner }); expect(await d.kiroMigrationObservation()).toBeNull();
    expect(kiro.readActiveKiroModel(d5Picker)).toBeNull();
    expect(kiro.readActiveKiroModel(realPane("other"), "our-agent")).toBeNull();
  });
  it("the captured D5 idle footer verifies, while busy, picker, modal and history controls refuse", async () => {
    const { d } = fakeDaemon("agend-audit-2598", "/scratch/owned.jsonl", d5Idle);
    expect(kiro.readKiroSteerComposer(d5Idle)).toBe("idle");
    expect(kiro.readActiveKiroAgent(d5Idle, "tui")).toBeNull(); // action reader remains unchanged
    expect(kiro.readActiveKiroModel(d5Idle)).toBe(model);
    expect(await d.kiroMigrationObservation()).toEqual({ sessionId: id, model, transcript: "/scratch/owned.jsonl" });
    for (const pane of [d5Picker, readFileSync("tests/fixtures/kiro-2.34.0-tui-d5/busy-steer.pane.txt", "utf8"), d5Idle + "\nPermission required\n", d5Idle.replace("/scratch/agend-wiki", "Select model:")]) {
      d.tmux.capturePane = async () => pane;
      expect(kiro.readActiveKiroModel(pane)).toBeNull(); expect(await d.kiroMigrationObservation()).toBeNull();
    }
    const branch = d5Idle.replace("/scratch/agend-wiki", "/scratch/agend-wiki\n(main)");
    expect(kiro.readActiveKiroModel(branch)).toBe(model);
    expect(kiro.readActiveKiroModel(d5Idle.replace("/scratch/agend-wiki", "(main)\n/scratch/agend-wiki"))).toBe(model);
    expect(kiro.readActiveKiroModel(d5Idle.replace("/scratch/agend-wiki", ""))).toBeNull();
  });
  it("saved-agent resumes verify with the production agent-switch feature disabled", async () => {
    const f = fixture(); armKiroTuiMigration(f.identity); await f.d.restart("wiki");
    const backend = new kiro.KiroBackend(join(root, "instance"), { version: "2.30.0", source: "version", supportsLegacyUi: true,
      supportsTui: true, supportsV3: true, agentEngines: ["v1", "v2"], supportsInstanceAgent: true, supportsEffortFlag: true });
    backend.buildCommand({ instanceName: "wiki", instanceDir: join(root, "instance"), workingDirectory: f.cwd, kiroUi: "tui", model, mcpServers: {} });
    expect(backend.agentSwitch()).toBeNull(); // production default: saved agent remains, no switch action
    backend.readSteerComposer = () => "idle";
    const { d } = fakeDaemon("kiro_default", f.log); d.backend = backend;
    expect(await d.kiroMigrationObservation()).toEqual({ sessionId: id, model, transcript: f.log });
  });
  it("the full migration reserves the delivery lane and rejects competing restarts", async () => {
    const f = fixture(), fm = Object.create(FleetManager.prototype) as any;
    Object.assign(fm, { kiroMigrationRuns: new Map(), restartsInFlight: new Map(), stopsInFlight: new Map(), explicitStopGeneration: new Map(),
      shuttingDown: false, scheduleDeliveryOutboxPump: vi.fn() });
    const deps = fm.kiroMigrateDeps(), lease = deps.reserve("wiki");
    expect(fm.isInstanceRestarting("wiki")).toBe(true);
    await expect(fm.restartSingleInstance("wiki", { explicit: true })).rejects.toThrow(t("kiro_migrate.in_progress"));
    expect(() => deps.reserve("wiki")).toThrow(); lease.release(); expect(fm.isInstanceRestarting("wiki")).toBe(false);
  });
  it.each(["session", "model", "path", "replacement"])("production verification rejects changed %s proof", async changed => {
    const f = fixture(), fm = Object.create(FleetManager.prototype) as any;
    const daemon = { kiroMigrationObservation: vi.fn(async () => ({ sessionId: changed === "session" ? "other" : id,
      model: changed === "model" ? "other-model" : model, transcript: changed === "path" ? "/other.jsonl" : join(f.sessions, id + ".jsonl") })) };
    Object.assign(fm, { kiroMigrationRuns: new Map(), restartsInFlight: new Map(), stopsInFlight: new Map(), explicitStopGeneration: new Map(),
      shuttingDown: false, scheduleDeliveryOutboxPump: vi.fn(), lifecycle: { daemons: new Map([["wiki", daemon]]) }, fleetConfig: f.fleet, dataDir: root });
    vi.spyOn(sharedKiroV2StoreLane, "read").mockImplementation(async () => { fm.lifecycle.daemons.set("wiki", {}); return { kind: "ok", sessions: [], diagnostics: { reads: 0, hits: 0 }, verification: { forensic: "clean" } }; });
    const deps = fm.kiroMigrateDeps(), lease = deps.reserve("wiki");
    try { await expect(deps.verify("wiki", id, model, true)).rejects.toThrow();
      if (changed !== "replacement") expect(sharedKiroV2StoreLane.read).not.toHaveBeenCalled();
    } finally { lease.release(); }
  });
  it("failed workflow stop leaves a durable error pause, even when teardown itself fails", async () => {
    const f = fixture(), fm = Object.create(FleetManager.prototype) as any, dir = join(root, "instance");
    Object.assign(fm, { getInstanceDir: () => dir, stopInstance: vi.fn(async () => { throw new Error("teardown unconfirmed"); }) });
    await expect(fm.kiroMigrateDeps().stop("wiki")).rejects.toThrow("teardown unconfirmed");
    expect(hasPausedMarker(dir)).toBe(true); expect(readPauseReason(dir)).toBe("error");
  });
  it("its own completed stop preserves cleanup authority when replacement startup fails", async () => {
    const f = fixture(), fm = Object.create(FleetManager.prototype) as any;
    Object.assign(fm, { kiroMigrationRuns: new Map(), restartsInFlight: new Map(), stopsInFlight: new Map(), explicitStopGeneration: new Map(),
      shuttingDown: false, scheduleDeliveryOutboxPump: vi.fn(), restartSingleInstance: vi.fn(async () => { fm.explicitStopGeneration.set("wiki", 1); throw new Error("startup failed"); }) });
    const deps = fm.kiroMigrateDeps(), lease = deps.reserve("wiki");
    try { await expect(deps.restart("wiki")).rejects.toThrow("startup failed"); expect(lease.current()).toBe(true);
      fm.explicitStopGeneration.set("wiki", 2); expect(lease.current()).toBe(false);
    } finally { lease.release(); }
  });
  it("production preflight uses a fresh idle pane and refuses an unreadable model", async () => {
    const f = fixture(), fm = Object.create(FleetManager.prototype) as any;
    vi.spyOn(backendTypes, "resolveBinary").mockReturnValue("stub-kiro-cli");
    vi.spyOn(kiro, "getCachedKiroCliCompatibility").mockReturnValue({ version: "2.34.0", supportsTui: true, supportsInstanceAgent: true, agentEngines: ["v2"] } as never);
    const daemon = { kiroMigrationIdle: vi.fn(async () => false), getModelOverride: () => undefined };
    Object.assign(fm, { kiroMigrationRuns: new Map(), restartsInFlight: new Map(), stopsInFlight: new Map(), explicitStopGeneration: new Map(),
      shuttingDown: false, scheduleDeliveryOutboxPump: vi.fn(), lifecycle: { daemons: new Map([["wiki", daemon]]) }, fleetConfig: f.fleet, getInstanceStatus: () => "running" });
    const deps = fm.kiroMigrateDeps(), lease = deps.reserve("wiki");
    try { await expect(deps.preflight("wiki", plan(f))).rejects.toThrow(t("kiro_migrate.idle_required"));
      daemon.kiroMigrationIdle.mockResolvedValue(true); expect(await deps.preflight("wiki", plan(f))).toBe(model);
      delete f.fleet.instances.wiki.model; await expect(deps.preflight("wiki", plan(f))).rejects.toThrow(t("kiro_migrate.model_unknown"));
    } finally { lease.release(); }
  });
});
