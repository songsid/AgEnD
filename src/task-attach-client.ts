/**
 * an agent's side of attaching files to a task card. Both doors use it — `agend-agent task …` (the CLI) and the
 * instance's daemon (the MCP `task` tool): they read each file the agent names (readAgentFile: inside its working
 * directory, no symlink, within the size limit — the fleet never opens a path an agent names), stage it on the fleet in
 * parts (`action: "upload"`, scheduler/task-files.ts), and send the write itself — update, move or attach — with the
 * staged ids in `uploads` instead of the paths in `attach`. The fleet then links the files to the comment of that one
 * write, all or nothing.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readAgentFile, type AgentFileContext } from "./agent-file-read.js";
import { TASK_FILE_LIMITS, TASK_FILE_PART_BYTES } from "./task-file-limits.js";

/** One call to the fleet's `task` tool, in whichever way this side makes it. */
export type TaskSend = (args: Record<string, unknown>) => Promise<{ result?: unknown; error?: string }>;

export type StageOutcome = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

/** The actions that take `attach` (file paths on the agent's side). */
const ATTACHING = new Set(["update", "move", "attach"]);

/** Whether this call names files to attach (so it needs staging before it is sent). */
export function wantsAttach(args: Record<string, unknown>): boolean {
  return typeof args.action === "string" && ATTACHING.has(args.action) && args.attach !== undefined;
}

const asObject = (v: unknown): Record<string, unknown> | null => {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string") { try { const p = JSON.parse(v) as unknown; return p && typeof p === "object" && !Array.isArray(p) ? p as Record<string, unknown> : null; } catch { return null; } }
  return null;
};

/**
 * Read and stage the files `args.attach` names; the same call without `attach` and with `uploads`. Nothing is sent for
 * the write itself here: a file that cannot be read or staged fails the call before the card is touched.
 */
export async function stageAttachments(args: Record<string, unknown>, ctx: AgentFileContext, send: TaskSend): Promise<StageOutcome> {
  const raw = args.attach;
  if (!Array.isArray(raw) || raw.some((p) => typeof p !== "string" || !p.trim())) return { ok: false, error: "attach takes file paths in your working directory, e.g. [\"./design.md\"]" };
  const paths = raw as string[];
  if (!paths.length) {
    if (args.action === "attach") return { ok: false, error: "attach: name at least one file" };
    const { attach: _a, ...rest } = args;
    return { ok: true, args: rest };
  }
  if (paths.length > TASK_FILE_LIMITS.perWrite) return { ok: false, error: `attach: at most ${TASK_FILE_LIMITS.perWrite} files in one write` };
  // Every file is read before any is staged: one that cannot be read must not leave the others waiting on the fleet.
  const files: Array<{ path: string; name: string; bytes: Buffer }> = [];
  let total = 0;
  for (const path of paths) {
    const read = await readAgentFile(path, { ...ctx, maxBytes: TASK_FILE_LIMITS.fileBytes });
    if (!read.ok) return { ok: false, error: `attach: ${path.slice(0, 200)} — ${read.reason}` };
    if (!read.bytes.length) return { ok: false, error: `attach: ${path.slice(0, 200)} — the file is empty` };
    total += read.bytes.length;
    files.push({ path, name: basename(path), bytes: read.bytes });
  }
  if (total > TASK_FILE_LIMITS.cardBytes) return { ok: false, error: `attach: ${Math.ceil(total / (1024 * 1024))} MiB in one write; at most ${Math.floor(TASK_FILE_LIMITS.cardBytes / (1024 * 1024))} MiB on a card` };
  const uploads: string[] = [];
  for (const f of files) {
    const got = await stageFile(f.name, f.bytes, send);
    if ("error" in got) {
      await releaseUploads(uploads, send);         // the ones already staged are not wanted any more
      return { ok: false, error: `attach: ${f.path.slice(0, 200)} — ${got.error}` };
    }
    uploads.push(got.upload);
  }
  const { attach: _a, ...rest } = args;
  return { ok: true, args: { ...rest, uploads } };
}

/** Give staged files back to the fleet (`release`); never fails the caller — what is not released leaves after the wait. */
export async function releaseUploads(uploads: readonly string[], send: TaskSend): Promise<void> {
  if (!uploads.length) return;
  try { await send({ action: "release", uploads: [...uploads] }); } catch { /* the fleet drops them after the wait */ }
}

/**
 * The write an agent asked for, with the files it names: staged first (a failure there is `staging`, nothing was written), then the
 * write itself with their ids — and when the fleet REFUSES the write the staged files are released, so a write tried again and again
 * (a card at its limit, a stale `version`) never fills the instance's room for staged files. One path for both doors: the CLI and the daemon.
 */
export async function sendTaskWrite(args: Record<string, unknown>, ctx: AgentFileContext, send: TaskSend): Promise<{ staging: true; error: string } | { staging: false; answer: { result?: unknown; error?: string } }> {
  let call = args;
  if (wantsAttach(args)) {
    const staged = await stageAttachments(args, ctx, send);
    if (!staged.ok) return { staging: true, error: staged.error };
    call = staged.args;
  }
  const answer = await send(call);
  if (answer.error && Array.isArray(call.uploads)) await releaseUploads(call.uploads as string[], send);
  return { staging: false, answer };
}

/** One file, whole or in parts, as the fleet's `upload` action takes it; the id it was staged under. */
export async function stageFile(name: string, bytes: Uint8Array, send: TaskSend): Promise<{ upload: string } | { error: string }> {
  const count = Math.max(1, Math.ceil(bytes.length / TASK_FILE_PART_BYTES));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let upload: string | undefined;
  for (let index = 0; index < count; index++) {
    const chunk = bytes.subarray(index * TASK_FILE_PART_BYTES, (index + 1) * TASK_FILE_PART_BYTES);
    const call: Record<string, unknown> = { action: "upload", name, data_b64: Buffer.from(chunk).toString("base64") };
    if (count > 1) call.part = { index, count, bytes: bytes.length, sha256, ...(upload ? { upload } : {}) };
    const r = await send(call);
    if (r.error) return { error: r.error };
    const answer = asObject(r.result);
    if (!answer || typeof answer.upload !== "string") return { error: "the fleet did not stage the file" };
    upload = answer.upload;
    if (index === count - 1) return answer.done === true ? { upload } : { error: "the fleet did not finish the file" };
  }
  return { error: "the fleet did not stage the file" };
}
