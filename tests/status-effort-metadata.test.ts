import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const guards = vi.hoisted(() => ({
  armed: false,
  writes: [] as string[],
  createBackend: vi.fn(() => { throw new Error("backend construction forbidden in metadata queries"); }),
  subprocess: vi.fn(() => { throw new Error("subprocess forbidden in this harness"); }),
  httpHandler: null as null | ((req: IncomingMessage, res: ServerResponse) => void),
}));
vi.mock("../src/backend/factory.js", () => ({ createBackend: guards.createBackend }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: guards.subprocess, execSync: guards.subprocess, spawnSync: guards.subprocess,
  execFile: guards.subprocess, exec: guards.subprocess, spawn: guards.subprocess,
}));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const guarded: Record<string, unknown> = {};
  for (const key of ["mkdirSync", "renameSync", "symlinkSync", "writeFileSync", "rmSync", "unlinkSync", "chmodSync", "copyFileSync", "cpSync", "openSync"] as const) {
    guarded[key] = (...args: unknown[]) => {
      if (guards.armed) {
        guards.writes.push(key);
        throw new Error(`filesystem mutation forbidden during metadata query: ${key}`);
      }
      return (actual[key] as (...args: unknown[]) => unknown)(...args);
    };
  }
  return { ...actual, ...guarded };
});
vi.mock("../src/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }),
  rotateLogIfNeeded: vi.fn(),
  rotateLogIfNeededAsync: vi.fn(async () => {}),
}));
// Context refresh has its own async tmux path; this test targets effort metadata.
vi.mock("../src/topic-commands.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/topic-commands.js")>(),
  resolveInstanceContext: () => ({ context: null, tokenRatio: null }),
}));
vi.mock("node:http", async importOriginal => ({
  ...await importOriginal<typeof import("node:http")>(),
  createServer: vi.fn((handler: (req: IncomingMessage, res: ServerResponse) => void) => {
    guards.httpHandler = handler;
    return { on: vi.fn(), listen: vi.fn() }; // No socket/listener/lifecycle starts.
  }),
}));

import { FleetManager } from "../src/fleet-manager.js";
import { CodexBackend } from "../src/backend/codex.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { KiroBackend } from "../src/backend/kiro.js";
import { GrokBackend } from "../src/backend/grok.js";
import { AntigravityBackend } from "../src/backend/antigravity.js";
import { MuseBackend } from "../src/backend/muse.js";
import { CODEX_MODELS_CACHE_MAX_BYTES, codexMetadataHomes, codexShortHomeFor, readCodexEffortLevels } from "../src/backend/codex-metadata.js";
import { readEffortMetadata } from "../src/backend/effort-metadata.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";

let root: string;
let shared: string;
let instanceDir: string;
const floor = ["low", "medium", "high", "xhigh"];
const five = [...floor, "max"];
function cache(home: string, models: Array<[string, unknown[]]>): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: models.map(([slug, efforts]) => ({
    slug, supported_reasoning_levels: efforts.map(effort => ({ effort })),
  })) }));
}
function config(home: string, model: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), `model = "${model}"\n`);
}
function arm(): void {
  guards.createBackend.mockClear(); guards.subprocess.mockClear(); guards.writes.length = 0;
  guards.armed = true;
}
function assertPure(): void {
  expect(guards.createBackend).not.toHaveBeenCalled();
  expect(guards.subprocess).not.toHaveBeenCalled();
  expect(guards.writes).toEqual([]);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-status-metadata-"));
  shared = join(root, "shared"); instanceDir = join(root, "instances", "worker");
  mkdirSync(shared, { recursive: true }); mkdirSync(instanceDir, { recursive: true });
  vi.stubEnv("AGEND_HOME", join(root, "agend")); vi.stubEnv("CODEX_HOME", shared);
  guards.armed = false; guards.writes.length = 0; guards.httpHandler = null;
  guards.createBackend.mockClear(); guards.subprocess.mockClear();
});
afterEach(() => {
  guards.armed = false; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("pure effort metadata", () => {
  const cases = [
    ["claude-code", "runtime", five, ClaudeCodeBackend.prototype],
    ["kiro-cli", "restart", five, KiroBackend.prototype],
    ["grok", "runtime", ["low", "medium", "high"], GrokBackend.prototype],
    ["antigravity", "runtime", ["low", "medium", "high"], AntigravityBackend.prototype],
    ["muse", "runtime", five, MuseBackend.prototype],
  ] as const;
  it.each(cases)("%s shares its backend's strategy/levels without constructing it", (name, strategy, levels, prototype) => {
    arm();
    expect(readEffortMetadata(name, instanceDir)).toEqual({ strategy, levels });
    expect(prototype.getEffortStrategy()).toBe(strategy);
    expect(prototype.getEffortLevels()).toEqual(levels);
    assertPure();
  });
  it.each(["opencode", "gemini-cli", "mock", "unknown", "agy", "__proto__", "constructor", "toString"])("%s remains unsupported", name => {
    arm(); expect(readEffortMetadata(name, instanceDir)).toEqual({ strategy: "unsupported", levels: [] }); assertPure();
  });
  it("returns independent level arrays across profiles and calls", () => {
    readEffortMetadata("muse", instanceDir).levels.splice(0);
    expect(readEffortMetadata("muse", join(root, "other")).levels).toEqual(five);
  });
  it("keeps the canonical short-home hash and never creates it", () => {
    arm();
    const home = codexShortHomeFor(instanceDir);
    expect(home).toBe(CodexBackend.shortHomeFor(instanceDir));
    expect(home).toBe(codexShortHomeFor(`${instanceDir}/../worker/`));
    expect(home).toMatch(/\/cx\/[a-f0-9]{8}$/);
    expect(existsSync(home)).toBe(false); assertPure();
  });
  it("reads shared config/cache without preparing an instance home", () => {
    config(shared, "large"); cache(shared, [["large", five]]);
    arm(); expect(readEffortMetadata("codex", instanceDir)).toEqual({ strategy: "restart", levels: five });
    expect(existsSync(join(instanceDir, "codex-home"))).toBe(false);
    expect(existsSync(codexShortHomeFor(instanceDir))).toBe(false); assertPure();
  });
  it("reads a real legacy home without migrating or touching it", () => {
    const legacy = join(instanceDir, "codex-home");
    config(legacy, "legacy"); cache(legacy, [["legacy", ["low", "high", "max"]]]);
    config(shared, "shared"); cache(shared, [["shared", ["medium"]]]);
    arm(); expect(readEffortMetadata("codex", instanceDir).levels).toEqual(["low", "high", "max"]);
    expect(lstatSync(legacy).isDirectory()).toBe(true);
    expect(readFileSync(join(legacy, "config.toml"), "utf-8")).toContain("legacy");
    expect(existsSync(codexShortHomeFor(instanceDir))).toBe(false); assertPure();
  });
  it("preserves values before and after migration, including the compatibility symlink", () => {
    const legacy = join(instanceDir, "codex-home"); const short = codexShortHomeFor(instanceDir);
    config(legacy, "private"); cache(legacy, [["private", five]]);
    const before = readEffortMetadata("codex", instanceDir);
    mkdirSync(join(root, "agend", "cx"), { recursive: true }); renameSync(legacy, short); symlinkSync(short, legacy);
    arm(); expect(readEffortMetadata("codex", instanceDir)).toEqual(before); assertPure();
  });
  it("prefers the short home when both real directories exist", () => {
    const short = codexShortHomeFor(instanceDir); const legacy = join(instanceDir, "codex-home");
    config(short, "short"); cache(short, [["short", ["max"]]]);
    config(legacy, "legacy"); cache(legacy, [["legacy", ["low"]]]);
    arm(); expect(readEffortMetadata("codex", instanceDir).levels).toEqual(["max"]); assertPure();
  });
  it("does not follow an external legacy symlink or repair a dangling one", () => {
    const external = join(root, "external"); config(external, "external"); cache(external, [["external", ["low"]]]);
    config(shared, "shared"); cache(shared, [["shared", five]]);
    symlinkSync(external, join(instanceDir, "codex-home"));
    arm(); expect(readEffortMetadata("codex", instanceDir).levels).toEqual(five); assertPure();
    guards.armed = false; rmSync(external, { recursive: true }); arm();
    expect(readEffortMetadata("codex", instanceDir).levels).toEqual(five);
    expect(lstatSync(join(instanceDir, "codex-home")).isSymbolicLink()).toBe(true); assertPure();
  });
  it("keeps per-instance model/cache scope and observes changes on the next read", () => {
    const other = join(root, "instances", "other");
    const a = codexShortHomeFor(instanceDir); const b = codexShortHomeFor(other);
    config(a, "small"); cache(a, [["small", floor], ["large", five]]);
    config(b, "large"); cache(b, [["large", ["medium", "max"]]]);
    arm(); expect(readEffortMetadata("codex", instanceDir).levels).toEqual(floor);
    expect(readEffortMetadata("codex", other).levels).toEqual(["medium", "max"]); assertPure();
    guards.armed = false; config(a, "large"); arm();
    expect(readEffortMetadata("codex", instanceDir).levels).toEqual(five); assertPure();
  });
  it("uses isolated config with shared cache when only the isolated cache is absent", () => {
    config(codexShortHomeFor(instanceDir), "small"); config(shared, "large");
    cache(shared, [["small", ["low", "xhigh"]], ["large", five]]);
    arm(); expect(readEffortMetadata("codex", instanceDir).levels).toEqual(["low", "xhigh"]); assertPure();
  });
  it("preserves the backend's last launched model over config.toml", () => {
    config(shared, "small"); cache(shared, [["small", floor], ["launched", five]]);
    // No constructor/buildCommand: provide only the state consumed by this getter.
    const backend = Object.assign(Object.create(CodexBackend.prototype), {
      isolatedCodexHome: codexShortHomeFor(instanceDir), sharedCodexHome: shared, lastKnownModel: "launched",
    }) as CodexBackend;
    arm(); expect(backend.getEffortLevels()).toEqual(five);
    expect(readEffortMetadata("codex", instanceDir).levels).toEqual(floor); assertPure();
  });
  it("filters non-canonical catalog values and retains catalog order", () => {
    config(shared, "model"); cache(shared, [["model", ["max", "low", "ultra", "", 2, null, "xhigh"]]]);
    arm(); expect(readEffortMetadata("codex", instanceDir).levels).toEqual(["max", "low", "xhigh"]); assertPure();
  });
  it.each(["missing", "corrupt", "unknown-model", "empty-levels", "bad-levels", "bad-models", "oversized"])("%s cache uses the existing low…xhigh fallback", shape => {
    config(shared, "model");
    if (shape === "corrupt") writeFileSync(join(shared, "models_cache.json"), "{bad");
    if (shape === "unknown-model") cache(shared, [["other", five]]);
    if (shape === "empty-levels") cache(shared, [["model", []]]);
    if (shape === "bad-levels") writeFileSync(join(shared, "models_cache.json"), JSON.stringify({ models: [{ slug: "model", supported_reasoning_levels: {} }] }));
    if (shape === "bad-models") writeFileSync(join(shared, "models_cache.json"), JSON.stringify({ models: {} }));
    if (shape === "oversized") writeFileSync(join(shared, "models_cache.json"), " ".repeat(CODEX_MODELS_CACHE_MAX_BYTES) + JSON.stringify({ models: [{ slug: "model", supported_reasoning_levels: [{ effort: "max" }] }] }));
    arm(); expect(readEffortMetadata("codex", instanceDir).levels).toEqual(floor); assertPure();
  });
  it("does not replace an invalid isolated cache with another account's shared cache", () => {
    const short = codexShortHomeFor(instanceDir); config(short, "same-model");
    writeFileSync(join(short, "models_cache.json"), "{bad"); cache(shared, [["same-model", ["max"]]]);
    arm(); expect(readEffortMetadata("codex", instanceDir).levels).toEqual(floor); assertPure();
  });
  it("returns the floor when neither home config identifies a model", () => {
    cache(shared, [["anything", ["max"]]]);
    arm(); expect(readCodexEffortLevels(codexMetadataHomes(instanceDir))).toEqual(floor); assertPure();
  });
});

function fleet(): FleetManager {
  const fm = new FleetManager(root);
  fm.fleetConfig = { defaults: { backend: "muse", model: "default-model", effort: "high" }, instances: {
    worker: { backend: "codex", effort: "max", working_directory: root },
    claude: { backend: "claude-code", working_directory: root },
    kiro: { backend: "kiro-cli", working_directory: root },
    agy: { backend: "antigravity", working_directory: root },
    stopped: { backend: "opencode", working_directory: root },
    bad: { backend: "unknown", working_directory: root },
    inherited: { working_directory: root },
  } } as never;
  fm.classicChannels = {
    getAll: () => [{ instanceName: "classic", channelId: "chat", adapterId: "secondary", name: "Room", displayName: "Classic name" }],
    getChannelIdByInstance: (name: string) => name === "classic" ? "chat" : undefined,
    getBackendByInstance: () => "grok",
    getModel: () => "classic-model",
  } as never;
  vi.spyOn(fm, "getInstanceStatus").mockReturnValue("stopped");
  vi.spyOn(fm, "getInstanceExecutionState").mockReturnValue("idle");
  Object.assign(fm, { getInstanceIdle: vi.fn(() => true) });
  vi.spyOn(fm, "lastActivityMs").mockReturnValue(0);
  return fm;
}
describe("FleetManager status composers", () => {
  it("renders repeated fleet/Classic status without constructors, probes or home mutation", () => {
    const fm = fleet(); config(shared, "model"); cache(shared, [["model", five]]);
    arm();
    for (let tick = 0; tick < 4; tick++) {
      const rows = (fm.getUiStatus() as { instances: Array<Record<string, unknown>> }).instances;
      expect(rows).toHaveLength(8);
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "worker", backend: "codex", effort: "max", effort_source: "instance" }),
        expect.objectContaining({ name: "claude", effort: "high", effort_source: "fleet-default" }),
        expect.objectContaining({ name: "kiro", effort: "high" }),
        expect.objectContaining({ name: "agy", effort: null, effort_source: null }),
        expect.objectContaining({ name: "stopped", effort: null, effort_source: null }),
        expect.objectContaining({ name: "bad", effort: null }),
        expect.objectContaining({ name: "inherited", backend: "muse", effort: "high" }),
        expect.objectContaining({ name: "classic", backend: "grok", model: "classic-model", display_name: "Classic name", effort: "high" }),
      ]));
    }
    expect(fm.effortLevelsFor("worker")).toEqual(five);
    expect(fm.effortLevelsFor("stopped")).toEqual([]);
    expect(existsSync(join(instanceDir, "codex-home"))).toBe(false); assertPure();
  });
  it("serves the real /api/fleet enrichment with pure effort metadata", () => {
    const fm = fleet(); const token = "a".repeat(48);
    vi.spyOn(fm as unknown as { readonly webToken: string | null }, "webToken", "get").mockReturnValue(token);
    Object.assign(fm, { viewToken: "b".repeat(48) });
    vi.spyOn(fm, "getSysInfo").mockReturnValue({ instances: Object.keys(fm.fleetConfig!.instances).map(name => ({ name, status: "stopped" })) } as never);
    fm["startHealthServer"](0); // createServer and listen are stubbed above.
    const req = { method: "GET", url: "/api/fleet", headers: { host: "localhost", "x-agend-token": token } } as unknown as IncomingMessage;
    const res = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
    arm(); guards.httpHandler!(req, res as unknown as ServerResponse);
    expect(res.writeHead).toHaveBeenCalledWith(200);
    const body = JSON.parse(String(res.end.mock.calls[0]![0])) as { instances: Array<Record<string, unknown>> };
    expect(body.instances).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "worker", backend: "codex", effort: "max", effort_supported: true }),
      expect.objectContaining({ name: "stopped", backend: "opencode", effort: null, effort_supported: false }),
      expect.objectContaining({ name: "bad", effort: null, effort_supported: false }),
      expect.objectContaining({ name: "classic", backend: "grok", effort: "high", effort_supported: true }),
    ]));
    assertPure();
  });
  it("multiple SSE clients and 10s ticks share pure status reads, with cleanup", () => {
    vi.useFakeTimers(); const fm = fleet();
    const clients: Array<{ req: EventEmitter; res: EventEmitter & { write: ReturnType<typeof vi.fn> } }> = [];
    arm();
    try {
      for (let i = 0; i < 3; i++) {
        const req = Object.assign(new EventEmitter(), { method: "GET", headers: { "x-agend-token": "a".repeat(48) } });
        const res = Object.assign(new EventEmitter(), { writeHead: vi.fn(), write: vi.fn() });
        clients.push({ req, res });
        vi.spyOn(fm as unknown as { readonly webToken: string | null }, "webToken", "get").mockReturnValue("a".repeat(48));
        expect(handleWebRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL("http://localhost/ui/events"), fm as unknown as WebApiContext)).toBe(true);
      }
      vi.advanceTimersByTime(30_000);
      for (const { res } of clients) {
        expect(res.write).toHaveBeenCalledTimes(4);
        const first = String(res.write.mock.calls[0]![0]);
        expect(first).toContain('"effort":"max"');
        expect(first).toContain('"effort":"high"');
      }
      assertPure();
    } finally { for (const { req } of clients) req.emit("close"); }
    expect(fm["sseClients"].size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
});
