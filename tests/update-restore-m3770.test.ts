// M-3770 slice 2.3 (design update-transaction §5.5): the restore on a real temp home — the snapshot's scope back
// exactly, the new state in replaced/, excluded state untouched, containers kept in place — and a crash injected at
// every step boundary (every rename, every fsync, before every log line, including before the first `aside` line),
// each retried to the same end state. Plus the states the retry table hands to manual-recovery.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { takeSnapshot } from "../src/update-snapshot.js";
import { REPLACED_DIR, RESTORE_LOG, restoreHome, type RestoreIo } from "../src/update-restore.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p = "restore-") => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const gone = { proveWritersGone: () => ({ ok: true as const }) };

/** A home and its attempt: seeded, snapshotted, then changed by "the new version". */
function scenario(): { home: string; attempt: string } {
  const root = tmp(), home = join(root, "home"), attempt = join(root, "attempt");
  mkdirSync(home); mkdirSync(attempt);
  writeFileSync(join(home, "fleet.yaml"), "version: old\n");
  mkdirSync(join(home, "hub", "deep"), { recursive: true });                           // a unit: a nested directory
  writeFileSync(join(home, "hub", "deep", "a.json"), "old-a"); writeFileSync(join(home, "hub", "b.json"), "old-b");
  mkdirSync(join(home, "instances", "a"), { recursive: true });                        // a container (output.log excluded)
  writeFileSync(join(home, "instances", "a", "session.jsonl"), "old-session"); writeFileSync(join(home, "instances", "a", "output.log"), "log-1");
  chmodSync(join(home, "instances", "a"), 0o750);
  writeFileSync(join(home, "removed-later.json"), "only-in-snapshot");                 // manifest-only after the change
  symlinkSync("fleet.yaml", join(home, "fleet-link"));
  mkdirSync(join(home, "workspaces", "w"), { recursive: true }); writeFileSync(join(home, "workspaces", "w", "f"), "w1");   // excluded
  const snap = takeSnapshot(home, attempt, gone);
  if (!snap.ok) throw new Error(snap.reason);
  // The new version: a migrated fleet.yaml, changed and new files, a new directory, a removed file, a re-pointed link,
  // and excluded state that moves on (it must be left alone).
  writeFileSync(join(home, "fleet.yaml"), "version: new\nmigrated: true\n");
  writeFileSync(join(home, "hub", "deep", "a.json"), "new-a"); writeFileSync(join(home, "hub", "new.db"), "new-db");
  mkdirSync(join(home, "new-dir", "x"), { recursive: true }); writeFileSync(join(home, "new-dir", "x", "y"), "new");   // new-only directory
  writeFileSync(join(home, "new-file.json"), "new");                                    // new-only file
  rmSync(join(home, "removed-later.json"));
  writeFileSync(join(home, "instances", "a", "session.jsonl"), "new-session"); writeFileSync(join(home, "instances", "a", "output.log"), "log-2");
  chmodSync(join(home, "instances", "a"), 0o700);
  rmSync(join(home, "fleet-link")); symlinkSync("elsewhere", join(home, "fleet-link"));
  writeFileSync(join(home, "workspaces", "w", "f"), "w2");
  return { home, attempt };
}

/** Everything under a directory (excluded state included), by content: the end state to compare. */
function state(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (rel: string) => {
    if (!existsSync(rel ? join(dir, rel) : dir)) return;
    for (const n of readdirSync(rel ? join(dir, rel) : dir).sort()) {
      const r = rel ? `${rel}/${n}` : n, st = lstatSync(join(dir, r));
      if (st.isSymbolicLink()) out[r] = `link:${readlinkSync(join(dir, r))}`;
      else if (st.isDirectory()) { out[r] = `dir:${(st.mode & 0o777).toString(8)}`; visit(r); }
      else out[r] = `file:${createHash("sha256").update(readFileSync(join(dir, r))).digest("hex").slice(0, 12)}`;
    }
  };
  visit("");
  return out;
}

describe("M-3770 §5.5: the restore", () => {
  it("puts the snapshot's scope back exactly, moves the new state to replaced/, keeps containers and excluded state", () => {
    const { home, attempt } = scenario();
    expect(restoreHome(home, attempt, gone)).toEqual({ ok: true });
    expect(readFileSync(join(home, "fleet.yaml"), "utf8")).toBe("version: old\n");
    expect(readFileSync(join(home, "hub", "deep", "a.json"), "utf8")).toBe("old-a");
    expect(existsSync(join(home, "hub", "new.db"))).toBe(false);
    expect(existsSync(join(home, "new-dir"))).toBe(false);
    expect(existsSync(join(home, "new-file.json"))).toBe(false);
    expect(readFileSync(join(home, "removed-later.json"), "utf8")).toBe("only-in-snapshot");
    expect(readlinkSync(join(home, "fleet-link"))).toBe("fleet.yaml");
    expect(readFileSync(join(home, "instances", "a", "session.jsonl"), "utf8")).toBe("old-session");
    expect(lstatSync(join(home, "instances", "a")).mode & 0o777).toBe(0o750);                      // the container's mode, restored
    // Excluded state is never touched: the container stayed in place, and its excluded child kept the new value.
    expect(readFileSync(join(home, "instances", "a", "output.log"), "utf8")).toBe("log-2");
    expect(readFileSync(join(home, "workspaces", "w", "f"), "utf8")).toBe("w2");
    // The new version's state, in replaced/.
    const r = join(attempt, REPLACED_DIR);
    expect(readFileSync(join(r, "fleet.yaml"), "utf8")).toBe("version: new\nmigrated: true\n");
    expect(readFileSync(join(r, "hub", "new.db"), "utf8")).toBe("new-db");
    expect(readFileSync(join(r, "new-dir", "x", "y"), "utf8")).toBe("new");
    expect(readFileSync(join(r, "new-file.json"), "utf8")).toBe("new");
    expect(existsSync(join(r, "instances", "a", "output.log"))).toBe(false);
    expect(readFileSync(join(attempt, RESTORE_LOG), "utf8").trim().split("\n").at(-1)).toBe(JSON.stringify({ step: "verified" }));
    // A retry after `verified` changes nothing.
    const before = state(home);
    expect(restoreHome(home, attempt, gone)).toEqual({ ok: true });
    expect(state(home)).toEqual(before);
  });

  it("the snapshot itself is never modified", () => {
    const { home, attempt } = scenario();
    const snap = state(join(attempt, "snapshot"));
    restoreHome(home, attempt, gone);
    expect(state(join(attempt, "snapshot"))).toEqual(snap);
  });

  it("a crash at EVERY step boundary, then a retry, ends in the same state as an uninterrupted restore", () => {
    const ref = scenario();
    let steps = 0;
    expect(restoreHome(ref.home, ref.attempt, { ...gone, io: { step: () => { steps++; } } })).toEqual({ ok: true });
    const want = { home: state(ref.home), replaced: state(join(ref.attempt, REPLACED_DIR)) };
    expect(steps).toBeGreaterThan(20);
    for (let k = 1; k <= steps; k++) {
      const s = scenario();
      let n = 0;
      const crashing: RestoreIo = { step: name => { if (++n === k) throw new Error(`crash at ${k} (${name})`); } };
      expect(() => restoreHome(s.home, s.attempt, { ...gone, io: crashing }), `step ${k}`).toThrow(/crash at/);
      if (k % 3 === 0 && existsSync(join(s.attempt, RESTORE_LOG))) appendFileSync(join(s.attempt, RESTORE_LOG), "{\"u\":\"torn");   // a torn last line
      expect(restoreHome(s.home, s.attempt, gone), `retry after step ${k}`).toEqual({ ok: true });
      expect(state(s.home), `home after step ${k}`).toEqual(want.home);
      expect(state(join(s.attempt, REPLACED_DIR)), `replaced after step ${k}`).toEqual(want.replaced);
    }
  }, 120_000);
});

describe("M-3770 §5.5: the states the table doesn't cover go to manual-recovery", () => {
  it("a unit present both in the home and in replaced/ (a both-unit), or with another identity: manual", () => {
    const s = scenario();
    let n = 0;
    expect(() => restoreHome(s.home, s.attempt, { ...gone, io: { step: name => { if (name.startsWith("rename-aside:fleet.yaml") && ++n === 1) throw new Error("crash"); } } })).toThrow();
    writeFileSync(join(s.home, "fleet.yaml"), "someone wrote it back");                         // now in both places
    expect(restoreHome(s.home, s.attempt, gone)).toMatchObject({ ok: false, manual: true, reason: expect.stringMatching(/fleet\.yaml is in a state/) });
  });

  it("a unit replaced (another identity) between the plan and its move: manual — never moved aside as if it were the planned one", () => {
    const s = scenario();
    expect(() => restoreHome(s.home, s.attempt, { ...gone, io: { step: name => { if (name === "header") throw new Error("crash after the plan"); } } })).toThrow();
    rmSync(join(s.home, "fleet.yaml")); writeFileSync(join(s.home, "fleet.yaml"), "a new inode");
    expect(restoreHome(s.home, s.attempt, gone)).toMatchObject({ ok: false, manual: true, reason: expect.stringMatching(/fleet\.yaml is in a state/) });
    expect(existsSync(join(s.attempt, REPLACED_DIR, "fleet.yaml"))).toBe(false);
  });

  it("a present unit matching neither the plan nor the snapshot after its aside: manual", () => {
    const s = scenario();
    expect(() => restoreHome(s.home, s.attempt, { ...gone, io: { step: name => { if (name === "log:aside:fleet.yaml") throw new Error("crash"); } } })).toThrow();
    writeFileSync(join(s.home, "fleet.yaml"), "a stranger");
    expect(restoreHome(s.home, s.attempt, gone)).toMatchObject({ ok: false, manual: true, reason: expect.stringMatching(/fleet\.yaml is present and matches neither/) });
  });

  it("a snapshot that no longer verifies, or a log for another snapshot: manual, before anything moves", () => {
    const s = scenario();
    writeFileSync(join(s.attempt, "snapshot", "fleet.yaml"), "tampered");
    expect(restoreHome(s.home, s.attempt, gone)).toMatchObject({ ok: false, manual: true, reason: expect.stringMatching(/doesn't verify/) });
    expect(readFileSync(join(s.home, "fleet.yaml"), "utf8")).toBe("version: new\nmigrated: true\n");
    const t = scenario();
    writeFileSync(join(t.attempt, RESTORE_LOG), JSON.stringify({ schema: 1, manifestSha256: "0".repeat(64), units: [], containers: [] }) + "\n");
    expect(restoreHome(t.home, t.attempt, gone)).toMatchObject({ ok: false, manual: true, reason: expect.stringMatching(/header doesn't match/) });
  });

  it("the final exact-set check catches what the plan never saw: a stray file appearing in a container, or a restored file changed", () => {
    const s = scenario();
    expect(restoreHome(s.home, s.attempt, { ...gone, io: { step: name => { if (name === "log:containers") writeFileSync(join(s.home, "instances", "a", "stray.json"), "x"); } } }))
      .toMatchObject({ ok: false, manual: true, reason: expect.stringMatching(/instances\/a\/stray\.json is in the home but not in the snapshot/) });
    const t = scenario();
    expect(restoreHome(t.home, t.attempt, { ...gone, io: { step: name => { if (name === "log:containers") writeFileSync(join(t.home, "fleet.yaml"), "changed again"); } } }))
      .toMatchObject({ ok: false, manual: true, reason: expect.stringMatching(/fleet\.yaml doesn't match/) });
    const u = scenario();
    expect(restoreHome(u.home, u.attempt, { ...gone, io: { step: name => { if (name === "log:containers") rmSync(join(u.home, "removed-later.json")); } } }))
      .toMatchObject({ ok: false, manual: true, reason: expect.stringMatching(/removed-later\.json is missing/) });
  });

  it("a writer appearing during the restore: not verified (retryable), and the retry completes", () => {
    const s = scenario();
    expect(restoreHome(s.home, s.attempt, { proveWritersGone: () => ({ ok: false, reason: "pid 7" }) })).toEqual({ ok: false, manual: false, reason: expect.stringMatching(/pid 7/) });
    expect(readFileSync(join(s.attempt, RESTORE_LOG), "utf8")).not.toContain("verified");
    expect(restoreHome(s.home, s.attempt, gone)).toEqual({ ok: true });
  });
});
