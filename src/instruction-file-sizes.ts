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
import { claudeConfigDirFor, claudeMemoryRoot, claudeProfileConfigDir, claudeProjectKey } from "./backend/claude-code.js";
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
  /**
   * The file this text is already part of (AGENTS.md, where the CLI's fleet instructions are appended): shown for
   * reference, never added to the total again.
   */
  includedIn?: string;
}

export interface InstructionFileSizes {
  files: InstructionFile[];
  total: number;
  /** Bytes at which one file is flagged. */
  warnBytes: number;
}

/** Per file. The total is shown, never flagged on its own. */
export const INSTRUCTION_FILE_WARN_BYTES = 50 * 1024;
/**
 * Codex's default `project_doc_max_bytes` (read from the audited 0.169 and 0.171 binaries). A person's own Codex
 * configuration can change it, so the page says "by default".
 */
export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

/**
 * The instructions file each CLI reads from its working directory — the one General's instructions are written to
 * (fleet-manager.ts uses this table) — and whether AgEnD's fleet instructions (Agent instructions and "Owner and routine
 * operations" included) are appended to that same file inside a marker block (`appendWithMarker`): then they are part of
 * its size and not counted again. Claude Code and OpenCode read them from a separate fleet-instructions.md; Kiro from
 * its agent prompt.
 */
export const INSTRUCTIONS_FILE: Readonly<Record<string, { file: string; embedsFleetInstructions: boolean }>> = Object.freeze({
  "claude-code": { file: "CLAUDE.md", embedsFleetInstructions: false },
  "codex": { file: "AGENTS.md", embedsFleetInstructions: true },
  "opencode": { file: "AGENTS.md", embedsFleetInstructions: false },
  "kiro-cli": { file: ".kiro/steering/project.md", embedsFleetInstructions: false },
  // Grok reads AGENTS.md project docs; agy reads .agents/AGENTS.md (board 0340ec89: not the lowercase name).
  "grok": { file: "AGENTS.md", embedsFleetInstructions: true },
  // muse init scaffolds AGENTS.md and the binary reads it as project rules.
  "muse": { file: "AGENTS.md", embedsFleetInstructions: true },
  "antigravity": { file: ".agents/AGENTS.md", embedsFleetInstructions: true },
  "mock": { file: "CLAUDE.md", embedsFleetInstructions: false },
});
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
  const entry = INSTRUCTIONS_FILE[backend] ?? INSTRUCTIONS_FILE["claude-code"]!;
  // Where AgEnD's fleet instructions land: inside the project file (then counted there), or a file of their own.
  const embeddedIn = cwd && entry.embedsFleetInstructions ? entry.file : undefined;
  const add = (label: string, kind: InstructionFile["kind"], bytes: number | null, limit = INSTRUCTION_FILE_WARN_BYTES, truncates = false, includedIn?: string) => {
    if (bytes === null) return;
    files.push({ label, kind, bytes, limit, ...(truncates ? { truncates: true as const } : {}), ...(includedIn ? { includedIn } : {}) });
  };

  if (cwd) {
    if (backend === "kiro-cli") {
      let names: string[] = [];
      try { names = readdirSync(join(cwd, KIRO_STEERING)).filter((n) => n.endsWith(".md")).sort(); } catch { /* none */ }
      for (const n of names) add(join(KIRO_STEERING, n), "file", fileSize(join(cwd, KIRO_STEERING, n)));
    } else {
      const codex = backend === "codex";
      add(entry.file, "file", fileSize(join(cwd, entry.file)), codex ? CODEX_PROJECT_DOC_MAX_BYTES : INSTRUCTION_FILE_WARN_BYTES, codex);
    }
    if (backend === "claude-code") {
      // Claude Code's auto-memory index, in the config dir the agent's CLI uses, under the key Claude Code gives the
      // project: the repository's root (a worktree's main checkout), not the working directory (#1754 claudeMemoryRoot).
      const configDir = opts.home ?? claudeConfigDirFor(claudeProfileConfigDir(inst.backend_options?.["claude-code"] as Record<string, unknown> | undefined));
      add("MEMORY.md (Claude Code memory)", "memory", fileSize(join(configDir, "projects", claudeProjectKey(claudeMemoryRoot(cwd)), "memory", "MEMORY.md")));
    }
  }

  // Agent instructions: inline text counts as it is; each `file:` part is the file it names.
  const sp = typeof inst.systemPrompt === "string" ? inst.systemPrompt : "";
  if (sp.trim()) {
    const parts = systemPromptParts(sp);
    if (parts.some((p) => p.startsWith("file:"))) {
      for (const part of parts) {
        if (!part.startsWith("file:")) { add("Agent instructions", "inline", Buffer.byteLength(part, "utf8"), undefined, false, embeddedIn); continue; }
        const ref = part.slice(5);
        if (!cwd || isUnsupportedHomeRef(ref)) continue;
        add(ref, "file", fileSize(resolveFileRefPath(ref, cwd)), undefined, false, embeddedIn);
      }
    } else {
      add("Agent instructions", "inline", Buffer.byteLength(sp, "utf8"), undefined, false, embeddedIn);
    }
  }
  const ops = typeof inst.operations === "string" ? inst.operations : "";
  if (ops.trim()) add("Owner and routine operations", "inline", Buffer.byteLength(ops, "utf8"), undefined, false, embeddedIn);

  return { files, total: files.reduce((n, f) => n + (f.includedIn ? 0 : f.bytes), 0), warnBytes: INSTRUCTION_FILE_WARN_BYTES };
}
