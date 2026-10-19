/**
 * #1956 item 1, step 3: the fleet's status reads each instance's statusline.json once per build (it read it up to three
 * times: the cost, then the context, then the model), and with no existsSync first.
 * - statuslineContextPct / statuslineModel are the readers' own rules: the same answers for every payload shape.
 * - A build reads statusline.json once per instance; its cost, context and model are what the readers say.
 * - resolveInstanceContext given a statusline that is absent (no file) falls back as it did for a missing file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "agend-1956-stl-"));
process.env.AGEND_HOME = home;
const reads: string[] = [];
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => { reads.push(String(args[0])); return actual.readFileSync(...args); } };
});
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));

const tc = await import("../src/topic-commands.js");
let FleetManager: typeof import("../src/fleet-manager.js").FleetManager;
beforeAll(async () => { ({ FleetManager } = await import("../src/fleet-manager.js")); });
afterAll(() => rmSync(home, { recursive: true, force: true }));

// [name, file contents (null: no file), what the readers answered before this change: [context, model]] — pinned from
// main's readStatuslineContextPct / readStatuslineModel (they now use the functions under test, so comparing with them
// would be circular).
const PAYLOADS: Array<[string, string | null, [number | null, string | null]]> = [
  ["none", null, [null, null]],
  ["broken", "{ not json", [null, null]],
  ["json null", "null", [null, null]],
  ["a number", "7", [null, null]],
  ["empty", "{}", [null, null]],
  ["id only", JSON.stringify({ model: { id: " claude-x " } }), [null, "claude-x"]],
  ["name only", JSON.stringify({ model: { display_name: "Opus" } }), [null, "Opus"]],
  ["both, different", JSON.stringify({ model: { id: "claude-opus-5-5", display_name: "Opus 5.5" }, context_window: { used_percentage: 41.6 } }), [41.6, "Opus 5.5 (claude-opus-5-5)"]],
  ["both, the same", JSON.stringify({ model: { id: "x", display_name: "x" }, context_window: { used_percentage: 140 } }), [100, "x"]],
  ["odd types", JSON.stringify({ model: { id: 3, display_name: [] }, context_window: { used_percentage: "50" } }), [null, null]],
];

describe("the readers' rules, from a parsed statusline", () => {
  it.each(PAYLOADS)("%s: statuslineContextPct and statuslineModel answer as the readers did", (_n, text, before) => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1956-p-"));
    try {
      mkdirSync(join(dir, "instances", "w"), { recursive: true });
      if (text !== null) writeFileSync(join(dir, "instances", "w", "statusline.json"), text);
      const data = tc.readStatuslineJson(dir, "w");
      expect([tc.statuslineContextPct(data), tc.statuslineModel(data)]).toEqual(before);
      expect([tc.readStatuslineContextPct(dir, "w"), tc.readStatuslineModel(dir, "w")]).toEqual(before);   // and the readers still do
      if (text === null || text === "{ not json") expect(data).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("resolveInstanceContext given an absent statusline goes on as for a missing file (no read of it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1956-c-"));
    try {
      mkdirSync(join(dir, "instances", "w"), { recursive: true });
      writeFileSync(join(dir, "instances", "w", "statusline.json"), JSON.stringify({ context_window: { used_percentage: 33 } }));
      expect(tc.resolveInstanceContext(dir, "w", "claude-code", { statusline: { context_window: { used_percentage: 33 } } }).context).toBe(33);
      reads.length = 0;
      const given = tc.resolveInstanceContext(dir, "w", "claude-code", { statusline: undefined });
      expect(reads.filter((p) => p.endsWith("statusline.json"))).toEqual([]);
      expect(given.context).not.toBe(33);                                                  // not the file's: it was said to be absent
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("the fleet's status reads statusline.json once per instance", () => {
  it("one read per instance per build; its cost, context and model as the readers say", () => {
    const dir = join(home, "fleet"); mkdirSync(dir, { recursive: true });
    const names = ["c1", "c2", "x1", "k1"];
    const backends: Record<string, string> = { c1: "claude-code", c2: "claude-code", x1: "codex", k1: "kiro-cli" };
    writeFileSync(join(dir, "fleet.yaml"), ["defaults: {}", "instances:", ...names.flatMap((n) => [`  ${n}:`, `    working_directory: ${JSON.stringify(dir)}`, `    backend: ${backends[n]}`])].join("\n") + "\n");
    const fm = new FleetManager(dir) as any;
    fm.loadConfig(join(dir, "fleet.yaml"));
    fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
    fm.getInstanceStatus = () => "running";
    for (const n of names) mkdirSync(fm.getInstanceDir(n), { recursive: true });
    writeFileSync(join(fm.getInstanceDir("c1"), "statusline.json"), JSON.stringify({ model: { id: "claude-opus-5-5", display_name: "Opus 5.5" }, cost: { total_cost_usd: 2.5 }, context_window: { used_percentage: 41 } }));
    writeFileSync(join(fm.getInstanceDir("c2"), "statusline.json"), "{ not json");
    reads.length = 0;
    const st = fm.getUiStatus() as { instances: Array<{ name: string; cost: number; context_pct: number | null; model: string; model_source: string }> };
    const perFile = new Map<string, number>();
    for (const p of reads.filter((r) => r.endsWith("statusline.json"))) perFile.set(p, (perFile.get(p) ?? 0) + 1);
    expect([...perFile.values()].every((n) => n === 1)).toBe(true);
    expect(perFile.size).toBe(names.length);                                              // every instance's, once (missing ones too)
    const c1 = st.instances.find((i) => i.name === "c1")!, c2 = st.instances.find((i) => i.name === "c2")!;
    expect([c1.cost, c1.context_pct, c1.model, c1.model_source]).toEqual([2.5, 41, "Opus 5.5 (claude-opus-5-5)", "live"]);
    expect([c2.cost, c2.model_source === "live"]).toEqual([0, false]);
    expect(st.instances.find((i) => i.name === "x1")!.cost).toBe(0);
  });
});
