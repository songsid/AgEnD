/**
 * Semantic tool-progress labelling for the channel processing bubble.
 *
 * This is a SECOND labeller, deliberately separate from `Daemon.summarizeTool`:
 * that one feeds the statusline / `/view` / recent events and is pinned by
 * tests to the terse `Read <path>` / `$ <cmd>` form. This one feeds the
 * channel bubble only — it is semantic (`npm test` → `🧪 執行測試`), may
 * return `""` for uninteresting work, and never carries shell arguments at
 * the default `standard` level. Do not merge the two: they serve different
 * audiences with different safety requirements (the bubble is broadcast to a
 * chat channel; the statusline is an operator surface).
 */

import { t } from "./locale.js";

export type ToolProgressLevel = "off" | "standard" | "verbose";

/** Max characters for any single progress line (before the display cap). */
const LABEL_MAX_CHARS = 80;
/** Max characters of command preview appended at `verbose`. */
const VERBOSE_PREVIEW_CHARS = 48;

/**
 * Strip credentials before anything reaches a chat channel. Patterns are
 * deliberately broad — a false positive redacts a harmless token, a false
 * negative broadcasts a secret.
 */
export function redactSecrets(text: string): string {
  return text
    // JWTs (three base64url segments) — before generic keys, which match prefixes
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g, "[REDACTED]")
    // Known key shapes: OpenAI/Anthropic/GitHub/Slack/AWS/Telegram bot tokens
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g, "[REDACTED]")
    // Bearer / basic auth headers
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/._=-]{8,}/gi, "$1 [REDACTED]")
    // key=value / key: value assignments for sensitive names
    .replace(/\b((?:api[-_]?key|token|secret|passwd|password|authorization|credential)s?\s*[=:]\s*)(["']?)[^\s"']{6,}\2/gi, "$1[REDACTED]")
    // URL userinfo credentials (https://user:pass@host). The scheme is bounded: `\w+` at every position of a long word
    // run made this quadratic (#1788 review: a Log result can be long).
    .replace(/(\b\w{1,32}:\/\/[^/\s:@]+:)[^@\s]+@/g, "$1[REDACTED]@");
}

/** Flatten whitespace and cap length for a single bubble line. */
function capLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > LABEL_MAX_CHARS ? `${flat.slice(0, LABEL_MAX_CHARS - 1)}…` : flat;
}

/** Shorten an absolute path to something readable in a bubble line (a Windows path, with backslashes, too). */
function shortPath(p: string): string {
  const clean = String(p).trim();
  if (clean.length <= 48) return clean;
  const parts = clean.split(/[\\/]/);
  if (parts.length <= 3) return clean;
  return `…/${parts.slice(-3).join("/")}`;
}

interface ShellIntent {
  label: string;
  /** True when the raw command may be appended at `verbose`. */
  preview: boolean;
}

/**
 * Reduce a shell command to its intent. Returns null for commands with no
 * interesting intent — the caller renders a generic "執行指令" line with the
 * program name only (never arguments) at `standard`.
 */
function classifyShellCommand(cmd: string): ShellIntent | null {
  const c = cmd.trim();
  // Test runners
  if (/\b(npm|pnpm|yarn|bun)( run)? test\b/.test(c) || /\b(vitest|jest|pytest|go test|cargo test|mocha|rspec)\b/.test(c)) {
    return { label: t("progress.test"), preview: true };
  }
  // Typecheck / build
  if (/\btsc\b/.test(c) || /\b(npm|pnpm|yarn|bun) run build\b/.test(c) || /\b(cargo|go) build\b/.test(c) || /\bmake\b/.test(c)) {
    return { label: t("progress.build"), preview: true };
  }
  // Dependency install
  if (/\b(npm|pnpm|yarn|bun) (i|ci|install|add)\b/.test(c) || /\bpip3? install\b/.test(c) || /\bcargo add\b/.test(c)) {
    return { label: t("progress.install"), preview: true };
  }
  // Git — order matters: push/pull before generic commit
  if (/\bgit push\b/.test(c)) return { label: "⬆️ git push", preview: true };
  if (/\bgit (pull|fetch)\b/.test(c)) return { label: "⬇️ git pull/fetch", preview: true };
  if (/\bgit commit\b/.test(c)) return { label: "💾 git commit", preview: false };
  if (/\bgit (checkout|switch|branch)\b/.test(c)) return { label: t("progress.git_branch"), preview: true };
  if (/\bgit (diff|log|status|show|blame)\b/.test(c)) return { label: t("progress.git_inspect"), preview: true };
  if (/\bgh (pr|issue|api|run)\b/.test(c)) return { label: t("progress.github"), preview: true };
  return null;
}

/** Low-signal inspection commands: hidden entirely at `standard`. */
function isLowSignalCommand(cmd: string): boolean {
  return /^(rg|grep|find|fd|ls|cat|head|tail|wc|which|pwd|echo|sed|awk|cut|sort|uniq)\b/.test(cmd.trim());
}

/**
 * First program name of a shell command, pipelines/chains reduced to the head.
 * Prism #3709 R3: a wrapper's own options (`npx --package=…`, `sudo --user=…`, `timeout -s KILL`) and their values are
 * ARGUMENTS, never a program: when what follows a wrapper is an option (or an assignment) the program cannot be named
 * safely, so only the wrapper itself is returned — never the option string, which standard progress must not send.
 */
export function shellProgramName(cmd: string): string {
  const head = cmd.trim().split(/\s*(?:&&|\|\||\||;)\s*/)[0] ?? "";
  const tokens = head.trim().split(/\s+/);
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
  // Skip env assignments and common wrappers
  let i = 0;
  while (i < tokens.length && assignment.test(tokens[i])) i++;
  let wrapper = "";
  if (tokens[i] === "sudo" || tokens[i] === "npx" || tokens[i] === "timeout") { wrapper = tokens[i]!; i++; }
  if (tokens[i] && /^\d+[smh]?$/.test(tokens[i])) i++; // timeout's duration arg
  const next = tokens[i] ?? "";
  if (wrapper && (next.startsWith("-") || assignment.test(next))) return wrapper;
  return next.startsWith("-") || assignment.test(next) ? "" : next;
}

/** Search programs: their arguments are what is being searched for, which can be a literal secret. */
const SEARCH_PROGRAMS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "fd", "fdfind", "locate", "git-grep"]);
/** A search program, given by name or path (`/usr/bin/grep`). */
export function isSearchProgram(program: string): boolean { return SEARCH_PROGRAMS.has(program.replace(/^.*[\\/]/, "")); }
/** A search anywhere in the command (any pipeline or chain segment, `git grep` included). */
function isSearchCommand(cmd: string): boolean {
  return cmd.split(/\s*(?:&&|\|\||\||;|\n)\s*/).some(segment => {
    const prog = shellProgramName(segment).replace(/^.*[\\/]/, "");
    // git grep, git -C dir grep, git log --grep=…
    return isSearchProgram(prog) || (prog === "git" && /\bgrep\b/.test(segment));
  });
}

function labelShell(cmd: string, level: "standard" | "verbose"): string {
  // A search anywhere in the command: at verbose, never its arguments (no redactor can tell a searched-for secret from
  // any other word) — the intent label alone, or the plain search line. Standard never carries arguments: unchanged.
  const search = isSearchCommand(cmd);
  const intent = classifyShellCommand(cmd);
  if (intent) {
    if (level === "verbose" && intent.preview && !search) {
      return t("progress.detail", intent.label, redactSecrets(cmd).slice(0, VERBOSE_PREVIEW_CHARS));
    }
    return intent.label;
  }
  if (level === "verbose") return search ? t("progress.search") : `⚙️ $ ${redactSecrets(cmd).slice(0, VERBOSE_PREVIEW_CHARS)}`;
  if (isLowSignalCommand(cmd)) return "";
  // standard: program name only, never arguments
  const prog = shellProgramName(cmd);
  return prog ? t("progress.run_named", prog) : "";
}

/** Extract the shell command from a codex exec input (array or JSON string). */
function codexShellCommand(input: unknown): string | null {
  let inp = input;
  if (typeof inp === "string") {
    // custom_tool_call "exec" input is a JS snippet driving tools.* — surface the call names
    const raw = inp;
    const toolCalls = [...raw.matchAll(/\btools\.(\w+)\s*\(/g)].map(m => m[1]);
    if (toolCalls.length) return null; // handled by the caller via codeModeCalls
    // Not JSON → a plain JS snippet for codex's exec runtime, not a shell command.
    try { inp = JSON.parse(raw); } catch { return null; }
  }
  const obj = inp as Record<string, unknown> | null;
  if (!obj) return null;
  const cmd = obj.command;
  if (Array.isArray(cmd)) {
    // ["bash","-lc","actual command"] — take the last element
    return String(cmd[cmd.length - 1] ?? "");
  }
  if (typeof cmd === "string") return cmd;
  return null;
}

/**
 * The `tools.<name>(<args>)` calls of a codex code-mode script, in order, each with its argument text up to the matching
 * parenthesis (string literals skipped, so a ")" inside one does not end it). Codex 0.153+ runs every tool this way
 * (`text(await tools.exec_command({cmd:"npm test"}))`, `tools.apply_patch("*** Begin Patch…")`, `tools.mcp__srv__tool({…})`).
 */
export function codeModeCalls(script: string): Array<{ name: string; args: string }> {
  const out: Array<{ name: string; args: string }> = [];
  const re = /\btools\.(\w+)\s*\(/g;
  for (let m = re.exec(script); m; m = re.exec(script)) {
    const start = re.lastIndex;
    let depth = 1, i = start, quote = "";
    for (; i < script.length && depth > 0; i++) {
      const ch = script[i]!;
      if (quote) { if (ch === "\\") i++; else if (ch === quote) quote = ""; continue; }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    out.push({ name: m[1]!, args: script.slice(start, depth === 0 ? i - 1 : i) });
  }
  return out;
}

/** A JS string literal's value ("…", '…', or a `…` template without interpolation); undefined for anything computed. */
function jsStringValue(lit: string): string | undefined {
  if (lit.startsWith('"')) { try { return JSON.parse(lit) as string; } catch { return undefined; } }
  if (lit.includes("${")) return undefined;
  return lit.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\(.)/g, "$1");
}
const JS_STRING = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\x60(?:[^\x60\\]|\\.)*\x60`;
/** `key: "literal"` in a code-mode call's argument object, or a field of an already parsed object; undefined when computed. */
function argField(args: unknown, key: string): string | undefined {
  if (args && typeof args === "object") { const v = (args as Record<string, unknown>)[key]; return typeof v === "string" ? v : undefined; }
  if (typeof args !== "string") return undefined;
  const m = new RegExp(String.raw`(?:^|[{,\s])["']?${key}["']?\s*:\s*(${JS_STRING})`).exec(args);
  return m ? jsStringValue(m[1]!) : undefined;
}
/** The call's first argument when it is a string literal (`tools.apply_patch("*** Begin Patch…")`), or a raw string input. */
function leadingString(args: unknown): string | undefined {
  if (typeof args !== "string") return undefined;
  const m = new RegExp(String.raw`^\s*(${JS_STRING})`).exec(args);
  return m ? jsStringValue(m[1]!) : /^\s*\*\*\* Begin Patch/.test(args) ? args : undefined;
}
/** The files an apply_patch patch adds, updates or deletes. */
function patchFiles(patch: string): string[] {
  return [...new Set([...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m => m[1]!.trim()))];
}

/**
 * One codex tool call as a bubble line — the same style and the same safety as Claude's tools: a command through the shell
 * labeller (its intent, or the program name only, at `standard`; the redacted command at `verbose`), files and images by
 * their short path, MCP tools as `server · tool`. `args` is a code-mode call's argument text or a function call's parsed input.
 * "" for what is not a step of its own: a poll of a running command (write_stdin — its command already has its line), plan
 * bookkeeping (update_plan, as Claude's TodoWrite), AgEnD's channel tools.
 */
function labelCodexTool(name: string, args: unknown, level: "standard" | "verbose"): string {
  const named = labelToolName(name);
  if (named !== undefined) return named;
  switch (name) {
    case "exec_command": {
      const cmd = argField(args, "cmd") ?? argField(args, "command");
      return cmd ? labelShell(cmd, level) : t("progress.run");
    }
    case "write_stdin":
    case "update_plan":
      return "";
    case "apply_patch": {
      const patch = argField(args, "input") ?? argField(args, "patch") ?? leadingString(args) ?? "";
      const files = patchFiles(patch).map(f => shortPath(redactSecrets(f)));
      return files.length ? capLine(t("progress.edit_path", files.join(", "))) : t("progress.edit");
    }
    case "view_image": {
      const path = argField(args, "path");
      return path ? capLine(t("progress.view_image_path", shortPath(redactSecrets(path)))) : t("progress.view_image");
    }
    case "web_search":
    case "web__run":
      return t("progress.web_search");
  }
  // Another tool: its name only — its arguments are the highest-risk place for secrets.
  return capLine(`🔧 ${name}`);
}

/**
 * Name-level classification shared by direct tool uses and codex exec's
 * tools.* calls. Returns "" for channel-plumbing agend MCP tools (suppressed),
 * `🔌 server:tool` for other MCP tools, undefined for everything else.
 *
 * agend naming varies per CLI: claude-code `mcp__agend__reply`, codex
 * `mcp__agend_<instance>__reply`, opencode `agend-<instance>_reply` — hence
 * prefix matching rather than an exact list.
 */
function labelToolName(name: string): string | undefined {
  if (/^mcp__agend[_-]|^agend[-_]/.test(name)) return "";
  const mcpMatch = name.match(/^mcp__(\w+?)__(\w+)$/);
  if (mcpMatch) return capLine(t("progress.mcp", mcpMatch[1]!, mcpMatch[2]!));
  return undefined;
}

/**
 * The channel-bubble labeller. Returns "" when the tool use is not worth a
 * line (channel-plumbing MCP tools, low-signal inspection commands at
 * `standard`). Input shapes vary per backend; unknown shapes degrade to the
 * bare tool name rather than throwing.
 */
export function summarizeProgress(name: string, input: unknown, level: "standard" | "verbose" = "standard"): string {
  const inp = (input ?? {}) as Record<string, unknown>;

  const named = labelToolName(name);
  if (named !== undefined) return named;

  switch (name) {
    // claude-code shapes
    case "Read": {
      const p = inp.file_path ?? inp.path ?? "";
      return p ? capLine(t("progress.read_path", shortPath(redactSecrets(String(p))))) : t("progress.read");
    }
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const p = inp.file_path ?? inp.path ?? "";
      return p ? capLine(t("progress.edit_path", shortPath(redactSecrets(String(p))))) : t("progress.edit");
    }
    case "Glob":
    case "Grep":
      // Never the pattern, at any level: a search can be for a literal secret, and no redactor knows every shape.
      return t("progress.search");
    case "Agent":
    case "Task":
      return t("progress.subagent");
    case "WebFetch":
      return level === "verbose" && inp.url ? capLine(t("progress.web_fetch_url", redactSecrets(String(inp.url)))) : t("progress.web_fetch");
    case "WebSearch":
      return t("progress.web_search");
    case "Skill":
      return inp.skill ? capLine(t("progress.skill_named", String(inp.skill))) : t("progress.skill");
    case "TodoWrite":
      return ""; // bookkeeping, not work
    case "Bash":
    case "bash": // opencode
    case "shell": { // kiro / codex function_call
      const cmd = String(inp.command ?? "");
      return cmd ? capLine(labelShell(cmd, level)) : "";
    }
    case "exec": { // codex custom_tool_call (code mode, 0.153+): a JS script driving tools.*
      const calls = typeof input === "string" ? codeModeCalls(input) : [];
      if (calls.length) {
        // Each call as the tool it is; polls of a running command (write_stdin) and plan bookkeeping fold away.
        const labels = [...new Set(calls.map(c => labelCodexTool(c.name, c.args, level)))].filter(Boolean);
        return labels.length ? capLine(labels.join(" · ")) : "";
      }
      const cmd = codexShellCommand(input);
      if (cmd) return capLine(labelShell(cmd, level));
      // A JS snippet with no tools.* calls: still work happening, name it as such.
      return typeof input === "string" && input.trim() ? t("progress.code") : "";
    }
    // codex's own tools called directly (function_call / custom_tool_call before code mode)
    case "exec_command":
    case "write_stdin":
    case "apply_patch":
    case "view_image":
    case "update_plan":
    case "web_search":
    case "web__run":
      return capLine(labelCodexTool(name, input, level));
    // kiro built-in file ops
    case "fs_read": {
      const ops = inp.operations as Array<Record<string, unknown>> | undefined;
      const p = ops?.[0]?.path ?? inp.path ?? "";
      return p ? capLine(t("progress.read_path", shortPath(redactSecrets(String(p))))) : t("progress.read");
    }
    case "fs_write": {
      const p = inp.path ?? "";
      return p ? capLine(t("progress.edit_path", shortPath(redactSecrets(String(p))))) : t("progress.edit");
    }
    // opencode built-ins
    case "read":
      return inp.filePath ? capLine(t("progress.read_path", shortPath(redactSecrets(String(inp.filePath))))) : t("progress.read");
    case "edit":
    case "write":
      return inp.filePath ? capLine(t("progress.edit_path", shortPath(redactSecrets(String(inp.filePath))))) : t("progress.edit");
    case "glob":
    case "grep":
      return t("progress.search");
    case "webfetch":
      return t("progress.web_fetch");
    case "todowrite":
    case "todoread":
      return "";
  }

  // Unknown tool: show its name, nothing else — inputs of unknown tools are
  // the highest-risk place for secrets.
  return capLine(`🔧 ${name}`);
}

/**
 * Per-turn progress accumulator: dedupes consecutive repeats, keeps a rolling
 * window of the latest lines, renders to the bubble block.
 */
export class ProgressAccumulator {
  private lines: string[] = [];
  constructor(private maxLines = 8) {}

  /** Add a labelled line. Empty labels are ignored. Returns true when the rendered block changed. */
  add(label: string): boolean {
    if (!label) return false;
    if (this.lines[this.lines.length - 1] === label) return false;
    this.lines.push(label);
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
    return true;
  }

  reset(): void {
    this.lines = [];
  }

  isEmpty(): boolean {
    return this.lines.length === 0;
  }

  render(): string {
    return this.lines.join("\n");
  }
}
