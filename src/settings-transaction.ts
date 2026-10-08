import { createHash } from "node:crypto";
import { dirname, resolve, basename } from "node:path";
import { realpathSync } from "node:fs";
import { performance } from "node:perf_hooks";

export const SETTINGS_OPERATION_MS = 60_000;
export class SettingsExecutionError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function settingsFingerprint(value: unknown): string {
  return createHash("sha256").update((JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) ?? "undefined")).digest("hex");
}
function canonicalPath(path: string): string {
  const full = resolve(path);
  try { return realpathSync(full); } catch { /* a future file still has one identity */ }
  try { return resolve(realpathSync(dirname(full)), basename(full)); } catch { return full; }
}
interface Journal { epoch: number; next: number; revisions: Map<string, number> }
// Process-wide: stop/start never revives an old lease or revision ticket.
const journals = new Map<string, Journal>();
function journal(path: string): Journal {
  const key = canonicalPath(path); let value = journals.get(key);
  if (!value) { value = { epoch: 0, next: 0, revisions: new Map() }; journals.set(key, value); }
  return value;
}
export function settingsRevision(path: string): number { return journal(path).epoch; }
function leaves(value: unknown, path: string[] = [], result = new Map<string, unknown>()): Map<string, unknown> {
  if (value && typeof value === "object" && Object.keys(value).length) {
    for (const [key, child] of Object.entries(value)) leaves(child, [...path, key], result);
  } else result.set(JSON.stringify(path), value);
  return result;
}
/** All in-process writers, including ordinary edits, record before replacement. */
export function noteSettingsWrite(path: string, before: unknown, after: unknown): void {
  const state = journal(path), old = leaves(before), next = leaves(after);
  state.epoch++;
  for (const key of new Set([...old.keys(), ...next.keys()])) {
    if (settingsFingerprint(old.get(key)) !== settingsFingerprint(next.get(key))) {
      const parts = JSON.parse(key) as string[];
      for (let depth = 0; depth <= parts.length; depth++) state.revisions.set(JSON.stringify(parts.slice(0, depth)), ++state.next);
    }
  }
}
export interface SettingsUndo { path: readonly string[]; before: unknown; written: unknown; revision: number }
function getPath(value: any, path: readonly string[]): unknown {
  for (const key of path) value = value?.[key]; return value;
}
function setPath(value: any, path: readonly string[], next: unknown): void {
  for (const key of path.slice(0, -1)) value = value[key] ??= {};
  if (next === undefined) delete value[path.at(-1)!]; else value[path.at(-1)!] = structuredClone(next);
}
export function settingsUndo(path: string, before: unknown, written: unknown, fields: readonly (readonly string[])[]): SettingsUndo[] {
  return fields.map(field => ({ path: [...field], before: structuredClone(getPath(before, field)),
    written: structuredClone(getPath(written, field)), revision: journal(path).revisions.get(JSON.stringify(field)) ?? 0 }));
}
/** Preserve concurrent edits and ABA writes; never restore a whole stale document. */
export function undoSettingsPaths(path: string, current: unknown, undo: readonly SettingsUndo[]): { value: any; conflicts: boolean } {
  const value = structuredClone(current), state = journal(path); let conflicts = false;
  for (const item of undo) {
    if ((state.revisions.get(JSON.stringify(item.path)) ?? 0) !== item.revision
      || settingsFingerprint(getPath(current, item.path)) !== settingsFingerprint(item.written)) { conflicts = true; continue; }
    setPath(value, item.path, item.before);
  }
  return { value, conflicts };
}

const leases = new Map<string, { owner: symbol; count: number }>();
const leaseWaiters = new Set<() => void>();
export interface SettingsLease { readonly owner: symbol; readonly keys: readonly string[]; release(): void }
export function settingsFileResource(path: string): string { return `file:${canonicalPath(path)}`; }
export function settingsLeaseBusy(key: string): boolean { return leases.has(key); }
export function assertSettingsLease(key: string, owner?: symbol): void {
  const held = leases.get(key); if (held && held.owner !== owner) throw new SettingsExecutionError("settings_resource_busy");
}
/** Atomic reservation of the complete resource set; helpers reuse the same owner. */
export function trySettingsLease(keys: readonly string[], owner = Symbol("settings-operation")): SettingsLease | null {
  const ordered = [...new Set(keys)].sort();
  if (ordered.some(key => leases.has(key) && leases.get(key)?.owner !== owner)) return null;
  for (const key of ordered) { const held = leases.get(key); leases.set(key, { owner, count: (held?.count ?? 0) + 1 }); }
  let released = false;
  return { owner, keys: ordered, release() {
    if (released) return; released = true;
    for (const key of ordered) {
      const held = leases.get(key); if (held?.owner !== owner) continue;
      if (--held.count === 0) leases.delete(key);
    }
    for (const notify of [...leaseWaiters]) notify();
  } };
}

/** A server-created continuation; never reconstructed from headers or payload. */
export class SettingsExecution {
  readonly owner = Symbol("settings-execution");
  private expected: string;
  private deadline: number;
  private cancelled = false;
  private committed = false;
  private timer: ReturnType<typeof setTimeout>;
  constructor(private readonly options: {
    current(): boolean; snapshot(): unknown; now?: () => number; expectedFingerprint?: string;
    progress?(phase: "queued" | "running" | "cleanup", reason?: string): void;
  }) {
    this.expected = options.expectedFingerprint ?? settingsFingerprint(options.snapshot()); this.deadline = this.now() + SETTINGS_OPERATION_MS;
    this.timer = setTimeout(() => { this.cancelled = true; options.progress?.("cleanup", "operation_timed_out"); }, SETTINGS_OPERATION_MS);
    this.timer.unref?.(); options.progress?.("queued");
  }
  private now(): number { return this.options.now?.() ?? performance.now(); }
  current(): boolean {
    return !this.cancelled && !this.committed && this.now() < this.deadline && this.options.current()
      && this.expected === settingsFingerprint(this.options.snapshot());
  }
  assert(): void { if (!this.current()) throw new SettingsExecutionError("settings_execution_stale"); }
  /** No await is permitted between the check, mutation, and expected-state update. */
  mutate<T>(effect: () => T): T {
    this.assert(); this.options.progress?.("running");
    try { return effect(); } finally { this.expected = settingsFingerprint(this.options.snapshot()); }
  }
  /** Place a self-revoking effect last; its receipt authorizes settlement only. */
  commit<T>(effect: () => T): T {
    const result = this.mutate(effect); this.committed = true; clearTimeout(this.timer); return result;
  }
  complete(): void { this.commit(() => undefined); }
  get deadlineAt(): number { return this.deadline; }
  get remainingMs(): number { return Math.max(0, this.deadline - this.now()); }
  get completed(): boolean { return this.committed; }
  cancel(): void { this.cancelled = true; this.options.progress?.("cleanup", "execution_cancelled"); }
  close(): void { clearTimeout(this.timer); }
}

/** Wait for physical cleanup, with a bounded admission deadline and no polling. */
export function waitSettingsLease(keys: readonly string[], current: () => boolean, deadline: number, owner?: symbol): Promise<SettingsLease> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const check = (): void => {
      if (!current() || performance.now() >= deadline) {
        clearTimeout(timer); leaseWaiters.delete(check); reject(new SettingsExecutionError("settings_resource_unavailable")); return;
      }
      const lease = trySettingsLease(keys, owner);
      if (lease) { clearTimeout(timer); leaseWaiters.delete(check); resolve(lease); }
    };
    leaseWaiters.add(check); timer = setTimeout(check, Math.max(1, Math.ceil(deadline - performance.now()))); check();
  });
}
/** Apply only this writer's delta to the latest document, retaining unrelated fields. */
export function mergeSettingsDelta(before: any, after: any, current: any): any {
  if (settingsFingerprint(before) === settingsFingerprint(after)) return structuredClone(current);
  const object = (v: any): boolean => !!v && typeof v === "object" && !Array.isArray(v);
  if (!object(before) || !object(after)) return structuredClone(after);
  const next = object(current) ? structuredClone(current) : {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (settingsFingerprint(before[key]) === settingsFingerprint(after[key])) continue;
    if (!Object.hasOwn(after, key)) delete next[key];
    else next[key] = mergeSettingsDelta(before[key], after[key], next[key]);
  }
  return next;
}
