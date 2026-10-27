import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyKiroCarryReconciliation, planKiroCarryReconciliation, prepareKiroCarryForLaunch } from "../src/backend/kiro-classic-archive.js";
import { sharedKiroV2StoreLane } from "../src/backend/kiro-v2-store.js";
import { reconciliationFixture } from "./support/kiro-reconcile.js";
import { archivedKiroAlternative } from "../src/backend/kiro-reconcile-store.js";

const disk = vi.hoisted(() => ({ paths: new Map<number, string>(), syncs: [] as string[], fail: "" }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    openSync: (...args: any[]) => { const fd = (fs.openSync as any)(...args); disk.paths.set(fd, String(args[0])); return fd; },
    closeSync: (fd: number) => { disk.paths.delete(fd); return fs.closeSync(fd); },
    fsyncSync: (fd: number) => { const path = disk.paths.get(fd) ?? "unknown"; disk.syncs.push(path); if (path.endsWith(disk.fail) && disk.fail) throw new Error("injected fsync failure"); fs.fsyncSync(fd); },
  };
});
const roots: string[] = [], oldPath = process.env.PATH, ps = mkdtempSync(join(tmpdir(), "reconcile-ps-"));
beforeAll(() => { writeFileSync(join(ps, "ps"), "#!/bin/sh\nprintf '1 offline-fixture\\n'\n"); chmodSync(join(ps, "ps"), 0o700); process.env.PATH = ps + ":" + oldPath; });
afterEach(() => { disk.syncs = []; disk.fail = ""; vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { sharedKiroV2StoreLane.close(); process.env.PATH = oldPath; rmSync(ps, { recursive: true, force: true }); });
function f() { const x = reconciliationFixture(); roots.push(x.root); return x; }
const apply = (x: ReturnType<typeof f>) => applyKiroCarryReconciliation(x.input, planKiroCarryReconciliation(x.input), "discord:admin", () => {});
const rootOf = (x: ReturnType<typeof f>, receipt: string) => join(x.home, "kiro-reconciliations", readdirSync(join(x.home, "kiro-reconciliations"))[0]!, receipt);

describe("explicit stopped original/newer reconciliation", () => {
  it("a live process resuming the archived ID prevents even read-only planning", () => {
    const x = f();
    try {
      writeFileSync(join(ps, "ps"), "#!/bin/sh\nprintf '123 kiro-cli chat --resume-id newer\\n'\n");
      expect(() => planKiroCarryReconciliation(x.input)).toThrow(/still alive/); expect(x.own()).toBeNull();
    } finally { writeFileSync(join(ps, "ps"), "#!/bin/sh\nprintf '1 offline-fixture\\n'\n"); }
  });
  it("planning writes nothing; apply archives both byte-exact V2 sets and retains every native file", () => {
    const x = f(), native = x.native(), before = x.rows(), identity = readFileSync(x.identityFile);
    expect(planKiroCarryReconciliation(x.input).digest).toMatch(/^[a-f0-9]{64}$/);
    expect(x.native()).toEqual(native); expect(x.rows()).toEqual(before); expect(readFileSync(x.identityFile)).toEqual(identity);
    expect(existsSync(join(x.home, "kiro-reconciliations"))).toBe(false);
    const receipt = apply(x), root = rootOf(x, receipt);
    for (const [name, bytes] of Object.entries(native)) { expect(readFileSync(join(root, name)).toString("base64")).toBe(bytes); expect(statSync(join(root, name)).mode & 0o777).toBe(0o600); }
    expect(statSync(root).mode & 0o777).toBe(0o700); expect(x.native()).toEqual(native); expect(x.own()).toBe(x.keep);
    expect(x.rows()).toEqual(before.filter((row: any) => row.conversation_id !== x.keep));
    expect(prepareKiroCarryForLaunch(x.input).sessionId).toBe(x.keep);
  });
  it.each(["newer bytes", "identity", "classic bytes"])("changed %s invalidates confirmation before an archive or pin change", change => {
    const x = f(), plan = planKiroCarryReconciliation(x.input);
    if (change === "newer bytes") writeFileSync(join(x.sessions, x.archive + ".jsonl"), "changed work");
    if (change === "identity") { const s = JSON.parse(readFileSync(x.identityFile, "utf8")); s.keys[Object.keys(s.keys)[1]!].since++; writeFileSync(x.identityFile, JSON.stringify(s)); }
    if (change === "classic bytes") writeFileSync(join(x.sessions, x.keep + ".jsonl"), "broken");
    expect(() => applyKiroCarryReconciliation(x.input, plan, "admin", () => {})).toThrow(); expect(x.own()).toBeNull(); expect(x.rows()).toHaveLength(2);
    expect(existsSync(join(x.home, "kiro-reconciliations"))).toBe(false);
  });
  it.each(["foreign claim", "other cwd", "missing log", "symlink"])("refuses %s without guessing ownership", kind => {
    const x = f(), metaPath = join(x.sessions, x.archive + ".json");
    if (kind === "foreign claim") writeFileSync(join(x.home, "kiro-identity", "claims", "v2", x.archive), "someone-else\n");
    if (kind === "other cwd") { const m = JSON.parse(readFileSync(metaPath, "utf8")); m.cwd = "/another"; writeFileSync(metaPath, JSON.stringify(m)); }
    if (kind === "missing log") rmSync(join(x.sessions, x.archive + ".jsonl"));
    if (kind === "symlink") { rmSync(metaPath); symlinkSync(join(x.sessions, x.keep + ".json"), metaPath); }
    expect(() => planKiroCarryReconciliation(x.input)).toThrow(); expect(x.own()).toBeNull(); expect(x.rows()).toHaveLength(2);
  });
  it("a third same-cwd session with work cannot ride on the selected alternative", () => {
    const x = f(), m = JSON.parse(readFileSync(join(x.sessions, x.archive + ".json"), "utf8")); m.session_id = "third";
    writeFileSync(join(x.sessions, "third.json"), JSON.stringify(m)); writeFileSync(join(x.sessions, "third.jsonl"), "unacknowledged work");
    expect(() => planKiroCarryReconciliation(x.input)).toThrow(/third/); expect(x.own()).toBeNull();
  });
  it("peer pending ownership prevents adopting its otherwise unclaimed newer session", () => {
    const x = f(); writeFileSync(join(x.home, "kiro-identity", "instances", "peer.adopting.json"), JSON.stringify({ [JSON.stringify(["v2", x.cwd, null])]: x.archive }));
    expect(() => planKiroCarryReconciliation(x.input)).toThrow(/ownership/); expect(x.own()).toBeNull();
  });
  it("a well-formed unrelated native pending map does not block the explicit selection", () => {
    const x = f(); writeFileSync(join(x.home, "kiro-identity", "instances", "peer.adopting.json"), JSON.stringify({ [JSON.stringify(["v2", "/other", null])]: "other" }));
    expect(() => planKiroCarryReconciliation(x.input)).not.toThrow();
  });
  it("an inconsistent peer record cannot be trusted as another directory", () => {
    const x = f(), state = JSON.parse(readFileSync(x.identityFile, "utf8")), key = Object.keys(state.keys)[1]!;
    state.instance = "peer"; state.keys[key].workingDirectory = "/another";
    writeFileSync(join(x.home, "kiro-identity", "instances", "peer.json"), JSON.stringify(state));
    expect(() => planKiroCarryReconciliation(x.input)).toThrow(/another instance/);
  });
  it("an interruption after the durable intent resumes only its exact preserved selection", () => {
    const x = f(), plan = planKiroCarryReconciliation(x.input); let checks = 0;
    expect(() => applyKiroCarryReconciliation(x.input, plan, "admin", () => { if (++checks === 2) throw new Error("interrupted"); })).toThrow(/interrupted/);
    expect(x.own()).toBeNull(); expect(x.rows()).toHaveLength(2);
    expect(prepareKiroCarryForLaunch(x.input).sessionId).toBe(x.keep); expect(x.own()).toBe(x.keep);
    expect(readFileSync(join(x.home, "kiro-identity", "claims", "v2", x.archive), "utf8")).toBe(x.name + "\nabandoned\n");
  });
  it("prepared replay rechecks third-session work after the original re-pin survived", () => {
    const x = f();
    expect(() => applyKiroCarryReconciliation(x.input, planKiroCarryReconciliation(x.input), "admin", () => {
      if (x.own() === x.keep) throw new Error("interrupted after re-pin");
    })).toThrow(/after re-pin/);
    const before = x.rows(), m = JSON.parse(readFileSync(join(x.sessions, x.archive + ".json"), "utf8")); m.session_id = "third";
    writeFileSync(join(x.sessions, "third.json"), JSON.stringify(m)); writeFileSync(join(x.sessions, "third.jsonl"), "unacknowledged third work");
    expect(() => prepareKiroCarryForLaunch(x.input)).toThrow(/third/); expect(x.rows()).toEqual(before);
    const dir = join(x.home, "kiro-reconciliations", readdirSync(join(x.home, "kiro-reconciliations"))[0]!);
    expect(JSON.parse(readFileSync(join(dir, "active.json"), "utf8")).phase).toBe("prepared");
  });
  function changeClassic(x: ReturnType<typeof f>): void {
    const db = new Database(x.input.dbPath);
    try {
      const row = db.prepare("SELECT value FROM conversations_v2 WHERE conversation_id=?").get(x.keep) as { value: string };
      const value = JSON.parse(row.value); value.unknown_metadata = "changed after confirmation";
      db.prepare("UPDATE conversations_v2 SET value=? WHERE conversation_id=?").run(JSON.stringify(value), x.keep);
    } finally { db.close(); }
  }
  it("prepared replay refuses changed classic metadata before re-pinning or removing rows", () => {
    const x = f(); let checks = 0;
    expect(() => applyKiroCarryReconciliation(x.input, planKiroCarryReconciliation(x.input), "admin", () => { if (++checks === 2) throw new Error("interrupted"); })).toThrow();
    changeClassic(x); const before = x.rows(), native = x.native(), identity = readFileSync(x.identityFile);
    expect(() => prepareKiroCarryForLaunch(x.input)).toThrow(/Confirmed classic bytes/);
    expect(x.rows()).toEqual(before); expect(x.native()).toEqual(native); expect(readFileSync(x.identityFile)).toEqual(identity); expect(x.own()).toBeNull();
  });
  it("classic bytes changed after the replay proof are refused inside the removal transaction", () => {
    const x = f(); let checks = 0;
    expect(() => applyKiroCarryReconciliation(x.input, planKiroCarryReconciliation(x.input), "admin", () => { if (++checks === 2) throw new Error("interrupted"); })).toThrow();
    let pinChecks = 0;
    expect(() => prepareKiroCarryForLaunch(x.input, () => { if (x.own() === x.keep && ++pinChecks === 2) changeClassic(x); })).toThrow(/Confirmed classic bytes/);
    expect(x.rows()).toHaveLength(2);
  });
  it.each(["missing", "different"])("committed removal replay refuses a %s exact classic archive", kind => {
    const x = f();
    expect(() => applyKiroCarryReconciliation(x.input, planKiroCarryReconciliation(x.input), "admin", () => {
      if (!x.rows().some((r: any) => r.conversation_id === x.keep)) throw new Error("interrupted after commit");
    })).toThrow(/after commit/);
    const root = join(x.home, "kiro-classic-archives", readdirSync(join(x.home, "kiro-classic-archives"))[0]!);
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (kind === "missing") rmSync(path); // synthetic missing-archive crash fixture only
      else {
        const archive = JSON.parse(readFileSync(path, "utf8")), value = JSON.parse(Buffer.from(archive.payload.rows[0].valueBase64, "base64").toString("utf8"));
        value.unknown_metadata = "a different otherwise valid archive";
        archive.payload.rows[0].valueBase64 = Buffer.from(JSON.stringify(value)).toString("base64");
        archive.sha256 = createHash("sha256").update(JSON.stringify(archive.payload)).digest("hex"); writeFileSync(path, JSON.stringify(archive));
      }
    }
    expect(() => prepareKiroCarryForLaunch(x.input)).toThrow(/exact archive is missing/);
    expect(x.rows()).toHaveLength(1);
  });
  it("a committed classic removal with a lost final identity update cannot become a fresh start", () => {
    const x = f(), before = readFileSync(x.identityFile), claim = join(x.home, "kiro-identity", "claims", "v2", x.keep), claimBefore = readFileSync(claim);
    expect(() => applyKiroCarryReconciliation(x.input, planKiroCarryReconciliation(x.input), "admin", () => {
      if (!x.rows().some((r: any) => r.conversation_id === x.keep)) throw new Error("interrupted after commit");
    })).toThrow(/after commit/);
    expect(x.rows()).toHaveLength(1);
    // Offline power-loss fixture: the previous directory entry survived instead
    // of the newly renamed identity/claim. All conversation bytes stay intact.
    writeFileSync(x.identityFile, before); writeFileSync(claim, claimBefore);
    expect(prepareKiroCarryForLaunch(x.input)).toMatchObject({ sessionId: x.keep, repaired: true }); expect(x.own()).toBe(x.keep);
  });
  it("a newer identity revision cannot be replaced by a pending confirmed intent", () => {
    const x = f(); let checks = 0;
    expect(() => applyKiroCarryReconciliation(x.input, planKiroCarryReconciliation(x.input), "admin", () => { if (++checks === 2) throw new Error("interrupted"); })).toThrow();
    const state = JSON.parse(readFileSync(x.identityFile, "utf8")); state.keys[Object.keys(state.keys)[1]!].since++;
    writeFileSync(x.identityFile, JSON.stringify(state));
    expect(() => prepareKiroCarryForLaunch(x.input)).toThrow(/newer selection/); expect(x.own()).toBeNull();
  });
  it.each(["native", "archive", "kept"])("a changed %s alternative invalidates an interrupted intent", kind => {
    const x = f(); let checks = 0;
    expect(() => applyKiroCarryReconciliation(x.input, planKiroCarryReconciliation(x.input), "admin", () => { if (++checks === 2) throw new Error("interrupted"); })).toThrow();
    const ownerDir = join(x.home, "kiro-reconciliations", readdirSync(join(x.home, "kiro-reconciliations"))[0]!);
    const receipt = JSON.parse(readFileSync(join(ownerDir, "active.json"), "utf8")).receipt;
    const path = join(kind !== "archive" ? x.sessions : rootOf(x, receipt), (kind === "kept" ? x.keep : x.archive) + ".jsonl");
    const text = kind === "archive" ? "z".repeat(statSync(path).size) : kind === "kept" ? readFileSync(path, "utf8")
      + JSON.stringify({ version: "v1", kind: "AssistantMessage", data: { content: [{ kind: "text", data: "synthetic new work" }] } }) + "\n" : "new work";
    writeFileSync(path, text);
    expect(() => prepareKiroCarryForLaunch(x.input)).toThrow(); expect(x.own()).toBeNull(); expect(x.rows()).toHaveLength(2);
  });
  it("rollback is confirmation-bound, preserves archives and progressed native data, and holds future startup", () => {
    const x = f(), identityBefore = readFileSync(x.identityFile), rowsBefore = x.rows(), receipt = apply(x), archiveBytes = readFileSync(join(rootOf(x, receipt), x.archive + ".jsonl"));
    writeFileSync(join(x.sessions, x.keep + ".history"), "progress after recovery");
    const native = x.native(), rollback = planKiroCarryReconciliation(x.input, receipt);
    expect(applyKiroCarryReconciliation(x.input, rollback, "admin", () => {})).toBe(receipt);
    expect(x.native()).toEqual(native); expect(readFileSync(x.identityFile)).toEqual(identityBefore); expect(x.own()).toBeNull();
    expect(x.rows()).toEqual(rowsBefore);
    expect(readFileSync(join(rootOf(x, receipt), x.archive + ".jsonl"))).toEqual(archiveBytes);
    expect(() => prepareKiroCarryForLaunch(x.input)).toThrow(/rolled back/);
    expect(apply(x)).toMatch(/^[a-f0-9]{64}$/); expect(x.own()).toBe(x.keep); expect(x.native()).toEqual(native);
  });
  it("a different receipt or a changed identity cannot be rolled back", () => {
    const x = f(), receipt = apply(x), plan = planKiroCarryReconciliation(x.input, receipt);
    const s = JSON.parse(readFileSync(x.identityFile, "utf8")); s.keys[Object.keys(s.keys)[1]!].id = "other-selection"; writeFileSync(x.identityFile, JSON.stringify(s));
    expect(() => applyKiroCarryReconciliation(x.input, plan, "admin", () => {})).toThrow();
    expect(() => planKiroCarryReconciliation(x.input, "a".repeat(64))).toThrow();
  });
  it("the original must be a proven complete carry before a confirmation can be offered", () => {
    const x = f(), path = join(x.sessions, x.keep + ".json"), m = JSON.parse(readFileSync(path, "utf8"));
    m.exported_from_v1 = false; writeFileSync(path, JSON.stringify(m));
    expect(() => planKiroCarryReconciliation(x.input)).toThrow(/matching carried/); expect(x.own()).toBeNull();
  });
  it("a durable V3 floor cannot be reconciled backwards through an old V2 record", () => {
    const x = f(), state = JSON.parse(readFileSync(x.identityFile, "utf8")), old = state.keys[Object.keys(state.keys)[1]!];
    state.keys[JSON.stringify(["v3", x.cwd, null])] = { ...old, engine: "v3", id: "v3-current" }; writeFileSync(x.identityFile, JSON.stringify(state));
    expect(() => planKiroCarryReconciliation(x.input)).toThrow(/V2 carry/); expect(x.own()).toBeNull();
  });
  it("an archive receipt cannot authorize a different store/profile scope", () => {
    const x = f(); apply(x);
    expect(() => archivedKiroAlternative({ ...x.input, dbPath: join(x.root, "different.sqlite") }, x.archive)).toThrow(/scope/);
  });
  it("a modified manifest cannot grant a replacement-work exception", () => {
    const x = f(), receipt = apply(x), path = join(rootOf(x, receipt), "manifest.json"), m = JSON.parse(readFileSync(path, "utf8"));
    m.actor = "different"; writeFileSync(path, JSON.stringify(m));
    expect(() => prepareKiroCarryForLaunch(x.input)).toThrow(/checksum/);
  });
  it("rollback refuses changed classic ownership or conflicting classic bytes", () => {
    const x = f(), receipt = apply(x), claim = join(x.home, "kiro-identity", "claims", "v1", x.keep);
    writeFileSync(claim, "other-owner\n"); expect(() => planKiroCarryReconciliation(x.input, receipt)).toThrow(/claims changed/);
    writeFileSync(claim, x.name + "\n"); const rollback = planKiroCarryReconciliation(x.input, receipt);
    const db = new Database(x.input.dbPath); db.prepare("INSERT INTO conversations_v2 VALUES(?,?,?,?,?)").run(x.cwd, x.keep, "different work", 1, 2); db.close();
    const before = x.rows(); expect(() => applyKiroCarryReconciliation(x.input, rollback, "admin", () => {})).toThrow(/different classic/);
    expect(x.rows()).toEqual(before); expect(() => prepareKiroCarryForLaunch(x.input)).toThrow(/rolled back/);
  });
  it("files, manifest and all first-use ancestors are synced before publishing the intent", () => {
    const x = f(), receipt = apply(x), root = rootOf(x, receipt);
    const published = disk.syncs.findIndex(path => /active\.json\..*\.tmp$/.test(path));
    expect(published).toBeGreaterThan(0);
    for (const name of [...Object.keys(x.native()), "manifest.json"]) expect(disk.syncs.indexOf(join(root, name))).toBeGreaterThanOrEqual(0);
    for (const path of [root, join(root, ".."), join(root, "..", ".."), x.home]) {
      expect(disk.syncs.indexOf(path)).toBeGreaterThanOrEqual(0); expect(disk.syncs.indexOf(path)).toBeLessThan(published);
    }
    expect(disk.syncs.indexOf(join(root, "manifest.json"))).toBeLessThan(published);
  });
  it("a failed manifest fsync keeps rows/pins held; retry fsyncs the visible archive again", () => {
    const x = f(), plan = planKiroCarryReconciliation(x.input); disk.fail = "manifest.json";
    expect(() => applyKiroCarryReconciliation(x.input, plan, "admin", () => {})).toThrow(/fsync/); expect(x.own()).toBeNull(); expect(x.rows()).toHaveLength(2);
    disk.fail = ""; disk.syncs = []; const receipt = applyKiroCarryReconciliation(x.input, plan, "admin", () => {});
    expect(disk.syncs).toContain(join(rootOf(x, receipt), "manifest.json")); expect(x.own()).toBe(x.keep);
  });
  it("the bounded worker returns only plan/receipt metadata and applies the same selection", async () => {
    const x = f();
    const planned = await sharedKiroV2StoreLane.read({ keys: [], sessionsDir: x.sessions, reconciliation: { input: x.input } });
    expect(planned.kind).toBe("ok"); if (planned.kind !== "ok") throw new Error(planned.detail);
    expect(planned.reconciliation?.plan?.digest).toMatch(/^[a-f0-9]{64}$/);
    const selected = await sharedKiroV2StoreLane.read({ keys: [], sessionsDir: x.sessions, reconciliation: { input: x.input, plan: planned.reconciliation!.plan, actor: "admin" } });
    expect(selected.kind).toBe("ok"); expect(JSON.stringify(selected)).not.toContain("synthetic newer work"); expect(x.own()).toBe(x.keep);
  }, 40_000);
});
