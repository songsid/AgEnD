import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, linkSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeBackendVersion } from "../src/backend-availability.js";
import { GrokBackend } from "../src/backend/grok.js";
import { Daemon } from "../src/daemon.js";
import { checkpointGrokDelivery, grokConsumedMarker } from "../src/grok-delivery-proof.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { ConsumedWatch, consumedWatches } from "../src/delivery-consumed-watch.js";
const osHome = vi.hoisted(() => ({ value: "" }));
vi.mock("node:os", async importOriginal => {
  const real = await importOriginal<typeof import("node:os")>();
  return { ...real, homedir: () => osHome.value || real.homedir() };
});
const fsGate = vi.hoisted(() => ({ next: null as null | { wait: Promise<void>; entered(): void; settled(): void } }));
vi.mock("node:fs/promises", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return { ...real, lstat: async (...args: Parameters<typeof real.lstat>) => {
    const gate = fsGate.next; fsGate.next = null;
    if (gate) { gate.entered(); await gate.wait; }
    try { return await real.lstat(...args); } finally { gate?.settled(); }
  } };
});
const versionProbe = vi.hoisted(() => ({ value: "1.0.77" as string | null }));
vi.mock("../src/backend-availability.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/backend-availability.js")>();
  return { ...real, probeBackendVersion: vi.fn(async () => versionProbe.value) };
});
const roots: string[] = [];
afterEach(() => { consumedWatches.stopAll(); osHome.value = ""; versionProbe.value = "1.0.77"; vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const temp = () => { const p = mkdtempSync(join(tmpdir(), "grok3810-")); roots.push(p); return p; };
const log: any = { info() {}, warn() {}, debug() {}, error() {}, child() { return this; } };
describe("#3810 owned Grok late consumption", () => {
  it("pins a fresh launch UUID rather than guessing the newest same-cwd session", async () => {
    const p = temp(), backend = fakeLaunch(p); await backend.prepareLaunch();
    const command = backend.buildCommand({ instanceName: "worker", instanceDir: p, workingDirectory: p, mcpServers: {} });
    expect(command).toMatch(/--session-id [0-9a-f-]{36}(?: |$)/);
  });
  it("starts a positive-only late watch for a Grok idle_submit whose pane proof stayed uncertain", () => {
    const p = temp(), dir = join(p, "instances", "worker"); mkdirSync(dir, { recursive: true });
    const daemon: any = new Daemon("worker", { working_directory: p, log_level: "error", backend: "grok" } as any, dir, false, undefined as any, undefined as any, log);
    const port = { complete: vi.fn(), markConsumed: vi.fn() }; daemon.setDeliveryOutboxPort(port);
    const start = vi.spyOn(consumedWatches, "start").mockReturnValue(true);
    const ownedGrok = { sessionId: "4b388fc1-2601-4552-bd03-4a6e2edcf8e0", current: () => true, readChunk: vi.fn() };
    daemon.finishDurableDelivery({ deliveryId: "d-3810", attemptNo: 1 }, "uncertain", "post-submit-proof:unproven", { submissionMode: "idle_submit", transcriptCheckpoint: { backend: "grok", path: "/owned/updates.jsonl", offset: 0, ownedGrok } });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ backend: "grok", deliveryId: "d-3810", grokSessionId: ownedGrok.sessionId, readChunk: ownedGrok.readChunk }));
    expect(start.mock.calls[0][0].notTaken).toBeUndefined();
    expect(port.markConsumed).not.toHaveBeenCalled();
  });
});

const SID = "4b388fc1-2601-4552-bd03-4a6e2edcf8e0", DID = "74ff4c43-8c39-400f-a8a0-f2551b05b2db";
const marker = `[agend-delivery-id:${DID}]`;
const fix = (name: string) => readFileSync(new URL(`./fixtures/grok-consumed-3810/${name}`, import.meta.url), "utf8");
const user = fix("submitted.updates.jsonl");
function source(existing = "") {
  const root = temp(), cwd = join(root, "work"), home = join(root, "home"); mkdirSync(cwd);
  const dir = join(home, ".grok", "sessions", encodeURIComponent(cwd), SID); mkdirSync(dir, { recursive: true });
  const summary = JSON.parse(fix("summary.json")); summary.info.cwd = cwd;
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary));
  const path = join(dir, "updates.jsonl"); if (existing) writeFileSync(path, existing);
  let live = true;
  const checkpoint = () => checkpointGrokDelivery({ sessionId: SID, cwd, home, current: () => live });
  return { root, cwd, home, dir, path, checkpoint, fence: () => { live = false; } };
}
async function watching(h: ReturnType<typeof source>) {
  const cp = (await h.checkpoint())!; expect(cp).not.toBeNull();
  const consumed = vi.fn(), ended = vi.fn();
  const w = new ConsumedWatch({ deliveryId: DID, attemptNo: 1, backend: "grok", path: cp.path, offset: cp.offset,
    grokSessionId: SID, readChunk: cp.ownedGrok.readChunk, current: cp.ownedGrok.current, consumed }, ended);
  return { cp, consumed, ended, w };
}
describe("recorded Grok 1.0.77 structured input (real CLI, offline mock)", () => {
  it("the submitted input proves consumption; the draft and completed assistant text do not", () => {
    expect(grokConsumedMarker(user, SID, marker)).toBe("user");
    expect(grokConsumedMarker(fix("draft.chat.jsonl"), SID, marker)).toBeNull();
    expect(grokConsumedMarker(fix("completed.updates.jsonl").split("\n").slice(1).join("\n"), SID, marker)).toBeNull();
  });
  it.each([
    ["wrong session", (r: any) => { r.params.sessionId = "00000000-0000-4000-8000-000000000000"; }],
    ["assistant quote", (r: any) => { r.params.update.sessionUpdate = "agent_message_chunk"; }],
    ["tool quote", (r: any) => { r.params.update.sessionUpdate = "tool_call_update"; }],
    ["completion", (r: any) => { r.params.update.sessionUpdate = "turn_completed"; }],
    ["wrong method", (r: any) => { r.method = "_x.ai/session/update"; }],
    ["quoted marker", (r: any) => { r.params.update.content.text = "quoted: " + r.params.update.content.text; }],
    ["wrong content", (r: any) => { r.params.update.content.type = "resource"; }],
    ["wrong delivery", (r: any) => { r.params.update.content.text = r.params.update.content.text.replace(DID, "other"); }],
  ] as const)("%s never proves delivery", (_, change) => {
    const r = JSON.parse(user); change(r); expect(grokConsumedMarker(JSON.stringify(r), SID, marker)).toBeNull();
  });
  it("does not follow a newer same-cwd session or any unknown launch id", async () => {
    const h = source();
    expect(await checkpointGrokDelivery({ sessionId: null, cwd: h.cwd, home: h.home, current: () => true })).toBeNull();
    const other = join(h.dir, "..", "00000000-0000-4000-8000-000000000000"); mkdirSync(other); writeFileSync(join(other, "updates.jsonl"), user);
    const w = await watching(h); await w.w.look(); expect(w.consumed).not.toHaveBeenCalled(); w.w.stop();
  });
  it("ignores pre-checkpoint input and incomplete lines, then accepts only a complete later record", async () => {
    const h = source(user), w = await watching(h); await w.w.look(); expect(w.consumed).not.toHaveBeenCalled();
    appendFileSync(h.path, user.trimEnd()); await w.w.look(); expect(w.consumed).not.toHaveBeenCalled();
    appendFileSync(h.path, "\n"); await w.w.look(); expect(w.consumed).toHaveBeenCalledOnce(); w.w.stop();
  });
  it("a partial EOF cannot authorize a pre-write checkpoint", async () => {
    const h = source(user.trimEnd()); expect(await h.checkpoint()).toBeNull();
  });
  it.each(["replace", "symlink", "truncate", "directory"])("%s permanently retires a lease, even if the original is restored before a late marker", async kind => {
    const h = source(user), w = await watching(h), saved = h.path + ".saved";
    if (kind === "directory") { renameSync(h.dir, h.dir + ".saved"); mkdirSync(h.dir); linkSync(join(h.dir + ".saved", "updates.jsonl"), h.path); }
    else { renameSync(h.path, saved); if (kind === "symlink") symlinkSync(saved, h.path); else writeFileSync(h.path, kind === "truncate" ? "" : user); }
    await w.w.look(); expect(w.ended).toHaveBeenCalledWith("unavailable");
    if (kind === "directory") { rmSync(h.dir, { recursive: true }); renameSync(h.dir + ".saved", h.dir); }
    else { rmSync(h.path); renameSync(saved, h.path); }
    appendFileSync(h.path, user); await w.w.look(); expect(w.consumed).not.toHaveBeenCalled(); expect(w.cp.ownedGrok.current()).toBe(false);
  });
  it("a stop/respawn fence ends a pending watch with no proof and no resend", async () => {
    const h = source(), w = await watching(h); h.fence(); writeFileSync(h.path, user); await w.w.look();
    expect(w.consumed).not.toHaveBeenCalled(); expect(w.ended).toHaveBeenCalledWith("fenced");
  });
  it("after uncertain idle submission, real outbox upgrades only on the late exact input record, without another paste", async () => {
    const h = source(), cp = (await h.checkpoint())!;
    const box = new DeliveryOutbox(join(h.root, "outbox.db"), "manager");
    try {
      const row = box.admit({ operationId: "op3810", sourceKey: "fixture3810", sourceInstance: "source", sourceDaemonBootId: "source-boot", targetInstance: "worker", kind: "message", payload: { type: "message", content: "fixture" } }).delivery;
      const instance = join(h.root, "instance"); mkdirSync(instance);
      const d: any = new Daemon("worker", { working_directory: h.cwd, backend: "grok" } as any, instance, false, undefined as any, undefined as any, log);
      d.setDeliveryOutboxPort(box);
      const claim = box.claimNext("manager", () => d.bootId, new Set())!;
      expect(box.begin(row.deliveryId, d.bootId, claim.attemptNo, { backend: "grok", backendVersion: null, windowId: "@w", transcriptPath: cp.path, transcriptOffset: cp.offset, transcriptSessionId: SID, submissionMode: "idle_submit" })).toBe("begun");
      let w!: ConsumedWatch;
      const start = vi.spyOn(consumedWatches, "start").mockImplementation(target => { w = new ConsumedWatch(target, () => {}); return true; });
      d.finishDurableDelivery({ deliveryId: row.deliveryId, attemptNo: claim.attemptNo }, "uncertain", "post-submit-proof:unproven", { submissionMode: "idle_submit", transcriptCheckpoint: cp });
      expect(start).toHaveBeenCalledOnce(); expect(start.mock.calls[0][0].notTaken).toBeUndefined();
      await w.look(); expect(box.get(row.deliveryId)?.state).toBe("uncertain");
      writeFileSync(h.path, user.replaceAll(DID, row.deliveryId)); await w.look();
      expect(box.get(row.deliveryId)?.state).toBe("delivered"); expect(box.queryStatusForInstance("source", { deliveryId: row.deliveryId }).items[0].consumed_via).toBe("turn"); w.stop();
    } finally { box.close(); }
  });
});

describe("pre-paste ownership and late watcher fences", () => {
  it("takes the exact checkpoint before durable begin and before any paste", async () => {
    const h = source(), instance = join(h.root, "instance"); mkdirSync(instance); writeFileSync(join(instance, "session-id"), SID);
    osHome.value = h.home;
    const backend = new GrokBackend(instance); backend.buildCommand({ instanceName: "worker", instanceDir: instance, workingDirectory: h.cwd, mcpServers: {} });
    const d: any = new Daemon("worker", { working_directory: h.cwd, backend: "grok" } as any, instance, false, backend, undefined as any, log);
    const pasted = vi.fn(), begin = vi.fn(() => "begun"); d.setDeliveryOutboxPort({ begin } as any);
    d.tmux = { capturePane: async () => fix("ready.pane.txt"), getWindowId: () => "@w", pasteBuffer: pasted };
    const verdict: any = { reached: false };
    await expect(d.writeMessageToPane(marker + " fixture", "@w", false, undefined, undefined, verdict, { deliveryId: DID, attemptNo: 1 }, false, () => true, undefined, () => {
      expect(begin).toHaveBeenCalledWith(DID, d.bootId, 1, expect.objectContaining({ transcriptPath: h.path, transcriptOffset: 0, transcriptSessionId: SID, submissionMode: "idle_submit" }));
      expect(verdict.transcriptCheckpoint.ownedGrok.sessionId).toBe(SID);
      throw new Error("owned pre-paste checkpoint reached");
    })).rejects.toThrow("owned pre-paste checkpoint reached");
    expect(pasted).not.toHaveBeenCalled();
    d.launchFenceEpoch++; expect(verdict.transcriptCheckpoint.ownedGrok.current()).toBe(false);
  });
  it("retains explicit resume, creates a fresh identity after skipResume, and never reuses an unselected UUID", async () => {
    const p = temp(), backend = fakeLaunch(p); await backend.prepareLaunch(); writeFileSync(join(p, "session-id"), SID);
    const config = { instanceName: "worker", instanceDir: p, workingDirectory: p, mcpServers: {} };
    expect(backend.buildCommand(config)).toContain(`--resume ${SID}`); expect(backend.getDeliverySessionId()).toBe(SID);
    expect(backend.buildCommand({ ...config, skipResume: true })).toContain("--session-id "); expect(backend.getDeliverySessionId()).not.toBe(SID);
  });
  it.each(["id", "cwd", "symlink"])("rejects a mismatched %s source before write", async kind => {
    const h = source(), path = join(h.dir, "summary.json"), r = JSON.parse(readFileSync(path, "utf8"));
    if (kind === "id") r.info.id = "00000000-0000-4000-8000-000000000000";
    else if (kind === "cwd") r.info.cwd = h.root;
    if (kind === "symlink") { renameSync(path, path + ".saved"); symlinkSync(path + ".saved", path); }
    else writeFileSync(path, JSON.stringify(r));
    expect(await h.checkpoint()).toBeNull();
  });
  it("an expired unknown watch never revives from a late input, and a fenced in-flight read proves nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let clock = 0; vi.spyOn(performance, "now").mockImplementation(() => clock);
    let live = true, release!: (x: { chunk: Buffer; size: number }) => void;
    const consumed = vi.fn(), ended = vi.fn();
    const target = { deliveryId: DID, attemptNo: 1, backend: "grok", path: "/owned", offset: 0, grokSessionId: SID, current: () => live, consumed,
      readChunk: () => new Promise<{ chunk: Buffer; size: number }>(r => { release = r; }), lifetimeMs: 120_000 };
    const w = new ConsumedWatch(target, ended), pending = w.look(); live = false; release({ chunk: Buffer.from(user), size: Buffer.byteLength(user) }); await pending;
    expect(consumed).not.toHaveBeenCalled(); expect(ended).toHaveBeenCalledWith("fenced");
    live = true; const w2 = new ConsumedWatch({ ...target, readChunk: async () => ({ chunk: Buffer.from(user), size: Buffer.byteLength(user) }) }, ended);
    clock = 120_000; await vi.advanceTimersByTimeAsync(120_000); await w2.look(); await w2.look(); expect(consumed).not.toHaveBeenCalled(); expect(ended).toHaveBeenCalledWith("expired");
  });
});

describe("bounded checkpoint admission", () => {
  it("a delayed filesystem inspection times out, and its late answer remains retired", async () => {
    const h = source();
    let release!: () => void, entered!: () => void, settled!: () => void;
    const held = new Promise<void>(r => { release = r; }), inside = new Promise<void>(r => { entered = r; }), finished = new Promise<void>(r => { settled = r; });
    fsGate.next = { wait: held, entered, settled };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = h.checkpoint(); await inside;
    await vi.advanceTimersByTimeAsync(250); expect(await pending).toBeNull();
    release();
    // Complete the held IO before cleanup; no late inspection can publish a lease.
    await finished; await new Promise<void>(r => setImmediate(r));
    vi.useRealTimers();
    expect(await h.checkpoint()).not.toBeNull();
  });
});

describe("late-watch admission negatives", () => {
  it.each(["raw_paste", "steer", "native_queue_handoff"])("does not reconcile Grok %s from idle-only proof", mode => {
    const p = temp(), instance = join(p, "instance"); mkdirSync(instance);
    const d: any = new Daemon("worker", { working_directory: p, backend: "grok" } as any, instance, false, undefined as any, undefined as any, log);
    d.setDeliveryOutboxPort({ complete: vi.fn(), markConsumed: vi.fn() });
    const start = vi.spyOn(consumedWatches, "start").mockReturnValue(true);
    d.finishDurableDelivery({ deliveryId: DID, attemptNo: 1 }, "uncertain", "unproven", { submissionMode: mode, transcriptCheckpoint: { backend: "grok", path: "/owned", offset: 0, ownedGrok: { sessionId: SID, current: () => true, readChunk: vi.fn() } } });
    expect(start).not.toHaveBeenCalled();
  });
});

it.each(["custom-grok", " custom Grok "])("honors literal GROK_HOME=%s for both summary and fenced updates", async name => {
  const h = source(), home = join(h.root, name); renameSync(join(h.home, ".grok"), home); vi.stubEnv("GROK_HOME", home);
  const cp = await checkpointGrokDelivery({ sessionId: SID, cwd: h.cwd, current: () => true });
  const path = join(home, "sessions", encodeURIComponent(h.cwd), SID, "updates.jsonl");
  expect(cp?.path).toBe(path); writeFileSync(path, user);
  expect((await cp!.ownedGrok.readChunk(0, 4096))?.chunk.toString()).toBe(user);
});

function fakeLaunch(p: string) {
  const backend = new GrokBackend(p), binary = join(p, "grok-fixture");
  writeFileSync(binary, "inert version-gate fixture; never executed\n");
  (backend as any).binaryPath = binary;
  return backend;
}
describe("G1: old and unknown launch compatibility", () => {
  it.each(["1.0.62", "1.0.77"])("%s selects a fresh UUID only after bounded preparation", async version => {
    versionProbe.value = version; const p = temp(), backend = fakeLaunch(p);
    const config = { instanceName: "worker", instanceDir: p, workingDirectory: p, mcpServers: {} };
    expect(backend.buildCommand(config)).not.toContain("--session-id"); expect(backend.getDeliverySessionId()).toBeNull();
    await backend.prepareLaunch(); expect(backend.buildCommand(config)).toMatch(/--session-id [0-9a-f-]{36}/);
  });
  it.each(["1.0.61", null, "unknown"])("%s keeps the old fresh-launch syntax and has no lease/watch", async version => {
    versionProbe.value = version; const p = temp(), backend = fakeLaunch(p); await backend.prepareLaunch();
    const config = { instanceName: "worker", instanceDir: p, workingDirectory: p, mcpServers: {} };
    expect(backend.buildCommand(config)).not.toContain("--session-id"); expect(backend.getDeliverySessionId()).toBeNull();
    expect(await checkpointGrokDelivery({ sessionId: backend.getDeliverySessionId(), cwd: p, home: p, current: () => true })).toBeNull();
    writeFileSync(join(p, "session-id"), SID); expect(backend.buildCommand(config)).toContain(`--resume ${SID}`);
  });
  it("does not reuse version proof after binary replacement or a later unknown preparation", async () => {
    const p = temp(), backend = fakeLaunch(p), config = { instanceName: "worker", instanceDir: p, workingDirectory: p, mcpServers: {} };
    await backend.prepareLaunch(); appendFileSync(join(p, "grok-fixture"), "replaced");
    expect(backend.buildCommand(config)).not.toContain("--session-id"); expect(backend.getDeliverySessionId()).toBeNull();
    await backend.prepareLaunch(); expect(backend.buildCommand(config)).toContain("--session-id");
    versionProbe.value = null; await backend.prepareLaunch(); expect(backend.buildCommand(config)).not.toContain("--session-id");
  });
});

it("an older in-flight version answer cannot re-enable a later unknown preparation", async () => {
  const p = temp(), backend = fakeLaunch(p), config = { instanceName: "worker", instanceDir: p, workingDirectory: p, mcpServers: {} };
  let release!: (v: string) => void, entered!: () => void;
  const inside = new Promise<void>(r => { entered = r; });
  vi.mocked(probeBackendVersion).mockImplementationOnce(async () => { entered(); return await new Promise<string>(r => { release = r; }); });
  const old = backend.prepareLaunch(); await inside;
  versionProbe.value = null; await backend.prepareLaunch(); release("1.0.77"); await old;
  expect(backend.buildCommand(config)).not.toContain("--session-id"); expect(backend.getDeliverySessionId()).toBeNull();
});
it("a binary changed during version preparation cannot gain UUID capability", async () => {
  const p = temp(), backend = fakeLaunch(p), config = { instanceName: "worker", instanceDir: p, workingDirectory: p, mcpServers: {} };
  vi.mocked(probeBackendVersion).mockImplementationOnce(async () => { appendFileSync(join(p, "grok-fixture"), "changed during read"); return "1.0.77"; });
  await backend.prepareLaunch(); expect(backend.buildCommand(config)).not.toContain("--session-id");
});
it("a synthetic #3742 banner above the recorded composer is nonmodal and preserves the readable input box", () => {
  const backend = new GrokBackend(temp()), pane = fix("ready.pane.txt");
  const banner = "Help improve Grok [Opt out] [Opt in]\nOff by default. Opt-in to allow SpaceXAI to retain coding data.\n";
  const shown = pane.replace("  ╭", banner + "  ╭");
  expect(backend.readInputRow(pane)).not.toBeNull(); expect(backend.readInputRow(shown)).toEqual(backend.readInputRow(pane));
  expect(backend.getRuntimeDialogs().filter(d => d.pattern.test(shown))).toEqual([]);
});
