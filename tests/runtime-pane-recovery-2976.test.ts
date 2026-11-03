/** Offline host/ledger proof only: no native process, provider store or account. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { paneSystemBootId } from "../src/runtime-pane-boot.js";
import { RuntimePaneStore, type RuntimePaneRecord } from "../src/runtime-pane-store.js";
import { RuntimePaneHost } from "../src/runtime-pane-host.js";
import { validateRuntimePaneRequest, validateRuntimePaneSnapshot } from "../src/runtime-pane-protocol.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(systemBootId: string | undefined = "a".repeat(64)) {
 const root = mkdtempSync(join(tmpdir(), "agend-pane-recovery-")); roots.push(root);
 const store = new RuntimePaneStore(root), bootId = randomUUID();
 const launch = { paneId: randomUUID(), launchId: randomUUID(), agentId: randomUUID(), instance: "held-pane", cli: "codex" as const, cwd: "C:\\scratch", sandbox: "read-only" as const, columns: 80, rows: 24, sessionId: randomUUID() };
 const record: RuntimePaneRecord = { launch, bootId, ...(systemBootId ? { systemBootId } : {}), openDigest: RuntimePaneStore.digest(launch), openOperationId: randomUUID(), pid: 12345,
  snapshot: { paneId: launch.paneId, launchId: launch.launchId, agentId: launch.agentId, instance: launch.instance, sessionId: launch.sessionId, columns: launch.columns, rows: launch.rows, hostBootId: bootId, state: "running", commandSequence: 7, seq: 10, outputAt: 1 },
  lastCommand: { id: randomUUID(), digest: "b".repeat(64), state: "prepared" } };
 store.put(record); return { root, store, record };
}
it("hashes only a strict Windows boot-time value; malformed or absent proof cannot manufacture an incarnation", () => {
 expect(paneSystemBootId("638977239000000000")).toMatch(/^[a-f0-9]{64}$/);
 expect(paneSystemBootId("638977239000000000")).toBe(paneSystemBootId("638977239000000000"));
 for (const value of ["", "0", "unknown", "638977239000000000\n", "x638977239000000000"]) expect(() => paneSystemBootId(value)).toThrow();
});
it("a proven later OS boot settles only the exact old tree, preserving the pin and interrupted command identity", () => {
 const f = fixture(); f.store.recoverInterrupted("c".repeat(64)); const ended = f.store.get(f.record.launch.paneId)!;
 expect(ended.snapshot).toMatchObject({ state: "exited", exitProof: "system-reboot", sessionId: f.record.launch.sessionId, hostBootId: f.record.bootId, commandSequence: 7 });
 expect(ended.lastCommand).toEqual(f.record.lastCommand); expect(ended.snapshot.exitCode).toBeUndefined();
 expect(validateRuntimePaneSnapshot(ended.snapshot)).toEqual(ended.snapshot);
});
it.each(["same", "unknown", "legacy"])("%s boot evidence holds the reservation", kind => {
 const f = fixture(kind === "legacy" ? undefined : "a".repeat(64));
 // Explicitly remove the optional field for a legacy record (the helper's default argument is for other fixtures).
 if (kind === "legacy") { delete f.record.systemBootId; f.store.put(f.record); }
 f.store.recoverInterrupted(kind === "same" ? "a".repeat(64) : kind === "legacy" ? "c".repeat(64) : undefined);
 expect(f.store.get(f.record.launch.paneId)?.snapshot.state).toBe("unknown");
});
it("admin recovery is exact, idempotent, no-input and available only for an orphaned unknown launch", async () => {
 const f = fixture(); f.store.recoverInterrupted(); const spawn = vi.fn();
 const host = new RuntimePaneHost({ store: f.store, bootId: randomUUID(), online: () => true, maxAgents: () => 4, spawn });
 const request = { action: "recover" as const, paneId: f.record.launch.paneId, launchId: f.record.snapshot.launchId, hostBootId: f.record.bootId, confirmedStopped: true as const };
 await expect(host.request({ ...request, confirmedStopped: false })).rejects.toThrow("confirmation");
 await expect(host.request({ ...request, hostBootId: randomUUID() })).rejects.toThrow("exact");
 await expect(host.request({ ...request, launchId: randomUUID() })).rejects.toThrow("exact");
 const ended = await host.request(request); expect(ended).toMatchObject({ state: "exited", exitProof: "admin-confirmed", commandSequence: 7, sessionId: f.record.launch.sessionId });
 expect(await host.request(request)).toEqual(ended); expect(spawn).not.toHaveBeenCalled();
 expect(f.store.get(request.paneId)?.lastCommand).toEqual(f.record.lastCommand);
});
it("a current host's unproven process cannot be unlocked by an admin assertion", async () => {
 const f = fixture(); f.store.recoverInterrupted();
 const host = new RuntimePaneHost({ store: f.store, bootId: f.record.bootId, online: () => true, maxAgents: () => 4 });
 await expect(host.request({ action: "recover", paneId: f.record.launch.paneId, launchId: f.record.snapshot.launchId, hostBootId: f.record.bootId, confirmedStopped: true })).rejects.toThrow("not eligible");
 expect(f.store.get(f.record.launch.paneId)?.snapshot.state).toBe("unknown");
});
it("recovery RPC is closed and exit proofs cannot be attached to live states", () => {
 const f = fixture(), request = { action: "recover", paneId: f.record.launch.paneId, launchId: f.record.snapshot.launchId, hostBootId: f.record.bootId, confirmedStopped: true };
 expect(() => validateRuntimePaneRequest({ ...request, command: "never" })).toThrow();
 expect(() => validateRuntimePaneSnapshot({ ...f.record.snapshot, exitProof: "admin-confirmed" })).toThrow();
});
