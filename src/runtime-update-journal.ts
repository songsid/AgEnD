/** Private, code-update-only recovery state. Pairing credentials and task ledgers are never copied or restored. */
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { validateRuntimeServer } from "./runtime-client-store.js";
import { compareRuntimeVersions, parseRuntimeUpdateMetadata } from "./runtime-update-artifact.js";
import { assertRuntimeInstallDirectory, readRuntimeInstallFile } from "./runtime-update-lock.js";
import type { RuntimeInstalledProgram } from "./runtime-update-install.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const PHASES = ["prepared", "handoff", "trial", "activating", "active", "rollback"] as const;
export type RuntimeUpdatePhase = typeof PHASES[number];
export interface RuntimeUpdateBinding { origin: string; machineId: string; installId: string }
export interface RuntimeUpdateAttempt { id: string; ownerId: string; phase: RuntimeUpdatePhase; old: RuntimeInstalledProgram; next: RuntimeInstalledProgram }
export interface RuntimeUpdateState {
  version: 1; revision: number; binding: RuntimeUpdateBinding;
  failed?: { version: string; sha256: string };
  attempt?: RuntimeUpdateAttempt;
}
export class RuntimeUpdateJournalError extends Error {
  constructor(readonly reason: "unsafe" | "changed" | "transition" | "uncertain") { super(`Runtime update journal ${reason}`); }
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function binding(value: unknown): RuntimeUpdateBinding {
  if (!object(value) || !keys(value, ["origin", "machineId", "installId"]) || typeof value.origin !== "string" || validateRuntimeServer(value.origin).origin !== value.origin
    || typeof value.machineId !== "string" || !UUID.test(value.machineId) || typeof value.installId !== "string" || !UUID.test(value.installId)) throw new RuntimeUpdateJournalError("unsafe");
  return { origin: value.origin, machineId: value.machineId, installId: value.installId };
}
function program(value: unknown): RuntimeInstalledProgram {
  if (!object(value) || !keys(value, ["folder", "version", "sha256", "buildId"]) || typeof value.buildId !== "string" || !HASH.test(value.buildId)) throw new RuntimeUpdateJournalError("unsafe");
  const parsed = parseRuntimeUpdateMetadata({ version: value.version, sha256: value.sha256, bytes: 1 });
  if (value.folder !== `${parsed.version}+${parsed.sha256.slice(0, 8)}`) throw new RuntimeUpdateJournalError("unsafe");
  return { folder: value.folder as string, version: parsed.version, sha256: parsed.sha256, buildId: value.buildId };
}
export function parseRuntimeUpdateState(value: unknown): RuntimeUpdateState {
  if (!object(value) || !keys(value, ["version", "revision", "binding"], ["failed", "attempt"]) || value.version !== 1
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || (value.revision as number) >= Number.MAX_SAFE_INTEGER) throw new RuntimeUpdateJournalError("unsafe");
  const result: RuntimeUpdateState = { version: 1, revision: value.revision as number, binding: binding(value.binding) };
  if (Object.hasOwn(value, "failed")) {
    if (!object(value.failed) || !keys(value.failed, ["version", "sha256"])) throw new RuntimeUpdateJournalError("unsafe");
    const { version, sha256 } = parseRuntimeUpdateMetadata({ ...value.failed, bytes: 1 }); result.failed = { version, sha256 };
  }
  if (Object.hasOwn(value, "attempt")) {
    const a = value.attempt;
    if (!object(a) || !keys(a, ["id", "ownerId", "phase", "old", "next"]) || typeof a.id !== "string" || !UUID.test(a.id)
      || typeof a.ownerId !== "string" || !UUID.test(a.ownerId) || !PHASES.includes(a.phase as RuntimeUpdatePhase)) throw new RuntimeUpdateJournalError("unsafe");
    const old = program(a.old), next = program(a.next);
    if (old.sha256 === next.sha256 || compareRuntimeVersions(next.version, old.version) < 0) throw new RuntimeUpdateJournalError("unsafe");
    result.attempt = { id: a.id, ownerId: a.ownerId, phase: a.phase as RuntimeUpdatePhase, old, next };
  }
  return result;
}
/** Callers hold the shared install lock, and the exact registered controller owns all writes. */
export class RuntimeUpdateJournal {
  private readonly file: string;
  private readonly expected: RuntimeUpdateBinding;
  constructor(private readonly directory: string, expected: RuntimeUpdateBinding) {
    assertRuntimeInstallDirectory(directory); this.file = join(directory, "runtime-update.json"); this.expected = binding(expected); this.read();
  }
  read(): RuntimeUpdateState {
    assertRuntimeInstallDirectory(this.directory);
    const file = readRuntimeInstallFile(this.file, 16 * 1024);
    const state = file ? parseRuntimeUpdateState(JSON.parse(file.text)) : { version: 1 as const, revision: 0, binding: this.expected };
    if (JSON.stringify(state.binding) !== JSON.stringify(this.expected)) throw new RuntimeUpdateJournalError("changed");
    return structuredClone(state);
  }
  private commit(before: RuntimeUpdateState, next: RuntimeUpdateState, current: () => void): RuntimeUpdateState {
    const checked = parseRuntimeUpdateState({ ...next, revision: before.revision + 1 });
    const file = readRuntimeInstallFile(this.file, 16 * 1024);
    const assert = () => {
      if ((current() as unknown) !== undefined) throw new RuntimeUpdateJournalError("unsafe");
      const now = readRuntimeInstallFile(this.file, 16 * 1024);
      if (JSON.stringify(this.read()) !== JSON.stringify(before) || now?.text !== file?.text || now?.stat.ino !== file?.stat.ino || now?.stat.dev !== file?.stat.dev) throw new RuntimeUpdateJournalError("changed");
    };
    assert(); atomicWriteFileSync(this.file, JSON.stringify(checked), { mode: 0o600, beforeRename: assert }); return structuredClone(checked);
  }
  begin(id: string, ownerId: string, old: RuntimeInstalledProgram, next: RuntimeInstalledProgram, current: () => void): RuntimeUpdateState {
    const before = this.read();
    if (before.attempt || before.failed?.sha256 === next.sha256) throw new RuntimeUpdateJournalError("transition");
    return this.commit(before, { ...before, attempt: { id, ownerId, phase: "prepared", old, next } }, current);
  }
  advance(id: string, phase: RuntimeUpdatePhase, current: () => void): RuntimeUpdateState {
    const before = this.read(), attempt = before.attempt;
    const transitions: Record<RuntimeUpdatePhase, readonly RuntimeUpdatePhase[]> = { prepared: ["handoff", "rollback"], handoff: ["trial", "rollback"], trial: ["activating", "rollback"], activating: ["active"], active: [], rollback: [] };
    if (!attempt || attempt.id !== id || !transitions[attempt.phase].includes(phase)) throw new RuntimeUpdateJournalError("transition");
    return this.commit(before, { ...before, attempt: { ...attempt, phase } }, current);
  }
  fail(id: string, current: () => void): RuntimeUpdateState {
    const before = this.read(), attempt = before.attempt;
    if (!attempt || attempt.id !== id) throw new RuntimeUpdateJournalError("transition");
    if (["activating", "active"].includes(attempt.phase)) throw new RuntimeUpdateJournalError("uncertain");
    const { attempt: _, ...rest } = before;
    return this.commit(before, { ...rest, failed: { version: attempt.next.version, sha256: attempt.next.sha256 } }, current);
  }
  complete(id: string, current: () => void): RuntimeUpdateState {
    const before = this.read();
    if (before.attempt?.id !== id || before.attempt.phase !== "active") throw new RuntimeUpdateJournalError("transition");
    return this.commit(before, { version: 1, revision: before.revision, binding: before.binding }, current);
  }
}
