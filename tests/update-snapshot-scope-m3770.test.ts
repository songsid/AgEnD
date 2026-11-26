// M-3770 slice 2.3 (design update-transaction §5.1): the snapshot's scope (an exclude list), the writer inventory and
// its gate over the code's path literals, and rollback eligibility.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { classify, rollbackEligible, WRITER_INVENTORY, type Writer } from "../src/update-snapshot-scope.js";

describe("M-3770 §5.1: the scope", () => {
  it("includes everything not on the exclude list — the Hub, the databases, fleet.yaml, instances' state", () => {
    for (const rel of ["fleet.yaml", "events.db", "events.db-wal", "scheduler.db", "hub", "hub/hub.db", "instances/a/session.jsonl", "classicBot.yaml", "web-themes.json", "marks.json"]) {
      expect(classify(rel), rel).toEqual({ included: true });
    }
  });

  it("excludes exactly §5.1's list, each with its kind", () => {
    const cases: Array<[string, string]> = [
      [".update-journal", "journal"], [".update-journal/attempts/x/attempt.json", "journal"], ["update-in-progress.json", "journal"],
      ["workspaces", "user-state"], ["workspaces/a/file", "user-state"], ["credential-profiles/claude-code/p/.claude.json", "user-state"], ["cx/x", "user-state"],
      ["cache/a", "cache"], ["cache-codex-rollouts.json", "cache"], ["usage-last-good.json", "cache"], ["search.db", "cache"], ["search.db-wal", "cache"],
      ["fleet.log", "log"], ["instances/a/output.log", "log"], ["daemon.log", "log"], ["profiles/cpu.cpuprofile", "log"],
      ["tmux", "runtime"], ["tmux/default", "runtime"], ["operator/x", "runtime"], ["instances/a/channel.sock", "runtime"], ["fleet.pid", "runtime"], ["fleet.lock", "runtime"],
      ["fleet.lock.reclaim", "runtime"], [".update.lock", "runtime"], [".service.lock", "runtime"], [".update.lock.reclaim", "runtime"], ["tunnel.lease", "runtime"], ["web.token", "runtime"], ["view.token", "runtime"],
      [".state-lease.sqlite", "lease"], [".state-lease.sqlite-journal", "lease"],
    ];
    for (const [rel, kind] of cases) expect(classify(rel), rel).toMatchObject({ included: false, kind });
  });

  it("is precise at the edges: a name that merely starts like an excluded one is included", () => {
    for (const rel of ["workspaces-old", "cachex", "tmux-migration.json", "search", "fleet.lockfile", "logs-archive.json", "instances/a/output.logx"]) {
      expect(classify(rel), rel).toEqual({ included: true });
    }
  });

  it("refuses anything that isn't a plain relative path", () => {
    for (const rel of ["", "/etc/passwd", "../x", "a/../b", "a//b", "./a"]) expect(() => classify(rel), rel).toThrow(/not a relative path/);
  });
});

/** Every `.ts` file under src. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("M-3770 §5.1: the writer inventory's gate", () => {
  const root = process.cwd();
  const files = sources(join(root, "src"));
  /** The roots that mean the AgEnD home, and the user's home directory. */
  const HOME_ROOT = /join\(\s*(?:dataDir|DATA_DIR|getAgendHome\(\)|this\.dataDir|ctx\.dataDir|deps\.dataDir|opts\.dataDir|agendHome)\s*,\s*"([^"]+)"/g;
  const OUTSIDE_ROOT = /join\(\s*(?:homedir\(\)|os\.homedir\(\)|process\.env\.CLAUDE_CONFIG_DIR[^,]*)\s*,\s*"([^"]+)"/g;
  const firstSegment = (lit: string) => lit.split("/")[0]!;

  const scan = (re: RegExp) => {
    const found = new Map<string, string[]>();
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(re)) {
        const name = firstSegment(m[1]!);
        if (name === "..") continue;                         // navigation, not a written path
        found.set(name, [...(found.get(name) ?? []), relative(root, f)]);
      }
    }
    return found;
  };

  it("every top-level name the code joins under the AgEnD home is in the inventory", () => {
    const listed = new Set(WRITER_INVENTORY.filter(w => w.where === "home").map(w => w.path));
    const missing = [...scan(HOME_ROOT)].filter(([name]) => !listed.has(name)).map(([name, where]) => `${name} (${[...new Set(where)].join(", ")})`);
    expect(missing, "classify these in src/update-snapshot-scope.ts WRITER_INVENTORY (§5.1)").toEqual([]);
  });

  it("every name the code joins under the user's home directory is in the inventory", () => {
    const listed = new Set(WRITER_INVENTORY.filter(w => w.where === "outside").map(w => w.path));
    const missing = [...scan(OUTSIDE_ROOT)].filter(([name]) => !listed.has(name)).map(([name, where]) => `${name} (${[...new Set(where)].join(", ")})`);
    expect(missing, "classify these in src/update-snapshot-scope.ts WRITER_INVENTORY (§5.1)").toEqual([]);
  });

  it("the gate catches an unlisted name (the scan itself works)", () => {
    expect([..."join(dataDir, \"brand-new.json\")".matchAll(HOME_ROOT)].map(m => m[1])).toEqual(["brand-new.json"]);
    expect([..."join(homedir(), \".newcli\", \"x\")".matchAll(OUTSIDE_ROOT)].map(m => m[1])).toEqual([".newcli"]);
  });

  it("names are listed once", () => {
    const keys = WRITER_INVENTORY.map(w => `${w.where}:${w.path}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });
});

describe("M-3770 §5.1: rollback eligibility", () => {
  it("today's inventory is eligible: no pre-commit writer touches excluded user state or an unrestored outside path", () => {
    expect(rollbackEligible()).toEqual({ ok: true });
  });

  it("a pre-commit writer of excluded user state, or of an outside path nothing restores, makes a release ineligible", () => {
    const w = (x: Partial<Writer>): Writer => ({ path: "workspaces", where: "home", phase: "pre-commit", by: "test", ...x });
    expect(rollbackEligible([w({})])).toMatchObject({ ok: false, offenders: [{ path: "workspaces" }] });
    expect(rollbackEligible([w({ path: ".claude.json", where: "outside" })])).toMatchObject({ ok: false });
    // Not offenders: post-commit writes, excluded runtime/logs/caches, restored outside paths, the home itself.
    expect(rollbackEligible([w({ phase: "post-commit" }), w({ path: "fleet.log" }), w({ path: "cache" }), w({ path: ".config", where: "outside", restoredBy: "unit-preimage" }), w({ path: ".agend", where: "outside" })])).toEqual({ ok: true });
  });
});
