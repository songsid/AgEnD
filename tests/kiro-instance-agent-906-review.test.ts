/**
 * #906 / #1416 review round 1: one regression per finding, each with the control that still works. Every root is a
 * scratch directory (AGEND_HOME, XDG_DATA_HOME, KIRO_HOME stubbed); no kiro, fleet or tmux is started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A write failure injected for one exact path (the identity state file), everything else written for real.
const inject = vi.hoisted(() => ({ failPath: null as string | null }));
vi.mock("../src/backend/kiro-engine-ledger.js", async original => {
  const real = await original<typeof import("../src/backend/kiro-engine-ledger.js")>();
  return { ...real, writeFileAtomic: (path: string, data: string) => {
    if (inject.failPath && path === inject.failPath) throw new Error("injected write failure");
    return real.writeFileAtomic(path, data);
  } };
});

// No kiro-cli is ever run: the backend factory's compatibility probe (and any binary lookup) finds nothing.
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  execFileSync: vi.fn(() => { throw new Error("no kiro-cli in tests"); }),
}));
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  isOwnKiroAgent, kiroAgentName, kiroFleetTag, removeSharedKiroMcpEntries, writeKiroAgent, kiroAgentDescription,
  type KiroAgentSpec,
} from "../src/backend/kiro-agent.js";
import { forgetKiroIdentity, listKiroV1Sessions, resolveKiroIdentity, KiroIdentityError, type KiroStoreRead } from "../src/backend/kiro-identity.js";
import { KiroBackend, readActiveKiroAgent, type KiroCliCompatibility } from "../src/backend/kiro.js";
import { resolveKiroV3Resume } from "../src/backend/kiro-v3-identity.js";
import { kasBucket } from "../src/backend/kiro-kas-store.js";
import { recordKiroLaunch } from "../src/backend/kiro-engine-ledger.js";
import { FleetManager } from "../src/fleet-manager.js";
import { authorizeExplicitInstanceRemoval } from "../src/instance-removal.js";
import { writeSharedKiroMcpEntries, writeTaggedKiroSteering, kiroSteeringPath } from "../src/backend/kiro-agent.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-906r-"));
  vi.stubEnv("AGEND_HOME", join(root, "agend"));
  vi.stubEnv("XDG_DATA_HOME", join(root, "xdg"));
  vi.stubEnv("KIRO_HOME", join(root, "kiro-home"));
  mkdirSync(join(root, "agend", "instances", "worker"), { recursive: true });
  mkdirSync(join(root, "work"), { recursive: true });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

const COMPAT: KiroCliCompatibility = {
  version: "kiro-cli 2.27.0", supportsLegacyUi: true, supportsTui: true, supportsV3: true,
  agentEngines: ["v2", "v1", "v3"], supportsEffortFlag: true, supportsInstanceAgent: true, source: "version",
};
const instanceDir = () => join(root, "agend", "instances", "worker");
const cfg = (over: Record<string, unknown> = {}) => ({
  workingDirectory: join(root, "work"), instanceDir: instanceDir(), instanceName: "worker",
  mcpServers: { agend: { command: "node", args: ["s.js"], env: {} } }, instructions: "# AgEnD Fleet Context\nhi", ...over,
}) as never;
const launch = (b: KiroBackend, over: Record<string, unknown> = {}) => { const c = cfg(over); b.writeConfig(c); return b.buildCommand(c); };
const agentFile = () => join(root, "work", ".kiro", "agents", `${kiroAgentName("worker", kiroFleetTag(join(root, "agend")))}.json`);
const mcpPath = () => join(root, "work", ".kiro", "settings", "mcp.json");
const stateName = (i: string) => `${createHash("sha256").update(i).digest("hex").slice(0, 32)}.json`;

describe("#1 CLI agent mode (no MCP servers) restarts, and mode switches keep the file ours", () => {
  it("write → build → cleanup → write, in CLI mode", () => {
    const b = new KiroBackend(instanceDir(), COMPAT);
    launch(b, { mcpServers: {} });
    expect(JSON.parse(readFileSync(agentFile(), "utf-8")).mcpServers).toEqual({});
    b.cleanup(cfg({ mcpServers: {} }));
    expect(existsSync(agentFile())).toBe(false);
    expect(() => launch(b, { mcpServers: {} })).not.toThrow();
  });
  it("MCP → CLI → MCP without a conflict", () => {
    const b = new KiroBackend(instanceDir(), COMPAT);
    launch(b);
    expect(() => launch(b, { mcpServers: {} })).not.toThrow();
    expect(() => launch(b)).not.toThrow();
  });
  it("an empty-map file without our provenance line is still not ours", () => {
    const spec: KiroAgentSpec = { workingDirectory: join(root, "work"), instance: "worker", fleet: "f", instanceDir: instanceDir(), serverNames: [] };
    expect(isOwnKiroAgent({ name: kiroAgentName("worker", "f"), description: "someone", mcpServers: {} }, spec)).toBe(false);
    expect(isOwnKiroAgent({ name: kiroAgentName("worker", "f"), description: kiroAgentDescription(spec), mcpServers: {} }, spec)).toBe(true);
  });
});

describe("#2 the TUI reader takes only the live bottom layout", () => {
  const pair = (agent: string) => `${agent} · auto · ◔ 1%        /w\n──────\n›  ask a question ↵`;
  it("a status/input pair followed by a modal is not live (neither theirs nor ours)", () => {
    const modal = "\n╭──────────────╮\n│ Allow this tool? │\n│ ❯ Yes  No    │\n╰──────────────╯";
    expect(readActiveKiroAgent(pair("kiro_default") + modal, "tui")).toBeNull();
    expect(readActiveKiroAgent(pair("agend-x") + modal, "tui")).toBeNull();
  });
  it("control: the pair followed by the right-aligned hint is live", () => {
    expect(readActiveKiroAgent(pair("agend-x") + "\n                                    /copy to clipboard", "tui")).toBe("agend-x");
  });
});

describe("#5 symlink siblings never take each other's conversation", () => {
  it("fresh A on the link and fresh B on the target: B does not take A's new conversation", () => {
    const target = join(root, "work"); const link = join(root, "link");
    symlinkSync(target, link);
    const home = join(root, "agend");
    let now = 1_000;
    const store = { read: { kind: "ok", sessions: [], createdAt: () => null } as KiroStoreRead };
    const r = (instance: string, cwd: string) => resolveKiroIdentity({ instance, engine: "v1", workingDirectory: cwd, credentialProfile: null,
      agendHome: home, readStore: () => store.read, launchedBefore: () => false, now: () => now });
    r("a", link); r("b", target);
    now = 3_000;
    store.read = { kind: "ok", sessions: [{ id: "a-conv", updatedAt: 2_000 }], createdAt: () => 2_000 };
    expect(r("b", target)).toEqual({ mode: "fresh" });
  });
});

describe("#6 take-up needs creation evidence, and an abandoned id stays given up after its state is lost", () => {
  const home = () => join(root, "agend");
  let now = 1_000;
  let store: KiroStoreRead = { kind: "ok", sessions: [], createdAt: () => null };
  beforeEach(() => { now = 1_000; store = { kind: "ok", sessions: [], createdAt: () => null }; });
  const r = (over: Record<string, unknown> = {}) => resolveKiroIdentity({ instance: "a", engine: "v1", workingDirectory: join(root, "work"),
    credentialProfile: null, agendHome: home(), readStore: () => store, launchedBefore: () => false, now: () => now, ...over });
  it("an old conversation updated after the mark (unreadable baseline) is not taken up; a new one is", () => {
    store = { kind: "unreadable", detail: "x" };
    expect(r()).toEqual({ mode: "fresh" }); // mark at 1000, known = []
    now = 3_000;
    store = { kind: "ok", sessions: [{ id: "old", updatedAt: 2_000 }], createdAt: () => 500 };
    expect(r()).toEqual({ mode: "fresh" });
    now = 5_000;
    store = { kind: "ok", sessions: [{ id: "new", updatedAt: 4_500 }], createdAt: () => 4_400 };
    expect(r()).toEqual({ mode: "resume", id: "new", agentConfirmed: true });
  });
  it("adopt X, abandon X, lose the state, unreadable fresh mark, X updated later: X never comes back", () => {
    store = { kind: "ok", sessions: [{ id: "X", updatedAt: 10 }], createdAt: () => 10 };
    expect(r({ launchedBefore: () => true })).toMatchObject({ mode: "resume", id: "X" });
    now = 2_000;
    expect(r({ skipResume: true })).toEqual({ mode: "fresh" });
    writeFileSync(join(home(), "kiro-identity", "instances", stateName("a")), "{ corrupt");
    store = { kind: "unreadable", detail: "x" };
    expect(r()).toEqual({ mode: "fresh" });
    now = 9_000;
    store = { kind: "ok", sessions: [{ id: "X", updatedAt: 8_000 }], createdAt: () => 8_500 }; // even a misleading created_at
    expect(r()).toEqual({ mode: "fresh" });
  });
});

describe("#6 the two abandonment barriers each hold on their own", () => {
  const home = () => join(root, "agend");
  it("the claim's abandoned mark lost (written back as held): the state's abandoned list still keeps X out", () => {
    let now = 1_000;
    let store: KiroStoreRead = { kind: "ok", sessions: [{ id: "X", updatedAt: 10 }], createdAt: () => 10 };
    const r = (over: Record<string, unknown> = {}) => resolveKiroIdentity({ instance: "a", engine: "v1", workingDirectory: join(root, "work"),
      credentialProfile: null, agendHome: home(), readStore: () => store, launchedBefore: () => true, now: () => now, ...over });
    r();
    now = 2_000;
    store = { kind: "unreadable", detail: "x" }; // the fresh mark lists nothing
    r({ skipResume: true });
    writeFileSync(join(home(), "kiro-identity", "claims", "v1", "X"), "a\n"); // as if the mark had not been written
    now = 9_000;
    store = { kind: "ok", sessions: [{ id: "X", updatedAt: 8_000 }], createdAt: () => 8_500 };
    expect(r()).toEqual({ mode: "fresh" });
  });
  it("a state file of an unknown version is not 'no state': fresh, never an adoption", () => {
    mkdirSync(join(home(), "kiro-identity", "instances"), { recursive: true });
    writeFileSync(join(home(), "kiro-identity", "instances", stateName("a")), JSON.stringify({ version: 99, instance: "a", keys: {} }));
    const store: KiroStoreRead = { kind: "ok", sessions: [{ id: "c1", updatedAt: 10 }], createdAt: () => 10 };
    expect(resolveKiroIdentity({ instance: "a", engine: "v1", workingDirectory: join(root, "work"), credentialProfile: null,
      agendHome: home(), readStore: () => store, launchedBefore: () => true })).toEqual({ mode: "fresh" });
  });
});

describe("#7 a CJK instance name gets the feature, not the old shared identity", () => {
  it("fresh, take-up, resume and forget for 中文-t123456", () => {
    const home = join(root, "agend");
    let now = 1_000;
    let store: KiroStoreRead = { kind: "ok", sessions: [], createdAt: () => null };
    const r = () => resolveKiroIdentity({ instance: "中文-t123456", engine: "v2", workingDirectory: join(root, "work"), credentialProfile: null,
      agendHome: home, readStore: () => store, launchedBefore: () => false, now: () => now });
    expect(r()).toEqual({ mode: "fresh" });
    now = 3_000;
    store = { kind: "ok", sessions: [{ id: "s1", updatedAt: 2_000 }], createdAt: () => 2_000 };
    expect(r()).toEqual({ mode: "resume", id: "s1", agentConfirmed: true });
    expect(r()).toEqual({ mode: "resume", id: "s1", agentConfirmed: true });
    forgetKiroIdentity(home, "中文-t123456");
    expect(existsSync(join(home, "kiro-identity", "claims", "v2", "s1"))).toBe(false);
  });
});

describe("#8 / R2#3 a failed adoption record is retried with exactly the conversation it chose", () => {
  const home = () => join(root, "agend");
  const statePath = () => join(home(), "kiro-identity", "instances", stateName("a"));
  afterEach(() => { inject.failPath = null; });
  const r = (store: KiroStoreRead) => resolveKiroIdentity({ instance: "a", engine: "v1", workingDirectory: join(root, "work"), credentialProfile: null,
    agendHome: home(), readStore: () => store, launchedBefore: () => true });
  const c1: KiroStoreRead = { kind: "ok", sessions: [{ id: "c1", updatedAt: 10 }], createdAt: () => 10 };
  function failFirst() {
    inject.failPath = statePath();
    expect(() => r(c1)).toThrow(KiroIdentityError);
    inject.failPath = null;
    expect(readFileSync(join(home(), "kiro-identity", "claims", "v1", "c1"), "utf-8")).toBe("a\n");
  }
  it("the store unchanged: c1", () => { failFirst(); expect(r(c1)).toEqual({ mode: "resume", id: "c1", agentConfirmed: false }); });
  it("c2 became newest meanwhile: still c1, and c2 is not claimed", () => {
    failFirst();
    expect(r({ kind: "ok", sessions: [{ id: "c1", updatedAt: 10 }, { id: "c2", updatedAt: 99 }], createdAt: () => 50 }))
      .toEqual({ mode: "resume", id: "c1", agentConfirmed: false });
    expect(existsSync(join(home(), "kiro-identity", "claims", "v1", "c2"))).toBe(false);
  });
  it("c2 newest and owned by B: still c1", () => {
    failFirst();
    writeFileSync(join(home(), "kiro-identity", "claims", "v1", "c2"), "b\n");
    expect(r({ kind: "ok", sessions: [{ id: "c2", updatedAt: 99 }, { id: "c1", updatedAt: 10 }], createdAt: () => 50 }))
      .toEqual({ mode: "resume", id: "c1", agentConfirmed: false });
  });
  it("the store unreadable at the retry: c1 all the same (no store read needed)", () => {
    failFirst();
    expect(r({ kind: "unreadable", detail: "locked" })).toEqual({ mode: "resume", id: "c1", agentConfirmed: false });
  });
});

describe("R2#4 a creation time that cannot be read defers the take-up and keeps the mark", () => {
  it("unreadable at 3000, readable again later: new1 is still taken up", () => {
    const home = join(root, "agend");
    let now = 1_000;
    let store: KiroStoreRead = { kind: "ok", sessions: [], createdAt: () => null };
    const r = () => resolveKiroIdentity({ instance: "a", engine: "v1", workingDirectory: join(root, "work"), credentialProfile: null,
      agendHome: home, readStore: () => store, launchedBefore: () => false, now: () => now });
    expect(r()).toEqual({ mode: "fresh" }); // mark at 1000
    const before = readFileSync(join(home, "kiro-identity", "instances", stateName("a")), "utf-8");
    now = 3_000;
    store = { kind: "ok", sessions: [{ id: "new1", updatedAt: 2_500 }], createdAt: () => "unreadable" };
    expect(r()).toEqual({ mode: "fresh" });
    expect(readFileSync(join(home, "kiro-identity", "instances", stateName("a")), "utf-8")).toBe(before); // mark kept
    now = 4_000;
    store = { kind: "ok", sessions: [{ id: "new1", updatedAt: 2_500 }], createdAt: () => 2_000 };
    expect(r()).toEqual({ mode: "resume", id: "new1", agentConfirmed: true });
  });
  it("the v1 adapter reports a failed creation lookup as unreadable, not as absent", () => {
    const dir = join(root, "xdg", "kiro-cli"); mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "data.sqlite3");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE conversations_v2 (key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, conversation_id)); CREATE INDEX idx_conversations_v2_key_updated ON conversations_v2(key, updated_at DESC);");
    db.prepare("INSERT INTO conversations_v2 VALUES (?, 'n1', '{}', 2000, 2500)").run(join(root, "work"));
    db.close();
    const read = listKiroV1Sessions(join(root, "work"), dbPath);
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.createdAt("n1")).toBe(2_000);
    expect(read.createdAt("absent")).toBeNull();
    rmSync(dbPath); writeFileSync(dbPath, "not a database any more");
    expect(read.createdAt("n1")).toBe("unreadable");
  });
});

describe("#9 v1 stores of different credential profiles do not block each other's take-up", () => {
  const home = () => join(root, "agend");
  const r = (instance: string, profile: string | null, engine: "v1" | "v2", now: number, store: KiroStoreRead) => resolveKiroIdentity({
    instance, engine, workingDirectory: join(root, "work"), credentialProfile: profile, agendHome: home(),
    readStore: () => store, launchedBefore: () => false, now: () => now });
  const empty: KiroStoreRead = { kind: "ok", sessions: [], createdAt: () => null };
  const one = (id: string): KiroStoreRead => ({ kind: "ok", sessions: [{ id, updatedAt: 2_000 }], createdAt: () => 2_000 });
  it("v1, work vs personal: each takes up its own", () => {
    r("a", "work", "v1", 1_000, empty); r("b", "personal", "v1", 1_000, empty);
    expect(r("a", "work", "v1", 3_000, one("a-conv"))).toMatchObject({ mode: "resume", id: "a-conv" });
    expect(r("b", "personal", "v1", 3_000, one("b-conv"))).toMatchObject({ mode: "resume", id: "b-conv" });
  });
  it("controls: the same v1 profile, or the shared v2 store, still wait", () => {
    r("a", "work", "v1", 1_000, empty); r("b", "work", "v1", 1_000, empty);
    expect(r("a", "work", "v1", 3_000, one("x"))).toEqual({ mode: "fresh" });
    r("c", "work", "v2", 1_000, empty); r("d", "personal", "v2", 1_000, empty);
    expect(r("c", "work", "v2", 3_000, one("y"))).toEqual({ mode: "fresh" });
  });
});

describe("#10 delete/replace forgets V3 ownership too", () => {
  it("the V3 state and its own claim go; another owner's claim stays", () => {
    const home = join(root, "agend");
    const v3 = join(home, "kiro-v3");
    mkdirSync(join(v3, "instances"), { recursive: true }); mkdirSync(join(v3, "claims"), { recursive: true });
    const bucket = kasBucket(join(root, "work"));
    writeFileSync(join(v3, "instances", "worker.json"), JSON.stringify({ bucket, credentialProfile: null, id: "sess_1", since: 1, known: [] }));
    writeFileSync(join(v3, "claims", "sess_1"), "worker\n");
    writeFileSync(join(v3, "claims", "sess_2"), "other\n");
    mkdirSync(join(root, "kiro-home", "sessions", bucket, "sess_1"), { recursive: true });
    writeFileSync(join(root, "kiro-home", "sessions", bucket, "sess_1", "session.json"), JSON.stringify({ createdAt: "2026-10-08T00:00:00Z" }));
    expect(resolveKiroV3Resume("worker", join(root, "work"), null, { agendHome: home, env: { KIRO_HOME: join(root, "kiro-home") } })).toBe("sess_1");
    new KiroBackend(instanceDir(), COMPAT).forget("worker");
    expect(existsSync(join(v3, "instances", "worker.json"))).toBe(false);
    expect(existsSync(join(v3, "claims", "sess_1"))).toBe(false);
    expect(readFileSync(join(v3, "claims", "sess_2"), "utf-8")).toBe("other\n");
    expect(resolveKiroV3Resume("worker", join(root, "work"), null, { agendHome: home, env: { KIRO_HOME: join(root, "kiro-home") } })).toBeNull();
  });
});

describe("R2#5 a crafted server key cannot aim the expected wrapper at a sibling", () => {
  it("`x/../../sibling/mcp-wrapper-agend-worker` with the sibling's wrapper: not ours — refused on write, kept (and its .bak) on cleanup", () => {
    const fleet = kiroFleetTag(join(root, "agend"));
    const spec: KiroAgentSpec = { workingDirectory: join(root, "work"), instance: "worker", fleet, instanceDir: instanceDir(), serverNames: ["agend"] };
    const crafted = {
      name: kiroAgentName("worker", fleet), description: kiroAgentDescription(spec),
      mcpServers: { "x/../../sibling/mcp-wrapper-agend-worker": { command: join(root, "agend", "instances", "sibling", "mcp-wrapper-agend.sh") } },
    };
    expect(isOwnKiroAgent(crafted, spec)).toBe(false);
    mkdirSync(join(root, "work", ".kiro", "agents"), { recursive: true });
    writeFileSync(agentFile(), JSON.stringify(crafted));
    writeFileSync(`${agentFile()}.bak`, JSON.stringify(crafted));
    expect(() => writeKiroAgent(spec, "x")).toThrow();
    new KiroBackend(instanceDir(), COMPAT).cleanup(cfg());
    expect(JSON.parse(readFileSync(agentFile(), "utf-8"))).toEqual(crafted);
    expect(existsSync(`${agentFile()}.bak`)).toBe(true);
  });
  it("a key that stays inside this directory once normalized (`x/../y`) is still not a server name of ours", () => {
    const spec: KiroAgentSpec = { workingDirectory: join(root, "work"), instance: "worker", fleet: "f", instanceDir: instanceDir(), serverNames: ["agend"] };
    expect(isOwnKiroAgent({ name: kiroAgentName("worker", "f"), description: kiroAgentDescription(spec),
      mcpServers: { "x/../y-worker": { command: join(instanceDir(), "y.sh") } } }, spec)).toBe(false); // join normalizes it to <dir>/y.sh
  });
  it("controls: the CLI empty map and the generated MCP agent stay ours", () => {
    const spec: KiroAgentSpec = { workingDirectory: join(root, "work"), instance: "worker", fleet: "f", instanceDir: instanceDir(), serverNames: ["agend"] };
    expect(isOwnKiroAgent({ name: kiroAgentName("worker", "f"), description: kiroAgentDescription(spec), mcpServers: {} }, spec)).toBe(true);
    expect(isOwnKiroAgent({ name: kiroAgentName("worker", "f"), description: kiroAgentDescription(spec),
      mcpServers: { "agend-worker": { command: join(instanceDir(), "mcp-wrapper-agend.sh"), args: [] } } }, spec)).toBe(true);
  });
});

describe("#12 a relative command is never ours", () => {
  it("a shared entry with a relative command naming our wrapper is kept", () => {
    mkdirSync(join(root, "work", ".kiro", "settings"), { recursive: true });
    // Relative to the fleet's own working directory these would name our wrapper and a gone instance's wrapper —
    // but kiro resolves them against ITS directory, so they are not evidence of anything.
    const rel = relative(process.cwd(), join(instanceDir(), "mcp-wrapper-agend.sh"));
    const relGone = relative(process.cwd(), join(root, "agend", "instances", "gone", "mcp-wrapper-agend.sh"));
    writeFileSync(mcpPath(), JSON.stringify({ mcpServers: { "agend-worker": { command: rel }, "agend-gone": { command: relGone } } }));
    const spec: KiroAgentSpec = { workingDirectory: join(root, "work"), instance: "worker", fleet: "f", instanceDir: instanceDir(), serverNames: ["agend"] };
    expect(removeSharedKiroMcpEntries(spec, join(root, "agend", "instances"), true)).toBe("unchanged");
  });
});

describe("#13 a user MCP server named like an Object property never breaks a launch", () => {
  it("`constructor` and `toString` keys survive, and a fresh launch succeeds", () => {
    mkdirSync(join(root, "work", ".kiro", "settings"), { recursive: true });
    const user = { constructor: { command: "/usr/bin/npx", args: ["c"] }, toString: { command: "/usr/bin/npx", args: ["t"] } };
    writeFileSync(mcpPath(), JSON.stringify({ mcpServers: user }));
    const b = new KiroBackend(instanceDir(), COMPAT);
    expect(() => launch(b)).not.toThrow();
    b.cleanup(cfg());
    expect(JSON.parse(readFileSync(mcpPath(), "utf-8")).mcpServers).toEqual(user);
  });
});

describe("#14 the version warning is added to the isolation warnings, not written over them", () => {
  it("2.28 above the tested maximum, with a shared-file conflict: both warnings are consumed", () => {
    mkdirSync(join(root, "work", ".kiro", "steering"), { recursive: true });
    writeFileSync(join(root, "work", ".kiro", "steering", "agend-worker.md"), "my notes");
    recordKiroLaunch({ instance: "worker", workingDirectory: join(root, "work"), credentialProfile: null, kiroVersion: "2.27.0", ui: "legacy", flags: ["--legacy-ui", "--agent-engine=v1"] });
    const dir = join(root, "xdg", "kiro-cli"); mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "data.sqlite3"));
    db.exec("CREATE TABLE conversations_v2 (key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, conversation_id)); CREATE INDEX idx_conversations_v2_key_updated ON conversations_v2(key, updated_at DESC);");
    db.prepare("INSERT INTO conversations_v2 VALUES (?, 'c1', '{}', 1, 1)").run(join(root, "work"));
    db.close();
    const b = new KiroBackend(instanceDir(), { ...COMPAT, version: "kiro-cli 2.28.0", source: "help" });
    launch(b);
    const warning = b.consumeLaunchWarning() ?? "";
    expect(warning).toContain("steering");
    expect(warning).toContain("2.28.0");
  });
});

describe("#15 the v1 selector reads through the metadata index, or not at all", () => {
  it("without the index the store is unreadable, never scanned", () => {
    const dir = join(root, "xdg", "kiro-cli"); mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "data.sqlite3"));
    db.exec("CREATE TABLE conversations_v2 (key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, conversation_id));");
    db.close();
    expect(listKiroV1Sessions(join(root, "work"), join(dir, "data.sqlite3")).kind).toBe("unreadable");
  });
  it("with realistic statistics the query still searches the index, reading updated_at from it", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE conversations_v2 (key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, conversation_id)); CREATE INDEX idx_conversations_v2_key_updated ON conversations_v2(key, updated_at DESC); CREATE INDEX idx_conversations_v2_updated_at ON conversations_v2(updated_at DESC);");
    const ins = db.prepare("INSERT INTO conversations_v2 VALUES (?, ?, ?, ?, ?)");
    for (let k = 0; k < 3; k++) for (let i = 0; i < 20; i++) ins.run(`/k${k}`, `c${k}-${i}`, "x".repeat(50_000), i, i);
    db.exec("ANALYZE");
    const q = "SELECT conversation_id AS id, updated_at AS at FROM conversations_v2 INDEXED BY idx_conversations_v2_key_updated WHERE key IN (?, ?, ?)";
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${q}`).all("/k0", "/k0", "/k0") as Array<{ detail: string }>;
    expect(plan.map(p => p.detail).join(" ")).toContain("USING INDEX idx_conversations_v2_key_updated");
    // updated_at (table column 4, after `value`) is never read from the table cursor
    const ops = db.prepare(`EXPLAIN ${q}`).all("/k0", "/k0", "/k0") as Array<{ opcode: string; p1: number; p2: number }>;
    const tableCursor = (ops.find(o => o.opcode === "OpenRead" && o.p2 === 2) as { p1: number } | undefined)?.p1;
    expect(ops.some(o => o.opcode === "Column" && o.p1 === tableCursor && o.p2 === 4)).toBe(false);
    db.close();
  });
});

describe("#11 deleting an instance on the fleet's default kiro backend, with no daemon, cleans up its files", () => {
  it("agent file, tagged steering and shared entry go; the user's server stays", async () => {
    const dataDir = join(root, "agend");
    const fm = new FleetManager(dataDir);
    const dir = fm.getInstanceDir("worker");
    const spec: KiroAgentSpec = { workingDirectory: join(root, "work"), instance: "worker", fleet: kiroFleetTag(dataDir), instanceDir: dir, serverNames: ["agend"] };
    mkdirSync(join(root, "work", ".kiro", "settings"), { recursive: true });
    writeFileSync(mcpPath(), JSON.stringify({ mcpServers: { outline: { command: "npx", args: ["outline"] } } }));
    writeKiroAgent(spec, "# AgEnD Fleet Context");
    writeSharedKiroMcpEntries(spec);
    writeTaggedKiroSteering(spec, "# AgEnD Fleet Context");
    fm.fleetConfig = { defaults: { backend: "kiro-cli" }, instances: { worker: { working_directory: join(root, "work") } } } as never;
    await fm.lifecycle.remove("worker", authorizeExplicitInstanceRemoval("delete-instance-tool"));
    expect(existsSync(agentFile())).toBe(false);
    expect(existsSync(kiroSteeringPath(join(root, "work"), "worker"))).toBe(false);
    expect(JSON.parse(readFileSync(mcpPath(), "utf-8")).mcpServers).toEqual({ outline: { command: "npx", args: ["outline"] } });
  });
});
