/** Exact-session reads on the runner. No caller-supplied path and no newest-by-cwd discovery. */
import { codexTurnRecord, type CodexRecordState } from "./transcript-records.js";
import type { PaneTranscriptBaseline } from "./runtime-pane-transcript-protocol.js";
import { constants, fstatSync, lstatSync, type BigIntStats } from "node:fs";
import { codexQuotaErrorMessages } from "./pane-quota-history.js";
import { codexIndexHasNoThread } from "./runtime-pane-codex-index.js";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, parse, resolve, win32 } from "node:path";
import { createHash } from "node:crypto";
import { validNativeSessionId } from "./windows-cli-providers.js";
import { nativeCliEnvironment } from "./windows-cli-worker.js";
import { PANE_TRANSCRIPT_EMPTY_ANCHOR as EMPTY, PANE_TRANSCRIPT_MAX_FILE_BYTES as MAX_FILE, validatePaneTranscriptCursor,
  type PaneTranscriptCursor, type PaneTranscriptProvider, type PaneTranscriptWireBatch } from "./runtime-pane-transcript-protocol.js";
export { validatePaneTranscriptCursor, type PaneTranscriptCursor, type PaneTranscriptProvider } from "./runtime-pane-transcript-protocol.js";
export interface PaneTranscriptBatch extends PaneTranscriptWireBatch {
  /** Complete UTF-8 JSONL records only. A partial/oversized record never becomes a turn boundary. */
  lines: string[];
}
export interface PaneTranscriptRoots { codex: string; claude: string }
const CHUNK = 160 * 1024, META = 1024 * 1024, ANCHOR = 4096;
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const comparable = (path: string): string => /^[a-z]:[\\/]/i.test(path)
  ? win32.normalize(path).replace(/[\\/]+$/, "").toLowerCase() : normalize(path).replace(/\/+$/, "");
function owned(stat: Stats): boolean { return typeof process.getuid !== "function" || stat.uid === process.getuid(); }
function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs; }
function regular(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || !owned(stat) || stat.size > MAX_FILE) throw Error("Owned pane transcript is not a bounded regular file");
}
/** Root configuration comes only from the runner's allowed provider environment, never a pane RPC. */
export function nativePaneTranscriptRoots(env = nativeCliEnvironment(), home = homedir()): PaneTranscriptRoots {
  const find = (key: string): string | undefined => Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1];
  return { codex: find("CODEX_HOME") ?? join(home, ".codex"), claude: find("CLAUDE_CONFIG_DIR") ?? join(home, ".claude") };
}
/** Same algorithm as Claude's project directory, evaluated on the runner's canonical native cwd. */
export function nativeClaudeProjectKey(cwd: string): string {
  const safe = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (safe.length <= 200) return safe;
  let n = 0; for (let i = 0; i < cwd.length; i++) n = (Math.imul(31, n) + cwd.charCodeAt(i)) | 0;
  return `${safe.slice(0, 200)}-${Math.abs(n).toString(36)}`;
}
export type NativeClaudeSessionState = "absent" | "saved" | "unknown";
/** Positive absence is a read-only runner proof, never inferred from a failed resume or pending transcript read.
 * Key derivation is tied to the audited Claude launch version; re-check it with each Claude version audit. */
export async function nativeClaudeSessionState(cwd: string, sessionId: string, current: () => boolean = () => true,
  roots = nativePaneTranscriptRoots()): Promise<NativeClaudeSessionState> {
  if (!validNativeSessionId("claude-code", sessionId)) return "unknown";
  let reader: NativePaneTranscriptReader | undefined;
  try {
    const canonical = await realpath(cwd);
    if (!current() || comparable(canonical) !== comparable(cwd)) return "unknown";
    await realDirectory(roots.claude);
    let parent = roots.claude;
    // Check every existing directory; a junction/link/access error never becomes ENOENT evidence.
    for (const name of ["projects", nativeClaudeProjectKey(canonical), `${sessionId}.jsonl`]) {
      const path = join(parent, name);
      let stat: Stats;
      try { stat = await lstat(path); }
      catch (error) {
        if (!missing(error)) return "unknown";
        await realDirectory(parent);
        try { await lstat(path); return "unknown"; }
        catch (again) { return missing(again) && current() ? "absent" : "unknown"; }
      }
      if (name.endsWith(".jsonl")) { regular(stat); if (stat.size === 0) return "unknown"; }
      else await realDirectory(path);
      parent = path;
    }
    reader = new NativePaneTranscriptReader("claude-code", cwd, sessionId, roots);
    const proof = await reader.baseline(undefined, current);
    return current() && proof.state === "ready" ? "saved" : "unknown";
  } catch { return "unknown"; }
  finally { await reader?.close(); }
}
/** Complete, bounded absence proof, distinct from the transcript reader's incremental "pending" result.
 * A matching archive, stale metadata, incomplete walk, WAL, unsafe file or lost lease is unknown, never absence. */
export async function nativeCodexSessionState(cwd: string, sessionId: string, current: () => boolean = () => true,
  roots = nativePaneTranscriptRoots()): Promise<NativeClaudeSessionState> {
  if (!validNativeSessionId("codex", sessionId) || sessionId !== sessionId.toLowerCase()) return "unknown";
  const deadline=performance.now()+1250,live=()=>current()&&performance.now()<deadline;
  const observed=new Map<string,Stats|null>(),matches:string[]=[];
  const same=(a:Stats,b:Stats)=>sameFile(a,b)&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
  const inspect=async(path:string):Promise<Stats|null>=>{if(!live())throw Error("Expired proof");try{const st=await lstat(path);observed.set(path,st);return st;}catch(error){if(!missing(error))throw error;observed.set(path,null);return null;}};
  const unchanged=async()=>{for(const[path,before]of observed){if(!live())return false;let after:Stats|null;try{after=await lstat(path);}catch(error){if(!missing(error))return false;after=null;}if(before?(!after||!same(before,after)):after)return false;}return live();};
  let entries=0,dirs=0;
  try {
    const canonical=await realpath(cwd);if(!live()||comparable(canonical)!==comparable(cwd))return "unknown";
    await realDirectory(roots.codex);await inspect(roots.codex);
    const walk=async(folder:string,depth:number,archive:boolean):Promise<void>=>{
      if(++dirs>1024)throw Error("Proof scan bound");const stat=await inspect(folder);if(!stat)return;
      await realDirectory(folder);const dir=await opendir(folder);
      for await(const entry of dir){if(!live()||++entries>16384)throw Error("Proof scan bound");
        const path=join(folder,entry.name);
        if(entry.isSymbolicLink())throw Error("Unsafe proof entry");
        if(entry.name.toLowerCase().includes(sessionId)&&!entry.name.endsWith(`-${sessionId}.jsonl`))throw Error("Unknown exact-ID filename");
        if(entry.name.endsWith(`-${sessionId}.jsonl`)){
          if(archive||!entry.isFile()||entry.isSymbolicLink())throw Error("Archived or unsafe exact match");
          const st=await inspect(path);if(!st)throw Error("Match changed");regular(st);if(!st.size)throw Error("Incomplete match");matches.push(path);
        }else if(depth<3&&/^\d{2,4}$/.test(entry.name)){
          if(!entry.isDirectory()||entry.isSymbolicLink())throw Error("Unsafe date directory");await walk(path,depth+1,archive);
        }else if(entry.isDirectory())throw Error("Unknown proof layout");
      }
    };
    await walk(join(roots.codex,"sessions"),0,false);await walk(join(roots.codex,"archived_sessions"),0,true);
    if(matches.length>1)return "unknown";
    if(matches.length===1){
      const reader=new NativePaneTranscriptReader("codex",canonical,sessionId,roots);
      try{let proof:PaneTranscriptBaseline;do{proof=await reader.baseline(undefined,live);}while(live()&&proof.state==="pending");
        return proof.state==="ready"&&proof.complete&&await unchanged()?"saved":"unknown";
      }finally{await reader.close();}
    }
    // No rollouts is not sufficient if Codex retains metadata for that ID. Never open its DB in normal WAL mode.
    const index=join(roots.codex,"session_index.jsonl"),indexStat=await inspect(index);
    if(indexStat){regular(indexStat);if(indexStat.size>16*1024*1024)return "unknown";const handle=await open(index,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
      try{if(!same(indexStat,await handle.stat()))return "unknown";const text=decode(await bytes(handle,0,indexStat.size));
        for(const line of text.split(/\r?\n/)){if(!live())return "unknown";if(line){const entry=record(line);if(typeof entry.id!=="string"||!validNativeSessionId("codex",entry.id)||entry.id.toLowerCase()===sessionId)return "unknown";}}
      }finally{await handle.close();}}
    const profile=await opendir(roots.codex);
    for await(const entry of profile){if(!live()||++entries>16384)return "unknown";
      if(/^state_.*\.sqlite(?:-wal|-shm)?$/.test(entry.name)&&!/^state_5\.sqlite(?:-wal|-shm)?$/.test(entry.name))return "unknown";}
    const dbPath=join(roots.codex,"state_5.sqlite"),db=await inspect(dbPath),wal=await inspect(dbPath+"-wal");
    if(wal){regular(wal);if(wal.size)return "unknown";}
    if(db){regular(db);if(!db.size||db.size>128*1024*1024)return "unknown";
      if(!await codexIndexHasNoThread(dbPath,sessionId,live))return "unknown";}
    await realDirectory(roots.codex);
    return await unchanged()?"absent":"unknown";
  }catch{return "unknown";}
}
/** Reject directory links/junctions, including an ancestor swapped outside a configured provider root. */
async function realDirectory(path: string): Promise<void> {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Pane transcript directory is not a real directory");
  }
  if (comparable(await realpath(absolute)) !== comparable(absolute)) throw Error("Pane transcript directory escaped its configured root");
}
async function bytes(file: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length); let count = 0;
  while (count < length) { const read = await file.read(buffer, count, length - count, offset + count); if (!read.bytesRead) break; count += read.bytesRead; }
  return buffer.subarray(0, count);
}
function decode(value: Buffer): string { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
function record(line: string): any {
  try { const value = JSON.parse(line); if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(); return value; }
  catch { throw Error("Pane transcript contains an invalid JSON record"); }
}
function metadata(lines: string[], provider: PaneTranscriptProvider, sessionId: string, cwd: string): void {
  if (provider === "codex") {
    const first = record(lines[0] ?? "null");
    if (first?.type !== "session_meta" || first.payload?.id !== sessionId || comparable(String(first.payload?.cwd ?? "")) !== comparable(cwd)) throw Error("Pane transcript session metadata differs from its pinned conversation");
    return;
  }
  let proved = false;
  for (const line of lines) {
    const entry = record(line);
    if (entry.sessionId !== undefined && entry.sessionId !== sessionId || entry.cwd !== undefined && comparable(String(entry.cwd)) !== comparable(cwd)
      || entry.isSidechain === true) throw Error("Pane transcript session metadata differs from its pinned conversation");
    if (entry.sessionId === sessionId && typeof entry.cwd === "string" && comparable(entry.cwd) === comparable(cwd)) proved = true;
  }
  if (!proved) throw Error("Pane transcript has no exact session and workspace proof yet");
}
function ownedHeader(head: Buffer, provider: PaneTranscriptProvider, sessionId: string, cwd: string): Buffer {
  const lines: string[] = [];
  for (let start = 0; start < head.length;) {
    const end = head.indexOf(10, start); if (end < 0) break;
    const line = decode(head.subarray(start, end)).replace(/\r$/, ""); start = end + 1;
    if (!line) continue;
    const entry = record(line); lines.push(line);
    if (provider === "codex" || entry.sessionId === sessionId && typeof entry.cwd === "string") {
      metadata(lines, provider, sessionId, cwd); return head.subarray(0, start);
    }
    if (entry.sessionId !== undefined && entry.sessionId !== sessionId || entry.cwd !== undefined && comparable(String(entry.cwd)) !== comparable(cwd)
      || entry.isSidechain === true) throw Error("Pane transcript session metadata differs from its pinned conversation");
  }
  if (!lines.length) throw Error("Pane transcript metadata is incomplete");
  throw Error("Pane transcript has no exact session and workspace proof yet");
}
export class NativePaneTranscriptReader {
  private busy = false;
  private pinnedFile: string | undefined;
  private metadataBytes = 0;
  private discovery: AsyncGenerator<string | null> | undefined;
  private discoveryMatches: string[] = [];
  private canonicalCwd: string | undefined;
  private stopped = false;
  readonly initial: PaneTranscriptCursor;
  constructor(readonly provider: PaneTranscriptProvider, readonly cwd: string, readonly sessionId: string,
    private readonly roots = nativePaneTranscriptRoots()) {
    if (!validNativeSessionId(provider, sessionId)) throw Error("Invalid pane transcript session identity");
    this.initial = { sessionId, offset: 0, fileId: null, anchor: EMPTY };
  }
  /** At most one filesystem operation remains in flight even if a transport deadline abandons its result. */
  async read(cursor: PaneTranscriptCursor = this.initial, current: () => boolean = () => true): Promise<PaneTranscriptBatch> {
    validatePaneTranscriptCursor(cursor, this.sessionId);
    if (this.stopped) throw Error("Pane transcript reader is closed");
    if (this.busy) throw Error("Pane transcript read is already pending");
    this.busy = true;
    try { return await this.readOwned(cursor, current); } finally { this.busy = false; }
  }
  /** At most 4 MiB of tail content, independent of history size; no historical text leaves the runner. */
  async baseline(cursor: PaneTranscriptCursor = this.initial, current: () => boolean = () => true): Promise<PaneTranscriptBaseline> {
    validatePaneTranscriptCursor(cursor, this.sessionId);
    if (cursor.offset !== 0 || this.busy || this.stopped) throw Error("Native transcript baseline is not available");
    this.busy = true;
    const check = (): void => { if (this.stopped || !current()) throw Error("Pane baseline lease expired"); };
    const pending = (): PaneTranscriptBaseline => ({ state: "pending", cursor, complete: false, turnKnown: false, openTurn: null });
    try {
      check(); const found = this.pinnedFile ? { path: this.pinnedFile } : await this.locate(current), path = found.path; check();
      if (!path) return pending();
      await realDirectory(dirname(path)); const before = await lstat(path); regular(before);
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat(); regular(stat);
        if (!sameFile(before, stat) || comparable(await realpath(path)) !== comparable(path)) throw Error("Pane baseline changed while opening");
        const header = ownedHeader(await bytes(file, 0, Math.min(stat.size, this.metadataBytes || META)), this.provider, this.sessionId, this.cwd);
        const fileId = hash(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${hash(header.subarray(0, header.indexOf(10) + 1))}`);
        if (cursor.fileId && cursor.fileId !== fileId) throw Error("Pane baseline file identity changed");
        const start = Math.max(0, stat.size - 4 * 1024 * 1024), tail = await bytes(file, start, stat.size - start), last = tail.lastIndexOf(10);
        if (last < 0) return pending();
        const first = start ? tail.indexOf(10) + 1 : 0, offset = start + last + 1;
        const state: CodexRecordState = { openTurnId: "", openTurn: null, turnKnown: start === 0 || this.provider !== "codex" };
        for (const line of decode(tail.subarray(first, last + 1)).split(/\r?\n/)) if (line) {
          const entry = record(line);
          if (this.provider === "codex") {
            if (entry.type === "session_meta") metadata([line], this.provider, this.sessionId, this.cwd);
            const orphanEnd = !state.turnKnown && entry.type === "event_msg" && ["task_complete", "turn_aborted"].includes(entry.payload?.type);
            if (!orphanEnd) codexTurnRecord(entry, state, []);
          } else if (entry.sessionId !== undefined && entry.sessionId !== this.sessionId || entry.cwd !== undefined && comparable(String(entry.cwd)) !== comparable(this.cwd) || entry.isSidechain === true)
            throw Error("Pane baseline belongs to another conversation");
        }
        const anchor = await bytes(file, Math.max(0, offset - ANCHOR), Math.min(offset, ANCHOR));
        if (hash(await bytes(file, start, tail.length)) !== hash(tail) || hash(await bytes(file, 0, header.length)) !== hash(header)) throw Error("Pane baseline bytes changed during read");
        const after = await file.stat(), named = await lstat(path); regular(named);
        if (!sameFile(stat, after) || !sameFile(stat, named) || after.size < stat.size || after.size !== named.size || after.mtimeMs !== named.mtimeMs || after.ctimeMs !== named.ctimeMs
          || after.size === stat.size && (after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)) throw Error("Pane baseline changed during read");
        check(); this.pinnedFile = path; this.metadataBytes = header.length;
        return { state: "ready", cursor: { sessionId: this.sessionId, offset, fileId, anchor: hash(anchor) }, complete: offset === stat.size && after.size === stat.size,
          turnKnown: state.turnKnown, openTurn: state.turnKnown ? state.openTurn : null };
      } finally { await file.close(); }
    } catch (error) { if (!missing(error)) throw error; if (cursor.fileId || this.pinnedFile) throw Error("Pinned pane baseline disappeared"); return pending(); }
    finally { this.busy = false; }
  }
  /** Runner-only, before spawn. Never infer history from a post-resume baseline or a pane footer. */
  async quotaReplayHistory(current: () => boolean): Promise<{ messages: readonly string[]; current(): boolean } | null> {
    if (this.provider !== "codex" || this.busy || this.stopped) return null;
    this.busy = true;
    try {
      let found = await this.locate(current);
      // Discovery normally advances across monitor polls. Before launch it gets only this bounded, leased window.
      for (let look = 1; found.pending && current() && look < 128; look++) found = await this.locate(current);
      const path = found.path;
      if (!path || !current()) return null;
      await realDirectory(dirname(path)); const before = await lstat(path); regular(before);
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat(); regular(stat);
        if (!sameFile(before, stat)) return null;
        const frozen = fstatSync(file.fd, { bigint: true }), at = Date.now();
        const header = ownedHeader(await bytes(file, 0, Math.min(stat.size, META)), this.provider, this.sessionId, this.cwd);
        const first = record(decode(header).split(/\r?\n/)[0]!);
        if (first.payload?.source !== "cli") return null;
        const start = Math.max(0, stat.size - 256 * 1024), tail = await bytes(file, start, stat.size - start);
        if (!tail.length || tail.at(-1) !== 10 || start && tail.indexOf(10) < 0) return null;
        const lines = decode(tail.subarray(start ? tail.indexOf(10) + 1 : 0)).split(/\r?\n/); lines.pop();
        const messages = codexQuotaErrorMessages(lines, at);
        if (!messages?.length || messages.length > 32 || Buffer.byteLength(JSON.stringify(messages)) > 16 * 1024) return null;
        const signature = (value: BigIntStats) => `${value.dev}:${value.ino}:${value.uid}:${value.birthtimeNs}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
        const initial = signature(frozen);
        const unchanged = (): boolean => {
          try { const named = lstatSync(path, { bigint: true }); return named.isFile() && !named.isSymbolicLink() && signature(named) === initial; }
          catch { return false; }
        };
        return current() && unchanged() ? { messages, current: unchanged } : null;
      } finally { await file.close(); }
    } catch { return null; }
    finally { this.busy = false; }
  }
  async close(): Promise<void> { this.stopped = true; await this.discovery?.return(undefined); this.discovery = undefined; }
  private async *candidates(): AsyncGenerator<string | null> {
    const root = this.roots[this.provider === "codex" ? "codex" : "claude"];
    if (this.provider === "claude-code") {
      this.canonicalCwd ??= await realpath(this.cwd);
      if (comparable(this.canonicalCwd) !== comparable(this.cwd)) throw Error("Pane transcript workspace is not canonical");
      const folder = join(root, "projects", nativeClaudeProjectKey(this.canonicalCwd));
      try { await realDirectory(folder); yield join(folder, `${this.sessionId}.jsonl`); return; }
      catch (error) { if (missing(error)) return; throw error; }
    }
    let entries = 0, directories = 0;
    const sessionId = this.sessionId;
    const walk = async function *(folder: string, depth: number): AsyncGenerator<string | null> {
      if (++directories > 1024) throw Error("Pane transcript discovery exceeded its bound");
      let dir;
      try { await realDirectory(folder); dir = await opendir(folder); } catch (error) { if (missing(error)) return; throw error; }
      for await (const entry of dir) {
        if (++entries > 16_384) throw Error("Pane transcript discovery exceeded its bound");
        if (entry.name.endsWith(`-${sessionId}.jsonl`)) {
          if (!entry.isFile() || entry.isSymbolicLink()) throw Error("Pinned pane transcript is not a regular file");
          yield join(folder, entry.name);
        } else if (depth < 3 && /^\d{2,4}$/.test(entry.name)) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error("Pane transcript date directory is unsafe");
          yield null; yield* walk(join(folder, entry.name), depth + 1);
        } else yield null;
      }
    };
    yield* walk(join(root, "sessions"), 0); yield* walk(join(root, "archived_sessions"), 0);
  }
  private async locate(current: () => boolean): Promise<{ path?: string; pending: boolean }> {
    if (!this.discovery) { this.discovery = this.candidates(); this.discoveryMatches = []; }
    const started = performance.now();
    try {
      for (let step = 0; step < 128; step++) {
        if (!current() || this.stopped) throw Error("Pane transcript lease expired");
        const next = await this.discovery.next();
        if (next.done) {
          this.discovery = undefined;
          if (this.discoveryMatches.length > 1) throw Error("Pinned pane transcript has ambiguous matching files");
          return { path: this.discoveryMatches[0], pending: false };
        }
        if (next.value) this.discoveryMatches.push(next.value);
        if (performance.now() - started >= 250) break;
      }
      // Keep a bounded iterator across looks: a cold disk/AV scan must not restart discovery forever.
      return { pending: true };
    } catch (error) { await this.discovery?.return(undefined); this.discovery = undefined; throw error; }
  }
  private async readOwned(cursor: PaneTranscriptCursor, current: () => boolean): Promise<PaneTranscriptBatch> {
    const check = (): void => { if (!current() || this.stopped) throw Error("Pane transcript lease expired"); };
    check();
    const found = this.pinnedFile ? { path: this.pinnedFile, pending: false } : await this.locate(current), path = found.path; check();
    if (!path) {
      if (cursor.fileId && !found.pending) throw Error("Pinned pane transcript disappeared");
      return { state: "pending", cursor, lines: [], data: "", complete: false, gap: false };
    }
    let file: FileHandle;
    try {
      await realDirectory(dirname(path));
      const before = await lstat(path); regular(before);
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat(); regular(stat);
        if (!sameFile(before, stat) || comparable(await realpath(path)) !== comparable(path)) throw Error("Pane transcript changed while opening");
        const head = await bytes(file, 0, Math.min(stat.size, this.metadataBytes || META));
        const header = ownedHeader(head, this.provider, this.sessionId, this.cwd);
        // File identity excludes append-sensitive mtime/size; its first record is immutable session metadata.
        const firstEnd = header.indexOf(10) + 1;
        const fileId = hash(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${hash(header.subarray(0, firstEnd))}`);
        if (cursor.fileId !== null && cursor.fileId !== fileId || stat.size < cursor.offset) throw Error("Pane transcript identity changed or was truncated");
        const anchor = await bytes(file, Math.max(0, cursor.offset - ANCHOR), Math.min(cursor.offset, ANCHOR));
        if (hash(anchor) !== cursor.anchor) throw Error("Pane transcript checkpoint bytes changed");
        const chunk = await bytes(file, cursor.offset, Math.min(CHUNK, stat.size - cursor.offset));
        let start = 0, consumed = 0, skipping = cursor.skipping === true, gap = skipping;
        if (skipping) {
          const next = chunk.indexOf(10);
          if (next < 0) start = consumed = chunk.length;
          else { start = consumed = next + 1; skipping = false; }
        }
        const last = chunk.lastIndexOf(10);
        const completeBytes = last < start ? Buffer.alloc(0) : chunk.subarray(start, last + 1);
        consumed = Math.max(consumed, start + completeBytes.length);
        if (!skipping && !consumed && chunk.length === CHUNK) { consumed = chunk.length; skipping = true; gap = true; }
        const lines = decode(completeBytes).split(/\r?\n/).filter(Boolean);
        // Reject corrupted JSON instead of dropping a possible user or turn-boundary record.
        for (const line of lines) {
          const entry = record(line);
          if (this.provider === "claude-code" && (entry.sessionId !== undefined && entry.sessionId !== this.sessionId
            || entry.cwd !== undefined && comparable(String(entry.cwd)) !== comparable(this.cwd) || entry.isSidechain === true)) throw Error("Pane transcript record belongs to another conversation");
          if (this.provider === "codex" && entry.type === "session_meta") metadata([line], this.provider, this.sessionId, this.cwd);
        }
        const offset = cursor.offset + consumed;
        const nextAnchor = await bytes(file, Math.max(0, offset - ANCHOR), Math.min(offset, ANCHOR));
        if (hash(await bytes(file, cursor.offset, consumed)) !== hash(chunk.subarray(0, consumed))
          || hash(await bytes(file, Math.max(0, cursor.offset - ANCHOR), Math.min(cursor.offset, ANCHOR))) !== cursor.anchor) throw Error("Pane transcript checkpoint bytes changed during its read");
        const after = await file.stat(), named = await lstat(path); regular(named);
        if (!sameFile(stat, after) || !sameFile(stat, named) || after.size < stat.size
          || after.size !== named.size || after.mtimeMs !== named.mtimeMs || after.ctimeMs !== named.ctimeMs
          || after.size === stat.size && (after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)) throw Error("Pane transcript changed during its read");
        check(); this.pinnedFile = path; this.metadataBytes = header.length;
        return { state: "ready", cursor: { sessionId: this.sessionId, fileId, offset, anchor: hash(nextAnchor), ...(skipping ? { skipping: true } : {}) }, lines,
          data: completeBytes.toString("base64"), gap, complete: !skipping && offset === stat.size && after.size === stat.size };
      } finally { await file.close(); }
    } catch (error) {
      if (!missing(error)) throw error;
      if (cursor.fileId || this.pinnedFile) throw Error("Pinned pane transcript disappeared");
      return { state: "pending", cursor, lines: [], data: "", gap: false, complete: false };
    }
  }
}
