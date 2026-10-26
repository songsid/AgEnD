/** #2598: preserve a frozen classic copy outside Kiro's merged session index.
 * Only an owned, complete carried V2 copy permits this. Never called while its CLI is alive.
 * Production launch preparation runs this work on the existing bounded V2 worker lane.
 */
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { kiroAgentName, kiroFleetTag } from "./kiro-agent.js";
import { kiroCanonicalDirectory, kiroDirectoryKeys, kiroOwnedConversation, kiroCarryCandidate, reinstateKiroCarryPin } from "./kiro-identity.js";
import { readKiroTuiAssistantTexts, snapshotKiroTuiFile } from "../kiro-tui-forensic.js";

export interface KiroClassicArchiveInput {
  agendHome: string;
  instance: string;
  workingDirectory: string;
  credentialProfile: string | null;
  sessionId: string;
  sessionsDir: string;
  dbPath: string;
}
interface ArchivedRow { key: string; id: string; valueBase64: string; createdAt: number; updatedAt: number }
interface Payload { version: 1; instance: string; directory: string; profile: string | null; sessionId: string; dbPath: string; rows: ArchivedRow[] }
interface Archive { payload: Payload; sha256: string }
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const MAX_ROW_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 96 * 1024 * 1024;
const safeId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

/** Full process listing is bounded; only the matching agent/id is inspected, no command lines are logged. */
export function assertKiroConversationStopped(input: KiroClassicArchiveInput, listing?: string, ownerOf?: (pid: number) => string | null): void {
  const agent = kiroAgentName(input.instance, kiroFleetTag(input.agendHome));
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const target = new RegExp(`(?:^|\\s)--(?:agent(?:=|\\s+)['"]?${escape(agent)}|resume-id(?:=|\\s+)['"]?${escape(input.sessionId)})['"]?(?=\\s|$)`);
  const processes = listing ?? execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
  if (!processes.trim()) throw new Error("Cannot prove the Kiro process is stopped: process listing is empty");
  let parsed = 0;
  for (const line of processes.split("\n")) {
    const row = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (row) parsed++;
    if (row && target.test(row[2]!)) throw new Error("The instance's Kiro process is still alive; stop it before repairing its stores");
    if (row && !/--(?:agent|resume-id)(?:=|\s)/.test(row[2]!) && /(?:kiro-cli(?:-chat)?(?:\s|$)|[/\\]tui\.js(?:\s|$))/.test(row[2]!)) {
      const owner = ownerOf ? ownerOf(Number(row[1])) : listing !== undefined ? null : kiroProcessOwner(Number(row[1]), input.workingDirectory);
      if (owner === input.instance || owner === null) throw new Error("A Kiro process may still own this instance's conversation; stopped state is not proven");
    }
  }
  if (!parsed) throw new Error("Cannot prove the Kiro process is stopped: process listing is invalid");
}
/** Catch surviving TUI/agent children whose argv omits --agent; never log process environments. */
function kiroProcessOwner(pid: number, workingDirectory: string): string | null {
  try {
    if (process.platform === "linux") {
      const root = `/proc/${pid}`;
      const state = readFileSync(join(root, "stat"), "utf8");
      if (/^[ZX] /.test(state.slice(state.lastIndexOf(")") + 2))) return "gone";
      const env = readFileSync(join(root, "environ"));
      if (env.length > 4 * 1024 * 1024) throw new Error("Kiro process environment is unobservable");
      const marker = Buffer.from("AGEND_INSTANCE_NAME=");
      const at = env.indexOf(marker);
      if (at >= 0 && (at === 0 || env[at - 1] === 0)) {
        const end = env.indexOf(0, at); return env.subarray(at + marker.length, end < 0 ? env.length : end).toString("utf8") || null;
      }
      return kiroCanonicalDirectory(readlinkSync(join(root, "cwd"))) === kiroCanonicalDirectory(workingDirectory) ? null : "other-workspace";
    }
    const env = execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
    return /(?:^|\s)AGEND_INSTANCE_NAME=([^\s]+)/.exec(env)?.[1] ?? null;
  } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return "gone"; throw err; }
}

function ownedFile(path: string): void {
  const st = lstatSync(path);
  if (!st.isFile() || (process.getuid && st.uid !== process.getuid())) throw new Error("Store or archive is not an owned real file");
}
function privateDirectory(path: string): void {
  const existed = existsSync(path);
  if (!existed) mkdirSync(path, { mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077)) throw new Error("Archive directory is not private and owned");
  {
    // Repeat on retry too: a previous failed sync may have left a visible but non-durable directory.
    // Persist the directory itself AND its name in the parent before SQLite can remove the source.
    for (const dir of [path, resolve(path, "..")]) {
      const fd = openSync(dir, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
}
function readArchive(path: string): Archive {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_ARCHIVE_BYTES || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) throw new Error("Archive is not a bounded private owned file");
    const value = JSON.parse(readFileSync(fd, "utf8")) as Archive;
    if (!value?.payload || value.payload.version !== 1 || value.sha256 !== hash(JSON.stringify(value.payload))) throw new Error("Archive checksum or version is invalid");
    return value;
  } finally { closeSync(fd); }
}
function writeArchive(input: KiroClassicArchiveInput, rows: ArchivedRow[]): string {
  const payload: Payload = { version: 1, instance: input.instance, directory: kiroCanonicalDirectory(input.workingDirectory), profile: input.credentialProfile,
    sessionId: input.sessionId, dbPath: resolve(input.dbPath), rows };
  const archive: Archive = { payload, sha256: hash(JSON.stringify(payload)) };
  const base = join(input.agendHome, "kiro-classic-archives"); privateDirectory(base);
  const root = join(base, hash(input.instance).slice(0, 32)); privateDirectory(root);
  const path = join(root, `${input.sessionId}-${archive.sha256}.json`), temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeFileSync(fd, JSON.stringify(archive) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temp, path); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  finally { unlinkSync(temp); }
  const dir = openSync(root, constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); }
  if (JSON.stringify(readArchive(path)) !== JSON.stringify(archive)) throw new Error("Archive read-back does not match the frozen rows");
  return path;
}
function identity(input: KiroClassicArchiveInput, engine: "v1" | "v2") {
  return { agendHome: input.agendHome, instance: input.instance, engine, workingDirectory: input.workingDirectory, credentialProfile: input.credentialProfile };
}
function proveOwnedCarry(input: KiroClassicArchiveInput, allowAbandoned = false): void {
  const current = () => {
    const candidate = kiroCarryCandidate(input);
    return !!candidate && candidate.id === input.sessionId && (allowAbandoned || !candidate.repair);
  };
  if (!current()) throw new Error("Both classic and V2 must still be owned by this instance");
  const metadata = snapshotKiroTuiFile(join(input.sessionsDir, `${input.sessionId}.json`), 8 * 1024 * 1024);
  const meta = JSON.parse(metadata.text), state = meta.session_state;
  if (meta.exported_from_v1 !== true || typeof meta.cwd !== "string" || kiroCanonicalDirectory(meta.cwd) !== kiroCanonicalDirectory(input.workingDirectory)
    || !state || state.version !== "v1" || !state.conversation_metadata || state.rts_model_state?.conversation_id !== input.sessionId) throw new Error("No complete matching carried V2 copy is proven");
  const read = readKiroTuiAssistantTexts({ sessionId: input.sessionId, sessionsDir: input.sessionsDir, stillOwned: current });
  if (read.kind !== "ok" || !metadata.unchanged()) throw new Error("The carried V2 transcript is incomplete, changed or unreadable");
  proveClassicHistoryCoverage(input);
}
/** Kiro 2.34 preserves each classic assistant message_id and converts every history pair into two JSONL records.
 * Match the entire frozen prefix (user text, assistant text/tool inputs and tool outputs), not just readable syntax.
 * Unknown classic formats fail closed; original non-message metadata remains in the exact restorable archive.
 */
export function proveClassicHistoryCoverage(input: KiroClassicArchiveInput): void {
  ownedFile(input.dbPath);
  const db = new Database(input.dbPath, { readonly: true, fileMustExist: true, timeout: 200 });
  let values: Buffer[];
  try {
    const keys = kiroDirectoryKeys(input.workingDirectory), where = `key IN (${keys.map(() => "?").join(",")}) AND conversation_id=?`;
    const sizes = db.prepare(`SELECT length(CAST(value AS BLOB)) AS n FROM conversations_v2 WHERE ${where}`).all(...keys, input.sessionId) as { n: number }[];
    if (sizes.reduce((n, r) => n + r.n, 0) > MAX_ROW_BYTES) throw new Error("Classic history exceeds the coverage limit");
    values = (db.prepare(`SELECT CAST(value AS BLOB) AS value FROM conversations_v2 WHERE ${where}`).all(...keys, input.sessionId) as { value: Buffer }[]).map(r => r.value);
  } finally { db.close(); }
  if (!values.length) {
    const root = join(input.agendHome, "kiro-classic-archives", hash(input.instance).slice(0, 32));
    for (const name of readdirSync(root)) {
      if (!name.startsWith(input.sessionId + "-") || !name.endsWith(".json")) continue;
      const archive = readArchive(join(root, name)).payload;
      if (archive.instance === input.instance && archive.sessionId === input.sessionId && archive.directory === kiroCanonicalDirectory(input.workingDirectory)
        && archive.profile === input.credentialProfile && archive.dbPath === resolve(input.dbPath)) values.push(...archive.rows.map(r => Buffer.from(r.valueBase64, "base64")));
    }
    if (!values.length) throw new Error("No frozen source or verified archive proves complete history coverage");
  }
  const log = snapshotKiroTuiFile(join(input.sessionsDir, input.sessionId + ".jsonl"), 64 * 1024 * 1024);
  const records = log.text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
  const fail = () => { throw new Error("The carried V2 copy does not cover the complete frozen classic history"); };
  for (const bytes of values) {
    const classic = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (classic.conversation_id !== input.sessionId || !Array.isArray(classic.history) || !classic.history.length || classic.next_message != null) fail();
    for (let i = 0; i < classic.history.length; i++) {
      const turn = classic.history[i], user = turn?.user?.content, assistant = turn?.assistant;
      const u = records[i * 2], a = records[i * 2 + 1];
      const response = assistant?.Response, tool = assistant?.ToolUse, body = response ?? tool;
      if (!body || response && tool || !body.message_id || a?.kind !== "AssistantMessage" || a.data?.message_id !== body.message_id || !Array.isArray(a.data.content)) fail();
      const expected: unknown[] = [];
      if (typeof body.content !== "string") fail();
      if (body.content || response) expected.push({ kind: "text", data: body.content });
      if (tool) {
        if (!Array.isArray(tool.tool_uses)) fail();
        for (const call of tool.tool_uses) {
          if (!call || typeof call.id !== "string" || typeof call.name !== "string" || !call.args || typeof call.args !== "object") fail();
          expected.push({ kind: "toolUse", data: { toolUseId: call.id, name: call.name, input: call.args } });
        }
      }
      // Tool blocks may carry extra upstream metadata; compare the message-bearing fields exactly.
      const actual = a.data.content.map((b: any) => b.kind === "toolUse" ? { kind: b.kind, data: { toolUseId: b.data?.toolUseId, name: b.data?.name, input: b.data?.input } } : b);
      if (!isDeepStrictEqual(actual, expected) || !u?.data || (turn.user.images != null && (!Array.isArray(turn.user.images) || turn.user.images.length))) fail();
      if (user?.Prompt && typeof user.Prompt.prompt === "string") {
        if (u.kind !== "Prompt" || !isDeepStrictEqual(u.data.content, [{ kind: "text", data: user.Prompt.prompt }])) fail();
      } else if (Array.isArray((user?.ToolUseResults ?? user?.CancelledToolUses)?.tool_use_results)) {
        if (u.kind !== "ToolResults" || !u.data.results || typeof u.data.results !== "object") fail();
        const cancelled = user?.CancelledToolUses;
        const results = (user.ToolUseResults ?? cancelled).tool_use_results;
        if (cancelled && (typeof cancelled.prompt !== "string" || !Array.isArray(u.data.content)
          || !u.data.content.some((b: any) => b.kind === "text" && b.data === cancelled.prompt))) fail();
        if (Object.keys(u.data.results).length !== results.length) fail();
        for (const result of results) {
          let converted: unknown;
          if (cancelled) converted = "Cancelled";
          else if (result.status === "Success") converted = { Success: { items: result.content } };
          else if (result.status === "Error" && Array.isArray(result.content) && result.content.every((x: any) => typeof x.Text === "string")) converted = { Error: { Custom: result.content.map((x: any) => x.Text).join("\n") } };
          else fail();
          if (!isDeepStrictEqual(u.data.results[result.tool_use_id]?.result, converted)) fail();
        }
      } else fail();
    }
  }
  if (!log.unchanged()) fail();
}

/** An abandoned pin is recoverable only while every later unowned same-cwd alternative remains empty. Leave all of them untouched. */
function proveNoReplacementWork(input: KiroClassicArchiveInput): void {
  const original = JSON.parse(snapshotKiroTuiFile(join(input.sessionsDir, `${input.sessionId}.json`), 8 * 1024 * 1024).text);
  const created = Date.parse(original.created_at);
  if (!Number.isFinite(created)) throw new Error("Carried creation time is unavailable");
  for (const name of readdirSync(input.sessionsDir)) {
    if (!name.endsWith(".json") || name === `${input.sessionId}.json`) continue;
    const file = snapshotKiroTuiFile(join(input.sessionsDir, name), 8 * 1024 * 1024), meta = JSON.parse(file.text);
    if (typeof meta.cwd !== "string" || kiroCanonicalDirectory(meta.cwd) !== kiroCanonicalDirectory(input.workingDirectory)) continue;
    if (Date.parse(meta.created_at) < created) continue;
    if (!safeId.test(meta.session_id) || name !== `${meta.session_id}.json`) throw new Error("Replacement session metadata is ambiguous");
    const claim = join(input.agendHome, "kiro-identity", "claims", "v2", meta.session_id);
    if (existsSync(claim)) {
      const owner = readFileSync(claim, "utf8");
      if (/^[^\n\r\0]{1,512}\n$/.test(owner) && owner !== input.instance + "\n") continue;
      throw new Error("A replacement session is already owned; automatic repair held");
    }
    const log = snapshotKiroTuiFile(join(input.sessionsDir, `${meta.session_id}.jsonl`), 1);
    if (log.text.length !== 0 || !file.unchanged() || !log.unchanged()) throw new Error("An unowned replacement session has work or changed; automatic repair held");
  }
}
/** This runs before discovery can adopt one of the empty sessions left by the old retry escape hatch. */
export function repairAbandonedKiroCarry(input: KiroClassicArchiveInput, stopped = () => assertKiroConversationStopped(input)): boolean {
  const candidate = kiroCarryCandidate(input);
  if (!candidate || candidate.id !== input.sessionId || !candidate.repair) return false;
  stopped(); proveOwnedCarry(input, true); proveNoReplacementWork(input); stopped();
  reinstateKiroCarryPin(input, input.sessionId); return true;
}

function validateInput(input: KiroClassicArchiveInput): void {
  if (!safeId.test(input.sessionId) || !/^[^\n\r\0]{1,512}$/.test(input.instance)) throw new Error("Unsafe conversation id");
}
/** Archive all literal/canonical aliases of this exact conversation in this directory, never other conversations. */
export function archiveKiroClassicCopy(input: KiroClassicArchiveInput, hooks: { stopped?: () => void; checkpoint?: () => void; timeoutMs?: number } = {}): string | null {
  validateInput(input);
  if (!existsSync(input.dbPath)) return null;
  ownedFile(input.dbPath);
  const keys = kiroDirectoryKeys(input.workingDirectory), placeholders = keys.map(() => "?").join(",");
  const db = new Database(input.dbPath, { fileMustExist: true, timeout: hooks.timeoutMs ?? 2000 });
  const stopped = hooks.stopped ?? (() => assertKiroConversationStopped(input));
  try {
    const sizes = () => db.prepare(`SELECT length(CAST(value AS BLOB)) AS bytes FROM conversations_v2 WHERE key IN (${placeholders}) AND conversation_id=?`).all(...keys, input.sessionId) as Array<{ bytes: number }>;
    if (!sizes().length) return null;
    stopped(); proveOwnedCarry(input); hooks.checkpoint?.();
    db.exec("BEGIN IMMEDIATE");
    try {
      const lengths = sizes();
      if (!lengths.length) { db.exec("COMMIT"); return null; }
      if (lengths.reduce((n, r) => n + r.bytes, 0) > MAX_ROW_BYTES) throw new Error("Frozen classic rows exceed the archive limit");
      const rows = db.prepare(`SELECT key, conversation_id AS id, CAST(value AS BLOB) AS value, created_at AS createdAt, updated_at AS updatedAt FROM conversations_v2 WHERE key IN (${placeholders}) AND conversation_id=? ORDER BY key`).all(...keys, input.sessionId) as Array<{ key: string; id: string; value: Buffer; createdAt: number; updatedAt: number }>;
      const path = writeArchive(input, rows.map(r => ({ key: r.key, id: r.id, valueBase64: r.value.toString("base64"), createdAt: r.createdAt, updatedAt: r.updatedAt })));
      hooks.checkpoint?.(); stopped(); proveOwnedCarry(input);
      const del = db.prepare("DELETE FROM conversations_v2 WHERE key=? AND conversation_id=? AND CAST(value AS BLOB)=? AND created_at=? AND updated_at=?");
      for (const row of rows) if (del.run(row.key, row.id, row.value, row.createdAt, row.updatedAt).changes !== 1) throw new Error("Frozen classic row changed; nothing removed");
      hooks.checkpoint?.(); db.exec("COMMIT"); return path;
    } catch (err) { if (db.inTransaction) db.exec("ROLLBACK"); throw err; }
  } finally { db.close(); }
}

export interface KiroCarryPreparation { sessionId: string | null; archivePath: string | null; repaired: boolean }
/** One automatic launch repair. Explicit fresh starts do not call this. */
export function prepareKiroCarryForLaunch(input: Omit<KiroClassicArchiveInput, "sessionId">, checkpoint?: () => void): KiroCarryPreparation {
  const candidate = kiroCarryCandidate(input);
  if (!candidate) return { sessionId: null, archivePath: null, repaired: false };
  const full = { ...input, sessionId: candidate.id };
  let repaired = false;
  if (candidate.repair) {
    if (!existsSync(input.dbPath)) throw new Error("No frozen classic copy proves this abandoned migration; repair held");
    ownedFile(input.dbPath);
    const db = new Database(input.dbPath, { readonly: true, fileMustExist: true });
    let present: boolean;
    try {
      const keys = kiroDirectoryKeys(input.workingDirectory);
      present = !!db.prepare(`SELECT 1 FROM conversations_v2 WHERE key IN (${keys.map(() => "?").join(",")}) AND conversation_id=? LIMIT 1`).get(...keys, candidate.id);
    } finally { db.close(); }
    if (!present) {
      const root = join(input.agendHome, "kiro-classic-archives", hash(input.instance).slice(0, 32));
      const completed = existsSync(root) && readdirSync(root).some(name => {
        if (!name.startsWith(candidate.id + "-") || !name.endsWith(".json")) return false;
        const archive = readArchive(join(root, name)).payload;
        return archive.instance === input.instance && archive.sessionId === candidate.id && archive.dbPath === resolve(input.dbPath);
      });
      if (!completed) throw new Error("No frozen classic row or verified archive proves this abandoned migration; repair held");
      return { sessionId: null, archivePath: null, repaired: false }; // deliberate fresh after an already archived migration
    }
    checkpoint?.(); repaired = repairAbandonedKiroCarry(full);
  }
  checkpoint?.(); proveOwnedCarry(full);
  const archivePath = archiveKiroClassicCopy(full, { checkpoint });
  return { sessionId: candidate.id, archivePath, repaired };
}

/** Operator recovery only: verify the archive and insert missing exact rows. Never overwrite newer/different data. */
export function restoreKiroClassicArchive(input: KiroClassicArchiveInput, path: string, stopped = () => assertKiroConversationStopped(input)): void {
  validateInput(input); const { payload } = readArchive(path);
  if (payload.instance !== input.instance || payload.sessionId !== input.sessionId || payload.directory !== kiroCanonicalDirectory(input.workingDirectory)
    || payload.profile !== input.credentialProfile || payload.dbPath !== resolve(input.dbPath) || !Array.isArray(payload.rows) || !payload.rows.length) throw new Error("Archive does not match this instance/store");
  const keys = new Set(kiroDirectoryKeys(input.workingDirectory));
  for (const row of payload.rows) if (!keys.has(row.key) || row.id !== input.sessionId || typeof row.valueBase64 !== "string"
    || Buffer.from(row.valueBase64, "base64").toString("base64") !== row.valueBase64 || !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.updatedAt)) throw new Error("Archive row is invalid");
  stopped(); ownedFile(input.dbPath);
  const db = new Database(input.dbPath, { fileMustExist: true, timeout: 2000 });
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      stopped();
      for (const row of payload.rows) {
        const old = db.prepare("SELECT CAST(value AS BLOB) AS value, created_at AS createdAt, updated_at AS updatedAt FROM conversations_v2 WHERE key=? AND conversation_id=?").get(row.key, row.id) as { value: Buffer; createdAt: number; updatedAt: number } | undefined;
        const bytes = Buffer.from(row.valueBase64, "base64");
        if (old) { if (!old.value.equals(bytes) || old.createdAt !== row.createdAt || old.updatedAt !== row.updatedAt) throw new Error("A different classic row already exists; restore refused"); }
        else db.prepare("INSERT INTO conversations_v2 (key,conversation_id,value,created_at,updated_at) VALUES (?,?,CAST(? AS TEXT),?,?)").run(row.key, row.id, bytes, row.createdAt, row.updatedAt);
      }
      db.exec("COMMIT");
    } catch (err) { if (db.inTransaction) db.exec("ROLLBACK"); throw err; }
  } finally { db.close(); }
}

/** Metadata only, for the operator CLI to resolve the current configured store before restoration. */
export function kiroClassicArchiveMetadata(path: string): Pick<Payload, "instance" | "sessionId" | "directory" | "profile" | "dbPath"> {
  const p = readArchive(path).payload;
  return { instance: p.instance, sessionId: p.sessionId, directory: p.directory, profile: p.profile, dbPath: p.dbPath };
}
