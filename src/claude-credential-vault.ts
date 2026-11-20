/** Managed Claude credentials. Ciphertext and audit commit together; keys never share the DB/backup. */
import Database from "better-sqlite3";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { isCredentialProfileName } from "./backend/credential-profile.js";

export type ClaudeCredentialKind = "api-key" | "setup-token";
export interface ClaudeCredentialMetadata {
  id: string; profile: string | null; revision: number; kind: ClaudeCredentialKind | null;
  source: "managed" | "subscription";
  state: "saved-unverified" | "verified" | "needs-replacement" | "unknown" | "not-connected"; verifiedAt: string | null; updatedAt: string | null;
}
export type CredentialActor = { adapterId: string; userId: string };
export class ClaudeCredentialError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "unavailable" | "in-use" | "profile-unknown" | "session-changed") { super(code); }
}
interface Row { id: string; profile: string; revision: number; kind: ClaudeCredentialKind | null; payload: Buffer | null; updated_at: string; source: "managed" | "subscription"; }
function fail(): never { throw new ClaudeCredentialError("unavailable"); }
function privatePath(path: string, directory: boolean): void {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || (!directory && s.nlink !== 1)
    || (process.getuid && s.uid !== process.getuid()) || (process.platform !== "win32" && (s.mode & 0o077) !== 0)) fail();
}
function privateDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  privatePath(path, true);
}
/** The Linux/WSL fallback: separate owner-only random key file, never the old plaintext SecretStore. */
export function claudeVaultFileKey(home: string): Buffer {
  const dir = join(home, "credential-keys"); privateDirectory(dir);
  const path = join(dir, "claude.key"); let fd: number | undefined;
  try {
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const key = randomBytes(32); try { writeFileSync(fd, key); fsyncSync(fd); } finally { key.fill(0); closeSync(fd); fd = undefined; }
      const parent = openSync(dir, "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    privatePath(path, false);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const s = fstatSync(fd); if (s.size !== 32) fail();
    const key = readFileSync(fd); if (key.length !== 32) { key.fill(0); fail(); } return key;
  } catch { return fail(); } finally { if (fd !== undefined) closeSync(fd); }
}
export class ClaudeCredentialVault {
  private readonly db: Database.Database;
  private readonly key!: Buffer;
  private readonly dir: string;
  private readonly path: string;
  private readonly inode: { ino: number; dev: number };
  constructor(home: string, private readonly options: { key?: () => Buffer; now?: () => number } = {}) {
    // Home is the already-owned AgEnD state directory. Never follow a linked vault or key directory.
    this.dir = join(home, "credential-vault"); this.path = join(this.dir, "claude.sqlite");
    let db: Database.Database | undefined, key: Buffer | undefined;
    try {
      if (lstatSync(home).isSymbolicLink() || !lstatSync(home).isDirectory()) fail();
      const present=(path:string)=>{try{lstatSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}};
      const hadDirectory=present(this.dir),hadKeys=present(join(home,"credential-keys"));
      privateDirectory(this.dir);
      const existed = (() => { try { lstatSync(this.path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } })();
      // A read/audit must not recreate an empty database and erase the evidence of a lost managed selection.
      if(!existed&&(hadDirectory||hadKeys))fail();
      // A lost key must never silently create a new key for an existing vault.
      if (existed && !options.key) privatePath(join(home, "credential-keys", "claude.key"), false);
      key = options.key?.() ?? claudeVaultFileKey(home); if (key.length !== 32) fail(); this.key = Buffer.from(key);
      if (!existed) { const fd = openSync(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); closeSync(fd); }
      privatePath(this.path, false); this.inode = lstatSync(this.path);
      db = new Database(this.path); this.db = db;
      this.assertPath();
      db.pragma("journal_mode = DELETE"); db.pragma("synchronous = FULL"); db.pragma("busy_timeout = 1000"); db.pragma("secure_delete = ON");
      db.exec(`CREATE TABLE IF NOT EXISTS vault_meta (id INTEGER PRIMARY KEY CHECK(id=1), proof BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS credentials (profile TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, kind TEXT, payload BLOB, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS credential_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, credential_id TEXT, action TEXT NOT NULL, revision INTEGER, kind TEXT, outcome TEXT NOT NULL);`);
      // Additive migration: old removals remain managed tombstones, never implicit subscription choices.
      if (!(db.pragma("table_info(credentials)") as Array<{name:string}>).some(c=>c.name==="source"))
        db.exec("ALTER TABLE credentials ADD COLUMN source TEXT NOT NULL DEFAULT 'managed' CHECK(source IN ('managed','subscription'))");
      db.exec("CREATE TABLE IF NOT EXISTS credential_request_status(profile TEXT PRIMARY KEY, credential_id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('verified','needs-replacement','unknown')), verified_at TEXT, observed_at INTEGER NOT NULL)");
      const proof = db.prepare("SELECT proof FROM vault_meta WHERE id=1").get() as { proof: Buffer } | undefined;
      if (proof) { const value = this.open(proof.proof, "agend-claude-vault-key-v1"); try { if (value.toString() !== "managed-credential-vault") fail(); } finally { value.fill(0); } }
      else {
        if (existed) fail();
        db.prepare("INSERT INTO vault_meta VALUES(1,?)").run(this.seal(Buffer.from("managed-credential-vault"), "agend-claude-vault-key-v1"));
      }
    } catch { db?.close(); this.key?.fill(0); throw new ClaudeCredentialError("unavailable"); }
    finally { key?.fill(0); }
  }
  close(): void { this.db.close(); this.key.fill(0); }
  private assertPath(): void {
    privatePath(this.dir, true); privatePath(this.path, false); const s = lstatSync(this.path);
    if (s.ino !== this.inode.ino || s.dev !== this.inode.dev) fail();
  }
  private profile(profile: string | null): string {
    if (profile !== null && !isCredentialProfileName(profile)) throw new ClaudeCredentialError("invalid"); return profile ?? "";
  }
  private seal(value: Buffer, aad: string): Buffer {
    const nonce = randomBytes(12), c = createCipheriv("aes-256-gcm", this.key, nonce); c.setAAD(Buffer.from(aad));
    const body = Buffer.concat([c.update(value), c.final()]);
    return Buffer.concat([nonce, c.getAuthTag(), body]);
  }
  private open(value: Buffer, aad: string): Buffer {
    try {
      if (value.length < 28 || value.length > 16_512) fail();
      const c = createDecipheriv("aes-256-gcm", this.key, value.subarray(0, 12)); c.setAAD(Buffer.from(aad)); c.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([c.update(value.subarray(28)), c.final()]);
    } catch { return fail(); }
  }
  private aad(row: Pick<Row, "id" | "profile" | "revision" | "kind">): string { return JSON.stringify(["claude-code", row.id, row.profile, row.kind, row.revision]); }
  private row(profile: string | null): Row | undefined { this.assertPath(); return this.db.prepare("SELECT * FROM credentials WHERE profile=?").get(this.profile(profile)) as Row | undefined; }
  metadata(profile: string | null): ClaudeCredentialMetadata | null {
    const r = this.row(profile);if(!r)return null;
    const status=r.kind&&r.source==="managed"?this.db.prepare("SELECT state,verified_at FROM credential_request_status WHERE profile=? AND credential_id=? AND revision=?").get(r.profile,r.id,r.revision) as {state:"verified"|"needs-replacement"|"unknown";verified_at:string|null}|undefined:undefined;
    return {id:r.id,profile,revision:r.revision,kind:r.kind,source:r.source,state:r.kind?status?.state??"saved-unverified":"not-connected",verifiedAt:status?.verified_at??null,updatedAt:r.updated_at};
  }
  /** Internal metadata port, only after owned native request/launch proof; never an agent or web mutation. */
  observeRequest(profile:string|null,id:string,revision:number,kind:ClaudeCredentialKind,record:{at:number;outcome:"success"|"auth-error"|"unknown"}):boolean {
    if(!Number.isSafeInteger(record.at)||record.at<0||!["success","auth-error","unknown"].includes(record.outcome))return false;
    return this.db.transaction(()=>{
      const row=this.row(profile);if(!row||row.source!=="managed"||!row.kind||row.id!==id||row.revision!==revision||row.kind!==kind)return false;
      const prior=this.db.prepare("SELECT state,verified_at,observed_at FROM credential_request_status WHERE profile=? AND credential_id=? AND revision=?").get(row.profile,id,revision) as {state:string;verified_at:string|null;observed_at:number}|undefined;
      if(prior&&record.at<=prior.observed_at)return false;
      const state=record.outcome==="success"?"verified":record.outcome==="auth-error"?"needs-replacement":"unknown";
      const verifiedAt=state==="verified"?(prior?.state==="verified"?prior.verified_at:new Date(record.at).toISOString()):null;
      this.db.prepare("INSERT INTO credential_request_status(profile,credential_id,revision,state,verified_at,observed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(profile) DO UPDATE SET credential_id=excluded.credential_id,revision=excluded.revision,state=excluded.state,verified_at=excluded.verified_at,observed_at=excluded.observed_at").run(row.profile,id,revision,state,verifiedAt,record.at);
      const changed=prior?.state!==state||prior?.verified_at!==verifiedAt;
      if(changed)this.audit({adapterId:"system",userId:"normal-request"},id,"request-status",revision,kind,state);
      return changed;
    }).immediate();
  }
  /** Internal launcher/helper port only. Never returned by a web/API metadata route. Caller must zero the Buffer. */
  credential(profile: string | null, id: string, revision: number): { kind: ClaudeCredentialKind; value: Buffer } {
    const r = this.row(profile); if (!r || !r.kind || !r.payload || r.id !== id || r.revision !== revision) throw new ClaudeCredentialError("conflict");
    return { kind: r.kind, value: this.open(r.payload, this.aad(r)) };
  }
  write(profile: string | null, expected: number, change: { kind: ClaudeCredentialKind; value: string } | "subscription" | null, actor: CredentialActor): ClaudeCredentialMetadata {
    if (!Number.isSafeInteger(expected) || expected < 0 || !actor.adapterId || !actor.userId) throw new ClaudeCredentialError("invalid");
    if (change && change!=="subscription" && (!(["api-key", "setup-token"] as string[]).includes(change.kind) || typeof change.value !== "string" || change.value.length < 16 || Buffer.byteLength(change.value) > 16_384 || /\s|[\x00-\x1f\x7f]/u.test(change.value))) throw new ClaudeCredentialError("invalid");
    const p = this.profile(profile); this.assertPath();
    return this.db.transaction(() => {
      const prior = this.row(profile); if ((prior?.revision ?? 0) !== expected) throw new ClaudeCredentialError("conflict");
      const r: Row = { profile: p, id: prior?.id ?? randomUUID(), revision: expected + 1, kind: change && change!=="subscription" ? change.kind : null, source: change==="subscription" ? "subscription" : "managed", payload: null, updated_at: new Date(this.options.now?.() ?? Date.now()).toISOString() };
      if (change && change!=="subscription") { const raw = Buffer.from(change.value); try { r.payload = this.seal(raw, this.aad(r)); } finally { raw.fill(0); } }
      this.db.prepare("INSERT INTO credentials(profile,id,revision,kind,payload,updated_at,source) VALUES(@profile,@id,@revision,@kind,@payload,@updated_at,@source) ON CONFLICT(profile) DO UPDATE SET revision=excluded.revision,kind=excluded.kind,payload=excluded.payload,updated_at=excluded.updated_at,source=excluded.source").run(r);
      this.db.prepare("DELETE FROM credential_request_status WHERE profile=?").run(p);
      this.audit(actor, r.id, change==="subscription" ? "select-subscription" : change ? prior?.kind ? "replace" : "set" : "remove", r.revision, r.kind, "ok");
      return this.metadata(profile)!;
    }).immediate();
  }
  audit(actor: CredentialActor | null, id: string | null, action: string, revision: number | null, kind: ClaudeCredentialKind | null, outcome: string): void {
    this.assertPath();
    this.db.prepare("INSERT INTO credential_audit(at,actor,credential_id,action,revision,kind,outcome) VALUES(?,?,?,?,?,?,?)")
      .run(new Date(this.options.now?.() ?? Date.now()).toISOString(), actor ? JSON.stringify(actor) : "unverified", id, action, revision, kind, outcome);
    this.db.prepare("DELETE FROM credential_audit WHERE sequence <= (SELECT COALESCE(MAX(sequence),0)-1000 FROM credential_audit)").run();
  }
  history(): unknown[] { this.assertPath(); return this.db.prepare("SELECT * FROM credential_audit ORDER BY sequence DESC LIMIT 100").all(); }
}
