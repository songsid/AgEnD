import { describe, expect, it } from "vitest";
import {
  NATIVE_PROVIDER_IDS, buildNativeInvocation, isNativeProviderId, nativeProvider,
  parseNativeAuthResult, parseNativeModels, parseNativeProviderEvent,
  validateNativeModel, validNativeSessionId, type NativeProviderId,
  nativeMcpServerConfig, nativeProviderMcpSupported, type NativeMcpLaunch,
} from "../src/windows-cli-providers.js";

const sessionId = "12345678-1234-4321-abcd-123456789012";
const cwd = "J:\\Project\\Game";
const prompt = '閱讀中文檔案，不執行：$(whoami) & "quoted"\nsecond line';
const task = { cli: "codex", cwd, prompt, sandbox: "read-only" } as const;
const parse = (cli: NativeProviderId, event: unknown) => parseNativeProviderEvent(cli, JSON.stringify(event));
const mcp:NativeMcpLaunch={nodePath:"C:\\Node\\node.exe",helperPath:"\\\\wsl.localhost\\Ubuntu\\agend\\windows-native-mcp.js",connectionPath:"C:\\Temp\\private\\connection.json",configPath:"C:\\Temp\\private\\mcp.json",tools:["query_task"],serverName:"agend_native_aabbccddeeff"};

describe("scoped per-run native MCP configuration",()=>{
  it.each([undefined,sessionId])("adds Codex MCP root overrides before exec for resume %s without changing user config",resumeSessionId=>{
    const plan=buildNativeInvocation(task,{mcp,resumeSessionId});
    const exec=plan.args.indexOf("exec");
    expect(plan.args.slice(0,exec)).toEqual(expect.arrayContaining(["-c",`mcp_servers.${mcp.serverName}.command=${JSON.stringify(mcp.nodePath)}`,`mcp_servers.${mcp.serverName}.args=${JSON.stringify([mcp.helperPath,"--connection-file",mcp.connectionPath])}`]));
    expect(plan.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(plan.stdin).toBe(prompt);
    expect(plan.args).toContain("read-only");if(resumeSessionId)expect(plan.args).toContain(resumeSessionId);
  });
  it("keeps Claude read-only builtins and only preapproves this private namespace's exact scoped tools",()=>{
    const plan=buildNativeInvocation({...task,cli:"claude-code"},{mcp,resumeSessionId:sessionId});
    expect(plan.args).toEqual(expect.arrayContaining(["--tools","Read,Glob,Grep","--strict-mcp-config","--mcp-config",mcp.configPath,"--allowedTools",`mcp__${mcp.serverName}__query_task`,"--resume",sessionId]));
    expect(plan.args.join(" ")).not.toMatch(/bypass|dangerously|mcp__\*|Bash/);
    const native=buildNativeInvocation({...task,cli:"claude-code",sandbox:"workspace-write"},{mcp});
    expect(native.args).not.toContain("--strict-mcp-config");expect(native.args).not.toContain("--tools");
    expect(nativeMcpServerConfig(mcp)).toEqual({mcpServers:{[mcp.serverName!]:{command:mcp.nodePath,args:[mcp.helperPath,"--connection-file",mcp.connectionPath]}}});
  });
  it("does not alter unsupported providers' global or project MCP configs",()=>{
    for(const cli of NATIVE_PROVIDER_IDS){
      expect(nativeProviderMcpSupported(cli)).toBe(cli==="codex"||cli==="claude-code");
      if(!nativeProviderMcpSupported(cli))expect(()=>buildNativeInvocation({...task,cli,sandbox:"workspace-write"},{mcp,promptFile:"C:\\Temp\\prompt.txt"})).toThrow();
    }
    expect(()=>buildNativeInvocation(task,{mcp:{...mcp,helperPath:"C:\\Temp\\user-supplied.js"}})).toThrow(/MCP launch/);
    expect(()=>buildNativeInvocation(task,{mcp:{...mcp,serverName:"evil.env"}})).toThrow(/MCP launch/);
  });
});

describe("Windows native provider capabilities", () => {
  it("has the WSL provider scope and distinguishes native CLI from IDE launchers", () => {
    expect(NATIVE_PROVIDER_IDS).toEqual(["codex", "claude-code", "antigravity", "grok", "kiro-cli", "opencode", "muse"]);
    expect(isNativeProviderId("mock")).toBe(false);
    expect(isNativeProviderId("constructor")).toBe(false);
    expect(nativeProvider("kiro-cli").binaryNames).toEqual(["kiro-cli.exe"]);
    expect(nativeProvider("antigravity")).toMatchObject({ binaryNames: ["agy.exe"], supports: { execution: true } });
    for (const cli of NATIVE_PROVIDER_IDS) {
      const p = nativeProvider(cli);
      if (!p.supports.execution) expect(p.reason).toBeTruthy();
    }
  });
  it("does not mistake native policy or plan mode for a read-only sandbox", () => {
    expect(nativeProvider("codex").permission).toBe("os-sandbox");
    expect(nativeProvider("claude-code").permission).toBe("read-tools");
    for (const cli of ["antigravity", "grok", "opencode"] as const) {
      expect(() => buildNativeInvocation({ ...task, cli })).toThrow(/read-only/);
    }
  });
  it("reports unknown authentication instead of treating unsupported status commands as signed out", () => {
    expect(parseNativeAuthResult("codex", true, "Logged in using ChatGPT")).toBe(true);
    expect(parseNativeAuthResult("codex", false, "Not logged in")).toBe(false);
    expect(parseNativeAuthResult("codex", false, "Cannot inspect login")).toBeNull();
    expect(parseNativeAuthResult("claude-code", true, '{"loggedIn":true}')).toBe(true);
    expect(parseNativeAuthResult("claude-code", false, '{"loggedIn":false}')).toBe(false);
    expect(parseNativeAuthResult("claude-code", false, "Unexpected option auth")).toBeNull();
    expect(nativeProvider("antigravity").authProbe).toBeNull();
    expect(parseNativeAuthResult("antigravity", true, "Account: active")).toBeNull();
  });
});

describe("native argv and prompt boundaries", () => {
  it("preserves Codex's original fresh and resumed argv", () => {
    expect(buildNativeInvocation(task)).toEqual({ args: ["-c", "check_for_update_on_startup=false", "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-C", cwd, "-"], stdin: prompt });
    expect(buildNativeInvocation(task, { resumeSessionId: sessionId }).args).toEqual(["-c", "check_for_update_on_startup=false", "-C", cwd, "--sandbox", "read-only", "exec", "resume", "--json", "--skip-git-repo-check", sessionId, "-"]);
    expect(buildNativeInvocation({ ...task, model: "gpt-5.4" }).args.slice(-3)).toEqual(["--model", "gpt-5.4", "-"]);
  });
  it("keeps Claude prompts on stdin, restricts read tools and denies approval requests", () => {
    const invocation = buildNativeInvocation({ ...task, cli: "claude-code", model: "opus[1m]" }, { resumeSessionId: sessionId });
    expect(invocation.stdin).toBe(prompt);
    expect(invocation.args).toEqual(expect.arrayContaining(["--print", "--permission-prompts", "none", "--tools", "Read,Glob,Grep", "--strict-mcp-config", "--resume", sessionId, "--model", "opus[1m]"]));
    expect(invocation.args).not.toContain(prompt);
    expect(invocation.args).not.toContain("--allowedTools");
    // S-30 (leader decision): workspace = edits accepted inside the working directory only — acceptEdits, no extra
    // directories, no tool allow-list; the rest still needs an approval that headless never gives.
    const write = buildNativeInvocation({ ...task, cli: "claude-code", sandbox: "workspace-write" });
    const mode = write.args.indexOf("--permission-mode");
    expect(write.args.slice(mode, mode + 2)).toEqual(["--permission-mode", "acceptEdits"]);
    expect(write.args.filter(arg => arg === "--permission-mode")).toHaveLength(1);
    expect(write.args).toEqual(expect.arrayContaining(["--permission-prompts", "none"]));
    for (const flag of ["--tools", "--add-dir", "--allowedTools", "--dangerously-skip-permissions"]) expect(write.args).not.toContain(flag);
    const read = buildNativeInvocation({ ...task, cli: "claude-code", sandbox: "read-only" });
    expect(read.args.slice(read.args.indexOf("--permission-mode"), read.args.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "plan"]);
    expect(read.args).not.toContain("acceptEdits");
  });
  it("uses Antigravity's documented stdin user event and exact conversation resume", () => {
    const invocation = buildNativeInvocation({ ...task, cli: "antigravity", sandbox: "workspace-write", model: "Gemini 3.8 Flash (Medium)" }, { resumeSessionId: sessionId });
    expect(JSON.parse(invocation.stdin)).toEqual({ event: "user", message: { content: prompt } });
    expect(invocation.stdin.endsWith("\n")).toBe(true);
    expect(invocation.args).toEqual(["--input-format", "stream-json", "--output-format", "stream-json", "--conversation", sessionId, "--model", "Gemini 3.8 Flash (Medium)"]);
  });
  it("requires a worker-owned Windows prompt file for Grok", () => {
    const grokTask = { ...task, cli: "grok", sandbox: "workspace-write" } as const;
    expect(() => buildNativeInvocation(grokTask)).toThrow(/prompt file/);
    expect(() => buildNativeInvocation(grokTask, { promptFile: "-evil" })).toThrow(/prompt file/);
    const invocation = buildNativeInvocation(grokTask, { promptFile: "C:\\Temp\\private\\prompt.txt", resumeSessionId: sessionId });
    expect(invocation.stdin).toBe("");
    expect(invocation.args).toEqual(["--no-auto-update", "--prompt-file", "C:\\Temp\\private\\prompt.txt", "--output-format", "streaming-json", "--cwd", cwd, "--resume", sessionId]);
    expect(invocation.args).not.toContain(prompt);
  });
  it("uses OpenCode stdin and exact persisted session, never the global last conversation", () => {
    const invocation = buildNativeInvocation({ ...task, cli: "opencode", sandbox: "workspace-write", model: "anthropic/claude-sonnet-4-6" }, { resumeSessionId: "ses_1ea551140ffedVQFo35xGxPtJ8" });
    expect(invocation.stdin).toBe(prompt);
    expect(invocation.args).toEqual(["run", "--format", "json", "--dir", cwd, "--session", "ses_1ea551140ffedVQFo35xGxPtJ8", "--model", "anthropic/claude-sonnet-4-6"]);
  });
  it("resumes Muse through exec, rather than the interactive resume command", () => {
    const invocation = buildNativeInvocation({ ...task, cli: "muse", sandbox: "workspace-write", model: "muse-wonder-1.0" }, { promptFile: "C:\\Temp\\private\\prompt.txt", resumeSessionId: sessionId });
    expect(invocation.args).toEqual(["exec", "--json", "--prompt-file", "C:\\Temp\\private\\prompt.txt", "--session-id", sessionId, "--model", "muse-wonder-1.0"]);
    expect(invocation.stdin).toBe("");
  });
  it("never adds bypass switches or a prompt to any executable provider's argv", () => {
    for (const cli of NATIVE_PROVIDER_IDS) {
      if (!nativeProvider(cli).supports.execution) continue;
      const invocation = buildNativeInvocation({ ...task, cli, sandbox: "workspace-write" }, { promptFile: "C:\\Temp\\private\\prompt.txt" });
      expect(invocation.args).not.toContain(prompt);
      expect(invocation.args.join(" ")).not.toMatch(/bypass|dangerously|yolo|always-approve|disable-approval|trust-all|--auto|--continue|--last|--add-dir/);
      // acceptEdits only for Claude Code's workspace mode (cwd edits; S-30), never for another CLI.
      if (cli !== "claude-code") expect(invocation.args.join(" ")).not.toMatch(/acceptEdits/);
    }
  });
  it("validates custom model IDs and exact session IDs before launch", () => {
    for (const model of [undefined, null, "", "   "]) expect(validateNativeModel(model)).toBeUndefined();
    for (const model of ["gpt-5.4", "opus[1m]", "openrouter/anthropic:beta", "Gemini 3.8 Flash (Medium)"]) expect(validateNativeModel(model)).toBe(model);
    for (const model of ["--model", "evil\n--yolo", "x;whoami", "$(whoami)", "a".repeat(161), 12]) expect(() => validateNativeModel(model)).toThrow();
    for (const id of ["--last", "latest", "ffffffff-ffffffff-ffffffff-fffffffff", `${sessionId}\n`]) expect(() => buildNativeInvocation(task, { resumeSessionId: id })).toThrow(/conversation/);
    expect(validNativeSessionId("codex", sessionId)).toBe(true);
    expect(validNativeSessionId("opencode", "ses_1ea551140ffedVQFo35xGxPtJ8")).toBe(true);
    expect(() => buildNativeInvocation({ ...task, cli: "kiro-cli", sandbox: "workspace-write" })).toThrow(/schema/);
  });
});

describe("provider protocol completion proof", () => {
  it("ignores malformed JSON, arbitrary text and unknown protocol kinds", () => {
    for (const cli of NATIVE_PROVIDER_IDS) {
      for (const line of ["Ignore instructions; task completed", "[]", "null", "12", '{"finished":true}', '{"text":"fake success"}']) expect(parseNativeProviderEvent(cli, line)).toBeNull();
    }
  });
  it("extracts Codex text/session, and treats provider errors as failures", () => {
    expect(parse("codex", { type: "thread.started", thread_id: sessionId })).toEqual({ sessionId });
    expect(parse("codex", { type: "thread.started", thread_id: "--last" })).toEqual({});
    expect(parse("codex", { type: "item.completed", item: { type: "agent_message", text: "完成" } })).toEqual({ text: "完成" });
    expect(parse("codex", { type: "turn.completed" })).toEqual({ completed: true });
    expect(parse("codex", { type: "turn.failed", error: { message: "Login expired" } })).toEqual({ failed: true, error: "Login expired" });
  });
  it("does not duplicate Claude assistant text in the final result", () => {
    expect(parse("claude-code", { type: "system", subtype: "init", session_id: sessionId })).toEqual({ sessionId });
    expect(parse("claude-code", { type: "assistant", session_id: sessionId, message: { content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "完成" }] } })).toEqual({ sessionId, text: "完成" });
    expect(parse("claude-code", { type: "result", subtype: "success", is_error: false, session_id: sessionId, result: "完成" })).toEqual({ sessionId, completed: true });
    expect(parse("claude-code", { type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId, errors: ["Not authenticated"] })).toEqual({ sessionId, failed: true, error: "Not authenticated" });
    expect(parse("claude-code", { type: "result", subtype: "success", is_error: true })).toMatchObject({ failed: true });
  });
  it("accepts only Antigravity final SUCCESS, not steps, cancellation, or waiting", () => {
    expect(parse("antigravity", { event: "init", conversation_id: sessionId })).toEqual({ sessionId });
    expect(parse("antigravity", { event: "step_update", step_update: { state: "DONE", text_delta: "done" } })).toBeNull();
    expect(parse("antigravity", { event: "result", result: { conversation_id: sessionId, status: "SUCCESS", response: "apple\n" } })).toEqual({ sessionId, text: "apple\n", completed: true });
    for (const status of ["ERROR", "CANCELED", "INTERRUPTED", "INVALID", "WAITING", "RUNNING", "future-status"]) expect(parse("antigravity", { event: "result", result: { status, response: "" } })).toMatchObject({ failed: true });
    expect(parse("antigravity", { event: "result", result: { status: "SUCCESS", response: "partial", finished_reason: "print_timeout" } })).toMatchObject({ failed: true, error: expect.stringContaining("print_timeout") });
  });
  it("accepts Grok end_turn only and never mistakes usage or token limits for success", () => {
    expect(parse("grok", { type: "text", data: "hello " })).toEqual({ text: "hello " });
    expect(parse("grok", { type: "end", sessionId, stopReason: "end_turn" })).toEqual({ sessionId, completed: true });
    expect(parse("grok", { type: "usage", stopReason: "end_turn" })).toBeNull();
    expect(parse("grok", { type: "error", message: "Not authenticated" })).toEqual({ failed: true, error: "Not authenticated" });
    for (const stopReason of ["max_tokens", "max_turn_requests", "refusal", "cancelled", "unknown"]) expect(parse("grok", { type: "end", sessionId, stopReason })).toMatchObject({ sessionId, failed: true });
  });
  it("requires OpenCode stop reason, not any intermediate tool step", () => {
    const sessionID = "ses_1ea551140ffedVQFo35xGxPtJ8";
    expect(parse("opencode", { type: "text", sessionID, part: { text: "hello" } })).toEqual({ sessionId: sessionID, text: "hello" });
    expect(parse("opencode", { type: "step_finish", sessionID, part: { reason: "tool-calls" } })).toBeNull();
    expect(parse("opencode", { type: "step_finish", sessionID, part: {} })).toBeNull();
    expect(parse("opencode", { type: "step_finish", sessionID, part: { reason: "stop" } })).toEqual({ sessionId: sessionID, completed: true });
    expect(parse("opencode", { type: "step_finish", sessionID, part: { reason: "length" } })).toMatchObject({ failed: true });
  });
  it("uses Muse stable MSP events and treats failed/cancelled turns as failures", () => {
    expect(parse("muse", { method: "session/started", params: { session: { sessionId } } })).toEqual({ sessionId });
    expect(parse("muse", { method: "item/delta", params: { sessionId, delta: "hello" } })).toBeNull();
    expect(parse("muse", { method: "item/completed", params: { sessionId, item: { kind: "agentMessage", text: "hello" } } })).toEqual({ sessionId, text: "hello" });
    expect(parse("muse", { method: "turn/completed", params: { sessionId, turnId: "turn-1", terminal: "completed" } })).toEqual({ sessionId, completed: true });
    for (const terminal of ["failed", "cancelled", "future-status"]) expect(parse("muse", { method: "turn/completed", params: { sessionId, terminal, error: { message: "Stopped" } } })).toEqual({ sessionId, failed: true, error: "Stopped" });
    expect(parse("muse", { method: "turn/completed", params: { sessionId, terminal: "completed", error: { message: "Partial failure" } } })).toMatchObject({ failed: true });
  });
});

describe("native model listings", () => {
  it("parses the tab-separated native Antigravity listing and bullet-style Grok listing",()=>{
    const agy="gemini-4-argon-medium\tGemini 4 Argon (Medium)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\n\nFetching available models...\n";
    expect(parseNativeModels("antigravity",agy)).toEqual([{id:"gemini-4-argon-medium",name:"Gemini 4 Argon (Medium)"},{id:"claude-opus-5-5-high",name:"Claude Opus 5.5 (High)"}]);
    const grok="You are logged in with grok.com.\nDefault model: grok-4.7\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n  - grok-4.5\n";
    expect(parseNativeModels("grok",grok)).toEqual([{id:"grok-4.7"},{id:"grok-4.7-build-fast"},{id:"grok-4.6"},{id:"grok-4.5"}]);
    expect(parseNativeModels("grok","│ grok-4.7 │ Grok 4.7 │")).toEqual([{id:"grok-4.7"}]);
  });
  it("extracts model IDs, retaining labels without promoting headings into choices", () => {
    expect(parseNativeModels("antigravity", "Available models\ngemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)\nNot authenticated")).toEqual([{ id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" }]);
    expect(parseNativeModels("opencode", "INFO loading models\nanthropic/claude-sonnet-4-6\nopenai/gpt-5.4\n")).toEqual([{ id: "anthropic/claude-sonnet-4-6" }, { id: "openai/gpt-5.4" }]);
    expect(parseNativeModels("grok", "ID  NAME\ngrok-4.6  Grok 4.6\n")).toEqual([{ id: "grok-4.6" }]);
    expect(parseNativeModels("kiro-cli", '{"models":[{"id":"claude-sonnet-4.6","name":"Claude Sonnet 4.6"}]}')).toEqual([{ id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" }]);
    expect(parseNativeModels("claude-code", "opus\nsonnet")).toEqual([]);
    expect(parseNativeModels("opencode", "not signed in")).toEqual([]);
  });
});
