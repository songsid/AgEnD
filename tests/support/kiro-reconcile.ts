/** Synthetic conversations only. Callers run with native process/lifecycle boundaries stubbed. */
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { armKiroTuiMigration, resolveKiroIdentity, kiroOwnedConversation } from "../../src/backend/kiro-identity.js";
import { kiroV1DbPath } from "../../src/backend/kiro.js";
import type { KiroReconcileInput } from "../../src/backend/kiro-reconcile-store.js";
export function reconciliationFixture() {
  const root = mkdtempSync(join(tmpdir(), "kiro-reconcile-")), home = join(root, "agend"), cwd = join(root, "work"), kiro = join(root, "kiro");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(cwd); const sessions = join(kiro, "sessions", "cli"); mkdirSync(sessions, { recursive: true });
  vi.stubEnv("AGEND_HOME", home); vi.stubEnv("KIRO_HOME", kiro); vi.stubEnv("XDG_DATA_HOME", join(root, "xdg"));
  const keep = "original", archive = "newer", name = "wiki", model = "claude-sonnet-4.6", profile = null;
  const identity = { agendHome: home, instance: name, workingDirectory: cwd, credentialProfile: profile };
  const store = { kind: "ok" as const, sessions: [{ id: keep, updatedAt: 1 }], createdAt: () => 1 };
  resolveKiroIdentity({ ...identity, engine: "v1", readStore: () => store, launchedBefore: () => true }); armKiroTuiMigration(identity);
  resolveKiroIdentity({ ...identity, engine: "v2", readStore: () => store, launchedBefore: () => false });
  resolveKiroIdentity({ ...identity, engine: "v2", skipResume: true, readStore: () => store, launchedBefore: () => false });
  const meta = { session_id: keep, cwd, created_at: "2026-10-26T05:19:07Z", exported_from_v1: true, session_created_reason: "subagent",
    session_state: { version: "v1", conversation_metadata: {}, rts_model_state: { conversation_id: keep, model_info: { model_id: model } }, agent_name: null } };
  writeFileSync(join(sessions, keep + ".json"), JSON.stringify(meta));
  writeFileSync(join(sessions, keep + ".jsonl"), [
    { version: "v1", kind: "Prompt", data: { content: [{ kind: "text", data: "synthetic prompt" }] } },
    { version: "v1", kind: "AssistantMessage", data: { message_id: "m1", content: [{ kind: "text", data: "synthetic retained work" }] } },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(join(sessions, archive + ".json"), JSON.stringify({ ...meta, session_id: archive, created_at: "2026-10-27T00:58:40Z", exported_from_v1: false,
    session_created_reason: "interactive", session_state: { ...meta.session_state, rts_model_state: { ...meta.session_state.rts_model_state, conversation_id: archive } } }));
  writeFileSync(join(sessions, archive + ".jsonl"), "synthetic newer work\n");
  writeFileSync(join(sessions, archive + ".history"), Buffer.from([0, 255, 1]));
  const dbPath = kiroV1DbPath(profile); mkdirSync(dirname(dbPath), { recursive: true }); const db = new Database(dbPath);
  db.exec("CREATE TABLE conversations_v2(key TEXT,conversation_id TEXT,value TEXT,created_at INTEGER,updated_at INTEGER,PRIMARY KEY(key,conversation_id))");
  db.prepare("INSERT INTO conversations_v2 VALUES(?,?,?,?,?)").run(cwd, keep, JSON.stringify({ conversation_id: keep, next_message: null,
    history: [{ user: { content: { Prompt: { prompt: "synthetic prompt" } } }, assistant: { Response: { message_id: "m1", content: "synthetic retained work" } } }] }), 1, 2);
  db.prepare("INSERT INTO conversations_v2 VALUES(?,?,?,?,?)").run("/other", "other", "{}", 3, 4); db.close();
  const input: KiroReconcileInput = { ...identity, sessionId: keep, archiveId: archive, model, sessionsDir: sessions, dbPath };
  const rows = () => { const db = new Database(dbPath, { readonly: true }); try { return db.prepare("SELECT * FROM conversations_v2 ORDER BY key").all(); } finally { db.close(); } };
  const identityFile = join(home, "kiro-identity", "instances", readdirSync(join(home, "kiro-identity", "instances"))[0]!);
  const own = () => kiroOwnedConversation({ ...identity, engine: "v2" });
  const native = () => Object.fromEntries(readdirSync(sessions).map(n => [n, readFileSync(join(sessions, n)).toString("base64")]));
  return { root, home, cwd, sessions, name, keep, archive, model, input, identity, identityFile, rows, own, native };
}
