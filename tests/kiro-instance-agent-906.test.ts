/**
 * #906 / #1410: one kiro agent and one conversation per instance (docs/design/kiro-per-instance-agent.md).
 *
 * Kiro's own behaviour is pinned by the design's evidence (E1–E12, offline and a real-account probe); these pin
 * AgEnD's side: agent identity and ownership, provenance-only removal, the per-key conversation identity, the
 * launch command, and reading the active agent off the live layout. Every root is a scratch directory: AGEND_HOME,
 * XDG_DATA_HOME and KIRO_HOME are stubbed per test, so no test reads the operator's kiro stores; no kiro, fleet or
 * tmux is started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expectedKiroServers, isOwnKiroAgent, kiroAgentName, kiroAgentPath, kiroFleetTag, kiroSteeringPath, kiroSteeringTag,
  removeKiroAgent, removeSharedKiroMcpEntries, removeTaggedKiroSteering, writeKiroAgent, writeSharedKiroMcpEntries,
  writeTaggedKiroSteering, KiroAgentConflictError, type KiroAgentSpec,
} from "../src/backend/kiro-agent.js";
import {
  confirmKiroAgentSwitch, forgetKiroIdentity, kiroAgentConfirmed, listKiroV1Sessions, listKiroV2Sessions,
  resolveKiroIdentity, KiroIdentityError, type KiroStoreRead,
} from "../src/backend/kiro-identity.js";
import { KiroBackend, probeKiroCliCompatibility, readActiveKiroAgent, type KiroCliCompatibility } from "../src/backend/kiro.js";
import { recordKiroLaunch } from "../src/backend/kiro-engine-ledger.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-906-"));
  vi.stubEnv("AGEND_HOME", join(root, "agend"));
  vi.stubEnv("XDG_DATA_HOME", join(root, "xdg"));
  vi.stubEnv("KIRO_HOME", join(root, "kiro-home"));
  mkdirSync(join(root, "agend", "instances"), { recursive: true });
  mkdirSync(join(root, "work"), { recursive: true });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

const FLEET = "f1eet000";
function spec(over: Partial<KiroAgentSpec> = {}): KiroAgentSpec {
  return {
    workingDirectory: join(root, "work"), instance: "worker", fleet: FLEET,
    instanceDir: join(root, "agend", "instances", "worker"), serverNames: ["agend"], ...over,
  };
}
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf-8"));
const mcpPath = () => join(root, "work", ".kiro", "settings", "mcp.json");

describe("§1 the agent: fleet-scoped name, canonical ownership", () => {
  it("two fleets with a same-named instance in one directory get different agents", () => {
    expect(kiroAgentName("worker", kiroFleetTag(join(root, "a")))).not.toBe(kiroAgentName("worker", kiroFleetTag(join(root, "b"))));
    expect(kiroAgentPath(spec({ fleet: "aaaaaaaa" }))).not.toBe(kiroAgentPath(spec({ fleet: "bbbbbbbb" })));
  });

  it("the plain and hashed forms never collide (mixed-form control)", () => {
    const hashed = kiroAgentName("中文", FLEET);
    expect(hashed).toMatch(/^agendx-[0-9a-f]{16}-f1eet000$/);
    const hashPart = hashed.slice("agendx-".length, -("-" + FLEET).length);
    // An instance literally named like the hash gets the plain form, which differs at the sixth character.
    expect(kiroAgentName(hashPart, FLEET)).toBe(`agend-${hashPart}-${FLEET}`);
    expect(kiroAgentName(hashPart, FLEET)).not.toBe(hashed);
  });

  it("writes exactly this instance's servers, its prompt, includeMcpJson true; rewriting our own file is fine", () => {
    const s = spec();
    const path = writeKiroAgent(s, "# AgEnD Fleet Context\nhi");
    const agent = readJson(path);
    expect(agent).toMatchObject({ name: kiroAgentName("worker", FLEET), prompt: "# AgEnD Fleet Context\nhi", includeMcpJson: true, resources: [] });
    expect(agent.mcpServers).toEqual({ "agend-worker": { command: join(s.instanceDir, "mcp-wrapper-agend.sh"), args: [] } });
    expect(isOwnKiroAgent(agent, s)).toBe(true);
    expect(() => writeKiroAgent(s, "again")).not.toThrow();
  });

  const notOurs: Array<[string, (a: Record<string, any>, s: KiroAgentSpec) => void]> = [
    ["an empty mcpServers", a => { a.mcpServers = {}; }],
    ["a sibling's wrapper", (a, s) => { a.mcpServers["agend-worker"].command = join(s.instanceDir, "..", "sibling", "mcp-wrapper-agend.sh"); }],
    ["an extra key", (a, s) => { a.mcpServers.extra = { command: join(s.instanceDir, "mcp-wrapper-agend.sh") }; }],
    ["a missing key", a => { delete a.mcpServers["agend-worker"]; a.mcpServers.other = { command: "x" }; }],
    ["another name", a => { a.name = "agend-worker-ffffffff"; }],
  ];
  for (const [label, mutate] of notOurs) {
    it(`not ours — ${label}: refused on write, kept on removal`, () => {
      const s = spec();
      const path = writeKiroAgent(s, "x");
      const foreign = readJson(path); mutate(foreign, s);
      writeFileSync(path, JSON.stringify(foreign));
      expect(() => writeKiroAgent(s, "x")).toThrow(KiroAgentConflictError);
      expect(removeKiroAgent(s).kept).toEqual([path]);
      expect(readJson(path)).toEqual(foreign);
    });
  }

  it("an instance with no servers: an empty map is still not ours", () => {
    const s = spec({ serverNames: [] });
    expect(isOwnKiroAgent({ name: kiroAgentName("worker", FLEET), mcpServers: {} }, s)).toBe(false);
  });

  it("a user file at our path (unparseable) refuses the launch and survives", () => {
    const s = spec();
    mkdirSync(join(root, "work", ".kiro", "agents"), { recursive: true });
    writeFileSync(kiroAgentPath(s), "not json");
    expect(() => writeKiroAgent(s, "x")).toThrow(KiroAgentConflictError);
    removeKiroAgent(s);
    expect(readFileSync(kiroAgentPath(s), "utf-8")).toBe("not json");
  });

  it("removal takes our file and our .bak; a .bak that is not ours stays", () => {
    const s = spec();
    const path = writeKiroAgent(s, "x");
    writeFileSync(`${path}.bak`, readFileSync(path));
    expect(removeKiroAgent(s)).toEqual({ removed: [path, `${path}.bak`], kept: [] });
    writeKiroAgent(s, "x");
    writeFileSync(`${path}.bak`, JSON.stringify({ name: "someone else" }));
    expect(removeKiroAgent(s)).toEqual({ removed: [path], kept: [`${path}.bak`] });
  });
});

describe("§4 the shared files: written only where free, removed only by provenance", () => {
  it("the transition writes this instance's key into an absent or free slot, keeping the user's servers", () => {
    mkdirSync(join(root, "work", ".kiro", "settings"), { recursive: true });
    writeFileSync(mcpPath(), JSON.stringify({ mcpServers: { outline: { command: "npx", args: ["outline"] } }, other: 1 }));
    expect(writeSharedKiroMcpEntries(spec())).toBe("written");
    const cfg = readJson(mcpPath());
    expect(cfg.other).toBe(1);
    expect(cfg.mcpServers.outline).toEqual({ command: "npx", args: ["outline"] });
    expect(cfg.mcpServers["agend-worker"].command).toBe(expectedKiroServers(spec())["agend-worker"]);
    expect(writeSharedKiroMcpEntries(spec())).toBe("unchanged");
  });

  it("a foreign command under our key is a conflict and is not overwritten", () => {
    mkdirSync(join(root, "work", ".kiro", "settings"), { recursive: true });
    writeFileSync(mcpPath(), JSON.stringify({ mcpServers: { "agend-worker": { command: "/other/fleet/instances/worker/mcp-wrapper-agend.sh" } } }));
    expect(writeSharedKiroMcpEntries(spec())).toBe("conflict");
    expect(readJson(mcpPath()).mcpServers["agend-worker"].command).toBe("/other/fleet/instances/worker/mcp-wrapper-agend.sh");
  });

  it("a malformed mcp.json is never repaired: unreadable", () => {
    mkdirSync(join(root, "work", ".kiro", "settings"), { recursive: true });
    writeFileSync(mcpPath(), "{ broken");
    expect(writeSharedKiroMcpEntries(spec())).toBe("unreadable");
    expect(removeSharedKiroMcpEntries(spec(), join(root, "agend", "instances"), true)).toBe("unreadable");
    expect(readFileSync(mcpPath(), "utf-8")).toBe("{ broken");
  });

  it("removal: our own wrapper and a gone instance's wrapper go; user keys (an npx agend-*), another fleet's and live siblings' stay", () => {
    const instances = join(root, "agend", "instances");
    mkdirSync(join(instances, "worker"), { recursive: true });
    mkdirSync(join(instances, "sibling"), { recursive: true });
    mkdirSync(join(root, "work", ".kiro", "settings"), { recursive: true });
    const servers = {
      "agend-worker": { command: join(instances, "worker", "mcp-wrapper-agend.sh") },
      "agend-gone": { command: join(instances, "gone", "mcp-wrapper-agend.sh") },
      "agend-sibling": { command: join(instances, "sibling", "mcp-wrapper-agend.sh") },
      "agend-tools": { command: "npx", args: ["agend-tools"] },
      "agend-elsewhere": { command: "/other/fleet/instances/x/mcp-wrapper-agend.sh" },
      agend: { command: "old" },
    };
    writeFileSync(mcpPath(), JSON.stringify({ mcpServers: servers }));
    expect(removeSharedKiroMcpEntries(spec(), instances, false)).toBe("written");
    expect(Object.keys(readJson(mcpPath()).mcpServers).sort()).toEqual(["agend", "agend-elsewhere", "agend-sibling", "agend-tools", "agend-worker"]);
    expect(removeSharedKiroMcpEntries(spec(), instances, true)).toBe("written");
    expect(Object.keys(readJson(mcpPath()).mcpServers).sort()).toEqual(["agend", "agend-elsewhere", "agend-sibling", "agend-tools"]);
  });

  it("our own key run by something else is kept even on our own removal", () => {
    mkdirSync(join(root, "work", ".kiro", "settings"), { recursive: true });
    writeFileSync(mcpPath(), JSON.stringify({ mcpServers: { "agend-worker": { command: "npx", args: ["something"] } } }));
    expect(removeSharedKiroMcpEntries(spec(), join(root, "agend", "instances"), true)).toBe("unchanged");
    expect(readJson(mcpPath()).mcpServers["agend-worker"]).toEqual({ command: "npx", args: ["something"] });
  });

  it("steering: tagged ours is written and removed; untagged legacy and foreign files are kept", () => {
    const s = spec();
    const path = kiroSteeringPath(s.workingDirectory, s.instance);
    expect(writeTaggedKiroSteering(s, "# AgEnD Fleet Context\nnew")).toBe("written");
    expect(readFileSync(path, "utf-8").split("\n")[0]).toBe(kiroSteeringTag(s));
    expect(removeTaggedKiroSteering(s)).toBe("removed");
    expect(existsSync(path)).toBe(false);

    const legacy = `# AgEnD Fleet Context\nYou are **worker**, an instance in an AgEnD fleet.\nYour working directory is \`${s.workingDirectory}\`.\nold`;
    writeFileSync(path, legacy);
    expect(writeTaggedKiroSteering(s, "new")).toBe("untagged-legacy");
    expect(removeTaggedKiroSteering(s)).toBe("untagged-legacy");
    expect(readFileSync(path, "utf-8")).toBe(legacy);

    writeFileSync(path, "my own notes");
    expect(writeTaggedKiroSteering(s, "new")).toBe("conflict");
    expect(removeTaggedKiroSteering(s)).toBe("foreign");
    expect(readFileSync(path, "utf-8")).toBe("my own notes");
  });

  it("two AGEND_HOMEs with a same-named instance in one directory: neither removes or overwrites the other's steering", () => {
    const a = spec({ fleet: "aaaaaaaa" }), b = spec({ fleet: "bbbbbbbb" });
    expect(writeTaggedKiroSteering(a, "A's")).toBe("written");
    expect(writeTaggedKiroSteering(b, "B's")).toBe("conflict");
    expect(removeTaggedKiroSteering(b)).toBe("foreign");
    expect(readFileSync(kiroSteeringPath(a.workingDirectory, "worker"), "utf-8")).toContain("A's");
  });
});

// ── §2 identity ──

function v1Store(rows: Array<[string, string, number]>): string {
  const dir = join(root, "xdg", "kiro-cli");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "data.sqlite3"));
  db.exec("CREATE TABLE IF NOT EXISTS conversations_v2 (key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, conversation_id)); CREATE INDEX IF NOT EXISTS idx_k ON conversations_v2(key, updated_at DESC);");
  const ins = db.prepare("INSERT OR REPLACE INTO conversations_v2 VALUES (?, ?, '{}', ?, ?)");
  for (const [key, id, at] of rows) ins.run(key, id, at, at);
  db.close();
  return join(dir, "data.sqlite3");
}

describe("§2 store selectors", () => {
  it("v1: this directory's conversations from conversations_v2, newest by updated_at; a missing database is empty", () => {
    const cwd = join(root, "work");
    expect(listKiroV1Sessions(cwd, join(root, "xdg", "kiro-cli", "data.sqlite3"))).toEqual({ kind: "ok", sessions: [] });
    const db = v1Store([[cwd, "c-old", 100], [cwd, "c-new", 200], [join(root, "other"), "c-other", 300]]);
    const read = listKiroV1Sessions(cwd, db);
    expect(read.kind === "ok" && read.sessions.sort((a, b) => b.updatedAt - a.updatedAt).map(s => s.id)).toEqual(["c-new", "c-old"]);
  });

  it("v1: a corrupt database is unreadable, never empty", () => {
    const dir = join(root, "xdg", "kiro-cli"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "data.sqlite3"), "not a database");
    expect(listKiroV1Sessions(join(root, "work"), join(dir, "data.sqlite3")).kind).toBe("unreadable");
  });

  it("v2: session files of this directory, subagents and other directories ignored", () => {
    const dir = join(root, "kiro-home", "sessions", "cli"); mkdirSync(dir, { recursive: true });
    const cwd = join(root, "work");
    const file = (id: string, extra: Record<string, unknown>) => writeFileSync(join(dir, `${id}.json`), JSON.stringify({ session_id: id, updated_at: "2026-10-08T10:00:00Z", ...extra }));
    file("s-mine", { cwd, updated_at: "2026-10-08T12:00:00Z" });
    file("s-sub", { cwd, session_created_reason: "subagent" });
    file("s-other", { cwd: join(root, "other") });
    writeFileSync(join(dir, "s-partial.json"), "{");
    expect(listKiroV2Sessions(cwd, dir)).toEqual({ kind: "ok", sessions: [{ id: "s-mine", updatedAt: Date.parse("2026-10-08T12:00:00Z") }] });
    expect(listKiroV2Sessions(cwd, join(root, "nope")).kind).toBe("ok");
  });
});

describe("§2 the conversation identity", () => {
  const home = () => join(root, "agend");
  let now = 1_000;
  const store = { read: { kind: "ok", sessions: [] } as KiroStoreRead, reads: 0 };
  beforeEach(() => { now = 1_000; store.read = { kind: "ok", sessions: [] }; store.reads = 0; });
  const resolveAs = (instance: string, over: Partial<Parameters<typeof resolveKiroIdentity>[0]> = {}) => resolveKiroIdentity({
    instance, engine: "v1", workingDirectory: join(root, "work"), credentialProfile: null, agendHome: home(),
    readStore: () => { store.reads++; return store.read; }, launchedBefore: () => true, now: () => now, ...over,
  });
  const ok = (...s: Array<[string, number]>): KiroStoreRead => ({ kind: "ok", sessions: s.map(([id, updatedAt]) => ({ id, updatedAt })) });

  it("adoption: a pre-#906 instance claims the newest conversation and resumes it, switch not yet confirmed", () => {
    store.read = ok(["c1", 10], ["c2", 20]);
    expect(resolveAs("a")).toEqual({ mode: "resume", id: "c2", agentConfirmed: false });
    expect(resolveAs("a")).toEqual({ mode: "resume", id: "c2", agentConfirmed: false }); // the same id on every retry
  });

  it("adoption needs evidence the instance ran here before: a new instance starts fresh, never with a sibling's conversation", () => {
    store.read = ok(["c1", 10]);
    expect(resolveAs("brand-new", { launchedBefore: () => false })).toEqual({ mode: "fresh" });
  });

  it("adoption with an unreadable store is legacy mode: nothing recorded, the next launch adopts", () => {
    store.read = { kind: "unreadable", detail: "locked" };
    expect(resolveAs("a")).toEqual({ mode: "legacy", reason: "locked" });
    expect(existsSync(join(home(), "kiro-identity", "instances", "a.json"))).toBe(false);
    store.read = ok(["c1", 10]);
    expect(resolveAs("a")).toMatchObject({ mode: "resume", id: "c1" });
  });

  it("an owned conversation resumes by its exact id without reading the store (an unreadable store does not matter)", () => {
    store.read = ok(["c1", 10]);
    resolveAs("a");
    store.read = { kind: "unreadable", detail: "x" }; store.reads = 0;
    expect(resolveAs("a")).toEqual({ mode: "resume", id: "c1", agentConfirmed: false });
    expect(store.reads).toBe(0);
  });

  it("an owned id whose claim is no longer this instance's is not resumed", () => {
    store.read = ok(["c1", 10]);
    resolveAs("a");
    writeFileSync(join(home(), "kiro-identity", "claims", "v1", "c1"), "someone-else\n");
    expect(resolveAs("a")).toEqual({ mode: "fresh" });
  });

  it("an abandoned id stays abandoned even when the fresh mark could not list it (store unreadable then)", () => {
    store.read = ok(["X", 10]);
    resolveAs("a");
    now = 2_000;
    store.read = { kind: "unreadable", detail: "x" };
    expect(resolveAs("a", { skipResume: true })).toEqual({ mode: "fresh" }); // known = [], abandoned = [X]
    now = 3_000;
    store.read = ok(["X", 9_000]); // X still claimed by a, updated after the mark
    expect(resolveAs("a")).toEqual({ mode: "fresh" });
  });

  it("two siblings at the upgrade: the first claim keeps the conversation, the second starts fresh", () => {
    store.read = ok(["c1", 10]);
    expect(resolveAs("a")).toMatchObject({ mode: "resume", id: "c1" });
    expect(resolveAs("b")).toEqual({ mode: "fresh" });
  });

  it("the explicit fresh start (skipResume) abandons the id for good; a fresh mark never resumes", () => {
    store.read = ok(["c1", 10]);
    resolveAs("a");
    now = 2_000;
    expect(resolveAs("a", { skipResume: true })).toEqual({ mode: "fresh" });
    // c1 updated later by nobody we know: still not taken back (abandoned and known)
    store.read = ok(["c1", 5_000]);
    expect(resolveAs("a")).toEqual({ mode: "fresh" });
  });

  it("take-up after a fresh launch: only the one new, unclaimed conversation, on a readable store; unreadable defers", () => {
    store.read = ok(["old", 10]);
    expect(resolveAs("a", { launchedBefore: () => false })).toEqual({ mode: "fresh" }); // since=1000, known=[old]
    now = 3_000;
    store.read = { kind: "unreadable", detail: "x" };
    expect(resolveAs("a")).toEqual({ mode: "fresh" });
    store.read = ok(["old", 10], ["new", 2_000]);
    expect(resolveAs("a")).toEqual({ mode: "resume", id: "new", agentConfirmed: true });
  });

  it("take-up is refused when two new conversations appeared, or a sibling in the directory is waiting too", () => {
    resolveAs("a", { launchedBefore: () => false });
    resolveAs("b", { launchedBefore: () => false });
    now = 3_000;
    store.read = ok(["n1", 2_000]);
    expect(resolveAs("a")).toEqual({ mode: "fresh" }); // b is waiting in the same directory
  });

  it("round trip: X abandoned, engine changed, then back — X is never claimed or resumed again", () => {
    store.read = ok(["X", 10]);
    expect(resolveAs("a")).toMatchObject({ id: "X" });
    now = 2_000;
    resolveAs("a", { skipResume: true }); // abandon X under v1
    expect(resolveAs("a", { engine: "v2" })).toEqual({ mode: "fresh" }); // a new key after adoption: durably fresh
    now = 3_000;
    store.read = ok(["X", 9_000]);
    expect(resolveAs("a")).toEqual({ mode: "fresh" });
  });

  it("a key change keeps the old key's record: going back resumes what it owned", () => {
    store.read = ok(["X", 10]);
    resolveAs("a");
    expect(resolveAs("a", { credentialProfile: "work" })).toEqual({ mode: "fresh" });
    expect(resolveAs("a")).toEqual({ mode: "resume", id: "X", agentConfirmed: false });
  });

  it("a malformed state file is not 'no state': this key starts fresh, never a selection", () => {
    mkdirSync(join(home(), "kiro-identity", "instances"), { recursive: true });
    writeFileSync(join(home(), "kiro-identity", "instances", "a.json"), "{ nope");
    store.read = ok(["c1", 10]);
    expect(resolveAs("a")).toEqual({ mode: "fresh" });
  });

  it("a fresh start that cannot be recorded refuses the launch", () => {
    mkdirSync(join(home(), "kiro-identity", "instances"), { recursive: true });
    chmodSync(join(home(), "kiro-identity", "instances"), 0o500);
    try {
      expect(() => resolveAs("a", { launchedBefore: () => false })).toThrow(KiroIdentityError);
    } finally { chmodSync(join(home(), "kiro-identity", "instances"), 0o700); }
  });

  it("confirmation is recorded per id; forget drops the records and releases the claims", () => {
    store.read = ok(["c1", 10]);
    resolveAs("a");
    expect(confirmKiroAgentSwitch(home(), "a", "v1", join(root, "work"), null, "other")).toBe(false);
    expect(confirmKiroAgentSwitch(home(), "a", "v1", join(root, "work"), null, "c1")).toBe(true);
    expect(resolveAs("a")).toEqual({ mode: "resume", id: "c1", agentConfirmed: true });
    expect(kiroAgentConfirmed(home(), "a", "v1", join(root, "work"), null, "c1")).toBe(true);
    forgetKiroIdentity(home(), "a");
    expect(existsSync(join(home(), "kiro-identity", "claims", "v1", "c1"))).toBe(false);
    expect(resolveAs("b")).toMatchObject({ mode: "resume", id: "c1" }); // released: adoptable again
  });
});

// ── the backend end to end ──

const COMPAT: KiroCliCompatibility = {
  version: "kiro-cli 2.28.0", supportsLegacyUi: true, supportsTui: true, supportsV3: true,
  agentEngines: ["v2", "v1", "v3"], supportsEffortFlag: true, supportsInstanceAgent: true, source: "version",
};
function backendConfig(over: Record<string, unknown> = {}) {
  return {
    workingDirectory: join(root, "work"), instanceDir: join(root, "agend", "instances", "worker"), instanceName: "worker",
    mcpServers: { agend: { command: "node", args: ["server.js"], env: {} } }, instructions: "# AgEnD Fleet Context\nhi", ...over,
  } as never;
}
function launch(backend: KiroBackend, over: Record<string, unknown> = {}) {
  const cfg = backendConfig(over);
  backend.writeConfig(cfg);
  return backend.buildCommand(cfg);
}
const agentName = () => kiroAgentName("worker", kiroFleetTag(join(root, "agend")));

describe("the backend: command and files per plan", () => {
  beforeEach(() => mkdirSync(join(root, "agend", "instances", "worker"), { recursive: true }));

  it("a brand-new instance: fresh with --agent, no resume flag, nothing in the shared files", () => {
    const cmd = launch(new KiroBackend(join(root, "agend", "instances", "worker"), COMPAT));
    expect(cmd).toContain(` --agent '${agentName()}'`);
    expect(cmd).not.toMatch(/--resume/);
    expect(existsSync(mcpPath())).toBe(false);
    expect(existsSync(join(root, "work", ".kiro", "steering", "agend-worker.md"))).toBe(false);
  });

  it("an existing instance: adopted by id, the transition keeps the shared entry and tagged steering until confirmed", () => {
    recordKiroLaunch({ instance: "worker", workingDirectory: join(root, "work"), credentialProfile: null, kiroVersion: "2.27.0", ui: "legacy", flags: ["--legacy-ui", "--agent-engine=v1"] });
    v1Store([[join(root, "work"), "conv-1", 100]]);
    const backend = new KiroBackend(join(root, "agend", "instances", "worker"), COMPAT);
    const cmd = launch(backend);
    expect(cmd).toContain(" --resume-id 'conv-1'");
    expect(cmd).toContain(` --agent '${agentName()}'`);
    expect(readJson(mcpPath()).mcpServers["agend-worker"]).toBeDefined();
    expect(readFileSync(join(root, "work", ".kiro", "steering", "agend-worker.md"), "utf-8")).toContain(`agend-agent:${agentName()}`);
    const sw = backend.agentSwitch()!;
    expect(sw).toMatchObject({ agent: agentName(), alreadyConfirmed: false, command: `/agent swap ${agentName()}` });
    expect(backend.instructionsSource()).toBeNull(); // still its saved agent: the steering file
    expect(sw.confirm()).toEqual([]);
    expect(backend.instructionsSource()).toBe(`.kiro/agents/${agentName()}.json (its "prompt" field)`);
    expect(readJson(mcpPath()).mcpServers["agend-worker"]).toBeUndefined();
    expect(existsSync(join(root, "work", ".kiro", "steering", "agend-worker.md"))).toBe(false);
    // The next launch: confirmed, nothing written to the shared files, still resumed by id.
    const again = launch(backend);
    expect(again).toContain(" --resume-id 'conv-1'");
    expect(readJson(mcpPath()).mcpServers["agend-worker"]).toBeUndefined();
    expect(backend.agentSwitch()!.alreadyConfirmed).toBe(true);
  });

  it("a kiro-cli without --agent / --resume-id: today's command and one warning", () => {
    const backend = new KiroBackend(join(root, "agend", "instances", "worker"), { ...COMPAT, supportsInstanceAgent: false });
    const cmd = launch(backend);
    expect(cmd).toMatch(/--trust-all-tools --resume$/);
    expect(cmd).not.toContain("--agent ");
    expect(backend.consumeLaunchWarning()).toContain("--resume-id");
    expect(backend.agentSwitch()).toBeNull();
  });

  it("a foreign file at the agent path refuses the launch", () => {
    mkdirSync(join(root, "work", ".kiro", "agents"), { recursive: true });
    writeFileSync(join(root, "work", ".kiro", "agents", `${agentName()}.json`), JSON.stringify({ name: "mine" }));
    expect(() => launch(new KiroBackend(join(root, "agend", "instances", "worker"), COMPAT))).toThrow(KiroAgentConflictError);
  });

  it("cleanup removes only what is this instance's", () => {
    const backend = new KiroBackend(join(root, "agend", "instances", "worker"), COMPAT);
    launch(backend);
    const agentFile = join(root, "work", ".kiro", "agents", `${agentName()}.json`);
    expect(existsSync(agentFile)).toBe(true);
    backend.cleanup(backendConfig());
    expect(existsSync(agentFile)).toBe(false);
  });
});

describe("§3 reading the active agent off the live layout (captures from the probe, kiro-cli 2.28.0)", () => {
  it("legacy: the bracket on the prompt row, the default without one, nothing for a non-prompt last row", () => {
    expect(readActiveKiroAgent("Model: auto\n\n[agend-a] 2% > Ready when you are!\n", "legacy")).toBe("agend-a");
    expect(readActiveKiroAgent("> OK\n ▸ Time: 1s\n2% >\n", "legacy")).toBe("kiro_default");
    expect(readActiveKiroAgent("[agend-a] 4% !>\n", "legacy")).toBe("agend-a");
    expect(readActiveKiroAgent("Thinking...\n", "legacy")).toBeNull();
    // A prompt row from earlier in the pane (or quoted in the conversation) is not the live one.
    expect(readActiveKiroAgent("> [agend-x] 3% > was quoted\nThinking...\n", "legacy")).toBeNull();
    expect(readActiveKiroAgent("[agend-x] 3% > an earlier turn\n> its answer\nThinking...\n", "legacy")).toBeNull();
  });

  it("TUI/v3: the status row right above the input row — earlier `›` rows are history", () => {
    const pane = [
      "  › Remember the word MANGO. [agend-evil] agend-evil · auto",
      "• OK",
      "──────────────────",
      "kiro_default · auto · ◔ 1%                     /tmp/w2",
      "──────────────────",
      "›  ask a question or describe a task ↵",
      "                                       /copy to clipboard",
    ].join("\n");
    expect(readActiveKiroAgent(pane, "tui")).toBe("kiro_default");
    expect(readActiveKiroAgent(pane.replace("kiro_default ·", "agend-a ·"), "tui")).toBe("agend-a");
    expect(readActiveKiroAgent("Default · auto · ◔ 3%\n›  ask\n", "v3")).toBe("Default");
    expect(readActiveKiroAgent("no input row here\n", "tui")).toBeNull();
  });
});

describe("§5 the capability gate, from real `chat --help` captures", () => {
  const help = (v: string) => readFileSync(join(__dirname, "fixtures", "kiro-help", `chat-help-${v}.txt`), "utf-8");
  // The help path: a version newer than the table (or no table entry) is judged by its help text plus its version.
  const viaHelp = (helpVersion: string, version: string | null) => probeKiroCliCompatibility("/fake/kiro-cli", (_b, args) => {
    if (args[0] === "--version") { if (version === null) throw new Error("no version"); return `kiro-cli ${version}\n`; }
    return help(helpVersion);
  });
  it("2.28.0 (newer than the table): --agent and --resume-id listed, version known — isolation on", () => {
    expect(viaHelp("2.28.0", "2.28.0").supportsInstanceAgent).toBe(true);
  });
  it("the flags without a known version (or below 2.21) keep today's command", () => {
    expect(viaHelp("2.28.0", null).supportsInstanceAgent).toBe(false);
    expect(viaHelp("1.27.0", null).supportsInstanceAgent).toBe(false);
  });
  it("the version table: 2.21.0 and later on, 2.20.x off", () => {
    expect(probeKiroCliCompatibility("/fake", () => "kiro-cli 2.21.0\n").supportsInstanceAgent).toBe(true);
    expect(probeKiroCliCompatibility("/fake", () => "kiro-cli 2.20.9\n").supportsInstanceAgent).toBe(false);
  });
});
