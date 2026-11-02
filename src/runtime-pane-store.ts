/** A separate per-pane ledger: an uncertain pane consumes only its own machine slot. No input text is stored. */
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { runtimeJobDigest } from "./runtime-client-store.js";
import { validateRuntimePaneLaunch, validateRuntimePaneSnapshot, type RuntimePaneLaunch, type RuntimePaneSnapshot } from "./runtime-pane-protocol.js";
import type { NativePaneOwner } from "./runtime-pane-native.js";

export interface RuntimePaneRecord {
  launch: RuntimePaneLaunch;
  snapshot: RuntimePaneSnapshot;
  openDigest: string;
  openOperationId: string;
  bootId: string;
  /** Local process bookkeeping; never returned as a coordinator PID. */
  pid?: number;
  lastCommand?: { id: string; digest: string; state: "prepared" | "applied" };
}
interface Ledger { version: 1; panes: Record<string, RuntimePaneRecord>; retired?: Record<string, string> }
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PANES = 256;
const MAX_RETIRED = 65_536;
function writePaneState(path: string, text: string): void {
  for (let attempt = 0; ; attempt++) {
    try { atomicWriteFileSync(path, text, { mode: 0o600 }); return; }
    catch (error) {
      if (process.platform !== "win32" || attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // Windows scanners briefly hold replacement targets. Same bound as RuntimeClientStore, no dropped writes.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
    }
  }
}
export function writeNativePaneExit(owner: NativePaneOwner, launch: RuntimePaneLaunch, pid: number, code: number): void {
  const directory = join(owner.directory, "exits");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw Error("Unsafe pane exit directory");
  writePaneState(join(directory, `${owner.launchId}.json`), JSON.stringify({ version: 1, launchId: owner.launchId,
    paneId: launch.paneId, agentId: launch.agentId, pid, code }));
}
export class RuntimePaneStore {
  private readonly file: string;
  private ledger: Ledger;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error("Pane state must be a private real directory");
    this.file = join(directory, "panes.json");
    this.ledger = { version: 1, panes: {} };
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw Error("Invalid pane ledger file");
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (raw?.version !== 1 || !raw.panes || typeof raw.panes !== "object" || Array.isArray(raw.panes) || Object.keys(raw.panes).length > MAX_PANES) throw Error("Invalid pane ledger");
      if (raw.retired !== undefined && (!raw.retired || typeof raw.retired !== "object" || Array.isArray(raw.retired)
        || Object.keys(raw.retired).length > MAX_RETIRED || Object.entries(raw.retired).some(([id, digest]) => !/^[a-f0-9-]{36}$/i.test(id) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)))) throw Error("Invalid pane replay ledger");
      for (const [id, row] of Object.entries(raw.panes) as Array<[string, RuntimePaneRecord]>) {
        const launch = validateRuntimePaneLaunch(row?.launch);
        validateRuntimePaneSnapshot(row.snapshot);
        if (launch.launchId !== undefined && launch.launchId !== row.snapshot.launchId || id !== launch.paneId || row.snapshot?.paneId !== id || row.snapshot.agentId !== launch.agentId
          || row.snapshot.sessionId !== undefined && (launch.sessionId !== undefined && row.snapshot.sessionId !== launch.sessionId
            || launch.cli === "claude-code" && row.snapshot.sessionId !== (launch.sessionId ?? row.snapshot.launchId))
          || row.snapshot.instance !== launch.instance || !/^[a-f0-9-]{36}$/i.test(row.snapshot.launchId)
          || !["starting", "running", "exited", "unknown"].includes(row.snapshot.state)
          || !Number.isSafeInteger(row.snapshot.commandSequence) || row.snapshot.commandSequence < 0
          || !/^[a-f0-9]{64}$/.test(row.openDigest) || !/^[a-f0-9-]{36}$/i.test(row.openOperationId)
          || typeof row.bootId !== "string" || (row.pid !== undefined && (!Number.isSafeInteger(row.pid) || row.pid < 1))
          || (row.lastCommand && (!/^[a-f0-9-]{36}$/i.test(row.lastCommand.id) || !/^[a-f0-9]{64}$/.test(row.lastCommand.digest)
            || !["prepared", "applied"].includes(row.lastCommand.state)))) throw Error("Invalid pane record");
      }
      this.ledger = raw;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  list(): RuntimePaneRecord[] { return structuredClone(Object.values(this.ledger.panes)); }
  get(id: string): RuntimePaneRecord | undefined { return structuredClone(this.ledger.panes[id]); }
  put(record: RuntimePaneRecord): void {
    if (this.ledger.retired?.[record.launch.paneId]) throw Error("Pane id was retired; its open must never be replayed");
    const before = structuredClone(this.ledger);
    const previous = this.ledger.panes[record.launch.paneId];
    if (!previous && Object.keys(this.ledger.panes).length >= MAX_PANES) {
      const oldest = Object.values(this.ledger.panes).find(row => row.snapshot.state === "exited");
      if (!oldest || Object.keys(this.ledger.retired ?? {}).length >= MAX_RETIRED) throw Error("Pane replay ledger capacity reached");
      (this.ledger.retired ??= {})[oldest.launch.paneId] = oldest.openDigest;
      delete this.ledger.panes[oldest.launch.paneId];
    }
    this.ledger.panes[record.launch.paneId] = structuredClone(record);
    try {
      const text = JSON.stringify(this.ledger);
      if (Buffer.byteLength(text) > MAX_BYTES) throw Error("Pane ledger size limit reached");
      writePaneState(this.file, text);
    } catch (error) {
      this.ledger = before;
      throw error;
    }
  }
  /** Called under the profile lock. A lost runner never replays an open or assumes a PID is gone. */
  recoverInterrupted(): void {
    for (const record of this.list()) if (record.snapshot.state !== "exited") {
      if (record.snapshot.state !== "unknown") { record.snapshot.state = "unknown"; this.put(record); }
      this.reconcileExit(record.launch.paneId);
    }
  }
  /** Only an exact helper receipt of CLI exit releases a lost runner's reservation. No PID lookup or signal. */
  reconcileExit(id: string): void {
    const record = this.get(id);
    if (!record || record.snapshot.state === "exited") return;
    const path = join(this.directory, "exits", `${record.snapshot.launchId}.json`);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw Error("Unsafe pane exit receipt");
      const exit = JSON.parse(readFileSync(path, "utf8"));
      if (exit?.version !== 1 || exit.launchId !== record.snapshot.launchId || exit.paneId !== record.launch.paneId || exit.agentId !== record.launch.agentId
        || !Number.isSafeInteger(exit.pid) || exit.pid <= 0 || record.pid !== undefined && record.pid !== exit.pid || !Number.isSafeInteger(exit.code) || exit.code < 0) throw Error("Pane exit receipt identity differs");
      record.snapshot.state = "exited"; record.snapshot.exitCode = exit.code;
      this.put(record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const diagnostic = path.replace(/\.json$/, ".error.json");
      try {
        const stat = lstatSync(diagnostic);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw Error("Unsafe pane exit diagnostic");
        const value = JSON.parse(readFileSync(diagnostic, "utf8"));
        if (value.launchId !== record.snapshot.launchId || value.paneId !== record.launch.paneId || value.agentId !== record.launch.agentId
          || !["create", "start-helper", "assign", "running", "helper-exit", "tree-exit", "receipt"].includes(value.stage) || !Number.isSafeInteger(value.code)) throw Error("Invalid pane exit diagnostic");
        throw Error(`Owned Windows pane exit proof failed at ${value.stage} (win32 ${value.code}); the reservation is held`);
      } catch (diagnosticError) { if ((diagnosticError as NodeJS.ErrnoException).code !== "ENOENT") throw diagnosticError; }
    }
  }
  static digest(value: unknown): string { return runtimeJobDigest(value); }
}
