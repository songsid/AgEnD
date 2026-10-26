/** #2598 B1: read-only, bounded snapshot of the explicitly owned TUI conversation.
 * This is a forensic history scan, not proof of the pane's current session (the raw Log gate stays closed).
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KiroScanRead } from "./forged-envelope-scan.js";

export const KIRO_FORENSIC_MAX_BYTES = 64 * 1024 * 1024;
const META_MAX_BYTES = 8 * 1024 * 1024;
const LINE_MAX_BYTES = 4 * 1024 * 1024;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Refuse symlinks/devices/foreign files and read exactly the size observed at open, not an unbounded live tail. */
export function snapshotKiroTuiFile(path: string, maxBytes: number): { text: string; unchanged: () => boolean } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || (process.getuid && before.uid !== process.getuid()) || before.size > maxBytes) {
      throw new Error("TUI session is not an owned regular file within the scan size limit");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const got = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!got) throw new Error("TUI session was truncated while scanning");
      offset += got;
    }
    const after = fstatSync(fd);
    if (after.size < before.size || (after.size === before.size && after.mtimeMs !== before.mtimeMs)) throw new Error("TUI session changed while scanning");
    const samePath = () => {
      try {
        const current = lstatSync(path);
        return current.isFile() && current.dev === before.dev && current.ino === before.ino && current.size >= before.size
          && (current.size > before.size || current.mtimeMs === before.mtimeMs);
      } catch { return false; }
    };
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), unchanged: samePath };
  } finally { closeSync(fd); }
}

/** Tool input is assistant-authored too; returned output and user prompts never enter this walk. */
function inputStrings(value: unknown, texts: string[], depth = 0): void {
  if (depth > 64) throw new Error("TUI tool input exceeds the nesting limit");
  if (typeof value === "string") texts.push(value);
  else if (Array.isArray(value)) for (const item of value) inputStrings(item, texts, depth + 1);
  else if (plain(value)) for (const item of Object.values(value)) inputStrings(item, texts, depth + 1);
}

export function readKiroTuiAssistantTexts(opts: {
  sessionId: string;
  sessionsDir?: string;
  stillOwned: () => boolean;
}): KiroScanRead {
  try {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(opts.sessionId) || !opts.stillOwned()) throw new Error("TUI session ownership is not proven");
    // Same V2 root convention as kiroV2SessionsDir; credential profiles relocate classic only.
    const root = opts.sessionsDir ?? join(process.env.KIRO_HOME?.trim() || join(homedir(), ".kiro"), "sessions", "cli");
    const metadata = snapshotKiroTuiFile(join(root, `${opts.sessionId}.json`), META_MAX_BYTES);
    const meta: unknown = JSON.parse(metadata.text);
    if (!plain(meta) || meta.session_id !== opts.sessionId
      || (meta.session_created_reason === "subagent" && meta.exported_from_v1 !== true)) {
      throw new Error("TUI metadata does not match the owned pin, or is an ordinary child session");
    }
    const transcript = snapshotKiroTuiFile(join(root, `${opts.sessionId}.jsonl`), KIRO_FORENSIC_MAX_BYTES);
    const texts: string[] = [];
    let records = 0;
    for (const line of transcript.text.split("\n")) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > LINE_MAX_BYTES) throw new Error("TUI record exceeds the scan line limit");
      const record: unknown = JSON.parse(line);
      if (!plain(record) || record.version !== "v1" || !plain(record.data)) throw new Error("Unsupported TUI record schema");
      records++;
      if (record.kind === "Prompt" || record.kind === "ToolResults") continue;
      if (record.kind !== "AssistantMessage" || !Array.isArray(record.data.content)) throw new Error("Unsupported TUI assistant record");
      for (const block of record.data.content) {
        if (!plain(block)) throw new Error("Unsupported TUI assistant block");
        if (block.kind === "text" && typeof block.data === "string") texts.push(block.data);
        else if (block.kind === "toolUse" && plain(block.data) && plain(block.data.input)) inputStrings(block.data.input, texts);
        else throw new Error("Unsupported TUI assistant block");
      }
    }
    if (!records) throw new Error("TUI transcript has no complete records");
    if (!metadata.unchanged() || !transcript.unchanged() || !opts.stillOwned()) throw new Error("TUI session or ownership changed while scanning; rerun the scan");
    return { kind: "ok", conversationId: opts.sessionId, texts };
  } catch (error) {
    // Fixed prefix plus the local failure; no transcript text is included in the diagnostic.
    const reason = error instanceof SyntaxError || error instanceof TypeError ? "TUI session contains malformed JSON or UTF-8" : (error as Error).message;
    return { kind: "unreadable", reason };
  }
}
