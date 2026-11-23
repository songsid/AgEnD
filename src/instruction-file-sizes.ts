/**
 * M-3522: the files an agent's CLI loads every session, and how big each one is, for the Details page's
 * "Loaded every session" card. Over about 50 KB a file crowds the context; Codex also cuts its project docs
 * (AGENTS.md) off at `project_doc_max_bytes`, 32 KiB by default (the audited 0.169–0.171 binaries).
 *
 * `stat` only, on known paths: never a recursive scan (the one directory read is Kiro's steering folder, one level).
 * Sizes are cached by path, mtime and size, so a page refresh does not touch the disk for an unchanged file beyond
 * the `stat`. Nothing here reads a file's content.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDirFor, claudeProfileConfigDir, claudeProjectKey } from "./backend/claude-code.js";
import { isUnsupportedHomeRef, resolveFileRefPath, systemPromptParts } from "./prompt-file-ref.js";
import type { InstanceConfig } from "./types.js";

/** One file (or inline text) loaded every session. */
export interface InstructionFile {
  /** What the page calls it: a file name relative to the working directory, or a fixed label. */
  label: string;
  /** "file" — a project instructions file; "memory" — the CLI's own memory index; "inline" — text kept in fleet.yaml. */
  kind: "file" | "memory" | "inline";
  bytes: number;
  /** The size at which this one is flagged: 50 KB, or the CLI's own cut-off when that is lower. */
  limit: number;
  /** Set when the CLI itself stops reading at `limit` (the rest is never seen). */
  truncates?: true;
}

export interface InstructionFileSizes {
  files: InstructionFile[];
  total: number;
  /** Bytes at which one file is flagged. */
  warnBytes: number;
}

/** Per file. The total is shown, never flagged on its own. */
export const INSTRUCTION_FILE_WARN_BYTES = 50 * 1024;
/** Codex's default `project_doc_max_bytes` (read from the audited binaries). */
export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

/** The instructions file each CLI reads from its working directory (fleet-manager INSTRUCTIONS_FILENAME's). */
const PROJECT_FILE: Record<string, string> = {
  "claude-code": "CLAUDE.md",
  codex: "AGENTS.md",
  opencode: "AGENTS.md",
  grok: "AGENTS.md",
  muse: "AGENTS.md",
  antigravity: join(".agents", "AGENTS.md"),
};
const KIRO_STEERING = join(".kiro", "steering");

const cache = new Map<string, { mtimeMs: number; size: number }>();

function fileSize(path: string): number | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.size;
    cache.set(path, { mtimeMs: st.mtimeMs, size: st.size });
    return st.size;
  } catch {
    return null;
  }
}

/** Every file this agent's CLI loads at the start of a session, that exists. `home` is for tests. */
export function instructionFileSizes(inst: Partial<InstanceConfig>, backend: string, opts: { home?: string } = {}): InstructionFileSizes {
  const files: InstructionFile[] = [];
  const cwd = typeof inst.working_directory === "string" ? inst.working_directory : "";
  const add = (label: string, kind: InstructionFile["kind"], bytes: number | null, limit = INSTRUCTION_FILE_WARN_BYTES, truncates = false) => {
    if (bytes === null) return;
    files.push({ label, kind, bytes, limit, ...(truncates ? { truncates: true as const } : {}) });
  };

  if (cwd) {
    if (backend === "kiro-cli") {
      let names: string[] = [];
      try { names = readdirSync(join(cwd, KIRO_STEERING)).filter((n) => n.endsWith(".md")).sort(); } catch { /* none */ }
      for (const n of names) add(join(KIRO_STEERING, n), "file", fileSize(join(cwd, KIRO_STEERING, n)));
    } else {
      const rel = PROJECT_FILE[backend] ?? "CLAUDE.md";
      const codex = backend === "codex";
      add(rel, "file", fileSize(join(cwd, rel)), codex ? CODEX_PROJECT_DOC_MAX_BYTES : INSTRUCTION_FILE_WARN_BYTES, codex);
    }
    if (backend === "claude-code") {
      // Claude Code's auto-memory index for this working directory, in the config dir the agent's CLI uses.
      const configDir = opts.home ?? claudeConfigDirFor(claudeProfileConfigDir(inst.backend_options?.["claude-code"] as Record<string, unknown> | undefined));
      add("MEMORY.md (Claude Code memory)", "memory", fileSize(join(configDir, "projects", claudeProjectKey(cwd), "memory", "MEMORY.md")));
    }
  }

  // Agent instructions: inline text counts as it is; each `file:` part is the file it names.
  const sp = typeof inst.systemPrompt === "string" ? inst.systemPrompt : "";
  if (sp.trim()) {
    const parts = systemPromptParts(sp);
    if (parts.some((p) => p.startsWith("file:"))) {
      for (const part of parts) {
        if (!part.startsWith("file:")) { add("Agent instructions", "inline", Buffer.byteLength(part, "utf8")); continue; }
        const ref = part.slice(5);
        if (!cwd || isUnsupportedHomeRef(ref)) continue;
        add(ref, "file", fileSize(resolveFileRefPath(ref, cwd)));
      }
    } else {
      add("Agent instructions", "inline", Buffer.byteLength(sp, "utf8"));
    }
  }
  const ops = typeof inst.operations === "string" ? inst.operations : "";
  if (ops.trim()) add("Owner and routine operations", "inline", Buffer.byteLength(ops, "utf8"));

  return { files, total: files.reduce((n, f) => n + f.bytes, 0), warnBytes: INSTRUCTION_FILE_WARN_BYTES };
}
