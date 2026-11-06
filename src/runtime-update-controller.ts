/** Managed Runtime code replacement. Source of truth is the stored paired origin; no CLI installation or task replay. */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { spawn } from "./child-process.js";
import { RuntimeClient, describeRuntimeStop, type RuntimeClientOptions } from "./runtime-client.js";
import { RuntimeClientStore, validateRuntimeServer } from "./runtime-client-store.js";
import { credentialProfilesRoot } from "./runtime-credential-profiles.js";
import { nativeCliEnvironment } from "./windows-cli-worker.js";
import { fetchRuntimeUpdateArchive, fetchRuntimeUpdateMetadata, runtimeUpdateNeeded, RuntimeUpdateArtifactError } from "./runtime-update-artifact.js";
import { RuntimeUpdateJournal, type RuntimeUpdateBinding } from "./runtime-update-journal.js";
import { RuntimeUpdateIpc, type RuntimeUpdateIpcMessage, type RuntimeUpdateIpcPeer } from "./runtime-update-ipc.js";
import { acquireRuntimeInstallLock, assertRuntimeInstallDirectory, observeRuntimeProcess, runtimeProcessMatches, type RuntimeInstallLock, type RuntimeProcessObservation, type RuntimeProcessProof } from "./runtime-update-lock.js";
import { readRuntimeInstallReceipt, readRuntimeInstalledProgram, readRuntimeSelectedProgram, selectRuntimeProgram, stageRuntimeUpdate, type RuntimeInstalledProgram } from "./runtime-update-install.js";
import { adoptRuntimeInstallOwner, assertRuntimeInstallExclusive, attachRuntimeInstallChild, readRuntimeInstallOwner, registerRuntimeInstallOwner, releaseRuntimeInstallOwner, type RuntimeInstallOwner } from "./runtime-update-owners.js";

type Authentication = Parameters<NonNullable<NonNullable<RuntimeClientOptions["managedUpdate"]>["authenticated"]>>[0];
type Observe = (pid: number) => Promise<RuntimeProcessObservation>;
type Init = Extract<RuntimeUpdateIpcMessage, { type: "init" }>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const REINSTALL = "Automatic updates need a fresh, separate install. Use the one-line command in AgEnD Settings > Runtime. Your pairing is kept.";
export interface RuntimeUpdateControllerOptions {
  store: RuntimeClientStore;
  report?(message: string): void;
  /** Internal test seams; none is a server, task, environment or Settings field. */
  moduleDirectory?: string;
  observe?: Observe;
  makeClient?(options: RuntimeClientOptions): RuntimeClient;
  spawn?: typeof spawn;
  pollMs?: number;
}
interface Layout { root: string; folder: string; program?: RuntimeInstalledProgram; installId: string }
function journalAt(store: RuntimeClientStore, binding: RuntimeUpdateBinding): RuntimeUpdateJournal {
  // A fresh separate installation keeps the pairing, but must not inherit another installation's failed/recovery state.
  let directory = store.directory; assertRuntimeInstallDirectory(directory);
  for (const part of ["runtime-updates", binding.installId, binding.machineId]) {
    const path = join(directory, part);
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    assertRuntimeInstallDirectory(path); directory = path;
  }
  return new RuntimeUpdateJournal(directory, binding);
}
function layout(moduleDirectory: string): Layout | undefined {
  const programDirectory = dirname(resolve(moduleDirectory)), root = dirname(programDirectory), folder = basename(programDirectory);
  if (basename(moduleDirectory) !== "dist") return undefined;
  const receipt = readRuntimeInstallReceipt(root); if (!receipt) return undefined;
  let program: RuntimeInstalledProgram | undefined;
  try { program = readRuntimeInstalledProgram(root, folder); } catch { /* Still register a running managed client; it must not become invisible to another updater. */ }
  return { root, folder, installId: receipt.id, ...(program ? { program } : {}) };
}
function processPeer(value: ChildProcess): RuntimeUpdateIpcPeer {
  return { get connected() { return value.connected; }, on: (event, listener) => value.on(event, listener), off: (event, listener) => value.off(event, listener),
    send: (message, callback) => value.send(message, callback) };
}
interface Child { process: ChildProcess; channel: RuntimeUpdateIpc; exited: Promise<void>; proof?: RuntimeProcessProof }

export class RuntimeUpdateController {
  private readonly observe: Observe;
  private readonly report: (message: string) => void;
  private readonly binding: RuntimeUpdateBinding;
  private readonly journal: RuntimeUpdateJournal;
  private owner: RuntimeInstallOwner;
  private client: RuntimeClient | undefined;
  private authentication: Authentication | undefined;
  private work: Promise<void> | undefined;
  private lifecycle: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private handedOff = false;
  private intervalAt = 0;
  private lastReport = "";
  private trialPending = false;
  private closePromise: Promise<void> | undefined;
  private retainedLease: RuntimeInstallLock | undefined;
  private ownerReleased = false;
  private constructor(private readonly options: RuntimeUpdateControllerOptions, private readonly install: Layout,
    private readonly self: RuntimeProcessProof, owner: RuntimeInstallOwner, binding: RuntimeUpdateBinding) {
    this.owner = structuredClone(owner); this.binding = structuredClone(binding); this.observe = options.observe ?? observeRuntimeProcess;
    this.report = options.report ?? (() => {}); this.journal = journalAt(options.store, this.binding);
  }
  /** Registers before RuntimeClient.start; valid managed installs never run an untracked client. */
  static async open(options: RuntimeUpdateControllerOptions): Promise<RuntimeUpdateController | undefined> {
    const report = options.report ?? (() => {});
    let install: Layout | undefined;
    try { install = layout(options.moduleDirectory ?? dirname(fileURLToPath(import.meta.url))); } catch { /* legacy/unverifiable layout */ }
    if (!install) { report(REINSTALL); return undefined; }
    if (!install.program) report(REINSTALL);
    const credentials = options.store.credentials(); if (!credentials) throw Error("Pair this Runtime before starting it");
    const binding = { origin: validateRuntimeServer(credentials.server).origin, machineId: credentials.machineId, installId: install.installId };
    const observe = options.observe ?? observeRuntimeProcess, observed = await observe(process.pid);
    if (observed.state !== "alive" || observed.proof.pid !== process.pid || runtimeProcessMatches(observed.proof, observed) !== true) throw Error("Runtime process ownership is unconfirmed; no managed client was started");
    const self = { ...observed.proof }, lock = await acquireRuntimeInstallLock(install.root, { ownProof: self, observe });
    let owner: RuntimeInstallOwner | undefined;
    try {
      owner = await registerRuntimeInstallOwner(install.root, binding.origin, lock, observe);
      const controller = new RuntimeUpdateController(options, install, self, owner, binding);
      if (controller.journal.read().attempt) throw Error(`Runtime update recovery is unfinished. ${REINSTALL}`);
      return controller;
    } catch (error) { if (owner) await releaseRuntimeInstallOwner(install.root, owner, lock, observe); throw error; }
    finally { lock.release(); }
  }
  /** The new controller is initially only a helper. It cannot start a client before its exact old parent exits. */
  static async resume(options: RuntimeUpdateControllerOptions, init: Init, channel: RuntimeUpdateIpc,
    cancelled: () => boolean = () => false): Promise<RuntimeUpdateController> {
    const install = layout(options.moduleDirectory ?? dirname(fileURLToPath(import.meta.url)));
    if (!install?.program) throw Error("Runtime update program is unverified");
    const store = options.store, credentials = store.credentials(); if (!credentials) throw Error("Runtime pairing is unavailable");
    const binding = { origin: validateRuntimeServer(credentials.server).origin, machineId: credentials.machineId, installId: install.installId };
    const observe = options.observe ?? observeRuntimeProcess, observed = await observe(process.pid);
    if (observed.state !== "alive" || observed.proof.pid !== process.pid || runtimeProcessMatches(observed.proof, observed) !== true) throw Error("Runtime child identity is unconfirmed");
    const self = { ...observed.proof }, expected = readRuntimeInstallOwner(install.root, init.ownerId), journal = journalAt(store, binding), attempt = journal.read().attempt;
    if (!attempt || attempt.id !== init.id || attempt.ownerId !== expected.id || expected.installId !== install.installId || expected.origin !== binding.origin
      || expected.parent.pid !== process.ppid || !expected.child || runtimeProcessMatches(expected.child, { state: "alive", proof: self }) !== true
      || !same(install.program, init.role === "helper" ? attempt.next : attempt.old)
      || attempt.phase !== (init.role === "helper" ? "handoff" : "rollback")) throw Error("Runtime handoff binding changed");
    if (cancelled()) throw Error("Runtime handoff was cancelled");
    await channel.send({ v: 1, id: init.id, type: "armed" });
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (cancelled()) throw Error("Runtime handoff was cancelled");
      if (runtimeProcessMatches(expected.parent, await observe(expected.parent.pid)) === false) break;
      if (Date.now() >= deadline) throw Error("Previous Runtime process exit is unconfirmed");
      await sleep(250);
    }
    channel.close();
    const lock = await acquireRuntimeInstallLock(install.root, { ownProof: self, observe });
    let owner: RuntimeInstallOwner;
    try {
      owner = await adoptRuntimeInstallOwner(install.root, expected, lock, observe);
      const controller = new RuntimeUpdateController(options, install, self, owner, binding);
      controller.current(lock);
      if (init.role === "rollback") journal.fail(init.id, () => controller.current(lock));
      return controller;
    } finally { lock.release(); }
  }
  private bindingCurrent(): void {
    const value = this.options.store.credentials(), receipt = readRuntimeInstallReceipt(this.install.root);
    if (!value || validateRuntimeServer(value.server).origin !== this.binding.origin || value.machineId !== this.binding.machineId || receipt?.id !== this.binding.installId) throw Error("Runtime update binding changed");
  }
  private current(lock: RuntimeInstallLock): void {
    lock.assert(); this.bindingCurrent();
    if (!same(readRuntimeInstallOwner(this.install.root, this.owner.id), this.owner) || runtimeProcessMatches(this.owner.parent, { state: "alive", proof: this.self }) !== true) throw Error("Runtime update ownership changed");
  }
  private async locked<T>(job: (lock: RuntimeInstallLock) => Promise<T>): Promise<T> {
    const lock = this.retainedLease ?? await acquireRuntimeInstallLock(this.install.root, { ownProof: this.self, observe: this.observe });
    this.retainedLease = lock;
    try { this.current(lock); return await job(lock); }
    finally { lock.release(); if (this.retainedLease === lock) this.retainedLease = undefined; }
  }
  private say(message: string): void { if (message !== this.lastReport) { this.lastReport = message; this.report(message); } }
  private newClient(trialId?: string): RuntimeClient {
    this.authentication = undefined; this.trialPending = !!trialId;
    return (this.options.makeClient ?? (value => new RuntimeClient(value)))({ store: this.options.store, credentialProfilesRoot: credentialProfilesRoot(this.options.store.directory), report: this.report,
      managedUpdate: { ...(trialId ? { trialId } : {}), authenticated: value => { this.authentication = structuredClone(value); if (!this.trialPending) this.checkSoon(); } } });
  }
  private ownLifecycle(job: () => Promise<void>): Promise<void> {
    if (this.lifecycle) return Promise.reject(Error("Runtime lifecycle work is already pending"));
    const work = Promise.resolve().then(job); this.lifecycle = work;
    void work.finally(() => { if (this.lifecycle === work) this.lifecycle = undefined; }).catch(() => {});
    return work;
  }
  start(): Promise<void> { return this.ownLifecycle(() => this.startOwned()); }
  private async startOwned(): Promise<void> {
    if (this.closed || this.client) throw Error("Runtime controller cannot start twice");
    this.client = this.newClient(); if (this.closed) return; await this.client.start();
    if (this.closed) return;
    this.timer = setInterval(() => this.checkSoon(), this.options.pollMs ?? 5 * 60_000); this.timer.unref();
  }
  startTrial(id: string): Promise<void> { return this.ownLifecycle(() => this.startTrialOwned(id)); }
  private async startTrialOwned(id: string): Promise<void> {
    if (this.closed || this.client || !this.install.program) throw Error("Runtime trial cannot start");
    let activationIntent = false;
    this.client = this.newClient(id);
    try {
      if (this.closed) return;
      await this.locked(async lock => {
        const attempt = this.journal.read().attempt;
        if (!attempt || attempt.id !== id || attempt.ownerId !== this.owner.id || attempt.phase !== "handoff") throw Error("Runtime trial binding changed");
        await assertRuntimeInstallExclusive(this.install.root, this.owner, lock, this.observe);
        this.journal.advance(id, "trial", () => this.current(lock));
        selectRuntimeProgram(this.install.root, attempt.old, attempt.next, lock);
      });
      await this.client.start();
      const deadline = Date.now() + 30_000;
      while (!this.authentication && !this.closed && !this.client.stopReason) {
        if (Date.now() >= deadline) throw Error("Runtime trial connection failed");
        await sleep(100);
      }
      const auth = this.authentication, program = this.install.program;
      if (this.closed) return;
      if (!auth || auth.updateProtocol !== 1 || auth.bootId !== this.client.bootId || !Number.isSafeInteger(auth.generation) || auth.generation < 1
        || auth.runtimeInfo.version !== program.version || auth.runtimeInfo.buildId !== program.buildId) throw Error("Runtime trial identity or health failed");
      // Set before the durable write: a write error can have an unknown committed outcome.
      activationIntent = true;
      await this.locked(async lock => { this.journal.advance(id, "activating", () => this.current(lock)); });
      while (!this.closed && !this.client.stopReason) {
        try {
          if (await this.client.activateTrial(id)) {
            await this.locked(async lock => {
              const state = this.journal.read();
              if (state.attempt?.phase === "activating") this.journal.advance(id, "active", () => this.current(lock));
              if (this.journal.read().attempt) this.journal.complete(id, () => this.current(lock));
            });
            this.trialPending = false; this.say("Runtime update connected and activated.");
            this.timer = setInterval(() => this.checkSoon(), this.options.pollMs ?? 5 * 60_000); this.timer.unref(); this.checkSoon(); return;
          }
        } catch { /* Exact-ID retry; a lost acknowledgement never grants rollback. */ }
        this.say("Runtime activation is unconfirmed. Keeping the selected build and retrying the same attempt."); await sleep(1000);
      }
    } catch (error) {
      if (!activationIntent && !this.closed) { await this.rollback(id); return; }
      throw error;
    }
  }
  private async rollback(id: string): Promise<void> {
    // This method is reachable only while the candidate is still gated, before any activation intent.
    await this.client?.stop();
    let child: Child | undefined;
    await this.locked(async lock => {
      const attempt = this.journal.read().attempt;
      if (!attempt || attempt.id !== id || !["prepared", "handoff", "trial"].includes(attempt.phase)) throw Error("Runtime rollback is unconfirmed");
      this.journal.advance(id, "rollback", () => this.current(lock));
      const selected = readRuntimeSelectedProgram(this.install.root);
      if (same(selected, attempt.next)) selectRuntimeProgram(this.install.root, attempt.next, attempt.old, lock);
      // A lockless manual installer wins. Never overwrite a third selection while returning to the verified old code.
      child = await this.spawnChild(attempt.old, id, lock);
    });
    if (!child) throw Error("Runtime rollback did not start");
    try { await this.arm(child, { v: 1, id, type: "init", role: "rollback", ownerId: this.owner.id, profile: this.options.store.directory }); }
    catch (error) { await this.stopUnadmitted(child); throw error; }
    this.say("Runtime update failed. Returning to the previous verified build; pairing and task records are kept.");
    this.handedOff = true; child.channel.close(); if (child.process.connected) child.process.disconnect(); child.process.unref();
  }
  private checkSoon(): void {
    if (this.closed || this.work || this.handedOff || Date.now() < this.intervalAt) return;
    // Own the promise before any callback can re-enter stop/start.
    const work = Promise.resolve().then(() => this.check()); this.work = work;
    void work.catch(() => this.say("Runtime update check is unavailable; it will retry from the paired AgEnD.")).finally(() => { if (this.work === work) this.work = undefined; });
  }
  async checkNow(): Promise<void> {
    this.intervalAt = 0; this.checkSoon(); const work = this.work;
    try { await work; } finally { if (this.work === work) this.work = undefined; }
  }
  private async check(): Promise<void> {
    this.intervalAt = Date.now() + 30_000;
    const client = this.client, program = this.install.program;
    if (this.closed || this.trialPending || !client?.online() || this.authentication?.updateProtocol !== 1 || !program) return;
    this.bindingCurrent(); const state = this.journal.read();
    if (state.attempt) { this.say("Runtime update recovery is pending; the selected build and journal were preserved."); return; }
    await this.locked(async lock => {
      await assertRuntimeInstallExclusive(this.install.root, this.owner, lock, this.observe);
      if (!same(readRuntimeSelectedProgram(this.install.root), program)) throw Error("Runtime selection changed");
    });
    const metadata = await fetchRuntimeUpdateMetadata(this.binding.origin);
    if (!runtimeUpdateNeeded(program, metadata, state.failed?.sha256)) {
      if (state.failed?.sha256 === metadata.sha256) this.say(`Runtime update failed: ${metadata.version}/${metadata.sha256.slice(0, 8)}. Waiting for a different server build.`);
      return;
    }
    this.say(`Runtime update pending: ${metadata.version}/${metadata.sha256.slice(0, 8)}. Waiting for idle.`);
    let bytes: Buffer;
    try { bytes = await fetchRuntimeUpdateArchive(this.binding.origin, metadata); }
    catch (error) {
      // Transport interruptions/429 are backoff, never a failed-build tombstone.
      if (error instanceof RuntimeUpdateArtifactError && error.reason === "checksum") await this.locked(async lock => this.journal.rememberFailure(metadata, () => this.current(lock)));
      throw error;
    }
    if (this.closed) return;
    let child: Child | undefined;
    const id = randomUUID(); let retired = false;
    try {
      await this.locked(async lock => {
        await assertRuntimeInstallExclusive(this.install.root, this.owner, lock, this.observe);
        if (this.closed || !same(readRuntimeSelectedProgram(this.install.root), program)) return;
        const next = stageRuntimeUpdate(this.install.root, bytes, metadata, lock);
        if (!await client.prepareUpdate(id)) return;
        retired = true;
        if (this.closed) return;
        this.current(lock); await assertRuntimeInstallExclusive(this.install.root, this.owner, lock, this.observe);
        this.journal.begin(id, this.owner.id, program, next, () => this.current(lock));
        child = await this.spawnChild(next, id, lock);
        this.journal.advance(id, "handoff", () => this.current(lock));
      });
    } catch (error) {
      if (child) await this.stopUnadmitted(child);
      if (retired && !this.closed) await this.resumeOld(id, metadata);
      throw error;
    }
    if (!child) return;
    if (this.closed) { await this.stopUnadmitted(child); return; }
    try { await this.arm(child, { v: 1, id, type: "init", role: "helper", ownerId: this.owner.id, profile: this.options.store.directory }); }
    catch (error) {
      // This parent is still alive: the helper cannot yet adopt or admit any task.
      await this.stopUnadmitted(child);
      if (this.closed) return;
      await this.resumeOld(id, metadata); throw error;
    }
    if (this.closed) { await this.stopUnadmitted(child); return; }
    this.handedOff = true; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    child.channel.close(); if (child.process.connected) child.process.disconnect(); child.process.unref();
  }
  private async resumeOld(id: string, target: { version: string; sha256: string }): Promise<void> {
    await this.locked(async lock => {
      if (this.owner.child && runtimeProcessMatches(this.owner.child, await this.observe(this.owner.child.pid)) !== false) throw Error("Runtime helper exit is unconfirmed");
      const attempt = this.journal.read().attempt;
      if (attempt) this.journal.fail(id, () => this.current(lock));
      else this.journal.rememberFailure(target, () => this.current(lock));
    });
    if (!this.closed) { this.client = this.newClient(); await this.client.start(); }
  }
  private async spawnChild(program: RuntimeInstalledProgram, id: string, lock: RuntimeInstallLock): Promise<Child> {
    this.current(lock);
    if (!same(readRuntimeInstalledProgram(this.install.root, program.folder), program)) throw Error("Runtime target changed");
    const child = (this.options.spawn ?? spawn)(process.execPath, [join(this.install.root, program.folder, "dist", "runtime-cli.js"), "--internal-update"],
      { shell: false, stdio: ["inherit", "inherit", "inherit", "ipc"], env: nativeCliEnvironment(), windowsHide: false });
    const exited = new Promise<void>(done => {
      child.once("close", () => done()); child.once("error", () => { /* close owns physical completion */ });
      if (child.exitCode !== null || child.signalCode !== null) done();
    });
    let result: Child | undefined;
    try {
      result = { process: child, exited, channel: new RuntimeUpdateIpc(processPeer(child), id) };
      if (!child.pid) throw Error("Runtime update child did not start");
      const observed = await this.observe(child.pid);
      if (observed.state !== "alive" || observed.proof.pid !== child.pid || runtimeProcessMatches(observed.proof, observed) !== true) throw Error("Runtime update child ownership is unconfirmed");
      result.proof = { ...observed.proof }; this.owner = await attachRuntimeInstallChild(this.install.root, this.owner, result.proof, lock, this.observe);
      return result;
    } catch (error) {
      if (result) await this.stopUnadmitted(result);
      else { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; }
      throw error;
    }
  }
  private async arm(child: Child, init: Init): Promise<void> {
    const reply = await child.channel.exchange(init, ["armed", "failure"]);
    if (reply.type !== "armed" || !child.proof || runtimeProcessMatches(child.proof, await this.observe(child.proof.pid)) !== true) throw Error("Runtime helper readiness is unconfirmed");
  }
  private async stopUnadmitted(child: Child): Promise<void> {
    child.channel.close();
    if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill();
    await child.exited;
    if (child.proof && runtimeProcessMatches(child.proof, await this.observe(child.proof.pid)) !== false) throw Error("Runtime child exit is unconfirmed");
  }
  async wait(): Promise<void> {
    if (!this.client) throw Error("Runtime controller was not started");
    for (;;) {
      const client: RuntimeClient = this.client; await client.waitUntilStopped(); if (this.work) await this.work.catch(() => {});
      if (this.client !== client) continue;
      if (this.handedOff) return;
      if (client.stopReason) throw Error(describeRuntimeStop(client.stopReason)); return;
    }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    let accept!: () => void, reject!: (error: unknown) => void;
    const owned = new Promise<void>((done, fail) => { accept = done; reject = fail; }); this.closePromise = owned;
    this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    void (async () => {
      await this.client?.stop();
      if (this.lifecycle) await this.lifecycle.catch(() => {});
      if (this.work) await this.work.catch(() => {});
      if (!this.handedOff) {
        if (this.ownerReleased) { this.retainedLease?.release(); this.retainedLease = undefined; }
        else await this.locked(async lock => { await releaseRuntimeInstallOwner(this.install.root, this.owner, lock, this.observe); this.ownerReleased = true; });
      }
    })().then(accept, error => { if (this.closePromise === owned) this.closePromise = undefined; reject(error); });
    return owned;
  }
}

/** Public run/connect use this only after resolving the existing local pairing/profile normally. */
export async function runRuntimeWithUpdates(options: RuntimeUpdateControllerOptions): Promise<boolean> {
  let controller: RuntimeUpdateController | undefined, cancelled = false;
  const stop = () => { cancelled = true; void controller?.close().catch(() => { process.exitCode = 1; }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    controller = await RuntimeUpdateController.open(options); if (!controller) return false;
    if (!cancelled) { await controller.start(); await controller.wait(); }
    return true;
  } finally {
    try { await controller?.close(); } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  }
}

/** No public command can supply an init payload. It must arrive over the inherited Node IPC channel. */
export async function runtimeUpdateInternalMain(): Promise<void> {
  if (process.platform !== "win32" || !process.send || !process.connected) throw Error("Inherited native Runtime update channel required");
  const channel = new RuntimeUpdateIpc({ get connected() { return process.connected === true; },
    on: (event, listener) => process.on(event, listener), off: (event, listener) => process.off(event, listener),
    send: (message, callback) => process.send!(message, callback) });
  let controller: RuntimeUpdateController | undefined, cancelled = false;
  const stop = () => { cancelled = true; void controller?.close().catch(() => { process.exitCode = 1; }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const init = await channel.next(["init"]); if (init.type !== "init") throw Error("Runtime update initialization required");
    controller = await RuntimeUpdateController.resume({ store: new RuntimeClientStore(resolve(init.profile)), report: message => process.stdout.write(`${message}\n`) }, init, channel, () => cancelled);
    if (cancelled) return;
    if (init.role === "helper") await controller.startTrial(init.id); else await controller.start();
    await controller.wait();
  } finally {
    channel.close();
    try { await controller?.close(); } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  }
}
