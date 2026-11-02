/**
 * Native Windows CLI adapters. Built-ins only: also loaded by Windows Node from WSL.
 * Protocol references (fixtures below intentionally require explicit terminal success):
 * - Antigravity: https://antigravity.google/docs/cli/headless/
 * - Grok: https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md
 * - OpenCode: https://opencode.ai/docs/cli/ and anomalyco/opencode#26855 (stdin/step_finish).
 * - Muse: https://dev.meta.ai/docs/muse-code/extending and meta-models/muse-code-sdk MSP schema.
 * - Claude flags were checked against the installed native 2.1.299 --help.
 */
export const NATIVE_PROVIDER_IDS = ["codex", "claude-code", "antigravity", "grok", "kiro-cli", "opencode", "muse"] as const;
export type NativeProviderId = typeof NATIVE_PROVIDER_IDS[number];
export type NativeSandbox = "read-only" | "workspace-write";
export interface NativeProviderDescriptor {
  id: NativeProviderId;
  name: string;
  company: string;
  /** Executable basenames only. IDE launchers such as kiro.cmd are deliberately excluded. */
  binaryNames: readonly string[];
  supports: { execution: boolean; resume: boolean; model: boolean };
  readOnlySupport: boolean;
  permission: "os-sandbox" | "read-tools" | "native-policy";
  permissionNote: string;
  promptTransport: "stdin-text" | "stdin-json" | "file";
  /** null means unknown, not signed out. These commands must never initiate a login. */
  authProbe: readonly string[] | null;
  /** A listing command only; never an inference/model request. */
  modelProbe: readonly string[] | null;
  reason?: string;
}

const PROVIDERS: Record<NativeProviderId, NativeProviderDescriptor> = {
  codex: {
    id: "codex", name: "Codex", company: "OpenAI", binaryNames: ["codex.exe"],
    supports: { execution: true, resume: true, model: true }, readOnlySupport: true,
    permission: "os-sandbox", permissionNote: "Uses Codex's native read-only or workspace-write sandbox. Approval policy is unchanged.",
    promptTransport: "stdin-text", authProbe: ["login", "status"], modelProbe: null,
  },
  "claude-code": {
    id: "claude-code", name: "Claude Code", company: "Anthropic", binaryNames: ["claude.exe"],
    supports: { execution: true, resume: true, model: true }, readOnlySupport: true,
    permission: "read-tools", permissionNote: "Read-only exposes Read, Glob and Grep only, with MCP disabled; it is a tool restriction, not an OS sandbox. Permission requests are denied in headless mode.",
    promptTransport: "stdin-text", authProbe: ["auth", "status"], modelProbe: null,
  },
  antigravity: {
    id: "antigravity", name: "Antigravity", company: "Google", binaryNames: ["agy.exe"],
    supports: { execution: true, resume: true, model: true }, readOnlySupport: false,
    permission: "native-policy", permissionNote: "Uses the native CLI permission policy. Plan mode and terminal sandboxing do not guarantee read-only workspace access.",
    promptTransport: "stdin-json", authProbe: null, modelProbe: ["models"],
  },
  grok: {
    id: "grok", name: "Grok", company: "xAI", binaryNames: ["grok.exe"],
    supports: { execution: true, resume: true, model: true }, readOnlySupport: false,
    permission: "native-policy", permissionNote: "Uses the native CLI permission policy; no blanket approval or sandbox bypass is added.",
    promptTransport: "file", authProbe: null, modelProbe: ["--no-auto-update", "models"],
  },
  "kiro-cli": {
    id: "kiro-cli", name: "Kiro", company: "AWS", binaryNames: ["kiro-cli.exe"],
    supports: { execution: false, resume: false, model: true }, readOnlySupport: false,
    permission: "native-policy", permissionNote: "Native Windows Kiro CLI is separate from Kiro IDE. Headless authentication requires KIRO_API_KEY.",
    promptTransport: "stdin-text", authProbe: null, modelProbe: ["chat", "--list-models", "--format", "json"],
    reason: "Windows headless execution exists, but this adapter has not verified its terminal JSON event schema yet.",
  },
  opencode: {
    id: "opencode", name: "OpenCode", company: "Anomaly", binaryNames: ["opencode.exe"],
    supports: { execution: true, resume: true, model: true }, readOnlySupport: false,
    permission: "native-policy", permissionNote: "Uses the native CLI permission policy; no --auto or permission allow override is added.",
    promptTransport: "stdin-text", authProbe: null, modelProbe: ["models"],
  },
  muse: {
    id: "muse", name: "Muse", company: "Meta", binaryNames: ["muse.exe"],
    supports: { execution: true, resume: true, model: true }, readOnlySupport: false,
    permission: "native-policy", permissionNote: "Uses the native CLI approval and sandbox policy; no --disable-approval, --yolo or workspace-switch override is added.",
    promptTransport: "file", authProbe: null, modelProbe: null,
  },
};

export function isNativeProviderId(value: unknown): value is NativeProviderId {
  return typeof value === "string" && (NATIVE_PROVIDER_IDS as readonly string[]).includes(value);
}
export function nativeProvider(id: NativeProviderId): NativeProviderDescriptor {
  if (!isNativeProviderId(id)) throw new Error("Unknown Windows CLI provider");
  return PROVIDERS[id];
}

/** Empty means native CLI default. Models remain literal argv, never shell source. */
export function validateNativeModel(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Model must be a string");
  const model = value.trim();
  if (!model) return undefined;
  // Includes Claude's opus[1m] and Antigravity's human-readable model labels.
  if (model.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:/[\]() +\-]*$/.test(model)) throw new Error("Invalid Windows CLI model");
  return model;
}

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function validNativeSessionId(cli: NativeProviderId, value: unknown): value is string {
  if (typeof value !== "string") return false;
  return cli === "opencode" ? /^ses_[A-Za-z0-9]{8,100}$/.test(value) : UUID_RE.test(value);
}

export interface NativeProviderTask {
  cli: NativeProviderId;
  cwd: string;
  prompt: string;
  sandbox: NativeSandbox;
  model?: string;
}
export interface NativeInvocationOptions {
  resumeSessionId?: string;
  /** For file transports, a private file containing exactly task.prompt, owned/cleaned up by the worker. */
  promptFile?: string;
}
export interface NativeInvocation {
  args: string[];
  stdin: string;
  env?: Record<string, string>;
}

/** Only an argv plan. The caller supplies cwd to spawn({ shell: false, stdio: ['pipe', ...] }). */
export function buildNativeInvocation(task: NativeProviderTask, options: NativeInvocationOptions = {}): NativeInvocation {
  const provider = nativeProvider(task.cli);
  if (!provider.supports.execution) throw new Error(provider.reason || "Windows CLI execution is not supported");
  if (task.sandbox !== "read-only" && task.sandbox !== "workspace-write") throw new Error("Invalid sandbox mode");
  if (task.sandbox === "read-only" && !provider.readOnlySupport) throw new Error(`${provider.name} cannot guarantee read-only execution; choose native CLI permissions instead`);
  if (typeof task.prompt !== "string" || !task.prompt.trim() || task.prompt.includes("\0") || task.prompt.length > 16_384) throw new Error("Invalid Windows CLI prompt");
  const model = validateNativeModel(task.model);
  const resume = options.resumeSessionId;
  if (resume !== undefined && !validNativeSessionId(task.cli, resume)) throw new Error("Invalid Windows conversation id");
  const withModel = (args: string[]): string[] => model ? [...args, "--model", model] : args;
  switch (task.cli) {
    case "codex": {
      // Preserve the MVP ordering: global sandbox/cwd options must precede `exec resume`.
      const args = resume
        ? ["-C", task.cwd, "--sandbox", task.sandbox, "exec", "resume", "--json", "--skip-git-repo-check", resume]
        : ["exec", "--json", "--skip-git-repo-check", "--sandbox", task.sandbox, "-C", task.cwd];
      return { args: [...withModel(args), "-"], stdin: task.prompt };
    }
    case "claude-code": {
      const args = ["--print", "--verbose", "--input-format", "text", "--output-format", "stream-json", "--permission-prompts", "none"];
      if (task.sandbox === "read-only") {
        // Only built-in read tools; disallow MCP tools even if user/project config enables them.
        // No allowedTools flag: that would override the user's approval policy for the listed tools.
        args.push("--permission-mode", "plan", "--tools", "Read,Glob,Grep", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
      }
      if (resume) args.push("--resume", resume);
      return { args: withModel(args), stdin: task.prompt };
    }
    case "antigravity": {
      // Official streaming input protocol; EOF completes the final turn and exits.
      const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
      if (resume) args.push("--conversation", resume);
      return { args: withModel(args), stdin: `${JSON.stringify({ event: "user", message: { content: task.prompt } })}\n` };
    }
    case "grok": {
      const file = promptFile(options.promptFile);
      const args = ["--no-auto-update", "--prompt-file", file, "--output-format", "streaming-json", "--cwd", task.cwd];
      if (resume) args.push("--resume", resume);
      return { args: withModel(args), stdin: "" };
    }
    case "opencode": {
      const args = ["run", "--format", "json", "--dir", task.cwd];
      if (resume) args.push("--session", resume);
      return { args: withModel(args), stdin: task.prompt };
    }
    case "muse": {
      const args = ["exec", "--json", "--prompt-file", promptFile(options.promptFile)];
      // `muse resume` launches the TUI. Headless resume is exec --session-id.
      if (resume) args.push("--session-id", resume);
      return { args: withModel(args), stdin: "" };
    }
    default: throw new Error("Windows CLI execution is not supported");
  }
}
function promptFile(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z]:[\\/]/.test(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error("A private Windows prompt file is required");
  return value;
}

export interface NativeProviderEvent { text?: string; sessionId?: string; completed?: boolean; failed?: boolean; error?: string }
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function errorMessage(value: unknown): string | undefined {
  return string(value) ?? string(object(value)?.message) ?? string(object(object(value)?.data)?.message);
}
function session(cli: NativeProviderId, value: unknown): Pick<NativeProviderEvent, "sessionId"> {
  return validNativeSessionId(cli, value) ? { sessionId: value } : {};
}
function failure(message: string | undefined, fallback: string): NativeProviderEvent {
  return { failed: true, error: message || fallback };
}

/** A recognized provider event, never arbitrary stdout, supplies completion proof. */
export function parseNativeProviderEvent(cli: NativeProviderId, line: string): NativeProviderEvent | null {
  let e: JsonObject | null;
  try { e = object(JSON.parse(line)); } catch { return null; }
  if (!e) return null;
  switch (cli) {
    case "codex": {
      if (e.type === "thread.started") return session(cli, e.thread_id);
      if (e.type === "turn.completed") return { completed: true };
      if (e.type === "error" || e.type === "turn.failed") return failure(errorMessage(e.error) ?? string(e.message), "Codex turn failed");
      const item = object(e.item);
      if (e.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") return { text: item.text };
      if (e.type === "item.completed" && item?.type === "command_execution") {
        return { text: [item.command, item.aggregated_output].filter((v): v is string => typeof v === "string").join("\n") };
      }
      return null;
    }
    case "claude-code": {
      const sid = session(cli, e.session_id);
      if (e.type === "system" && e.subtype === "init") return sid;
      if (e.type === "assistant") {
        const content = object(e.message)?.content;
        const text = Array.isArray(content) ? content.map(object).filter(v => v?.type === "text").map(v => string(v?.text) ?? "").join("") : "";
        return text ? { ...sid, text } : null;
      }
      if (e.type === "result") {
        // `result` repeats the assistant message; don't append its text a second time.
        if (e.subtype === "success" && e.is_error !== true) return { ...sid, completed: true };
        const errors = Array.isArray(e.errors) ? e.errors.map(errorMessage).filter(Boolean).join("\n") : undefined;
        return { ...sid, ...failure(errors || string(e.result) || errorMessage(e.error), `Claude turn ended with ${String(e.subtype || "an error")}`) };
      }
      if (e.type === "error") return { ...sid, ...failure(errorMessage(e.error) ?? string(e.message), "Claude turn failed") };
      return null;
    }
    case "antigravity": {
      if (e.event === "init") return session(cli, e.conversation_id);
      if (e.event !== "result") return null;
      const result = object(e.result);
      if (!result) return null;
      const sid = session(cli, result.conversation_id);
      // Recent CLI releases can report SUCCESS after a print timeout. This is an early stop.
      if (typeof result.finished_reason === "string" && result.finished_reason) return { ...sid, ...failure(errorMessage(result.error), `Antigravity turn stopped early: ${result.finished_reason}`) };
      if (result.status === "SUCCESS") return { ...sid, text: string(result.response), completed: true };
      return { ...sid, ...failure(errorMessage(result.error), `Antigravity turn ended with ${String(result.status || "an unknown status")}`) };
    }
    case "grok": {
      if (e.type === "text" && typeof e.data === "string") return { text: e.data };
      if (e.type === "error") return failure(string(e.message) ?? errorMessage(e.error), "Grok turn failed");
      if (e.type !== "end") return null;
      const sid = session(cli, e.sessionId);
      return e.stopReason === "end_turn" ? { ...sid, completed: true }
        : { ...sid, ...failure(undefined, `Grok turn ended with ${String(e.stopReason || "an unknown stop reason")}`) };
    }
    case "opencode": {
      const part = object(e.part);
      const sid = session(cli, e.sessionID ?? part?.sessionID);
      if (e.type === "text" && typeof part?.text === "string") return { ...sid, text: part.text };
      if (e.type === "step_start") return sid;
      if (e.type === "error") return { ...sid, ...failure(errorMessage(e.error), "OpenCode turn failed") };
      if (e.type === "step_finish") {
        // A tool-calls step is not a finished turn. Older versions without a reason fail closed.
        if (part?.reason === "stop") return { ...sid, completed: true };
        if (["length", "content-filter", "error"].includes(String(part?.reason))) return { ...sid, ...failure(undefined, `OpenCode turn ended with ${String(part?.reason)}`) };
      }
      return null;
    }
    case "muse": {
      // Muse exec --json parity lines carry the stable MSP method/params envelope.
      // https://github.com/meta-models/muse-code-sdk/blob/main/schema/msp/stable/msp.schema.json
      const params = object(e.params);
      if (!params) return null;
      if (e.method === "session/started") return session(cli, object(params.session)?.sessionId);
      const sid = session(cli, params.sessionId);
      if (e.method === "item/completed") {
        const item = object(params.item);
        return item?.kind === "agentMessage" && typeof item.text === "string" ? { ...sid, text: item.text } : null;
      }
      if (e.method === "turn/completed") {
        if (params.terminal === "completed" && !params.error) return { ...sid, completed: true };
        return { ...sid, ...failure(errorMessage(params.error) ?? string(params.reason), `Muse turn ended with ${String(params.terminal || "an unknown status")}`) };
      }
      return null;
    }
    default: return null;
  }
}

/** No auth probe may infer signed-out from an unsupported command, timeout or malformed output. */
export function parseNativeAuthResult(cli: NativeProviderId, ok: boolean, output: string): boolean | null {
  if (cli === "codex") {
    if (/\bnot logged in\b/i.test(output)) return false;
    return ok && /\blogged in\b/i.test(output) ? true : null;
  }
  if (cli === "claude-code") {
    try { const value = object(JSON.parse(output.trim())); return typeof value?.loggedIn === "boolean" ? value.loggedIn : null; } catch { return null; }
  }
  return null;
}

export interface NativeModelOption { id: string; name?: string; description?: string }
/** Seven providers share a 64 KiB worker reply. Keep catalog data below 6 KiB each. */
export function boundNativeModelOptions(options: readonly NativeModelOption[]): NativeModelOption[] {
  const out: NativeModelOption[] = [], seen = new Set<string>();
  let bytes = 2;
  for (const raw of options) {
    if (!raw || typeof raw.id !== "string" || !raw.id || raw.id.length > 160 || seen.has(raw.id)) continue;
    const model = { id: raw.id, ...(raw.name ? { name: raw.name.slice(0, 200) } : {}), ...(raw.description ? { description: raw.description.slice(0, 300) } : {}) };
    const size = Buffer.byteLength(JSON.stringify(model)) + (out.length ? 1 : 0);
    if (bytes + size > 6 * 1024 || out.length >= 200) break;
    bytes += size; seen.add(model.id); out.push(model);
  }
  return out;
}
/** Conservative model listing parser; malformed/unrecognized listings leave custom model entry available. */
export function parseNativeModels(cli: NativeProviderId, output: string): NativeModelOption[] {
  if (!nativeProvider(cli).modelProbe) return [];
  const models = new Map<string, NativeModelOption>();
  const add = (value: unknown, label?: unknown): void => {
    if (typeof value !== "string" || value.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:/[\]\-]*$/.test(value)) return;
    models.set(value, { id: value, ...(typeof label === "string" && label !== value && label.length <= 200 ? { name: label } : {}) });
  };
  try {
    const parsed: unknown = JSON.parse(output);
    const rows = Array.isArray(parsed) ? parsed : object(parsed)?.models;
    if (Array.isArray(rows)) for (const row of rows) {
      if (typeof row === "string") add(row);
      else { const v = object(row); add(v?.id ?? v?.model_id ?? v?.modelId, v?.name ?? v?.display_name ?? v?.displayName); }
    }
    return [...models.values()].slice(0, 200);
  } catch { /* text listing below */ }
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  for (const line of plain.split(/\r?\n/)) {
    if (cli === "opencode") {
      const value = line.trim(); if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/[\]\-]+$/.test(value)) add(value);
    } else if (cli === "antigravity") {
      const match = /^\s*([A-Za-z0-9][A-Za-z0-9._:/[\]\-]*[-.][A-Za-z0-9._:/[\]\-]*)(?:\t+| {2,})(.+?)\s*$/.exec(line);
      if (match) add(match[1], match[2]);
    } else if (cli === "grok") {
      const match = /(?:^(?:[*-]\s+)?|[│|]\s*)(grok-[A-Za-z0-9._:/[\]\-]+)(?:\s|[│|]|$)/.exec(line.trim());
      if (match) add(match[1]);
    }
  }
  return [...models.values()].slice(0, 200);
}
