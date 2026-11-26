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
  /**
   * The roots that mean the AgEnD home — any member chain ending in dataDir, DATA_DIR, agendHome or stateDir, and
   * getAgendHome() (Fable #4520 F1; `home` and `root` stay out: they often mean other directories) — and the user's
   * home directory. A literal may be double-, single- or backtick-quoted (no interpolation).
   */
  const LITERAL = String.raw`\s*,\s*(?:"([^"]+)"|'([^']+)'|\`([^\`$]+)\`)`;
  const HOME_ROOT = new RegExp(String.raw`join\(\s*(?:(?:[\w$]+\.)*(?:dataDir|DATA_DIR|agendHome|stateDir)|getAgendHome\(\))` + LITERAL, "g");
  const OUTSIDE_ROOT = new RegExp(String.raw`join\(\s*(?:homedir\(\)|os\.homedir\(\)|process\.env\.CLAUDE_CONFIG_DIR[^,]*)` + LITERAL, "g");
  const literalOf = (m: RegExpMatchArray) => (m[1] ?? m[2] ?? m[3])!;
  const firstSegment = (lit: string) => lit.split("/")[0]!;

  const scan = (re: RegExp) => {
    const found = new Map<string, string[]>();
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(re)) {
        const name = firstSegment(literalOf(m));
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

  it("the gate catches an unlisted name (the scan itself works): any quote style, nested roots, getAgendHome()", () => {
    const names = (text: string, re: RegExp) => [...text.matchAll(re)].map(literalOf);
    expect(names(`join(dataDir, "brand-new.json")`, HOME_ROOT)).toEqual(["brand-new.json"]);
    expect(names(`join(this.dataDir, 'single.sqlite')`, HOME_ROOT)).toEqual(["single.sqlite"]);
    expect(names("join(this.ctx.dataDir, `tick.json`)", HOME_ROOT)).toEqual(["tick.json"]);
    expect(names(`join(d.agendHome, "a"); join(input.agendHome, 'b'); join(ctx.stateDir, "c"); join(getAgendHome(), "d")`, HOME_ROOT)).toEqual(["a", "b", "c", "d"]);
    expect(names("join(dataDir, `x-${n}.json`)", HOME_ROOT)).toEqual([]);                          // interpolated: not a literal
    expect(names(`join(home, "x"); join(root, "y")`, HOME_ROOT)).toEqual([]);                      // ambiguous roots stay out
    expect(names(`join(homedir(), ".newcli", "x"); join(os.homedir(), '.other')`, OUTSIDE_ROOT)).toEqual([".newcli", ".other"]);
  });

  it("names are listed once", () => {
    const keys = WRITER_INVENTORY.map(w => `${w.where}:${w.path}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });
});

describe("M-3770 §5.1: rollback eligibility", () => {
  it("today's inventory is eligible: no pre-commit writer touches excluded user state, an unrestored outside path, or a cache an older build wouldn't rebuild", () => {
    expect(rollbackEligible()).toEqual({ ok: true });
    // The three excluded caches are written at fleet start (pre-commit) and each is marked as rebuilt (Fable #4520 F2).
    for (const name of ["search.db", "cache-codex-rollouts.json", "usage-last-good.json"]) {
      expect(WRITER_INVENTORY.find(x => x.path === name), name).toMatchObject({ phase: "pre-commit", olderBuildRebuilds: true });
    }
  });

  it("a pre-commit writer of excluded user state, or of an outside path nothing restores, makes a release ineligible", () => {
    const w = (x: Partial<Writer>): Writer => ({ path: "workspaces", where: "home", phase: "pre-commit", by: "test", ...x });
    expect(rollbackEligible([w({})])).toMatchObject({ ok: false, offenders: [{ path: "workspaces" }] });
    expect(rollbackEligible([w({ path: ".claude.json", where: "outside" })])).toMatchObject({ ok: false });
    // A pre-commit cache an older build might refuse (not marked as rebuilt) is an offender (§5.1 rev 8).
    expect(rollbackEligible([w({ path: "search.db" })])).toMatchObject({ ok: false, offenders: [{ path: "search.db" }] });
    // Not offenders: post-commit writes, runtime and logs, a rebuilt cache, restored outside paths, the home itself.
    expect(rollbackEligible([w({ phase: "post-commit" }), w({ path: "fleet.log" }), w({ path: "fleet.pid" }), w({ path: "cache", olderBuildRebuilds: true }),
      w({ path: ".config", where: "outside", restoredBy: "unit-preimage" }), w({ path: ".agend", where: "outside" })])).toEqual({ ok: true });
  });
});
