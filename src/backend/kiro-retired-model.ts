/**
 * #2648: a kiro conversation saved with a model kiro has since retired. Resumed as is, kiro answers every start with
 * "Model unavailable — use /model to switch", and an instance with no model of its own never gets past it.
 *
 * `--model` on a resume overrides the conversation's saved model in every engine and launch form (probed on 2.30.0:
 * classic and TUI, interactive and not); the model given answers and becomes the saved one. So, for an instance with
 * no model of its own (none on the instance and none inherited from the fleet):
 *   1. at launch, the conversation it resumes is read (its own row or session file, read-only); a saved model that is
 *      not in kiro's cached model list launches with kiro's default model instead;
 *   2. a model error after a resume that (1) could not foresee restarts it once on that default, per conversation;
 *   3. the switch is announced once per conversation.
 * An instance whose own model is the retired one is a configuration error: it is said once, never switched (4).
 *
 * The records live in the instance's directory (kiro-model.json); a missing or damaged file reads as empty.
 */
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { atomicWriteFileSync } from "../atomic-write.js";
import { CLI_ENV_TTL_MS } from "./types.js";
import { kiroDirectoryKeys } from "./kiro-identity.js";

/** kiro's own default model: what `--list-models` names `default_model` (2.30.0: "auto", which kiro routes itself). */
export const KIRO_FALLBACK_MODEL = "auto";
const RECORD_FILE = "kiro-model.json";
/** Bounds the records an instance keeps (one per conversation it has had switched or reported). */
const MAX_ENTRIES = 32;
/** A v2 session file larger than this is not read on the launch path (the model sits near its top, but JSON is whole). */
const MAX_SESSION_FILE_BYTES = 8 * 1024 * 1024;

export interface KiroModelSwitch { from: string | null; to: string; announced: boolean }
export interface KiroModelRecords {
  /** conversation id → the model it is launched on instead of its saved one. */
  switched: Record<string, KiroModelSwitch>;
  /** conversations restarted once after a model error (step 2). */
  restarted: string[];
  /** model errors already said: `<conversation id or ->|<model or ->`. */
  notified: string[];
}

function empty(): KiroModelRecords {
  return { switched: Object.create(null) as Record<string, KiroModelSwitch>, restarted: [], notified: [] };
}

export function readKiroModelRecords(instanceDir: string): KiroModelRecords {
  const out = empty();
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(instanceDir, RECORD_FILE), "utf-8")); } catch { return out; }
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (r.switched && typeof r.switched === "object") {
    for (const [id, v] of Object.entries(r.switched as Record<string, unknown>)) {
      const s = v as Partial<KiroModelSwitch> | null;
      if (!s || typeof s.to !== "string" || !s.to) continue;
      out.switched[id] = { from: typeof s.from === "string" ? s.from : null, to: s.to, announced: s.announced === true };
    }
  }
  const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  out.restarted = strings(r.restarted);
  out.notified = strings(r.notified);
  return out;
}

export function writeKiroModelRecords(instanceDir: string, records: KiroModelRecords): void {
  const switched = Object.entries(records.switched).slice(-MAX_ENTRIES);
  atomicWriteFileSync(join(instanceDir, RECORD_FILE), JSON.stringify({
    switched: Object.fromEntries(switched),
    restarted: records.restarted.slice(-MAX_ENTRIES),
    notified: records.notified.slice(-MAX_ENTRIES),
  }) + "\n", { mode: 0o600 });
}

/**
 * v1: the model a conversation was saved with, or null when it cannot be read (never an error: step 2 covers it). The
 * owned row only — this directory's keys and this conversation id, through the (key, updated_at) index — in a
 * read-only connection with a short busy timeout. Synchronous, on the launch path: one indexed row.
 */
export function readKiroV1SavedModel(launch: { id: string; workingDirectory: string; dbPath: string }): string | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(launch.dbPath, { readonly: true, fileMustExist: true, timeout: 200 });
    const [a, b = a, c = b] = kiroDirectoryKeys(launch.workingDirectory);
    const row = db.prepare("SELECT json_extract(value, '$.model_info.model_id') AS m FROM conversations_v2 INDEXED BY idx_conversations_v2_key_updated"
      + " WHERE key IN (?, ?, ?) AND conversation_id = ? LIMIT 1").get(a, b, c, launch.id) as { m?: unknown } | undefined;
    return typeof row?.m === "string" && row.m ? row.m : null;
  } catch { return null; } finally { try { db?.close(); } catch { /* closed */ } }
}

/**
 * v2: the model in a session file's `rts_model_state`, or null. Asynchronous — session files are never read on the
 * fleet loop (#1417) — so it runs in the launch's preparation, for the conversation the instance has recorded.
 */
export async function readKiroV2SavedModel(sessionsDir: string, id: string): Promise<string | null> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return null;
  const path = join(sessionsDir, `${id}.json`);
  try {
    if ((await stat(path)).size > MAX_SESSION_FILE_BYTES) return null;
    const session = JSON.parse(await readFile(path, "utf-8")) as { session_state?: { rts_model_state?: { model_info?: { model_id?: unknown } } } };
    const model = session?.session_state?.rts_model_state?.model_info?.model_id;
    return typeof model === "string" && model ? model : null;
  } catch { return null; }
}

/** kiro's model list from AgEnD's cached probe (cli-env/kiro-cli.json); null when missing, damaged or stale. */
export function readKiroKnownModels(agendHome: string, now = Date.now()): { models: Set<string>; defaultModel: string } | null {
  try {
    const env = JSON.parse(readFileSync(join(agendHome, "cli-env", "kiro-cli.json"), "utf-8")) as
      { probedAt?: unknown; models?: Array<{ id?: unknown }>; currentModel?: unknown };
    if (typeof env?.probedAt !== "number" || now - env.probedAt >= CLI_ENV_TTL_MS) return null;
    const models = new Set((env.models ?? []).map(m => m?.id).filter((id): id is string => typeof id === "string" && !!id));
    if (models.size === 0) return null;
    const defaultModel = typeof env.currentModel === "string" && models.has(env.currentModel) ? env.currentModel : KIRO_FALLBACK_MODEL;
    return { models, defaultModel };
  } catch { return null; }
}

export type KiroModelErrorVerdict =
  /** Step 2: restart once on `model` (recorded; the restart's launch announces it). */
  | { kind: "restart"; model: string }
  /** Say it, once: `configured` = the instance's own model is the unavailable one (step 4). */
  | { kind: "notify"; configured: string | null }
  /** Already said for this conversation and model. */
  | { kind: "quiet" };

/**
 * What a kiro model error should do. `ownModel` = the model this launch was given from the instance's (or fleet's)
 * configuration; `launchModel` = the --model it ran with (its own, or a fallback from a switch); `conversation` = the
 * resumed conversation, null for a fresh one. Records what it decides.
 */
export function decideKiroModelError(
  instanceDir: string,
  launch: { ownModel: string | null; launchModel: string | null; conversation: string | null },
  fallbackModel: string,
): KiroModelErrorVerdict {
  const records = readKiroModelRecords(instanceDir);
  const save = (): boolean => { try { writeKiroModelRecords(instanceDir, records); return true; } catch { return false; } };
  if (!launch.ownModel && launch.conversation && !launch.launchModel && !records.restarted.includes(launch.conversation)) {
    const before = records.switched[launch.conversation];
    records.restarted.push(launch.conversation);
    records.switched[launch.conversation] = { from: before?.from ?? null, to: fallbackModel, announced: false };
    // The restart is the record's to authorize: one that cannot be committed would restart again on the same error,
    // and the next launch would not know to switch. Then it is only said (#2649 review).
    if (save()) return { kind: "restart", model: fallbackModel };
    records.restarted.pop();
    if (before) records.switched[launch.conversation] = before; else delete records.switched[launch.conversation];
  }
  const key = `${launch.conversation ?? "-"}|${launch.launchModel ?? "-"}`;
  if (records.notified.includes(key)) return { kind: "quiet" };
  records.notified.push(key);
  save();
  return { kind: "notify", configured: launch.ownModel };
}
