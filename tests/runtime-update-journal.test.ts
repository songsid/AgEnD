/** Private scratch state, inert code identities, no child process, native CLI, account or network. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RuntimeUpdateJournal, parseRuntimeUpdateState, type RuntimeUpdatePhase } from "../src/runtime-update-journal.js";
const roots: string[] = [], noop = () => {};
const old = { folder: "2.3.5+aaaaaaaa", version: "2.3.5", sha256: "a".repeat(64), buildId: "c".repeat(64) };
const next = { folder: "2.3.6+bbbbbbbb", version: "2.3.6", sha256: "b".repeat(64), buildId: "d".repeat(64) };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agend-update-journal-")); roots.push(root);
  const binding = { origin: "https://paired.example.test", machineId: randomUUID(), installId: randomUUID() };
  return { root, binding, file: join(root, "runtime-update.json"), journal: new RuntimeUpdateJournal(root, binding), id: randomUUID(), ownerId: randomUUID() };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("does not write at construction and returns independent binding/state snapshots", () => {
  const f = fixture(), state = f.journal.read(); state.binding.origin = "https://other.example.test";
  expect(f.journal.read()).toEqual({ version: 1, revision: 0, binding: f.binding }); expect(existsSync(f.file)).toBe(false);
});
it("persists each code-only transition before completion and never stores credential or task state", () => {
  const f = fixture();
  const begun = f.journal.begin(f.id, f.ownerId, old, next, noop);
  expect(begun.revision).toBe(1); expect(begun.attempt).toEqual({ id: f.id, ownerId: f.ownerId, phase: "prepared", old, next });
  for (const phase of ["handoff", "trial", "activating", "active"] as const) {
    const committed = f.journal.advance(f.id, phase, noop);
    expect(new RuntimeUpdateJournal(f.root, f.binding).read()).toEqual(committed); expect(committed.attempt?.phase).toBe(phase);
  }
  expect(f.journal.complete(f.id, noop)).toEqual({ version: 1, revision: 6, binding: f.binding });
  expect(Object.keys(JSON.parse(readFileSync(f.file, "utf8"))).sort()).toEqual(["binding", "revision", "version"]);
});
it.each(["prepared", "handoff", "trial", "rollback"] as const)("records a failed target from %s and refuses retrying the same hash", phase => {
  const f = fixture(); f.journal.begin(f.id, f.ownerId, old, next, noop);
  if (phase === "handoff" || phase === "trial") f.journal.advance(f.id, "handoff", noop);
  if (phase === "trial") f.journal.advance(f.id, "trial", noop);
  if (phase === "rollback") f.journal.advance(f.id, "rollback", noop);
  const failed = f.journal.fail(f.id, noop);
  expect(failed.attempt).toBeUndefined(); expect(failed.failed).toEqual({ version: next.version, sha256: next.sha256 });
  expect(() => f.journal.begin(randomUUID(), f.ownerId, old, next, noop)).toThrow(/transition/);
  const changed = { ...next, folder: "2.3.6+eeeeeeee", sha256: "e".repeat(64) };
  expect(f.journal.begin(randomUUID(), f.ownerId, old, changed, noop).attempt?.next).toEqual(changed);
});
it.each(["activating", "active"] as const)("retains %s uncertainty and cannot fail, roll back, replace, or clear its attempt", phase => {
  const f = fixture(); f.journal.begin(f.id, f.ownerId, old, next, noop);
  for (const step of ["handoff", "trial", "activating"] as const) f.journal.advance(f.id, step, noop);
  if (phase === "active") f.journal.advance(f.id, "active", noop);
  const bytes = readFileSync(f.file, "utf8");
  expect(() => f.journal.fail(f.id, noop)).toThrow(/uncertain/);
  expect(() => f.journal.advance(f.id, "rollback", noop)).toThrow(/transition/);
  expect(() => f.journal.begin(randomUUID(), f.ownerId, old, next, noop)).toThrow(/transition/);
  if (phase === "activating") expect(() => f.journal.complete(f.id, noop)).toThrow(/transition/);
  expect(readFileSync(f.file, "utf8")).toBe(bytes);
});
it("rejects a wrong attempt, skipped activation, downgrade, and unbound folder identity", () => {
  const f = fixture();
  expect(() => f.journal.begin(f.id, f.ownerId, next, old, noop)).toThrow();
  expect(() => f.journal.begin(f.id, f.ownerId, old, { ...next, folder: "../../other" }, noop)).toThrow();
  f.journal.begin(f.id, f.ownerId, old, next, noop);
  expect(() => f.journal.advance(randomUUID(), "handoff", noop)).toThrow(/transition/);
  expect(() => f.journal.advance(f.id, "active", noop)).toThrow(/transition/);
  expect(f.journal.read().attempt?.phase).toBe("prepared");
});
it("refuses malformed, extra authority, and another pairing or installation's state", () => {
  const f = fixture(), good = f.journal.begin(f.id, f.ownerId, old, next, noop);
  for (const bad of [{ ...good, credential: "forbidden" }, { ...good, revision: -1 }, { ...good, failed: null },
    { ...good, attempt: { ...good.attempt, phase: "unknown" as RuntimeUpdatePhase } }, { ...good, attempt: { ...good.attempt, ownerId: "path" } }]) expect(() => parseRuntimeUpdateState(bad)).toThrow();
  for (const key of ["origin", "machineId", "installId"] as const) {
    const binding = { ...f.binding, [key]: key === "origin" ? "https://other.example.test" : randomUUID() };
    expect(() => new RuntimeUpdateJournal(f.root, binding)).toThrow(/changed/);
  }
});
it("requires a synchronous current-owner fence before writing and immediately before publication", () => {
  const f = fixture();
  expect(() => f.journal.begin(f.id, f.ownerId, old, next, async () => {})).toThrow(/unsafe/);
  expect(existsSync(f.file)).toBe(false);
  let calls = 0;
  expect(() => f.journal.begin(f.id, f.ownerId, old, next, () => { if (++calls === 2) throw Error("owner changed"); })).toThrow("owner changed");
  expect(existsSync(f.file)).toBe(false);
});
it("a journal changed just before the rename is retained instead of overwritten", () => {
  const f = fixture(); f.journal.begin(f.id, f.ownerId, old, next, noop); let calls = 0;
  const newer = { ...f.journal.read(), revision: 99 };
  expect(() => f.journal.advance(f.id, "handoff", () => { if (++calls === 2) writeFileSync(f.file, JSON.stringify(newer), { mode: 0o600 }); })).toThrow(/changed/);
  expect(f.journal.read()).toEqual(newer);
});

it("refuses an identical-byte replacement of the journal at the final publication fence", () => {
  const f = fixture(); f.journal.begin(f.id, f.ownerId, old, next, noop); let calls = 0;
  const state = f.journal.read();
  expect(() => f.journal.advance(f.id, "handoff", () => {
    if (++calls === 2) { const replacement = join(f.root, "replacement"); writeFileSync(replacement, JSON.stringify(state), { mode: 0o600 }); renameSync(replacement, f.file); }
  })).toThrow(/changed/);
  expect(f.journal.read()).toEqual(state);
});

it("can remember a verified target's integrity failure before dispatch without overwriting an attempt", () => {
  const f = fixture();
  expect(f.journal.rememberFailure(next, noop).failed).toEqual({ version: next.version, sha256: next.sha256 });
  expect(() => f.journal.begin(f.id, f.ownerId, old, next, noop)).toThrow(/transition/);
  const other = { ...next, folder: "2.3.6+eeeeeeee", sha256: "e".repeat(64) };
  f.journal.begin(f.id, f.ownerId, old, other, noop); const before = f.journal.read();
  expect(() => f.journal.rememberFailure(next, noop)).toThrow(/uncertain/); expect(f.journal.read()).toEqual(before);
});
