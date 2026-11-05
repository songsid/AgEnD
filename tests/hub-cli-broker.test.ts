import { afterEach, describe, expect, it, vi } from "vitest";
import { createHubModelBroker, documentArguments, documentTool, HUB_CLI_TOOLS, HubForbiddenModelTool,
  MODEL_WIRE_LIMIT, restrictedModelRequest, validateModelReply, type HubCliBackend } from "../src/hub/execution/model-broker.js";
import { hubContainerArguments, verifyHubContainer } from "../src/hub/execution/cli-provider.js";

afterEach(() => { vi.unstubAllGlobals(); });
const tools = [...HUB_CLI_TOOLS.map(name => ({ type: "function", name, input_schema: {} })), { name: "Bash" }, { type: "web_search" }, { type: "mcp", server_url: "https://outside.test" }];
const request = () => ({ tools, model: "injected", input: [{ role: "user", content: "question" }], messages: [{ role: "user", content: "question" }], instructions: "local instructions", previous_response_id: "foreign", background: true, headers: { authorization: "wrong" } });
const event = (type: string, value: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
function container() {
  return { Image: "sha256:" + "a".repeat(64), Config: { User: "65532:65532", Labels: { "org.agend.hub.question": "token" }, WorkingDir: "/scratch", Entrypoint: ["/usr/local/bin/node"], Cmd: ["/opt/agend/sandbox-runner.js"] }, Mounts: [],
    HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, Init: true, LogConfig: { Type: "none" }, Memory: 1073741824, MemorySwap: 1073741824, NanoCpus: 1_000_000_000, PidsLimit: 64,
      CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], CapAdd: [], PidMode: "", IpcMode: "private", UTSMode: "", Binds: [], Devices: [], DeviceRequests: [], PortBindings: {}, Tmpfs: { "/scratch": "rw,nosuid,nodev,noexec,size=67108864,mode=1777" } } };
}
describe("Hub CLI model and tool broker", () => {
  it.each(["claude", "codex"] as const)("rebuilds %s model requests with only approved tool schemas and local model", backend => {
    const body = restrictedModelRequest(backend, "local-model", request());
    expect(body.model).toBe("local-model"); expect(body.stream).toBe(true);
    expect((body.tools as { name: string }[]).map(t => t.name)).toEqual(HUB_CLI_TOOLS);
    expect(body).not.toHaveProperty("previous_response_id"); expect(body).not.toHaveProperty("background"); expect(body).not.toHaveProperty("headers");
    expect(JSON.stringify(body.tools)).not.toContain("Bash"); expect(JSON.stringify(body.tools)).not.toContain("outside.test");
    if (backend === "codex") expect(body.store).toBe(false);
  });
  it("refuses incomplete/unknown tool catalogs and model-side media fetch input", () => {
    expect(() => restrictedModelRequest("claude", "model", { ...request(), tools: [{ name: "Bash" }] })).toThrow();
    expect(() => restrictedModelRequest("codex", "model", { ...request(), input: [{ type: "input_image", image_url: "https://outside.test" }] })).toThrow();
    expect(() => restrictedModelRequest("claude", "model", { ...request(), messages: [{ role: "user", content: [{ type: "document", source: { type: "url", url: "https://outside.test" } }] }] })).toThrow();
    expect(() => restrictedModelRequest("claude", "model", { ...request(), system: [{ type: "image", source: { type: "url", url: "https://outside.test" } }] })).toThrow();
    for (const name of ["Bash", "read_file", "fetch", "mcp__other__documents_read", "documents.read"]) expect(() => documentTool(name)).toThrow();
    for (const args of [{ path: "/home/owner/.ssh/key" }, { documentId: "approved", url: "https://outside.test" }, { documentId: "../private" }]) expect(() => documentArguments("documents.read", args)).toThrow();
    expect(documentArguments("documents.read", { documentId: "approved" })).toEqual({ documentId: "approved" });
  });
  it("preserves only Codex's exact document namespace and validates namespaced results", () => {
    const input = request(); input.tools = [{ type: "namespace", name: "mcp__hub_documents", tools: [{ type: "function", name: "documents_list" }, { type: "function", name: "documents_read" }] }, ...tools] as typeof input.tools;
    const body = restrictedModelRequest("codex", "model", input);
    expect(body.tools).toMatchObject([{ type: "namespace", name: "mcp__hub_documents", tools: [{ name: "documents_list" }, { name: "documents_read" }] }]);
    const safe = event("response.output_item.done", { item: { type: "function_call", namespace: "mcp__hub_documents", name: "documents_read", arguments: '{"documentId":"approved"}' } }) + event("response.completed");
    expect(() => validateModelReply("codex", { body: safe, contentType: "text/event-stream" })).not.toThrow();
    expect(() => validateModelReply("codex", { body: safe.replaceAll('"mcp__hub_documents"', '"other"'), contentType: "text/event-stream" })).toThrow();
  });
  it("validates entire Claude SSE before any native dispatch and retains exact denied arguments", () => {
    const body = event("message_start", { message: { type: "message", content: [] } })
      + event("content_block_start", { index: 0, content_block: { type: "tool_use", name: "Bash", id: "bad", input: {} } })
      + event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"cat /home/owner/.ssh/key"}' } })
      + event("message_stop");
    try { validateModelReply("claude", { body, contentType: "text/event-stream" }); throw Error("expected denial"); }
    catch (error) { expect(error).toBeInstanceOf(HubForbiddenModelTool); expect(error).toMatchObject({ tool: "Bash", args: { command: "cat /home/owner/.ssh/key" } }); }
  });
  it.each(["exec_command", "apply_patch", "custom_tool_call", "web_search_call", "mcp_call", "computer_call", "spawn_agent", "future_native_tool"])("refuses a forced Codex %s call, including an otherwise-valid streamed prefix", type => {
    const item = type === "exec_command" || type === "spawn_agent" ? { type: "function_call", name: type, arguments: '{"cmd":"probe"}' } : { type, name: type };
    const body = event("response.output_text.delta", { delta: "innocent prefix" }) + event("response.output_item.done", { item }) + event("response.completed");
    expect(() => validateModelReply("codex", { body, contentType: "text/event-stream" })).toThrow(HubForbiddenModelTool);
  });
  it("preserves custom tool names, exact raw inputs and unparseable arguments in local proposals", () => {
    const custom = { type: "custom_tool_call", name: "apply_patch", input: "*** exact patch ***" };
    try { validateModelReply("codex", { contentType: "text/event-stream", body: event("response.output_item.done", { item: custom }) + event("response.completed") }); throw Error("expected refusal"); }
    catch (error) { expect(error).toBeInstanceOf(HubForbiddenModelTool); expect(error).toMatchObject({ tool: "apply_patch", args: { input: custom.input } }); }
    const invalid = { type: "function_call", name: "exec_command", arguments: "{not valid JSON" };
    try { validateModelReply("codex", { contentType: "text/event-stream", body: event("response.output_item.done", { item: invalid }) + event("response.completed") }); throw Error("expected refusal"); }
    catch (error) { expect(error).toMatchObject({ tool: "exec_command", args: { unparsedArguments: invalid.arguments } }); }
    expect(() => validateModelReply("codex", { contentType: "text/event-stream", body: event("response.output_item.done", { item: { ...invalid, name: "x".repeat(257) } }) + event("response.completed") })).toThrow();
  });
  it.each(["claude", "codex"] as const)("requires a complete bounded %s response and accepts a permitted document call", backend => {
    const type = backend === "claude" ? "tool_use" : "function_call", call = { type, name: HUB_CLI_TOOLS[1], arguments: '{"documentId":"approved"}', input: { documentId: "approved" } };
    const body = backend === "claude" ? event("content_block_start", { index: 0, content_block: call }) + event("message_stop")
      : event("response.output_item.done", { item: call }) + event("response.completed");
    const reply = { body, contentType: "text/event-stream" as const };
    expect(validateModelReply(backend, reply)).toBe(reply);
    expect(() => validateModelReply(backend, { ...reply, body: body.split("event:").slice(0, -1).join("event:") })).toThrow();
    expect(() => validateModelReply(backend, { ...reply, body: "x".repeat(MODEL_WIRE_LIMIT + 1) })).toThrow();
  });
  it("refuses conflicting event framing and duplicate JSON discriminators", () => {
    expect(() => validateModelReply("claude", { body: 'event: content_block_start\ndata: {"type":"message_stop","content_block":{"name":"Bash"}}\n\n', contentType: "text/event-stream" })).toThrow();
    expect(() => validateModelReply("claude", { body: 'event: message_stop\ndata: {"type":"message_stop","type":"content_block_start"}\n\n', contentType: "text/event-stream" })).toThrow();
  });
  it.each(["claude", "codex"] as const)("refuses lone CR and mixed CR framing for %s before forwarding native tool events", backend => {
    const bad = backend === "claude"
      ? event("content_block_start", { index: 0, content_block: { type: "tool_use", name: "Bash", input: { command: "probe" } } })
      : event("response.output_item.done", { item: { type: "function_call", name: "exec_command", arguments: '{"cmd":"probe"}' } });
    const done = event(backend === "claude" ? "message_stop" : "response.completed");
    const crBad = bad.replaceAll("\n", "\r");
    for (const body of [bad + done, (bad + done).replaceAll("\n", "\r\n"), (bad + done).replaceAll("\n", "\r"),
      `: comment\r${crBad}${done}`, `: comment\r\n${crBad}${done}`, `${done}${crBad}${done}`]) {
      expect(() => validateModelReply(backend, { body, contentType: "text/event-stream" })).toThrow();
    }
    for (const body of [done, done.replaceAll("\n", "\r\n")]) {
      const reply = { body, contentType: "text/event-stream" as const }; expect(validateModelReply(backend, reply)).toBe(reply);
    }
    expect(() => validateModelReply(backend, { body: done.replaceAll("\n", "\r"), contentType: "text/event-stream" })).toThrow();
  });
  it("keeps credentials outside the container and restricts network to fixed HTTPS API endpoints without redirects", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(event("message_stop"), { status: 200, headers: { "content-type": "text/event-stream" } })); vi.stubGlobal("fetch", fetcher);
    const broker = createHubModelBroker({ claude: "FAKE-CLAUDE-CREDENTIAL", codex: "FAKE-CODEX-CREDENTIAL" });
    for (const backend of ["claude", "codex"] as HubCliBackend[]) await broker(backend, { model: "local-model" }, new AbortController().signal);
    expect(fetcher.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages"); expect(fetcher.mock.calls[1][0]).toBe("https://api.openai.com/v1/responses");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error", headers: { "x-api-key": "FAKE-CLAUDE-CREDENTIAL" } });
    expect(fetcher.mock.calls[1][1]).toMatchObject({ headers: { authorization: "Bearer FAKE-CODEX-CREDENTIAL" } });
    fetcher.mockImplementationOnce(async () => new Response("", { status: 302 })); await expect(broker("claude", {}, new AbortController().signal)).rejects.toThrow();
    fetcher.mockImplementationOnce(async () => new Response("x".repeat(MODEL_WIRE_LIMIT + 1), { headers: { "content-type": "text/event-stream" } })); await expect(broker("claude", {}, new AbortController().signal)).rejects.toThrow();
  });
});
describe("Hub container isolation verification", () => {
  it("accepts the enforced control and never mounts a host path, pulls, grants privilege or uses a shell", () => {
    const c = container(); expect(() => verifyHubContainer(c, c.Image, "token")).not.toThrow();
    const args = hubContainerArguments(c.Image, "owned-name", "token", "context"); expect(args).toContain("--pull=never"); expect(args).toContain("--network=none");
    expect(args).not.toContain("--privileged"); expect(args).not.toContain("--volume"); expect(args).not.toContain("--mount");
    expect(args.at(-1)).toBe("/opt/agend/sandbox-runner.js");
  });
  it.each(["NetworkMode", "ReadonlyRootfs", "Privileged", "Init", "Memory", "MemorySwap", "NanoCpus", "PidsLimit", "CapDrop", "SecurityOpt", "Binds", "Devices", "DeviceRequests", "PortBindings", "Tmpfs", "LogConfig", "PidMode"])("refuses a weaker actual %s setting before starting", field => {
    const c = container(), h = c.HostConfig as Record<string, unknown>;
    h[field] = ({ NetworkMode: "host", ReadonlyRootfs: false, Privileged: true, Init: false, Memory: 0, MemorySwap: -1, NanoCpus: 0, PidsLimit: 0, CapDrop: [], SecurityOpt: [], Binds: ["/home:/home"], Devices: [{}], DeviceRequests: [{}], PortBindings: { "80/tcp": [] }, Tmpfs: {}, LogConfig: { Type: "json-file" }, PidMode: "host" } as Record<string, unknown>)[field];
    expect(() => verifyHubContainer(c, c.Image, "token")).toThrow();
  });
});
