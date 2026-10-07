/**
 * #1314: `file:` references in an instance's `systemPrompt` and `workflow`.
 *
 * A relative reference is relative to the instance's own `working_directory` — the directory its CLI runs in, and
 * what Settings and the create_instance description always suggested (`file:prompts/dev.md`). It used to be read
 * against the fleet process's current directory: `~/.agend` under the installed service, the shell's directory
 * after a manual `agend fleet start`, so one fleet.yaml read different files depending on how the fleet started.
 *
 * For one release (2.1.x) a relative reference whose instance file is missing still falls back to the old,
 * fleet-directory file, with a warning that names both paths; the instance file always wins when it exists.
 *
 * Nothing here logs or returns a file's contents in a diagnostic: only the resolved path and an errno code.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** These are read synchronously on the fleet's event loop at every spawn; anything larger is refused. */
export const PROMPT_FILE_MAX_BYTES = 256 * 1024;

export type PromptFileField = "systemPrompt" | "workflow";

export interface PromptFileWarning {
  field: PromptFileField;
  /** The path the reference resolves to (the instance file). */
  path: string;
  /** missing | unreadable | too_large | fleet_dir_fallback */
  problem: "missing" | "unreadable" | "too_large" | "fleet_dir_fallback";
  /** errno code for missing/unreadable (ENOENT, EACCES, EISDIR, …). */
  code?: string;
  /** For fleet_dir_fallback: the old, fleet-directory file that was read instead. */
  legacyPath?: string;
}

export interface PromptFileContext {
  /** The instance's configured `working_directory`. */
  workingDirectory: string;
  /** The fleet process's current directory — injected, so tests never `chdir`. */
  fleetCwd: string;
  /** Home directory for `~/` (injectable for tests). */
  home?: string;
  onWarning?: (warning: PromptFileWarning) => void;
}

const expandHome = (path: string, home: string): string =>
  path === "~" ? home : path.startsWith("~/") ? resolve(home, path.slice(2)) : path;

/** The path a `file:` reference names: `~/` and absolute as given, anything else under the working directory. */
export function resolveFileRefPath(ref: string, workingDirectory: string, home: string = homedir()): string {
  const target = expandHome(ref.trim(), home);
  if (isAbsolute(target)) return target;
  return resolve(expandHome(workingDirectory, home), target);
}

type ReadOutcome = { ok: true; text: string } | { ok: false; problem: "missing" | "unreadable" | "too_large"; code?: string };

function readBounded(path: string): ReadOutcome {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, problem: "unreadable", code: "EISDIR" };
    if (st.size > PROMPT_FILE_MAX_BYTES) return { ok: false, problem: "too_large" };
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, read);
      if (n <= 0) break;
      read += n;
    }
    return { ok: true, text: buf.subarray(0, read).toString("utf-8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, problem: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable", code };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

/** The text a `file:` reference (without the prefix) loads, or "" — with a warning for anything but a clean read. */
export function readFileRef(ref: string, field: PromptFileField, ctx: PromptFileContext): string {
  const home = ctx.home ?? homedir();
  const path = resolveFileRefPath(ref, ctx.workingDirectory, home);
  const own = readBounded(path);
  if (own.ok) return own.text;
  const target = expandHome(ref.trim(), home);
  if (own.problem === "missing" && !isAbsolute(target)) {
    // One release of compatibility: the file where the old, fleet-directory resolution found it.
    const legacyPath = resolve(ctx.fleetCwd, target);
    if (legacyPath !== path) {
      const legacy = readBounded(legacyPath);
      if (legacy.ok) {
        ctx.onWarning?.({ field, path, problem: "fleet_dir_fallback", legacyPath });
        return legacy.text;
      }
    }
  }
  ctx.onWarning?.({ field, path, problem: own.problem, ...(own.code ? { code: own.code } : {}) });
  return "";
}

/**
 * The parts of a `systemPrompt`. Comma-separated parts only when at least one of them is a `file:` reference
 * (`"file:role.md, file:rules.md"`, inline text allowed between them); otherwise the value is one inline prompt,
 * commas and all — "You are Kuro, a careful reviewer" is one paragraph.
 */
export function systemPromptParts(value: string): string[] {
  const parts = value.split(",").map(part => part.trim());
  return parts.some(part => part.startsWith("file:")) ? parts : [value];
}

/** The assembled custom prompt: each part's text (files loaded), joined by blank lines; undefined when empty. */
export function assembleSystemPrompt(value: string, ctx: PromptFileContext): string | undefined {
  const texts = systemPromptParts(value)
    .map(part => (part.startsWith("file:") ? readFileRef(part.slice(5), "systemPrompt", ctx) : part))
    .filter(Boolean);
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

/** A `workflow` value: a `file:` reference is loaded, anything else is inline. "" when the file gives nothing. */
export function resolveWorkflowText(value: string, ctx: PromptFileContext): string {
  return value.startsWith("file:") ? readFileRef(value.slice(5), "workflow", ctx) : value;
}
