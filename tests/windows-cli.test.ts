import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/child-process.js", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
import { spawn } from "../src/child-process.js";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WindowsCliBridge } from "../src/windows-cli.js";
import { codexTaskArgs, codexEventText, validateNativeTask, validWindowsDirectory } from "../src/windows-cli-worker.js";
import { nativeProvider, type NativeProviderId } from "../src/windows-cli-providers.js";

const input = { requestId: "12345678-1234-4321-abcd-123456789012", cli: "codex", cwd: "J:\\Project\\Game", prompt: 'Read a file; do not execute: $(whoami) & "quoted"', sandbox: "read-only" } as const;
const launcher = async () => ({ executable: "/native/node.exe", args: ["C:\\AgEnD\\worker.js"] });
/** M-2239 P1-2: a task runs only a CLI the last detection found runnable — the task tests start from one. */
const DETECTED_DIR = mkdtempSync(join(tmpdir(), "agend-windows-inventory-"));
const DETECTED = join(DETECTED_DIR, "windows-cli-inventory.json");
writeFileSync(DETECTED, JSON.stringify({ home: "C:\\Users\\Test", probedAt: 1, clis: ["codex", "claude-code", "antigravity", "grok", "opencode", "muse"]
  .map(id => ({ id, path: `C:\\${id}.exe`, version: "1.0", authenticated: true, runnable: true, readOnlySupport: true, supports: nativeProvider(id as NativeProviderId).supports, models: [] })) }));
const conversationId = "87654321-4321-4321-abcd-123456789012";
const differentConversationId = "87654321-4321-4321-abcd-123456789013";
const providerCases: Array<{
  cli: NativeProviderId; model: string; output: string;
  success: (id: string) => unknown[]; failure: unknown;
}> = [
  { cli: "claude-code", model: "sonnet", output: "Windows works\n", success: id => [
    { type: "system", subtype: "init", session_id: id },
    { type: "assistant", session_id: id, message: { content: [{ type: "text", text: "Windows works" }] } },
    { type: "result", subtype: "success", is_error: false, session_id: id, result: "Windows works" },
  ], failure: { type: "result", subtype: "error_during_execution", is_error: true, errors: ["Login expired"] } },
  { cli: "antigravity", model: "gemini-3.8-flash-medium", output: "Windows works\n", success: id => [
    { event: "init", conversation_id: id },
    { event: "result", result: { conversation_id: id, status: "SUCCESS", response: "Windows works" } },
  ], failure: { event: "result", result: { status: "ERROR", error: "Login expired" } } },
  { cli: "grok", model: "grok-4.6", output: "Windows works", success: id => [
    { type: "text", data: "Windows " }, { type: "text", data: "works" },
    { type: "end", sessionId: id, stopReason: "end_turn" },
  ], failure: { type: "error", message: "Login expired" } },
  { cli: "muse", model: "muse-wonder-1.0", output: "Windows works\n", success: id => [
    { method: "session/started", params: { session: { sessionId: id } } },
    { method: "item/completed", params: { sessionId: id, item: { kind: "agentMessage", text: "Windows works" } } },
    { method: "turn/completed", params: { sessionId: id, terminal: "completed" } },
  ], failure: { method: "turn/completed", params: { terminal: "failed", error: { message: "Login expired" } } } },
];
class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); kill = vi.fn();
  send(value: unknown) { this.stdout.write(JSON.stringify(value) + "\n"); }
  close() { this.emit("close", 0); }
}
let child: FakeChild;
beforeEach(() => { vi.clearAllMocks(); child = new FakeChild(); vi.mocked(spawn).mockReturnValue(child as never); });
async function launched() { await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1)); }

describe("trusted native execution metadata",()=>{
  it("forwards a scoped MCP capability and task context only to the worker pipe",async()=>{
    const service=new WindowsCliBridge(launcher,DETECTED),mcp={endpoint:"http://127.0.0.1:19280/agent",token:"a".repeat(64),tools:["query_task"]},context="trusted task context";
    service.start(input,()=>true,{mcp,context});await launched();
    expect(JSON.parse(child.stdin.read().toString())).toEqual({op:"run",task:input,mcp,context});
    expect(JSON.stringify(service.list())).not.toContain(mcp.token);expect(JSON.stringify(service.get(input.requestId))).not.toContain(context);
    child.send({type:"finished",code:1});child.close();
  });
  it("rejects a public MCP or context injection before starting a Windows process",()=>{
    const service=new WindowsCliBridge(launcher);
    expect(()=>service.start({...input,mcp:{endpoint:"http://evil.example/agent"}})).toThrow();
    expect(()=>service.start({...input,context:"fake sender"})).toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
  it("requires scoped MCP support in the last explicit detection without starting a new probe",()=>{
    const file=join(DETECTED_DIR,"no-mcp.json"),inventory=JSON.parse(readFileSync(DETECTED,"utf8"));
    inventory.clis[0].supports.mcp=false;writeFileSync(file,JSON.stringify(inventory));
    const service=new WindowsCliBridge(launcher,file),mcp={endpoint:"http://127.0.0.1:19280/agent",token:"a".repeat(64),tools:["query_task"]};
    expect(()=>service.start(input,()=>true,{mcp})).toThrow(/detect it again.*MCP/);
    expect(spawn).not.toHaveBeenCalled();expect(service.hasActiveTask()).toBe(false);
  });
});

describe("managed Windows workspace transport", () => {
  const id=input.requestId, cwd=`C:\\Users\\Test\\.agend\\workspaces\\${id}`;
  it("creates a per-agent workspace through a UUID-only request without discovering a CLI", async () => {
    const service=new WindowsCliBridge(launcher), pending=service.prepareWorkspace(id);
    await launched();
    expect(JSON.parse(child.stdin.read().toString())).toEqual({op:"workspace",agentId:id});
    expect(spawn).toHaveBeenCalledWith("/native/node.exe",["C:\\AgEnD\\worker.js"],{stdio:["pipe","pipe","pipe"]});
    child.send({type:"workspace",agentId:id,cwd});child.close();
    expect(await pending).toBe(cwd);expect(service.list()).toEqual([]);
  });
  it("refuses arbitrary directory segments before starting Windows", async () => {
    const service=new WindowsCliBridge(launcher);
    for(const id of ["../escape","--last","C:\\elsewhere",`${input.requestId}\\child`])await expect(service.prepareWorkspace(id)).rejects.toThrow(/agent id/);
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each([
    {type:"workspace",agentId:differentConversationId,cwd},
    {type:"workspace",agentId:id,cwd:"C:\\elsewhere"},
    {type:"workspace",agentId:id,cwd:`C:\\other\\workspaces\\${id}`},
    {type:"workspace",agentId:id,cwd:`\\\\server\\.agend\\workspaces\\${id}`},
    {type:"probe",home:"C:\\Users\\Test",clis:[]},
  ])("refuses malformed workspace results %#", async value => {
    const service=new WindowsCliBridge(launcher), pending=service.prepareWorkspace(id), rejected=expect(pending).rejects.toThrow(/workspace/);
    await launched(); child.send(value);child.close(); await rejected;
  });
  it("rechecks authorization after native transport discovery and before directory creation", async () => {
    let finish!:(value:Awaited<ReturnType<typeof launcher>>)=>void, allowed=true;
    const service=new WindowsCliBridge(()=>new Promise(resolve=>{finish=resolve;}));
    const pending=service.prepareWorkspace(id,()=>allowed);allowed=false;finish(await launcher());
    await expect(pending).rejects.toThrow(/Authorization expired/);expect(spawn).not.toHaveBeenCalled();
  });
  it("does not return a native path after authorization expires while the worker is active", async () => {
    let allowed=true;const service=new WindowsCliBridge(launcher), pending=service.prepareWorkspace(id,()=>allowed);
    await launched();allowed=false;child.send({type:"workspace",agentId:id,cwd});child.close();
    await expect(pending).rejects.toThrow(/Authorization expired/);
  });
});

describe("Windows CLI detection (M-2239 P1-2: only on an explicit refresh)", () => {
  const result = (version = "1.0") => ({ home: "C:\\User", clis: [{ id: "codex", path: "C:\\codex.exe", version, authenticated: true, runnable: true, models: [{ id: "gpt-test" }] }] });
  const complete = async (worker: FakeChild, version = "1.0") => {
    // Let the async launcher finish before replying to its worker.
    await Promise.resolve();
    worker.send({ type: "probe", ...result(version) }); worker.close();
  };
  it("a plain read starts nothing: before any detection it says so", async () => {
    const service = new WindowsCliBridge(launcher);
    expect(await service.probe()).toEqual({ clis: [], home: "", probedAt: null });
    expect(await service.probe({ force: false })).toEqual({ clis: [], home: "", probedAt: null });
    expect(spawn).not.toHaveBeenCalled();
  });
  it("Detect again runs once; concurrent reads join it; later reads return it, starting nothing, as independent copies", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(5_000);
    try {
      const service = new WindowsCliBridge(launcher);
      const forced = service.probe({ force: true }), alsoForced = service.probe({ force: true }), joined = service.probe();
      await complete(child);
      const [a, b, c] = await Promise.all([forced, alsoForced, joined]);
      for (const value of [a, b, c]) expect(value).toEqual({ ...result(), probedAt: 5_000 });
      expect(spawn).toHaveBeenCalledOnce();
      a.home = "mutated"; a.clis[0]!.models[0]!.id = "mutated";
      clock.mockReturnValue(5_000 + 24 * 3_600_000);   // a day later: still no timer, no expiry
      expect(await service.probe()).toEqual({ ...result(), probedAt: 5_000 });
      expect(spawn).toHaveBeenCalledOnce();
    } finally { clock.mockRestore(); }
  });
  it("the detection is kept on disk (0600) and a restarted bridge reads it without starting anything", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "agend-windows-inventory-")), "windows-cli-inventory.json");
    const service = new WindowsCliBridge(launcher, file), forced = service.probe({ force: true });
    await complete(child); const value = await forced;
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(value);
    // Native Windows does not expose POSIX mode bits; keep the 0600 guarantee checked on POSIX hosts.
    if(process.platform!=="win32")expect(statSync(file).mode & 0o777).toBe(0o600);
    vi.mocked(spawn).mockClear();
    expect(await new WindowsCliBridge(launcher, file).probe()).toEqual(value);
    expect(spawn).not.toHaveBeenCalled();
  });
  it("does not keep a failed detection; the previous one stays, and a retry can succeed", async () => {
    const service = new WindowsCliBridge(launcher), initial = service.probe({ force: true });
    await complete(child); const before = await initial;
    const broken = new FakeChild(); vi.mocked(spawn).mockReturnValueOnce(broken as never);
    const failed = service.probe({force:true});
    const rejected = expect(failed).rejects.toThrow("probe failed");
    await Promise.resolve(); broken.send({ type:"error",message:"probe failed" }); broken.close(); await rejected;
    expect(await service.probe()).toEqual(before);
    const recovered = new FakeChild(); vi.mocked(spawn).mockReturnValueOnce(recovered as never);
    const retry = service.probe({ force: true }); await complete(recovered,"2.0");
    expect((await retry).clis[0]!.version).toBe("2.0"); expect(spawn).toHaveBeenCalledTimes(3);
  });
  it("#2937 review: a forced detection whose authority is revoked during the transport lookup starts nothing", async () => {
    let finish!: (value: Awaited<ReturnType<typeof launcher>>) => void, allowed = true;
    const service = new WindowsCliBridge(() => new Promise(resolve => { finish = resolve; }));
    const pending = service.probe({ force: true }, () => allowed);
    allowed = false; finish(await launcher());
    await expect(pending).rejects.toThrow(/Authorization expired/);
    expect(spawn).not.toHaveBeenCalled();
    expect(await service.probe()).toEqual({ clis: [], home: "", probedAt: null });
  });

  it("a task starts no detection: it runs only a CLI the last detection found runnable", async () => {
    const none = new WindowsCliBridge(launcher);
    expect(() => none.start(input)).toThrow(/Detect the Windows CLIs first/);
    const file = join(mkdtempSync(join(tmpdir(), "agend-windows-inventory-")), "windows-cli-inventory.json");
    writeFileSync(file, JSON.stringify({ home: "C:\\U", probedAt: 1, clis: [
      { id: "codex", path: "C:\\codex.exe", runnable: false, readOnlySupport: true, reason: "Sign in to this Windows CLI before running a task", models: [] },
      { id: "grok", path: "C:\\grok.exe", runnable: true, readOnlySupport: false, models: [] },
    ] }));
    const service = new WindowsCliBridge(launcher, file);
    expect(() => service.start(input)).toThrow(/Sign in to this Windows CLI/);
    expect(() => service.start({ ...input, cli: "claude-code" })).toThrow(/Detect the Windows CLIs first/);
    expect(service.hasActiveTask()).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("native request boundary", () => {
  it("keeps a prompt out of shell source and argv, including quotes and shell punctuation", () => {
    const parsed = validateNativeTask(input);
    const args = codexTaskArgs(parsed);
    expect(args).toEqual(["-c", "check_for_update_on_startup=false", "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-C", input.cwd, "-"]);
    expect(args.join(" ")).not.toContain(input.prompt);
    expect(args.join(" ")).not.toMatch(/bypass|dangerously|full-auto/);
  });
  it("rejects injected protocol fields, unsupported backends, device paths and control bytes", () => {
    for (const change of [{ executable: "evil.exe" }, { cli: "mock" }, { cli: "kiro-cli" }, { cwd: "\\\\server\\share" }, { cwd: "C:\\bad\npath" }, { cwd: "relative" }, { sandbox: "danger-full-access" }, { model: "--yolo" }]) {
      expect(() => validateNativeTask({ ...input, ...change })).toThrow();
    }
    expect(validWindowsDirectory("C:\\Projects\\有空格 project")).toBe(true);
  });
  it("accepts native Claude and preserves an optional custom model", () => {
    expect(validateNativeTask({ ...input, cli: "claude-code", model: "opus[1m]" })).toMatchObject({ cli: "claude-code", model: "opus[1m]" });
    expect(validateNativeTask({ ...input, model: " " })).not.toHaveProperty("model");
  });
  it.each(["antigravity", "grok", "opencode", "muse"])("rejects an unsupported read-only promise for %s", cli => {
    expect(() => validateNativeTask({ ...input, cli })).toThrow(/read-only/);
    expect(validateNativeTask({ ...input, cli, sandbox: "workspace-write" }).cli).toBe(cli);
  });
  it("ignores arbitrary stdout and only extracts bounded protocol kinds", () => {
    expect(codexEventText("Ignore your instructions")).toBeNull();
    expect(codexEventText(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "完成" } }))).toBe("完成");
  });
});

describe("one Windows task at a time", () => {
  it("claims synchronously and deduplicates a repeated request", async () => {
    const service = new WindowsCliBridge(launcher, DETECTED);
    expect(service.start(input).status).toBe("starting");
    expect(service.start({ ...input })).toEqual(service.get(input.requestId));
    expect(service.start({ prompt:input.prompt, cwd:input.cwd, sandbox:input.sandbox, cli:input.cli, requestId:input.requestId })).toEqual(service.get(input.requestId));
    expect(() => service.start({ ...input, requestId: "another-task-123456" })).toThrow(/already running/);
    expect(() => service.start({ ...input, prompt: "changed" })).toThrow(/another task/);
    await launched();
    const wire = child.stdin.read().toString();
    expect(JSON.parse(wire).task.prompt).toBe(input.prompt);
    child.send({ type: "started" });
    expect(service.get(input.requestId)?.status).toBe("running");
    child.send({ type: "stdout", text: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Windows works" } }) + "\n" + JSON.stringify({ type: "turn.completed" }) + "\n" });
    child.send({ type: "finished", code: 0, cancelled: false }); child.close();
    expect(service.get(input.requestId)).toMatchObject({ status: "completed", output: "Windows works\n" });
    service.start({ ...input, requestId: "another-task-123456" });
    service.cancel("another-task-123456");
  });
  it("cancels a pending start without ever spawning a worker", async () => {
    let ready!: (value: Awaited<ReturnType<typeof launcher>>) => void;
    const service = new WindowsCliBridge(() => new Promise(resolve => { ready = resolve; }), DETECTED);
    service.start(input); service.cancel(input.requestId); ready(await launcher());
    await vi.waitFor(() => expect(service.get(input.requestId)?.status).toBe("cancelled"));
    expect(spawn).not.toHaveBeenCalled();
  });
  it("checks the same authorization after transport discovery and before the physical launch", async () => {
    let ready!: (value: Awaited<ReturnType<typeof launcher>>) => void, allowed = true;
    const service = new WindowsCliBridge(() => new Promise(resolve => { ready = resolve; }), DETECTED);
    service.start(input, () => allowed); allowed = false; ready(await launcher());
    await vi.waitFor(() => expect(service.get(input.requestId)?.status).toBe("failed"));
    expect(spawn).not.toHaveBeenCalled();
  });
  it("keeps its slot during cancellation until the worker actually exits", async () => {
    const service = new WindowsCliBridge(launcher, DETECTED); service.start(input); await launched();
    service.cancel(input.requestId);
    expect(service.get(input.requestId)?.status).toBe("cancelling");
    expect(() => service.start({ ...input, requestId: "another-task-123456" })).toThrow(/running/);
    expect(child.stdin.read().toString()).toContain('{"cancel":true}');
    child.send({ type: "finished", code: 1, cancelled: true }); child.close();
    expect(service.get(input.requestId)?.status).toBe("cancelled");
  });
  it("#2945 CI: between the worker's finished line and its close, a snapshot is still running and a cancel cannot overwrite the outcome", async () => {
    const service = new WindowsCliBridge(launcher, DETECTED); service.start(input); await launched();
    child.stdin.read();
    child.send({ type: "started" });
    child.send({ type: "stdout", text: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\n" + JSON.stringify({ type: "turn.completed" }) + "\n" });
    child.send({ type: "finished", code: 0, cancelled: false });                    // not closed yet
    const between = service.get(input.requestId)!;
    expect(between.status).toBe("running"); expect(between.finishedAt).toBeUndefined();
    expect(service.list()[0].status).toBe("running");
    expect(service.cancel(input.requestId).status).toBe("running");               // the outcome is already decided
    expect(child.stdin.read().toString()).toContain('{"cancel":true}');            // the cancel is still sent
    child.close();
    expect(service.get(input.requestId)).toMatchObject({ status: "completed", outcomeConfirmed: true, output: "done\n" });
    expect(service.get(input.requestId)?.finishedAt).toEqual(expect.any(Number));
  });
  it("#2945 CI: a failure decided before close is published only with finishedAt", async () => {
    const service = new WindowsCliBridge(launcher, DETECTED); service.start(input); await launched();
    child.stdin.read(); child.send({ type: "started" });
    child.send({ type: "error", message: "provider failed", terminal: true });
    expect(service.get(input.requestId)?.status).toBe("running");
    child.close();
    expect(service.get(input.requestId)).toMatchObject({ status: "failed", error: "provider failed" });
  });
  it("does not report an exit code alone as a completed AI turn", async () => {
    const service = new WindowsCliBridge(launcher, DETECTED); service.start(input); await launched();
    child.send({ type: "finished", code: 0, cancelled: false }); child.close();
    expect(service.get(input.requestId)).toMatchObject({ status: "failed", error: expect.stringContaining("unknown") });
  });
  it("keeps a provider-reported failure even if the process exits zero", async () => {
    const service = new WindowsCliBridge(launcher, DETECTED); service.start(input); await launched();
    child.send({ type: "stdout", text: JSON.stringify({ type: "turn.failed", error: { message: "Login expired" } }) + "\n" });
    child.send({ type: "finished", code: 0, cancelled: false }); child.close();
    expect(service.get(input.requestId)).toMatchObject({ status: "failed", error: "Login expired" });
  });
  it("does not free an uncertain worker's reservation or resend the same task", async () => {
    const service = new WindowsCliBridge(launcher, DETECTED); service.start(input); await launched(); child.close();
    expect(service.get(input.requestId)?.status).toBe("failed");
    service.start(input);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(() => service.start({ ...input, requestId: "another-task-123456" })).toThrow(/running/);
  });
});

describe.each(providerCases)("$cli task orchestration", ({ cli, model, output, success, failure }) => {
  const nativeInput = { ...input, cli, model, sandbox: "workspace-write" } as const;
  const stdout = (events: unknown[], trailingNewline = true): void => {
    child.send({ type: "stdout", text: events.map(event => JSON.stringify(event)).join("\n") + (trailingNewline ? "\n" : "") });
  };
  const finish = (): void => { child.send({ type: "finished", code: 0, cancelled: false }); child.close(); };

  it("passes cli/model to the worker, captures output once and saves its exact conversation", async () => {
    const settled = vi.fn(), service = new WindowsCliBridge(launcher, DETECTED);
    service.start(nativeInput, () => true, { onSettled: settled }); await launched();
    expect(JSON.parse(child.stdin.read().toString()).task).toMatchObject({ cli, model, prompt: input.prompt });
    child.send({ type: "started" }); stdout(success(conversationId)); finish();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    expect(service.get(input.requestId)).toMatchObject({ cli, model, status: "completed", threadId: conversationId, output, outcomeConfirmed: true });
    expect(settled.mock.calls[0][0]).toMatchObject({ cli, model, status: "completed", threadId: conversationId });
  });
  it("keeps a provider failure even if the worker reports a zero process exit", async () => {
    const service = new WindowsCliBridge(launcher, DETECTED); service.start(nativeInput); await launched();
    stdout([failure]); finish();
    expect(service.get(input.requestId)).toMatchObject({ status: "failed", error: "Login expired", outcomeConfirmed: true });
  });
  it("resumes only the explicitly requested conversation", async () => {
    const service = new WindowsCliBridge(launcher, DETECTED);
    service.start(nativeInput, () => true, { resumeSessionId: conversationId }); await launched();
    expect(JSON.parse(child.stdin.read().toString()).resumeSessionId).toBe(conversationId);
    stdout(success(conversationId)); finish();
    expect(service.get(input.requestId)).toMatchObject({ status: "completed", threadId: conversationId });
  });
  it("cannot succeed when the CLI reports a different resumed conversation", async () => {
    const service = new WindowsCliBridge(launcher, DETECTED);
    service.start(nativeInput, () => true, { resumeSessionId: conversationId }); await launched();
    stdout(success(differentConversationId)); finish();
    expect(service.get(input.requestId)).toMatchObject({ status: "failed", error: expect.stringContaining("different conversation") });
    expect(service.get(input.requestId)?.threadId).not.toBe(differentConversationId);
  });
  it("parses a final provider event without a trailing newline before finishing", async () => {
    const service = new WindowsCliBridge(launcher, DETECTED); service.start(nativeInput); await launched();
    const wire = success(conversationId).map(event => JSON.stringify(event)).join("\n");
    // Subprocess stdout may split inside a JSON object, independent of provider events.
    child.send({ type: "stdout", text: wire.slice(0, 19) });
    child.send({ type: "stdout", text: wire.slice(19) }); finish();
    expect(service.get(input.requestId)).toMatchObject({ status: "completed", threadId: conversationId, output });
  });
});
