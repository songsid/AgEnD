/** #2598: read-only store proof, on the existing bounded Kiro worker lane. */
import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { kiroCanonicalDirectory, kiroDirectoryKeys, kiroOwnedConversation } from "./kiro-identity.js";
import { snapshotKiroTuiFile } from "../kiro-tui-forensic.js";
import { scanKiroInstanceForForgedEnvelopes } from "../forged-envelope-scan.js";
import { kiroClassicArchiveMetadata, type KiroClassicArchiveInput } from "./kiro-classic-archive.js";

export interface KiroMigrationVerificationInput extends KiroClassicArchiveInput {
  archived: boolean;
  model: string;
  outboxDbPath: string;
  knownInstances: string[];
}
export function verifyKiroMigrationStore(input: KiroMigrationVerificationInput): { forensic: string } {
  const current = () => kiroOwnedConversation({ ...input, engine: "v2" }) === input.sessionId;
  if (!current()) throw new Error("Carried V2 ownership is not current");
  const snapshot = snapshotKiroTuiFile(join(input.sessionsDir, input.sessionId + ".json"), 8 * 1024 * 1024);
  const meta = JSON.parse(snapshot.text);
  if (meta.exported_from_v1 !== true || meta.session_id !== input.sessionId || typeof meta.cwd !== "string"
    || kiroCanonicalDirectory(meta.cwd) !== kiroCanonicalDirectory(input.workingDirectory)
    || meta.session_state?.rts_model_state?.conversation_id !== input.sessionId
    || meta.session_state?.rts_model_state?.model_info?.model_id !== input.model) throw new Error("The carried V2 metadata/model does not match");
  const scan = scanKiroInstanceForForgedEnvelopes({ instanceName: input.instance, workingDirectory: input.workingDirectory,
    outboxDbPath: input.outboxDbPath, knownInstances: new Set(input.knownInstances),
    tui: { sessionId: input.sessionId, sessionsDir: input.sessionsDir, stillOwned: current } });
  if (scan.status === "unreadable-store" || scan.status === "no-conversation") throw new Error("Forensic V2 reader is unavailable: " + (scan.reason ?? scan.status));
  if (input.archived) {
    const root = join(input.agendHome, "kiro-classic-archives", createHash("sha256").update(input.instance).digest("hex").slice(0, 32));
    const found = readdirSync(root).some(name => {
      if (!name.startsWith(input.sessionId + "-") || !name.endsWith(".json")) return false;
      const archive = kiroClassicArchiveMetadata(join(root, name));
      return archive.instance === input.instance && archive.sessionId === input.sessionId && archive.directory === kiroCanonicalDirectory(input.workingDirectory)
        && archive.profile === input.credentialProfile && archive.dbPath === resolve(input.dbPath);
    });
    if (!found) throw new Error("No verified classic archive exists");
    const db = new Database(input.dbPath, { readonly: true, fileMustExist: true, timeout: 200 });
    try {
      const keys = kiroDirectoryKeys(input.workingDirectory);
      if (db.prepare(`SELECT 1 FROM conversations_v2 WHERE key IN (${keys.map(() => "?").join(",")}) AND conversation_id=? LIMIT 1`).get(...keys, input.sessionId)) throw new Error("The frozen classic duplicate is still indexed");
    } finally { db.close(); }
  }
  if (!snapshot.unchanged() || !current()) throw new Error("V2 ownership or metadata changed during verification");
  // Dirty/expired evidence remains an explicit verdict, never silently converted to clean.
  return { forensic: scan.status };
}
