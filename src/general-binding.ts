/** Metadata-only General location journal. Provider homes and conversations never move. */
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicWriteFileSync } from "./atomic-write.js";
import { settingsFingerprint, type SettingsExecution } from "./settings-transaction.js";
import type { InstanceConfig } from "./types.js";

export type GeneralLocation = { location: "host" } | { location: "windows"; machineId: string; cli: "claude-code" | "codex"; model: string };
export interface GeneralSwitchInput { name: string; revision: string; target: GeneralLocation }
export interface GeneralHostPin { backend: string; sessionId: string }
export interface GeneralHostOwner { kind: "tmux"; windowId: string; pid: number; pin?: GeneralHostPin }
export interface GeneralWindowsBinding { id: string; agentId: string; machineId: string; cli: "claude-code" | "codex"; config: InstanceConfig }
export interface GeneralBindingRecord {
  version: 1; name: string; revision: string; host: { config: InstanceConfig; pin?: GeneralHostPin };
  active: "host" | string; windows: GeneralWindowsBinding[];
  pending?: { id: string; phase: "prepared" | "stopped" | "selected"; from: string; to: string;
    source: InstanceConfig; target: InstanceConfig; at: number; hostOwner?: GeneralHostOwner };
  hold?: "exit" | "start";
}
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, n: number): v is string => typeof v === "string" && v.length <= n && !/[\p{Cc}\p{Cf}]/u.test(v);
const closed = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const config = (v: unknown): v is InstanceConfig => object(v) && typeof v.working_directory === "string" && v.general_topic === true;
export function parseGeneralSwitchInput(v: unknown): GeneralSwitchInput {
  if (!object(v) || !closed(v, ["name", "revision", "target"]) || !text(v.name, 256) || !v.name
    || !/^[0-9a-f]{64}$/.test(typeof v.revision === "string" ? v.revision : "") || !object(v.target)) throw Error("Invalid General location request");
  const target = v.target;
  if (target.location === "host" && closed(target, ["location"])) return structuredClone(v) as unknown as GeneralSwitchInput;
  if (target.location !== "windows" || !closed(target, ["location", "machineId", "cli", "model"]) || !uuid(target.machineId)
    || target.cli !== "claude-code" && target.cli !== "codex" || !text(target.model, 256)) throw Error("Invalid General location target");
  return structuredClone(v) as unknown as GeneralSwitchInput;
}
export function generalBindingRevision(value: GeneralBindingRecord | null, current: InstanceConfig): string {
  return settingsFingerprint([value, current]);
}
function validate(raw: unknown, name: string): GeneralBindingRecord {
  if (!object(raw) || raw.version !== 1 || raw.name !== name || !uuid(raw.revision) || !object(raw.host) || !config(raw.host.config)
    || raw.host.config.runtime === "windows" || !Array.isArray(raw.windows) || raw.windows.length > 32
    || !closed(raw, ["version", "name", "revision", "host", "active", "windows", "pending", "hold"])) throw Error("General binding journal scope differs");
  const ids = new Set<string>(), agents = new Set<string>();
  for (const row of raw.windows) {
    if (!object(row) || !uuid(row.id) || !uuid(row.agentId) || !uuid(row.machineId) || row.cli !== "claude-code" && row.cli !== "codex"
      || !config(row.config) || row.config.runtime !== "windows" || row.config.native_adapter !== "pane"
      || row.config.native_general_binding !== row.id || row.config.native_agent_id !== row.agentId
      || row.config.machine_id !== row.machineId || row.config.backend !== row.cli || ids.has(row.id) || agents.has(row.agentId)) throw Error("General Windows binding scope differs");
    ids.add(row.id); agents.add(row.agentId);
  }
  if (raw.active !== "host" && (!uuid(raw.active) || !ids.has(raw.active))) throw Error("General active binding differs");
  if (raw.host.pin !== undefined && (!object(raw.host.pin) || !text(raw.host.pin.backend, 64) || !text(raw.host.pin.sessionId, 256) || !raw.host.pin.sessionId)) throw Error("General host pin differs");
  if (raw.hold !== undefined && raw.hold !== "exit" && raw.hold !== "start") throw Error("General binding hold differs");
  if (raw.pending !== undefined) {
    const p = raw.pending;
    if (!object(p) || !uuid(p.id) || p.phase !== "prepared" && p.phase !== "stopped" && p.phase !== "selected" || !config(p.source) || !config(p.target)
      || p.from !== "host" && (!uuid(p.from) || !ids.has(p.from)) || p.to !== "host" && (!uuid(p.to) || !ids.has(p.to))
      || p.from === p.to || !Number.isSafeInteger(p.at) || (p.at as number) < 0) throw Error("General switch intent differs");
    const target = p.to === "host" ? raw.host.config : raw.windows.find(row => row.id === p.to)!.config;
    if (settingsFingerprint(target) !== settingsFingerprint(p.target) || p.phase === "selected" && raw.active !== p.to
      || p.phase !== "selected" && raw.active !== p.from) throw Error("General switch configuration differs");
    if (p.hostOwner !== undefined) {
      const o = p.hostOwner;
      if (!object(o) || o.kind !== "tmux" || typeof o.windowId !== "string" || !/^@\d+$/.test(o.windowId)
        || !Number.isSafeInteger(o.pid) || (o.pid as number) <= 1
        || o.pin !== undefined && (!object(o.pin) || !text(o.pin.backend, 64) || !text(o.pin.sessionId, 256) || !o.pin.sessionId)) throw Error("General old host owner differs");
    }
  }
  return structuredClone(raw) as unknown as GeneralBindingRecord;
}
export class GeneralBindings {
  constructor(private readonly home: string) {}
  private path(name: string): string { return join(this.home, "general-bindings", `${createHash("sha256").update(name).digest("hex")}.json`); }
  read(name: string): GeneralBindingRecord | null {
    let fd: number;
    try { fd = openSync(this.path(name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > 1024 * 1024 || typeof process.getuid === "function" && st.uid !== process.getuid()) throw Error("General binding journal is not an owned regular file");
      const bytes = readFileSync(fd); if (bytes.length > 1024 * 1024) throw Error("General binding journal is too large");
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!object(value) || value.checksum !== settingsFingerprint(value.record)) throw Error("General binding journal checksum differs");
      return validate(value.record, name);
    } finally { closeSync(fd); }
  }
  write(value: GeneralBindingRecord): void {
    const record = validate(value, value.name), bytes = JSON.stringify({ record, checksum: settingsFingerprint(record) });
    if (Buffer.byteLength(bytes) > 1024 * 1024) throw Error("General binding journal is too large");
    mkdirSync(join(this.home, "general-bindings"), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(this.path(record.name), bytes, { mode: 0o600 });
  }
  /** A selected intent already owns this exact config. Publication settles its receipt after a coordinator restart. */
  completeSelected(name: string, current: InstanceConfig): boolean {
    const record = this.read(name);
    if (!record) return false;
    const selected = record.active === "host" ? record.host.config : record.windows.find(row => row.id === record.active)!.config;
    if (record.pending ? record.pending.phase !== "selected" || settingsFingerprint(record.pending.target) !== settingsFingerprint(current)
      : record.hold !== "start" || settingsFingerprint(selected) !== settingsFingerprint(current)) return false;
    delete record.pending; delete record.hold; this.write(record); return true;
  }
  /** Called on every start, including boot and automatic recovery. Never guess through an unfinished switch. */
  assertStart(name: string, current: InstanceConfig): void {
    const record = this.read(name); if (!record) return;
    if (record.pending && (record.pending.phase !== "selected" || settingsFingerprint(record.pending.target) !== settingsFingerprint(current))) throw Error("General switch is waiting for a confirmed old process exit");
    const selected = record.active === "host" ? record.host.config : record.windows.find(row => row.id === record.active)!.config;
    const sameBinding = record.active === "host" ? current.runtime !== "windows" :
      ["runtime", "machine_id", "native_agent_id", "native_adapter", "native_general_binding", "backend", "working_directory"].every(key =>
        (selected as unknown as Record<string, unknown>)[key] === (current as unknown as Record<string, unknown>)[key]);
    if (!sameBinding || !current.general_topic) throw Error("General binding differs from the saved location");
    // Ordinary approved settings edits keep their existing policy. They must not turn a later restart into a binding hold.
    if (!record.pending && settingsFingerprint(selected) !== settingsFingerprint(current)) {
      if (record.active === "host") {
        if (selected.backend !== current.backend || selected.working_directory !== current.working_directory) delete record.host.pin;
        record.host.config = structuredClone(current);
      } else record.windows.find(row => row.id === record.active)!.config = structuredClone(current);
      record.revision = randomUUID(); this.write(record);
    }
  }
}

/** Only an unfinished, selected switch-back can override the host backend's ordinary resume policy. */
export function selectedGeneralHostSession(instanceDir: string, name: string, backend: string, cwd: string): string | null {
  if (basename(instanceDir) !== name || basename(dirname(instanceDir)) !== "instances") return null;
  const record = new GeneralBindings(dirname(dirname(instanceDir))).read(name);
  if (record?.pending?.phase !== "selected" || record.pending.to !== "host" || record.active !== "host" || !record.host.pin) return null;
  if (record.host.pin.backend !== backend || record.host.config.working_directory !== cwd || !uuid(record.host.pin.sessionId)) throw Error("General's saved host conversation scope differs");
  return record.host.pin.sessionId;
}

/** One lifecycle-serialized switch. The injected stop must positively prove its exact old owner exited. */
export async function switchGeneralLocation(deps: {
  store: GeneralBindings; current(): InstanceConfig; assert(): void;
  prepare(target: GeneralLocation, retained: GeneralBindingRecord): Promise<GeneralWindowsBinding | null>;
  capture?(): Promise<GeneralHostOwner | undefined>;
  hostSnapshot?(): InstanceConfig;
  idle(): Promise<boolean>;
  stop(owner?: GeneralHostOwner): Promise<GeneralHostPin | undefined>;
  save(config: InstanceConfig): void;
  start(): Promise<void>;
  notify(kind: "exit" | "start" | "complete", error?: unknown): void;
}, input: GeneralSwitchInput, execution: SettingsExecution): Promise<{ started: boolean }> {
  deps.assert(); execution.assert();
  let source = structuredClone(deps.current()); const before = deps.store.read(input.name);
  if (!source.general_topic || input.revision !== generalBindingRevision(before, source)) throw Error("General location changed; read its settings again");
  const record: GeneralBindingRecord = before ?? { version: 1, name: input.name, revision: randomUUID(), active: "host", host: { config: source }, windows: [] };
  if (!before && source.runtime === "windows") throw Error("The original host General binding is not available");
  if (!record.pending && record.active !== "host") record.windows.find(row => row.id === record.active)!.config = source;
  const matches = (target: GeneralLocation, id: string): boolean => target.location === "host" ? id === "host"
    : record.windows.some(row => row.id === id && row.machineId === target.machineId && row.cli === target.cli && (row.config.model ?? "") === target.model);
  // Finish only the already-committed config write before reversing a selected intent. This never starts it.
  // The ordinary stop below must still prove that selected Windows owner exited (or was never launched).
  if (record.pending?.phase === "selected" && matches(input.target, record.pending.from)
    && settingsFingerprint(source) === settingsFingerprint(record.pending.source)) {
    execution.mutate(() => deps.save(structuredClone(record.pending!.target)));
    source = structuredClone(deps.current());
  }
  if (!record.pending && record.hold === "start" && matches(input.target, record.active)) {
    execution.commit(() => deps.save(source));
    try { await deps.start(); } catch (err) { deps.notify("start", err); return { started: false }; }
    delete record.hold; deps.store.write(record); deps.notify("complete"); return { started: true };
  }
  const activeWindows = record.windows.find(row => row.id === record.active);
  if (!record.pending && input.target.location === "windows" && activeWindows?.machineId === input.target.machineId && activeWindows.cli === input.target.cli) throw Error("General already runs at this location");
  if (record.pending && matches(input.target, record.pending.to)) {
    if (record.pending.phase === "selected") {
      if (![record.pending.source, record.pending.target].some(row => settingsFingerprint(row) === settingsFingerprint(source))) throw Error("General switch configuration was changed");
      execution.commit(() => deps.save(structuredClone(record.pending!.target)));
      try { await deps.start(); } catch (err) { record.hold = "start"; deps.store.write(record); deps.notify("start", err); return { started: false }; }
      delete record.pending; delete record.hold; deps.store.write(record); deps.notify("complete"); return { started: true };
    }
    if (settingsFingerprint(source) !== settingsFingerprint(record.pending.source)) throw Error("General switch configuration was changed");
  } else if (record.pending && record.pending.phase !== "selected") throw Error("General has an unfinished switch to another location");
  const replay = record.pending && record.pending.phase !== "selected" ? record.pending : undefined;
  const windows = replay ? record.windows.find(row => row.id === replay.to) ?? null
    : input.target.location === "windows" ? await deps.prepare(input.target, record) : null;
  deps.assert(); execution.assert();
  const to = windows?.id ?? "host";
  if (to === record.active) throw Error("General already runs at this location");
  if (windows) { const old = record.windows.findIndex(row => row.id === windows.id); if (old < 0) record.windows.push(windows); else record.windows[old] = windows; }
  if (!await deps.idle()) throw Error("Wait for General to be idle before switching its location");
  deps.assert(); execution.assert();
  const hostOwner = replay?.hostOwner ?? await deps.capture?.();
  deps.assert(); execution.assert();
  const target = structuredClone(windows?.config ?? record.host.config);
  // The logical route always stays on the coordinator, including a retained host's older config.
  for (const key of ["general_topic", "channel_id", "topic_id"] as const) {
    if (source[key] === undefined) delete target[key]; else (target as unknown as Record<string, unknown>)[key] = source[key];
  }
  if (to === "host") record.host.config = target; else record.windows.find(row => row.id === to)!.config = target;
  record.pending = replay ?? { id: randomUUID(), phase: "prepared", from: record.active, to, source, target, at: Date.now(), ...(hostOwner ? { hostOwner } : {}) };
  execution.mutate(() => deps.store.write(record));
  let pin: GeneralHostPin | undefined;
  try { await execution.stopTarget(input.name, async () => { pin = await deps.stop(record.pending!.hostOwner); }); }
  catch (err) { record.hold = "exit"; deps.store.write(record); deps.notify("exit", err); throw err; }
  deps.assert(); execution.assert();
  if (record.active === "host") { record.host.config = structuredClone(deps.hostSnapshot?.() ?? source); if (pin) record.host.pin = pin; }
  record.pending.phase = "stopped"; execution.mutate(() => deps.store.write(record));
  // Keep the stopped intent until both configuration and selected receipt are durable. Any crash in this gap holds.
  record.active = to; record.pending.phase = "selected"; record.revision = randomUUID(); delete record.hold;
  execution.commit(() => { deps.store.write(record); deps.save(target); });
  // The committed receipt permits only starting its selected config, never another settings mutation.
  try { await deps.start(); }
  catch (err) { record.hold = "start"; deps.store.write(record); deps.notify("start", err); return { started: false }; }
  delete record.pending; deps.store.write(record); deps.notify("complete"); return { started: true };
}
