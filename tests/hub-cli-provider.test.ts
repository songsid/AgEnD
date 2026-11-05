/** Inert Docker/process transport. Real binaries are exercised only by the isolated manual acceptance rig. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { HubExecutionGateway } from "../src/hub/execution/service.js";
const state = vi.hoisted(() => ({ commands: [] as any[], processes: [] as any[], containers: new Map<string, any>(),
  socket: true, socketThrows: false, engine: "linux/x86_64", engineFails: false, imageFails: false, imageId: "sha256:" + "a".repeat(64), imageArchitecture: "amd64", imageVersion: "2.1.316", holdCreate: null as Promise<void> | null, skipInput: false, wrongInput: false, tool: false, toolName: "mcp__hub_documents__documents_read", toolArgs: { documentId: "approved" } as unknown,
  proposal: false, badExit: false, cleanupFails: false, cleanupRemovedThenFails: false, listFails: false, weaken: false, outputFlood: false }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), lstatSync: () => { if (state.socketThrows) throw Error("PRIVATE-SOCKET-PATH"); return { isSocket: () => state.socket }; } }));
vi.mock("../src/child-process.js", async () => {
  const { EventEmitter } = await import("node:events"), { PassThrough } = await import("node:stream");
  const execFile = () => {};
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), { value: async (cmd: string, all: string[], options: any) => {
    const args = all.slice(2); state.commands.push({ cmd, all, args, options });
    let stdout = "";
    if (args[0] === "info") { if (state.engineFails) throw Error("PRIVATE-DOCKER-ERROR"); stdout = state.engine; }
    else if (args[0] === "image") { if (state.imageFails) throw Error("PRIVATE-IMAGE-PATH"); stdout = JSON.stringify([{ Id: state.imageId, Architecture: state.imageArchitecture, Config: { Labels: { "org.agend.hub.protocol": "1", "org.agend.hub.claude": state.imageVersion, "org.agend.hub.codex": "0.166.0" } } }]); }
    else if (args[0] === "create") {
      await state.holdCreate;
      const id = (state.containers.size + 1).toString(16).padStart(64, "0"), token = args[args.indexOf("--label") + 1].split("=")[1];
      state.containers.set(id, { Id: id, Image: "sha256:" + "a".repeat(64), Config: { User: "65532:65532", WorkingDir: "/scratch", Entrypoint: ["/usr/local/bin/node"], Cmd: ["/opt/agend/sandbox-runner.js"], Labels: { "org.agend.hub.question": token, "org.agend.hub.context": args[args.indexOf(`org.agend.hub.question=${token}`) + 2].split("=")[1] } }, Mounts: [],
        HostConfig: { NetworkMode: state.weaken ? "host" : "none", ReadonlyRootfs: true, Privileged: false, Init: true, LogConfig: { Type: "none" }, Memory: 1073741824, MemorySwap: 1073741824, NanoCpus: 1_000_000_000, PidsLimit: 64, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], Tmpfs: { "/scratch": "rw,nosuid,nodev,noexec,size=67108864,mode=1777" } } }); stdout = id;
    } else if (args[0] === "container" && args[1] === "ls") {
      if (state.listFails) throw Error("cannot confirm absence");
      const id = args[args.indexOf("--filter") + 1].slice(3); stdout = state.containers.has(id) ? id : "";
    } else if (args[0] === "container") stdout = JSON.stringify([state.containers.get(args.at(-1)!)]);
    else if (args[0] === "rm") {
      if (state.cleanupFails) throw Error("unavailable");
      const id = args.at(-1)!; state.containers.delete(id); state.processes.find(p => p.id === id)?.kill(); if (state.cleanupRemovedThenFails) throw Error("lost removal response"); stdout = id;
    } else throw Error("unexpected command");
    return { stdout, stderr: "" };
  } });
  const spawn = (cmd: string, args: string[], options: any) => {
    const p: any = new EventEmitter(); p.id = args.at(-1); p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.dead = false;
    const frame = (v: unknown) => p.stdout.write(JSON.stringify(v) + "\n");
    const exit = (code: number) => { if (!p.dead) { p.dead = true; p.emit("close", code); } };
    p.kill = () => { exit(137); return true; }; state.processes.push(p); state.commands.push({ cmd, args, options, spawn: true });
    const final = () => { frame({ type: "answer", text: JSON.stringify({ answer: "approved answer", proposal: state.proposal ? { action: "delete sample", arguments: { target: "sample" }, consequences: "The sample would be removed." } : null }) }); queueMicrotask(() => exit(state.badExit ? 1 : 0)); };
    p.stdin.on("data", (b: Buffer) => {
      for (const line of b.toString().trim().split("\n")) {
        const v = JSON.parse(line);
        if (v.type === "start") {
          p.input = v;
          if (state.outputFlood) { p.stdout.write("x".repeat(2 * 1024 * 1024 + 1)); return; }
          if (!state.skipInput) frame({ type: "model", id: 1, body: { tools: ["documents_list", "documents_read"].map(n => ({ name: `mcp__hub_documents__${n}` })), input: [{ role: "user", content: state.wrongInput ? "wrong question" : v.prompt }], messages: [{ role: "user", content: state.wrongInput ? "wrong question" : v.prompt }] } });
        } else if (v.type === "model-result") { if (state.tool) frame({ type: "tool", id: 2, name: state.toolName, arguments: state.toolArgs }); else final(); }
        else if (v.type === "tool-result") final();
      }
    }); return p;
  };
  return { execFile, spawn };
});
import { hubProviderSetupReason } from "../src/hub/execution/provider-setup.js";
import { createHubCliProvider } from "../src/hub/execution/cli-provider.js";
import type { HubModelBroker } from "../src/hub/execution/model-broker.js";

function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const input = () => ({ contextId: randomUUID(), question: "Read the approved view", label: "External identity; no local authority", signal: new AbortController().signal, beforeInput: vi.fn() });
const broker = vi.fn<HubModelBroker>(async () => ({ contentType: "application/json", body: '{"type":"message","content":[{"type":"text","text":"answer"}]}' }));
const gateway = (): HubExecutionGateway => ({ invoke: vi.fn(async () => ({ text: "approved" })), propose: vi.fn(async () => {}) });
const factory = () => createHubCliProvider({ backend: "claude", imageId: "sha256:" + "a".repeat(64), model: "local-model", modelBroker: broker });
const tick = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
beforeEach(() => { state.commands = []; state.processes = []; state.containers.clear(); Object.assign(state, { socket: true, socketThrows: false, engine: "linux/x86_64", engineFails: false, imageFails: false, imageId: "sha256:" + "a".repeat(64), imageArchitecture: "amd64", imageVersion: "2.1.316", holdCreate: null, skipInput: false, wrongInput: false, tool: false, toolName: "mcp__hub_documents__documents_read", toolArgs: { documentId: "approved" }, proposal: false, badExit: false, cleanupFails: false, cleanupRemovedThenFails: false, listFails: false, weaken: false, outputFlood: false }); broker.mockClear(); });
afterEach(() => { vi.useRealTimers(); });

describe("Hub disposable provider lifecycle", () => {
  it.each([
    ["missing socket", "engine-unavailable", { socketThrows: true }],
    ["non-socket", "engine-unavailable", { socket: false }],
    ["daemon unavailable", "engine-unavailable", { engineFails: true }],
    ["Windows engine", "engine-unsupported", { engine: "windows/x86_64" }],
    ["ARM engine", "engine-unsupported", { engine: "linux/aarch64" }],
    ["missing image", "image-mismatch", { imageFails: true }],
    ["wrong image ID", "image-mismatch", { imageId: "sha256:" + "b".repeat(64) }],
    ["wrong image architecture", "image-mismatch", { imageArchitecture: "arm64" }],
    ["wrong CLI version", "image-mismatch", { imageVersion: "unreviewed" }],
  ] as const)("explains %s safely without starting a session", async (_scenario, reason, changes) => {
    Object.assign(state, changes);
    const error = await factory().then(() => { throw Error("unexpected ready provider"); }, error => error);
    expect(hubProviderSetupReason(error)).toBe(reason); expect(error.reason).toBe(reason);
    expect(error.message).not.toContain("PRIVATE-"); expect(JSON.stringify(error)).not.toContain("PRIVATE-");
    expect(state.processes).toHaveLength(0); expect(state.containers.size).toBe(0); expect(broker).not.toHaveBeenCalled();
  });
  it("explains an unselected image before contacting Docker and accepts the amd64 engine spelling", async () => {
    await expect(createHubCliProvider({ backend: "claude", imageId: "", model: "local-model", modelBroker: broker })).rejects.toMatchObject({ reason: "image-unconfigured" });
    expect(state.commands).toHaveLength(0); state.engine = "linux/amd64";
    const provider = await factory(); expect(provider.isolation).toBe("hub-restricted-v1"); await provider.close();
  });

  it("refuses unsupported architecture and missing local socket before any container exists", async () => {
    state.imageArchitecture = "arm64"; await expect(factory()).rejects.toThrow(); expect(state.containers.size).toBe(0);
    state.imageArchitecture = "amd64"; state.socket = false; await expect(factory()).rejects.toThrow(); expect(state.containers.size).toBe(0);
  });
  it("requires exact CLI consumption before open resolves and removes the container before releasing an answer", async () => {
    const provider = await factory(), question = input(), session = await provider.open(question);
    expect(broker).not.toHaveBeenCalled(); expect(state.processes[0].input.prompt).toContain(question.question);
    expect(await session.answer(gateway())).toBe("approved answer"); expect(state.containers.size).toBe(0);
    expect(state.commands.some(c => c.args[0] === "rm")).toBe(true);
    for (const c of state.commands) { expect(c.options.env).not.toHaveProperty("HOME"); expect(c.options.env).not.toHaveProperty("ANTHROPIC_API_KEY"); expect(c.options.env).not.toHaveProperty("OPENAI_API_KEY"); }
    await expect(session.answer(gateway())).rejects.toThrow(); await session.close(); await provider.close();
  });
  it("uses only validated document calls through the supplied S4 gateway", async () => {
    state.tool = true; const provider = await factory(), session = await provider.open(input()), scoped = gateway();
    expect(await session.answer(scoped)).toBe("approved answer"); expect(scoped.invoke).toHaveBeenCalledExactlyOnceWith("documents.read", { documentId: "approved" }); await provider.close();
  });
  it("checks current authority after setup and before sending the question into the isolated runner", async () => {
    const provider = await factory(), q = input(); q.beforeInput.mockImplementation(() => { throw Error("expired or revoked"); });
    await expect(provider.open(q)).rejects.toThrow(); expect(q.beforeInput).toHaveBeenCalledTimes(1);
    expect(state.processes[0].input).toBeUndefined(); expect(broker).not.toHaveBeenCalled(); expect(state.containers.size).toBe(0); await provider.close();
  });
  it.each(["wrong-question", "weaker-container", "output-flood"])("holds %s before broker or document disclosure", async scenario => {
    state.wrongInput = scenario === "wrong-question"; state.weaken = scenario === "weaker-container"; state.outputFlood = scenario === "output-flood";
    const provider = await factory(); await expect(provider.open(input())).rejects.toThrow(); expect(broker).not.toHaveBeenCalled(); expect(state.containers.size).toBe(0); await provider.close();
  });
  it.each(["unknown-tool", "extra-path"])("refuses a malicious CLI's %s at the member gateway", async scenario => {
    state.tool = true; if (scenario === "unknown-tool") state.toolName = "Bash"; else state.toolArgs = { documentId: "approved", path: "/home/owner" };
    const provider = await factory(), session = await provider.open(input()), scoped = gateway();
    await expect(session.answer(scoped)).rejects.toThrow(); expect(scoped.invoke).not.toHaveBeenCalled(); expect(state.containers.size).toBe(0); await provider.close();
  });
  it("persists an exact final proposal through S4 without granting or executing authority", async () => {
    state.proposal = true; const provider = await factory(), session = await provider.open(input()), scoped = gateway();
    expect(await session.answer(scoped)).toBe("approved answer"); expect(scoped.propose).toHaveBeenCalledExactlyOnceWith("delete sample", { target: "sample" }, "The sample would be removed."); expect(scoped.invoke).not.toHaveBeenCalled(); await provider.close();
  });
  it("withholds a valid-looking answer when the CLI exits unsuccessfully or cleanup is uncertain", async () => {
    state.badExit = true; const provider = await factory(), session = await provider.open(input()); await expect(session.answer(gateway())).rejects.toThrow(); await provider.close();
    state.badExit = false; state.cleanupFails = true; const broken = await factory(), other = await broken.open(input()); await expect(other.answer(gateway())).rejects.toThrow(); expect(() => broken.isolation).toThrow(); await expect(broken.open(input())).rejects.toThrow();
  });
  it("drains a reentrant gateway callback's physical work before close resolves", async () => {
    state.tool = true; const provider = await factory(), session = await provider.open(input()), gate = deferred<unknown>(); let closing!: Promise<void>, settled = false;
    const answering = session.answer({ ...gateway(), invoke: () => { closing = provider.close(); void closing.then(() => { settled = true; }); return gate.promise; } });
    const refusal = expect(answering).rejects.toThrow(); await tick(); expect(settled).toBe(false);
    gate.resolve({ text: "WITHHELD" }); await refusal; await closing; expect(settled).toBe(true); expect(state.containers.size).toBe(0);
  });
  it("retains physical broker work through a failed container removal", async () => {
    const held = deferred<Awaited<ReturnType<HubModelBroker>>>(); broker.mockImplementationOnce(() => held.promise);
    const provider = await factory(), session = await provider.open(input());
    const answering = session.answer(gateway()), refused = expect(answering).rejects.toThrow(); await tick();
    state.cleanupFails = true; let settled = false;
    const closing = provider.close(), stopped = closing.then(() => { settled = true; return null; }, error => { settled = true; return error; });
    await tick(); expect(settled).toBe(false);
    held.resolve({ contentType: "application/json", body: '{"type":"message","content":[{"type":"text","text":"WITHHELD"}]}' });
    await refused; expect(await stopped).toBeInstanceOf(Error); expect(settled).toBe(true); expect(() => provider.isolation).toThrow();
  });
  it.each(["session", "provider"])("retains failed cleanup ownership until a positive %s retry without reopening or answering", async retry => {
    const provider = await factory(), session = await provider.open(input()); state.cleanupFails = true;
    await expect(session.answer(gateway())).rejects.toThrow(); expect(state.containers.size).toBe(1);
    await expect(provider.close()).rejects.toThrow(); await expect(session.close()).rejects.toThrow(); expect(state.containers.size).toBe(1);
    state.cleanupFails = false;
    const attempts = state.commands.filter(c => c.args[0] === "rm").length;
    const first = retry === "session" ? session.close() : provider.close();
    await expect(Promise.all([first, session.close(), provider.close()])).resolves.toEqual([undefined, undefined, undefined]); expect(state.containers.size).toBe(0);
    expect(state.commands.filter(c => c.args[0] === "rm").length).toBe(attempts + 1);
    await provider.close(); await session.close(); expect(state.commands.filter(c => c.args[0] === "rm").length).toBe(attempts + 1);
    expect(() => provider.isolation).toThrow(); await expect(provider.open(input())).rejects.toThrow(); await expect(session.answer(gateway())).rejects.toThrow();
  });
  it("confirms absence after a lost successful removal response before retiring cleanup", async () => {
    const provider = await factory(), session = await provider.open(input()); state.cleanupRemovedThenFails = true;
    await expect(session.answer(gateway())).rejects.toThrow(); expect(state.containers.size).toBe(0);
    state.listFails = true; await expect(provider.close()).rejects.toThrow(); state.listFails = false;
    const attempts = state.commands.filter(c => c.args[0] === "rm").length;
    await expect(provider.close()).resolves.toBeUndefined(); await expect(session.close()).resolves.toBeUndefined(); expect(() => provider.isolation).toThrow();
    expect(state.commands.some(c => c.args[0] === "container" && c.args[1] === "ls")).toBe(true);
    expect(state.commands.filter(c => c.args[0] === "rm")).toHaveLength(attempts);
  });
  it("waits for pending creation on abort, then removes exactly that owned container", async () => {
    const gate = deferred<void>(); state.holdCreate = gate.promise; const provider = await factory(), signal = new AbortController();
    const opening = provider.open({ ...input(), signal: signal.signal }), refusal = expect(opening).rejects.toThrow(); signal.abort(); await tick();
    expect(state.commands.filter(c => c.args[0] === "rm")).toHaveLength(0); gate.resolve(); await refusal;
    expect(state.commands.filter(c => c.args[0] === "rm")).toHaveLength(1); expect(state.processes).toHaveLength(0); await provider.close();
  });
  it("bounds silent startup by a deadline and rejects late work", async () => {
    vi.useFakeTimers(); state.skipInput = true; const provider = await factory(); const opening = provider.open(input()), refused = expect(opening).rejects.toThrow(); let settled = false;
    void opening.then(() => { settled = true; }, () => { settled = true; });
    await tick(); await vi.advanceTimersByTimeAsync(120_001); expect(settled).toBe(true); await refused; expect(state.containers.size).toBe(0); expect(broker).not.toHaveBeenCalled(); await provider.close();
  });
  it("limits physical sessions and never admits a ninth overlapping question", async () => {
    const provider = await factory(), sessions = await Promise.all(Array.from({ length: 8 }, () => provider.open(input())));
    await expect(provider.open(input())).rejects.toThrow(); expect(state.containers.size).toBe(8);
    expect(new Set(state.processes.map(p => p.input.prompt))).toHaveProperty("size", 8); expect(broker).not.toHaveBeenCalled();
    await provider.close(); expect(state.containers.size).toBe(0); await Promise.all(sessions.map(s => s.close()));
  });
});
