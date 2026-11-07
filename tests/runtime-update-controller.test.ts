/** Real private files, producer archives and loopback HTTP; inert clients/process observations, never native execution. */
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createRuntimeBundle, type RuntimeBundle } from "../src/runtime-bundle.js";
import type { RuntimeClient, RuntimeClientOptions } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeUpdateController, type RuntimeUpdateControllerOptions } from "../src/runtime-update-controller.js";
import { RuntimeUpdateJournal } from "../src/runtime-update-journal.js";
import { RuntimeUpdateIpc, type RuntimeUpdateIpcMessage } from "../src/runtime-update-ipc.js";
import { acquireRuntimeInstallLock, type RuntimeProcessObservation, type RuntimeProcessProof } from "../src/runtime-update-lock.js";
import * as RuntimeLocks from "../src/runtime-update-lock.js";
import * as RuntimeOwners from "../src/runtime-update-owners.js";
import { RUNTIME_INSTALL_RECEIPT, readRuntimeSelectedProgram, stageRuntimeUpdate } from "../src/runtime-update-install.js";
import { readRuntimeInstallOwner } from "../src/runtime-update-owners.js";
import { runtimeBundleFixture } from "./support/runtime-bundle-fixture.js";

const self = { pid: process.pid, birth: "638980000000000000", boot: "a".repeat(64) };
const metadata = (b: RuntimeBundle) => ({ version: b.version, sha256: b.sha256, bytes: b.bytes.length });
let sa: ReturnType<typeof runtimeBundleFixture>, sb: ReturnType<typeof runtimeBundleFixture>, sc: ReturnType<typeof runtimeBundleFixture>;
let a: RuntimeBundle, b: RuntimeBundle, c: RuntimeBundle;
const cleanup: Array<() => Promise<void>> = [];
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(done => { release = done; });
  return { promise, release };
}
beforeAll(() => {
  sa = runtimeBundleFixture("2.3.5-fixture.1"); sb = runtimeBundleFixture("2.3.5-fixture.2"); sc = runtimeBundleFixture("2.3.5-fixture.1");
  writeFileSync(join(sc.moduleDirectory, "runtime-cli.js"), "// another same-version code fixture\nexport {};\n");
  a = createRuntimeBundle(sa); b = createRuntimeBundle(sb); c = createRuntimeBundle(sc);
});
afterAll(() => { sa?.cleanup(); sb?.cleanup(); sc?.cleanup(); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

class InertClient {
  readonly setUpdateStatus = vi.fn();
  readonly bootId = randomUUID(); readonly prepare = vi.fn(async (_id: string) => { if (this.busy) return false; await this.stop(); return true; });
  private stopped = false; private done!: () => void; private readonly completion = new Promise<void>(resolve => { this.done = resolve; });
  busy = true; starts = 0; stops = 0; stopReason = undefined;
  readonly activate = vi.fn(async (_id: string) => true);
  constructor(readonly options: RuntimeClientOptions, private readonly info: { version: string; buildId: string }) {}
  async start() { this.starts++; this.options.managedUpdate?.authenticated?.({ bootId: this.bootId, generation: 1, updateProtocol: 1,
    runtimeInfo: { ...this.info, protocolVersions: [1], capabilities: ["exec"] } }); }
  online() { return this.starts > 0 && !this.stopped; }
  prepareUpdate(id: string) { return this.prepare(id); }
  activateTrial(id: string) { return this.activate(id); }
  async stop() { this.stops++; this.stopped = true; this.done(); }
  waitUntilStopped() { return this.completion; }
}

class InertChild extends EventEmitter {
  connected = true; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
  readonly proof: RuntimeProcessProof; readonly kill = vi.fn(() => {
    this.signalCode = "SIGTERM"; queueMicrotask(() => { this.gone = true; this.emit("close", null, "SIGTERM"); }); return true;
  });
  gone = false; readonly unref = vi.fn(); onInit: (message: any) => void = () => {};
  constructor(readonly pid: number, private readonly failure: boolean) { super(); this.proof = { ...self, pid, birth: "638980000000000001" }; }
  send(message: any, callback: (error: Error | null) => void) {
    this.onInit(message); this.emit("message", { v: 1, id: message.id, type: this.failure ? "failure" : "armed", ...(this.failure ? { reason: "startup" } : {}) });
    callback(null); return true;
  }
  disconnect() { this.connected = false; this.emit("disconnect"); }
}

async function fixture(options: { shared?: boolean; unmanaged?: boolean; failChild?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-controller-")), requests: string[] = [], children: InertChild[] = [], clients: InertClient[] = [], reports: string[] = [];
  let target = b, archive: Buffer | undefined, interrupted = false, onArchive: (() => void) | undefined, onMetadata: (() => void) | undefined;
  const server = createServer((req, res) => {
    requests.push(req.url!); const value = metadata(target); res.setHeader("ETag", `"${value.version}-${value.sha256}"`);
    if (req.url === "/runtime/v1/bundle/windows.json") { onMetadata?.(); res.end(JSON.stringify(value)); return; }
    if (req.url !== "/runtime/v1/bundle/windows.zip") { res.writeHead(404).end(); return; }
    const bytes = archive ?? target.bytes; res.setHeader("Content-Length", bytes.length);
    onArchive?.();
    if (interrupted) { res.write(bytes.subarray(0, 16)); res.destroy(); return; }
    res.end(bytes);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, installId = randomUUID(), machineId = randomUUID();
  writeFileSync(join(root, RUNTIME_INSTALL_RECEIPT), JSON.stringify({ version: 1, id: installId, createdAt: 1, revision: 1,
    origins: options.shared ? [origin, "https://other.example.test"] : [origin], shared: !!options.shared }), { mode: 0o600 });
  mkdirSync(join(root, "bin"), { mode: 0o700 });
  const lock = await acquireRuntimeInstallLock(root, { ownProof: self }); let program;
  try { program = stageRuntimeUpdate(root, a.bytes, metadata(a), lock); writeFileSync(join(root, "bin", "current.txt"), program.folder, { mode: 0o600 }); }
  finally { lock.release(); }
  if (options.unmanaged) rmSync(join(root, RUNTIME_INSTALL_RECEIPT));
  const store = new RuntimeClientStore(join(root, "profile")); store.saveCredentials({ server: origin, machineId, credential: "b".repeat(64), name: "Fixed fake Runtime" });
  const credentials = readFileSync(join(store.directory, "connection.json"), "utf8");
  const observe = async (pid: number): Promise<RuntimeProcessObservation> => {
    if (pid === process.pid) return { state: "alive", proof: self };
    const child = children.find(c => c.pid === pid); return child && !child.gone ? { state: "alive", proof: child.proof } : { state: "gone" };
  };
  let controller: RuntimeUpdateController | undefined;
  const controllerOptions: RuntimeUpdateControllerOptions = {
    store, moduleDirectory: join(root, program.folder, "dist"), observe, report: message => reports.push(message),
    makeClient: opts => { const value = new InertClient(opts, program); clients.push(value); return value as unknown as RuntimeClient; },
    spawn: vi.fn((_exe, _args, _opts) => {
      const child = new InertChild(800_000 + children.length, !!options.failChild); children.push(child);
      child.onInit = message => {
        const owner = readRuntimeInstallOwner(root, message.ownerId);
        expect(owner.child).toEqual(child.proof); expect(owner.parent).toEqual(self);
        expect(journal().read().attempt?.phase).toBe(message.role === "helper" ? "handoff" : "rollback");
        expect(message).toEqual({ v: 1, id: journal().read().attempt!.id, type: "init", role: message.role, ownerId: owner.id, profile: store.directory });
      };
      return child as unknown as ChildProcess;
    }) as unknown as RuntimeUpdateControllerOptions["spawn"],
  };
  function journal() { return new RuntimeUpdateJournal(join(store.directory, "runtime-updates", installId, machineId), { origin, installId, machineId }); }
  cleanup.push(async () => {
    children.forEach(child => { child.gone = true; }); await controller?.close();
    await new Promise<void>((done, fail) => { server.close(error => error ? fail(error) : done()); server.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, requests, children, clients, reports, program, controllerOptions, journal, credentials, installId, machineId, origin,
    setTarget(value: RuntimeBundle) { target = value; }, corrupt() { archive = Buffer.from(target.bytes); archive[100] ^= 1; },
    interrupt(value: boolean) { interrupted = value; },
    beforeArchive(callback: () => void) { onArchive = callback; },
    beforeMetadata(callback: () => void) { onMetadata = callback; },
    async open() { return controller = await RuntimeUpdateController.open(controllerOptions); },
    own(value: RuntimeUpdateController) { controller = value; },
    selected() { return readRuntimeSelectedProgram(root); },
  };
}

it("registers ownership before any client starts and keeps an unmanaged pairing on the ordinary path", async () => {
  const f = await fixture(); const controller = await f.open();
  expect(readdirSync(join(f.root, ".agend-runtime-owners"))).toHaveLength(1); expect(f.clients).toHaveLength(0);
  await controller!.close(); expect(readdirSync(join(f.root, ".agend-runtime-owners"))).toEqual([]);
  const legacy = await fixture({ unmanaged: true }); expect(await legacy.open()).toBeUndefined(); expect(legacy.clients).toEqual([]);
  expect(legacy.reports.join(" ")).toMatch(/fresh, separate install.*pairing is kept/);
  expect(readFileSync(join(legacy.store.directory, "connection.json"), "utf8")).toBe(legacy.credentials);
});
it("downloads only the paired fixed endpoints, stages verified code and leaves a busy Runtime connected", async () => {
  const f = await fixture(), controller = (await f.open())!; await controller.start(); await controller.checkNow();
  expect(f.requests).toEqual(["/runtime/v1/bundle/windows.json", "/runtime/v1/bundle/windows.zip"]);
  expect(f.clients[0].prepare).toHaveBeenCalledOnce(); expect(f.clients[0].stops).toBe(0); expect(f.clients[0].online()).toBe(true);
  expect(f.selected()).toEqual(f.program); expect(f.children).toEqual([]); expect(f.journal().read().attempt).toBeUndefined();
  expect(f.reports.join(" ")).toMatch(/pending.*Waiting for idle/);
  expect(f.clients[0].setUpdateStatus).toHaveBeenCalledWith({ state: "pending", target: { version: b.version, bundleSha256: b.sha256 } });
  expect(readFileSync(join(f.store.directory, "connection.json"), "utf8")).toBe(f.credentials);
});
it("starts the exact verified child only after a positive idle stop and records its proof before arming", async () => {
  const f = await fixture(), controller = (await f.open())!; await controller.start(); f.clients[0].busy = false;
  await controller.checkNow(); await controller.wait();
  expect(f.children).toHaveLength(1); expect(f.clients[0].stops).toBe(1); expect(f.children[0].kill).not.toHaveBeenCalled();
  expect(f.journal().read().attempt).toMatchObject({ phase: "handoff", next: { version: b.version, sha256: b.sha256 } });
  expect(f.selected()).toEqual(f.program); // Only the new process may select after positively observing this process exit.
  expect(f.controllerOptions.spawn).toHaveBeenCalledWith(process.execPath,
    [join(f.root, `${b.version}+${b.sha256.slice(0, 8)}`, "dist", "runtime-cli.js"), "--internal-update"], expect.objectContaining({ shell: false, detached: true, windowsHide: true, stdio: ["inherit", "inherit", "inherit", "ipc"] }));
  await controller.close(); expect(readdirSync(join(f.root, ".agend-runtime-owners"))).toHaveLength(1);
});
it("remembers a checksum failure, never stops a client or retries that hash", async () => {
  const f = await fixture(); f.corrupt(); const controller = (await f.open())!; await controller.start();
  await expect(controller.checkNow()).rejects.toThrow(/checksum/);
  expect(f.journal().read().failed).toEqual({ version: b.version, sha256: b.sha256 }); expect(f.clients[0].prepare).not.toHaveBeenCalled();
  expect(f.children).toEqual([]); await controller.checkNow(); expect(f.requests.filter(p => p.endsWith(".zip"))).toHaveLength(1);
  expect(f.selected()).toEqual(f.program); expect(f.clients[0].online()).toBe(true);
  expect(f.clients[0].setUpdateStatus).toHaveBeenLastCalledWith({ state: "failed", target: { version: b.version, bundleSha256: b.sha256 } });
});

async function handoff(f: Awaited<ReturnType<typeof fixture>>) {
  const lock = await acquireRuntimeInstallLock(f.root, { ownProof: self });
  let next;
  try { next = stageRuntimeUpdate(f.root, b.bytes, metadata(b), lock); } finally { lock.release(); }
  const ownerId = randomUUID(), id = randomUUID(), parent = { ...self, pid: process.ppid, birth: "638980000000000002" };
  mkdirSync(join(f.root, ".agend-runtime-owners"), { mode: 0o700 });
  const owner = { version: 1, id: ownerId, installId: f.installId, origin: f.origin, parent, child: self };
  writeFileSync(join(f.root, ".agend-runtime-owners", `${ownerId}.json`), JSON.stringify(owner), { mode: 0o600 });
  mkdirSync(join(f.store.directory, "runtime-updates", f.installId, f.machineId), { recursive: true, mode: 0o700 });
  const journal = f.journal(); journal.begin(id, ownerId, f.program, next, () => {}); journal.advance(id, "handoff", () => {});
  const emitter = new EventEmitter(), sent: RuntimeUpdateIpcMessage[] = [];
  const channel = new RuntimeUpdateIpc({ connected: true, on: (event, listener) => emitter.on(event, listener), off: (event, listener) => emitter.off(event, listener),
    send: (message, callback) => { sent.push(message); callback(null); } }, id);
  cleanup.push(async () => { channel.close(); });
  const options = { ...f.controllerOptions, moduleDirectory: join(f.root, next.folder, "dist") };
  options.makeClient = opts => { const value = new InertClient(opts, next); f.clients.push(value); return value as unknown as RuntimeClient; };
  return { options, next, ownerId, id, parent, sent, channel, init: { v: 1 as const, id, type: "init" as const, role: "helper" as const, ownerId, profile: f.store.directory } };
}

it("arms without starting a client, requires positive parent exit and adopts only the registered child", async () => {
  const f = await fixture(), h = await handoff(f); let parentGone = false;
  const observe = h.options.observe!;
  h.options.observe = async pid => pid === process.ppid ? parentGone ? { state: "gone" } : { state: "unknown" } : observe(pid);
  let settled = false;
  const pending = RuntimeUpdateController.resume(h.options, h.init, h.channel).then(value => { settled = true; f.own(value); return value; });
  await vi.waitFor(() => expect(h.sent).toEqual([{ v: 1, id: h.id, type: "armed" }]));
  expect(settled).toBe(false); expect(f.clients).toEqual([]); expect(f.selected()).toEqual(f.program);
  parentGone = true; const controller = await pending;
  expect(readRuntimeInstallOwner(f.root, h.ownerId).parent).toEqual(self); expect(readRuntimeInstallOwner(f.root, h.ownerId).child).toBeUndefined();
  await controller.close();
});

it("selects and connects a gated trial, persists activation intent before its exact ACK, then completes", async () => {
  const f = await fixture(), h = await handoff(f), controller = await RuntimeUpdateController.resume(h.options, h.init, h.channel); f.own(controller);
  h.options.makeClient = opts => {
    const value = new InertClient(opts, h.next); f.clients.push(value);
    value.activate.mockImplementation(async id => {
      expect(id).toBe(h.id); expect(f.selected()).toEqual(h.next); expect(f.journal().read().attempt?.phase).toBe("activating"); return true;
    }); return value as unknown as RuntimeClient;
  };
  await controller.startTrial(h.id);
  expect(f.clients[0].options.managedUpdate?.trialId).toBe(h.id); expect(f.clients[0].activate).toHaveBeenCalledOnce();
  expect(f.journal().read().attempt).toBeUndefined(); expect(f.journal().read().failed).toBeUndefined(); expect(f.selected()).toEqual(h.next);
  expect(f.clients[0].setUpdateStatus).toHaveBeenLastCalledWith({ state: "current" });
  expect(readFileSync(join(f.store.directory, "connection.json"), "utf8")).toBe(f.credentials);
});
it("the verified rollback controller reports the failed target through its normal new connection", async () => {
  const f = await fixture(), h = await handoff(f); f.journal().advance(h.id, "rollback", () => {});
  const options = { ...f.controllerOptions }, init = { ...h.init, role: "rollback" as const };
  const controller = await RuntimeUpdateController.resume(options, init, h.channel); f.own(controller); await controller.start();
  expect(f.clients[0].options.updateStatus).toEqual({ state: "failed", target: { version: b.version, bundleSha256: b.sha256 } });
  expect(f.selected()).toEqual(f.program); expect(f.clients[0].online()).toBe(true);
});

it("a wrong candidate build rolls back before activation and arms only the verified old controller", async () => {
  const f = await fixture(), h = await handoff(f), controller = await RuntimeUpdateController.resume(h.options, h.init, h.channel); f.own(controller);
  h.options.makeClient = opts => { const value = new InertClient(opts, { ...h.next, buildId: "f".repeat(64) }); f.clients.push(value); return value as unknown as RuntimeClient; };
  await controller.startTrial(h.id);
  expect(f.clients[0].activate).not.toHaveBeenCalled(); expect(f.clients[0].stops).toBe(1); expect(f.selected()).toEqual(f.program);
  expect(f.journal().read().attempt?.phase).toBe("rollback"); expect(f.children).toHaveLength(1);
  expect(f.controllerOptions.spawn).toHaveBeenCalledWith(process.execPath,
    [join(f.root, f.program.folder, "dist", "runtime-cli.js"), "--internal-update"], expect.anything());
});

it.each([false, true])("close waits for the owned activation RPC (%s), preserving its intent without continuing", async acknowledged => {
  const f = await fixture(), h = await handoff(f), controller = await RuntimeUpdateController.resume(h.options, h.init, h.channel); f.own(controller);
  let finish!: (value: boolean) => void;
  h.options.makeClient = opts => { const value = new InertClient(opts, h.next); f.clients.push(value);
    value.activate.mockImplementation(() => new Promise<boolean>(done => { finish = done; })); return value as unknown as RuntimeClient; };
  const trial = controller.startTrial(h.id); await vi.waitFor(() => expect(f.clients[0]?.activate).toHaveBeenCalledOnce());
  expect(f.journal().read().attempt?.phase).toBe("activating"); expect(f.selected()).toEqual(h.next);
  let closed = false; const closing = controller.close().then(() => { closed = true; });
  await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false); finish(acknowledged);
  await trial; await closing;
  expect(f.selected()).toEqual(h.next); expect(f.children).toEqual([]); expect(f.journal().read().attempt?.phase).toBe("activating");
  expect(readdirSync(join(f.root, ".agend-runtime-owners"))).toEqual([]);
});

it.each((["lock", "exclusive"] as const).flatMap(phase => [true, false].map(cancel => ({ phase, cancel }))))(
  "trial paused at $phase (close=$cancel) preserves cancellation and the normal activation control", async ({ phase, cancel }) => {
  const f = await fixture(), h = await handoff(f), controller = await RuntimeUpdateController.resume(h.options, h.init, h.channel); f.own(controller);
  const entered = barrier(), held = barrier();
  const acquire = RuntimeLocks.acquireRuntimeInstallLock, exclusive = RuntimeOwners.assertRuntimeInstallExclusive;
  const spy = phase === "lock"
    ? vi.spyOn(RuntimeLocks, "acquireRuntimeInstallLock").mockImplementationOnce(async (...args) => { entered.release(); await held.promise; return acquire(...args); })
    : vi.spyOn(RuntimeOwners, "assertRuntimeInstallExclusive").mockImplementationOnce(async (...args) => { entered.release(); await held.promise; return exclusive(...args); });
  try {
    const trial = controller.startTrial(h.id); await entered.promise;
    let closed = false; const closing = cancel ? controller.close().then(() => { closed = true; }) : undefined;
    await Promise.resolve(); expect(closed).toBe(false);
    expect(readRuntimeInstallOwner(f.root, h.ownerId).parent).toEqual(self);
    held.release(); await trial; await closing;
    expect(f.clients[0].starts).toBe(cancel ? 0 : 1);
    expect(f.clients[0].activate).toHaveBeenCalledTimes(cancel ? 0 : 1);
    expect(f.selected()).toEqual(cancel ? f.program : h.next);
    expect(f.journal().read().attempt?.phase).toBe(cancel ? "handoff" : undefined);
    expect(f.children).toEqual([]);
    if (!cancel) await controller.close();
    expect(readdirSync(join(f.root, ".agend-runtime-owners"))).toEqual([]);
  } finally { held.release(); spy.mockRestore(); }
});

it.each((["stop", "child-proof", "child-register", "arm"] as const).flatMap(phase => [true, false].map(cancel => ({ phase, cancel }))))(
  "rollback paused at $phase (close=$cancel) preserves cancellation and the normal handoff control", async ({ phase, cancel }) => {
  const f = await fixture(), h = await handoff(f), entered = barrier(), held = barrier();
  const observe = h.options.observe!, spawn = h.options.spawn!;
  let observations = 0;
  if (phase === "child-proof" || phase === "child-register") h.options.observe = async pid => {
    if (f.children.some(child => child.pid === pid) && ++observations === (phase === "child-proof" ? 1 : 2)) { entered.release(); await held.promise; }
    return observe(pid);
  };
  if (phase === "arm") h.options.spawn = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args) as unknown as InertChild, send = child.send.bind(child);
    child.send = (message, callback) => { entered.release(); void held.promise.then(() => send(message, callback)); return true; };
    return child as unknown as ChildProcess;
  }) as typeof spawn;
  const controller = await RuntimeUpdateController.resume(h.options, h.init, h.channel); f.own(controller);
  h.options.makeClient = opts => {
    const value = new InertClient(opts, { ...h.next, buildId: "f".repeat(64) }); f.clients.push(value);
    if (phase === "stop") {
      const stop = value.stop.bind(value);
      value.stop = async () => { entered.release(); await held.promise; await stop(); };
    }
    return value as unknown as RuntimeClient;
  };
  const trial = controller.startTrial(h.id); await entered.promise;
  let closed = false; const closing = cancel ? controller.close().then(() => { closed = true; }) : undefined;
  await Promise.resolve(); expect(closed).toBe(false);
  expect(readRuntimeInstallOwner(f.root, h.ownerId).parent).toEqual(self);
  held.release(); await trial; await closing;
  expect(f.clients[0].starts).toBe(1); expect(f.clients[0].activate).not.toHaveBeenCalled();
  expect(f.children).toHaveLength(cancel && phase === "stop" ? 0 : 1);
  if (cancel) {
    for (const child of f.children) { expect(child.kill).toHaveBeenCalledOnce(); expect(child.gone).toBe(true); expect(child.unref).not.toHaveBeenCalled(); }
    expect(readdirSync(join(f.root, ".agend-runtime-owners"))).toEqual([]);
    expect(f.journal().read().attempt?.phase).toBe(phase === "stop" ? "trial" : "rollback");
    expect(f.selected()).toEqual(phase === "stop" ? h.next : f.program);
  } else {
    expect(f.children[0].kill).not.toHaveBeenCalled(); expect(f.children[0].unref).toHaveBeenCalledOnce();
    expect(readRuntimeInstallOwner(f.root, h.ownerId).child).toEqual(f.children[0].proof);
    expect(f.journal().read().attempt?.phase).toBe("rollback"); expect(f.selected()).toEqual(f.program);
    await controller.close(); expect(readdirSync(join(f.root, ".agend-runtime-owners"))).toEqual([`${h.ownerId}.json`]);
  }
});

it("shutdown keeps the owner row until an armed rollback helper has physically exited", async () => {
  const f = await fixture(), h = await handoff(f), entered = barrier(), held = barrier(), killed = barrier();
  const spawn = h.options.spawn!;
  h.options.spawn = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args) as unknown as InertChild, send = child.send.bind(child);
    child.send = (message, callback) => { entered.release(); void held.promise.then(() => send(message, callback)); return true; };
    child.kill.mockImplementation(() => { child.signalCode = "SIGTERM"; killed.release(); return true; });
    return child as unknown as ChildProcess;
  }) as typeof spawn;
  const controller = await RuntimeUpdateController.resume(h.options, h.init, h.channel); f.own(controller);
  h.options.makeClient = opts => { const value = new InertClient(opts, { ...h.next, buildId: "f".repeat(64) }); f.clients.push(value); return value as unknown as RuntimeClient; };
  const trial = controller.startTrial(h.id); await entered.promise;
  let closed = false, closeError: unknown;
  const closing = controller.close().then(() => { closed = true; }, error => { closed = true; closeError = error; });
  held.release();
  const first = await Promise.race([killed.promise.then(() => "killed"), closing.then(() => "closed")]);
  try {
    expect(first).toBe("killed");
    await new Promise<void>(done => setImmediate(done)); expect(closed).toBe(false); expect(closeError).toBeUndefined();
    expect(readRuntimeInstallOwner(f.root, h.ownerId).child).toEqual(f.children[0].proof);
    expect(f.children[0].unref).not.toHaveBeenCalled();
  } finally { f.children[0].gone = true; f.children[0].emit("close", null, "SIGTERM"); }
  await trial; await closing;
  expect(closeError).toBeUndefined();
  expect(readdirSync(join(f.root, ".agend-runtime-owners"))).toEqual([]);
});

it("a rollback report callback that closes the controller cannot hand off its armed helper", async () => {
  const f = await fixture(), h = await handoff(f); let closing: Promise<void> | undefined;
  h.options.report = message => { if (message.startsWith("Runtime update failed.")) closing = controller.close(); };
  const controller = await RuntimeUpdateController.resume(h.options, h.init, h.channel); f.own(controller);
  h.options.makeClient = opts => { const value = new InertClient(opts, { ...h.next, buildId: "f".repeat(64) }); f.clients.push(value); return value as unknown as RuntimeClient; };
  await controller.startTrial(h.id); expect(closing).toBeDefined(); await closing;
  expect(f.children[0].kill).toHaveBeenCalledOnce(); expect(f.children[0].gone).toBe(true);
  expect(f.children[0].unref).not.toHaveBeenCalled();
  expect(readdirSync(join(f.root, ".agend-runtime-owners"))).toEqual([]);
});
it("an interrupted download is retryable and cannot mark the server build as failed", async () => {
  const f = await fixture(); f.interrupt(true); const controller = (await f.open())!; await controller.start();
  await expect(controller.checkNow()).rejects.toThrow(/transport|download/); expect(f.journal().read().failed).toBeUndefined();
  expect(f.clients[0].prepare).not.toHaveBeenCalled(); f.interrupt(false); await controller.checkNow();
  expect(f.clients[0].prepare).toHaveBeenCalledOnce(); expect(f.requests.filter(p => p.endsWith(".zip"))).toHaveLength(2);
});
it("refuses a downgrade before downloading or stopping, while aligning a different same-version build", async () => {
  const f = await fixture(), controller = (await f.open())!; f.setTarget({ ...a, version: "2.3.4" }); await controller.start();
  await expect(controller.checkNow()).rejects.toThrow(/downgrade/); expect(f.requests).toEqual(["/runtime/v1/bundle/windows.json"]);
  expect(f.clients[0].prepare).not.toHaveBeenCalled(); f.setTarget(c); await controller.checkNow();
  expect(f.clients[0].prepare).toHaveBeenCalledOnce(); expect(f.selected()).toEqual(f.program);
});
it("a shared managed root stays connected but never downloads or prepares an update", async () => {
  const f = await fixture({ shared: true }), controller = (await f.open())!; await controller.start();
  await expect(controller.checkNow()).rejects.toThrow(/shared/); expect(f.requests).toEqual([]);
  expect(f.clients[0].setUpdateStatus).toHaveBeenLastCalledWith({ state: "manual", reason: "shared" });
  expect(f.clients[0].online()).toBe(true); expect(f.clients[0].prepare).not.toHaveBeenCalled(); expect(f.children).toEqual([]);
});
it("a helper startup refusal is positively stopped before restarting the old Runtime, with pairing and selection kept", async () => {
  const f = await fixture({ failChild: true }), controller = (await f.open())!; await controller.start(); f.clients[0].busy = false;
  await expect(controller.checkNow()).rejects.toThrow(/readiness/);
  expect(f.children[0].kill).toHaveBeenCalledOnce(); expect(f.children[0].gone).toBe(true); expect(f.clients).toHaveLength(2);
  expect(f.clients[1].online()).toBe(true); expect(f.selected()).toEqual(f.program);
  expect(f.journal().read()).toMatchObject({ failed: { version: b.version, sha256: b.sha256 } }); expect(f.journal().read().attempt).toBeUndefined();
  expect(readFileSync(join(f.store.directory, "connection.json"), "utf8")).toBe(f.credentials);
  await controller.checkNow(); expect(f.children).toHaveLength(1);
});

it("an unverifiable running managed program remains registered but never updates", async () => {
  const f = await fixture(); writeFileSync(join(f.root, f.program.folder, "dist", "runtime-cli.js"), "// tampered code fixture\n");
  const controller = (await f.open())!; expect(readdirSync(join(f.root, ".agend-runtime-owners"))).toHaveLength(1);
  await controller.start(); await controller.checkNow(); expect(f.requests).toEqual([]); expect(f.clients[0].online()).toBe(true);
  expect(f.reports.join(" ")).toMatch(/fresh, separate install/);
});
it.each(["boot", "generation", "protocol", "version"] as const)("a wrong authenticated trial %s never activates", async field => {
  const f = await fixture(), h = await handoff(f), controller = await RuntimeUpdateController.resume(h.options, h.init, h.channel); f.own(controller);
  h.options.makeClient = opts => {
    const original = opts.managedUpdate!.authenticated!;
    opts.managedUpdate!.authenticated = info => original({ ...info, ...(field === "boot" ? { bootId: randomUUID() } : {}),
      ...(field === "generation" ? { generation: 0 } : {}), ...(field === "protocol" ? { updateProtocol: undefined } : {}),
      ...(field === "version" ? { runtimeInfo: { ...info.runtimeInfo, version: a.version } } : {}) });
    const value = new InertClient(opts, h.next); f.clients.push(value); return value as unknown as RuntimeClient;
  };
  await controller.startTrial(h.id); expect(f.clients[0].activate).not.toHaveBeenCalled();
  expect(f.journal().read().attempt?.phase).toBe("rollback"); expect(f.selected()).toEqual(f.program);
});
it("close owns a held start callback and does not release the install row before it exits", async () => {
  const f = await fixture(); let entered!: () => void, finish!: () => void;
  const entering = new Promise<void>(done => { entered = done; }), held = new Promise<void>(done => { finish = done; });
  f.controllerOptions.makeClient = opts => {
    const value = new InertClient(opts, f.program); f.clients.push(value);
    value.start = async () => { entered(); await held; }; return value as unknown as RuntimeClient;
  };
  const controller = (await f.open())!, starting = controller.start(); await entering;
  let closed = false; const closing = controller.close().then(() => { closed = true; });
  await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false);
  expect(readdirSync(join(f.root, ".agend-runtime-owners"))).toHaveLength(1);
  finish(); await starting; await closing; expect(readdirSync(join(f.root, ".agend-runtime-owners"))).toEqual([]);
});
it("retries an uncertain activation using the same durable attempt and never rolls back", async () => {
  const f = await fixture(), h = await handoff(f), controller = await RuntimeUpdateController.resume(h.options, h.init, h.channel); f.own(controller);
  h.options.makeClient = opts => {
    const value = new InertClient(opts, h.next); f.clients.push(value);
    value.activate.mockRejectedValueOnce(Error("Lost acknowledgement fixture")); return value as unknown as RuntimeClient;
  };
  await controller.startTrial(h.id);
  expect(f.clients[0].activate.mock.calls).toEqual([[h.id], [h.id]]); expect(f.children).toEqual([]);
  expect(f.selected()).toEqual(h.next); expect(f.journal().read().attempt).toBeUndefined();
});
it("a lockless manual selection wins over rollback without changing pairing or the selected third build", async () => {
  const f = await fixture(), h = await handoff(f), controller = await RuntimeUpdateController.resume(h.options, h.init, h.channel); f.own(controller);
  const lock = await acquireRuntimeInstallLock(f.root, { ownProof: self }); let third;
  try { third = stageRuntimeUpdate(f.root, c.bytes, metadata(c), lock); } finally { lock.release(); }
  h.options.makeClient = opts => {
    const original = opts.managedUpdate!.authenticated!;
    opts.managedUpdate!.authenticated = info => { writeFileSync(join(f.root, "bin", "current.txt"), third.folder, { mode: 0o600 }); original(info); };
    const value = new InertClient(opts, { ...h.next, buildId: "f".repeat(64) }); f.clients.push(value); return value as unknown as RuntimeClient;
  };
  await controller.startTrial(h.id); expect(f.selected()).toEqual(third); expect(f.journal().read().attempt?.phase).toBe("rollback");
  expect(readFileSync(join(f.store.directory, "connection.json"), "utf8")).toBe(f.credentials);
});
it("ordinary startup cannot bypass an unfinished trial journal", async () => {
  const f = await fixture(), h = await handoff(f);
  await expect(f.open()).rejects.toThrow(/recovery is unfinished/);
  expect(f.clients).toEqual([]); expect(f.requests).toEqual([]); expect(f.journal().read().attempt?.id).toBe(h.id);
  expect(readdirSync(join(f.root, ".agend-runtime-owners"))).toEqual([`${h.ownerId}.json`]);
});
it.each(["alive", "unknown"] as const)("another same-origin %s owner defers updates before any download", async state => {
  const f = await fixture(), other = { ...self, pid: 900_000 }, id = randomUUID(), original = f.controllerOptions.observe!;
  f.controllerOptions.observe = async pid => pid === other.pid ? state === "alive" ? { state, proof: other } : { state } : original(pid);
  mkdirSync(join(f.root, ".agend-runtime-owners"), { mode: 0o700 });
  writeFileSync(join(f.root, ".agend-runtime-owners", `${id}.json`), JSON.stringify({ version: 1, id, installId: f.installId, origin: f.origin, parent: other }), { mode: 0o600 });
  const controller = (await f.open())!; await controller.start(); await expect(controller.checkNow()).rejects.toThrow(/owned|unknown/);
  expect(f.requests).toEqual([]); expect(f.children).toEqual([]); expect(f.clients[0].online()).toBe(true);
});
it("a hash-matching malformed archive is terminal for that target without stopping the current client", async () => {
  const f = await fixture(), bytes = Buffer.from("not a Runtime archive fixture"), target = { ...b, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  f.setTarget(target); const controller = (await f.open())!; await controller.start();
  await expect(controller.checkNow()).rejects.toThrow(/archive/); expect(f.journal().read().failed).toEqual({ version: b.version, sha256: target.sha256 });
  expect(f.clients[0].prepare).not.toHaveBeenCalled(); expect(f.children).toEqual([]); expect(f.selected()).toEqual(f.program);
  await controller.checkNow(); expect(f.requests.filter(p => p.endsWith(".zip"))).toHaveLength(1);
});
it("rechecks a lockless manual selection made during download before stopping the current client", async () => {
  const f = await fixture(), lock = await acquireRuntimeInstallLock(f.root, { ownProof: self }); let third;
  try { third = stageRuntimeUpdate(f.root, c.bytes, metadata(c), lock); } finally { lock.release(); }
  f.beforeArchive(() => writeFileSync(join(f.root, "bin", "current.txt"), third.folder, { mode: 0o600 }));
  const controller = (await f.open())!; await controller.start(); await controller.checkNow();
  expect(f.selected()).toEqual(third); expect(f.clients[0].prepare).not.toHaveBeenCalled(); expect(f.clients[0].online()).toBe(true);
  expect(f.children).toEqual([]); expect(f.journal().read().attempt).toBeUndefined();
});

it("metadata started under an older connection cannot confirm current after reconnect", async () => {
  const f = await fixture(); f.setTarget(a); let changed = false;
  f.beforeMetadata(() => { if (!changed) { changed = true; f.clients[0].options.managedUpdate!.authenticated!({ bootId: f.clients[0].bootId, generation: 2, updateProtocol: 1, runtimeInfo: { version: a.version, buildId: f.program.buildId, protocolVersions: [1], capabilities: ["exec"] } }); } });
  const controller = (await f.open())!; await controller.start(); await controller.checkNow();
  expect(changed).toBe(true); expect(f.clients[0].setUpdateStatus).not.toHaveBeenCalledWith({ state: "current" });
  f.beforeMetadata(() => {}); await controller.checkNow();
  expect(f.clients[0].setUpdateStatus).toHaveBeenCalledWith({ state: "current" });
});
