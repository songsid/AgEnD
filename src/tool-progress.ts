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
    // URL userinfo credentials (https://user:pass@host)
    .replace(/(\w+:\/\/[^/\s:@]+:)[^@\s]+@/g, "$1[REDACTED]@");
}

/** Flatten whitespace and cap length for a single bubble line. */
function capLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > LABEL_MAX_CHARS ? `${flat.slice(0, LABEL_MAX_CHARS - 1)}…` : flat;
}

/** Shorten an absolute path to something readable in a bubble line. */
function shortPath(p: string): string {
  const clean = String(p).trim();
  if (clean.length <= 48) return clean;
  const parts = clean.split("/");
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
    return { label: "🧪 執行測試", preview: true };
  }
  // Typecheck / build
  if (/\btsc\b/.test(c) || /\b(npm|pnpm|yarn|bun) run build\b/.test(c) || /\b(cargo|go) build\b/.test(c) || /\bmake\b/.test(c)) {
    return { label: "🔨 建置／型別檢查", preview: true };
  }
  // Dependency install
  if (/\b(npm|pnpm|yarn|bun) (i|ci|install|add)\b/.test(c) || /\bpip3? install\b/.test(c) || /\bcargo add\b/.test(c)) {
    return { label: "📦 安裝依賴", preview: true };
  }
  // Git — order matters: push/pull before generic commit
  if (/\bgit push\b/.test(c)) return { label: "⬆️ git push", preview: true };
  if (/\bgit (pull|fetch)\b/.test(c)) return { label: "⬇️ git pull/fetch", preview: true };
  if (/\bgit commit\b/.test(c)) return { label: "💾 git commit", preview: false };
  if (/\bgit (checkout|switch|branch)\b/.test(c)) return { label: "🔀 git 分支操作", preview: true };
  if (/\bgit (diff|log|status|show|blame)\b/.test(c)) return { label: "🔎 檢視 git 狀態", preview: true };
  if (/\bgh (pr|issue|api|run)\b/.test(c)) return { label: "🐙 GitHub 操作", preview: true };
  return null;
}

/** Low-signal inspection commands: hidden entirely at `standard`. */
function isLowSignalCommand(cmd: string): boolean {
  return /^(rg|grep|find|fd|ls|cat|head|tail|wc|which|pwd|echo|sed|awk|cut|sort|uniq)\b/.test(cmd.trim());
}

/** First program name of a shell command, pipelines/chains reduced to the head. */
function shellProgramName(cmd: string): string {
  const head = cmd.trim().split(/\s*(?:&&|\|\||\||;)\s*/)[0] ?? "";
  const tokens = head.trim().split(/\s+/);
  // Skip env assignments and common wrappers
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (tokens[i] === "sudo" || tokens[i] === "npx" || tokens[i] === "timeout") i++;
  if (tokens[i] && /^\d+[smh]?$/.test(tokens[i])) i++; // timeout's duration arg
  return tokens[i] ?? "";
}

function labelShell(cmd: string, level: "standard" | "verbose"): string {
  const intent = classifyShellCommand(cmd);
  if (intent) {
    if (level === "verbose" && intent.preview) {
      return `${intent.label}：${redactSecrets(cmd).slice(0, VERBOSE_PREVIEW_CHARS)}`;
    }
    return intent.label;
  }
  if (level === "verbose") return `⚙️ $ ${redactSecrets(cmd).slice(0, VERBOSE_PREVIEW_CHARS)}`;
  if (isLowSignalCommand(cmd)) return "";
  // standard: program name only, never arguments
  const prog = shellProgramName(cmd);
  return prog ? `⚙️ 執行指令：${prog}` : "";
}

/** Extract the shell command from a codex exec input (array or JSON string). */
function codexShellCommand(input: unknown): string | null {
  let inp = input;
  if (typeof inp === "string") {
    // custom_tool_call "exec" input is a JS snippet driving tools.* — surface the call names
    const raw = inp;
    const toolCalls = [...raw.matchAll(/\btools\.(\w+)\s*\(/g)].map(m => m[1]);
    if (toolCalls.length) return null; // handled by caller via codexToolsCalled
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

function codexToolsCalled(input: unknown): string[] {
  if (typeof input !== "string") return [];
  return [...new Set([...input.matchAll(/\btools\.(\w+)\s*\(/g)].map(m => m[1]))];
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
  if (mcpMatch) return capLine(`🔌 ${mcpMatch[1]}:${mcpMatch[2]}`);
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
      return p ? capLine(`📄 讀取檔案：${shortPath(redactSecrets(String(p)))}`) : "📄 讀取檔案";
    }
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const p = inp.file_path ?? inp.path ?? "";
      return p ? capLine(`✏️ 編輯檔案：${shortPath(redactSecrets(String(p)))}`) : "✏️ 編輯檔案";
    }
    case "Glob":
    case "Grep":
      return level === "verbose" ? capLine(`🔍 搜尋：${redactSecrets(String(inp.pattern ?? ""))}`) : "🔍 搜尋程式碼";
    case "Agent":
    case "Task":
      return "🤝 派工作給子 Agent";
    case "WebFetch":
      return level === "verbose" && inp.url ? capLine(`🌐 讀取網頁：${redactSecrets(String(inp.url))}`) : "🌐 讀取網頁";
    case "WebSearch":
      return "🌐 網路搜尋";
    case "Skill":
      return inp.skill ? capLine(`📚 使用 Skill：${String(inp.skill)}`) : "📚 使用 Skill";
    case "TodoWrite":
      return ""; // bookkeeping, not work
    case "Bash":
    case "bash": // opencode
    case "shell": { // kiro / codex function_call
      const cmd = String(inp.command ?? "");
      return cmd ? capLine(labelShell(cmd, level)) : "";
    }
    case "exec": { // codex custom_tool_call — JS driving tools.*
      const calls = codexToolsCalled(input);
      if (calls.length) {
        const labels = [...new Set(calls.map(c => labelToolName(c) ?? `🔌 ${c}`))].filter(Boolean);
        return labels.length ? capLine(labels.join(" · ")) : "";
      }
      const cmd = codexShellCommand(input);
      if (cmd) return capLine(labelShell(cmd, level));
      // A JS snippet with no tools.* calls: still work happening, name it as such.
      return typeof input === "string" && input.trim() ? "⚙️ 執行程式碼" : "";
    }
    // kiro built-in file ops
    case "fs_read": {
      const ops = inp.operations as Array<Record<string, unknown>> | undefined;
      const p = ops?.[0]?.path ?? inp.path ?? "";
      return p ? capLine(`📄 讀取檔案：${shortPath(redactSecrets(String(p)))}`) : "📄 讀取檔案";
    }
    case "fs_write": {
      const p = inp.path ?? "";
      return p ? capLine(`✏️ 編輯檔案：${shortPath(redactSecrets(String(p)))}`) : "✏️ 編輯檔案";
    }
    // opencode built-ins
    case "read":
      return inp.filePath ? capLine(`📄 讀取檔案：${shortPath(redactSecrets(String(inp.filePath)))}`) : "📄 讀取檔案";
    case "edit":
    case "write":
      return inp.filePath ? capLine(`✏️ 編輯檔案：${shortPath(redactSecrets(String(inp.filePath)))}`) : "✏️ 編輯檔案";
    case "glob":
    case "grep":
      return "🔍 搜尋程式碼";
    case "webfetch":
      return "🌐 讀取網頁";
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
