import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:fs", async original => { const fs = await original<typeof import("node:fs")>(); return { ...fs, rmdirSync: vi.fn(fs.rmdirSync) }; });
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRuntimeInstallLock, parseRuntimeInstallLock, readRuntimeInstallBytes, readRuntimeInstallFile, runtimeProcessMatches, RUNTIME_INSTALL_LOCK, type RuntimeInstallLockRecord, type RuntimeProcessObservation } from "../src/runtime-update-lock.js";
const roots: string[] = [];
const own = { pid: process.pid, birth: "638980000000000000", boot: "a".repeat(64) };
function root() { const path = mkdtempSync(join(tmpdir(), "agend-install-lock-")); roots.push(path); return path; }
function previous(path: string, extra: Partial<RuntimeInstallLockRecord> = {}) {
  const lock = join(path, RUNTIME_INSTALL_LOCK); mkdirSync(lock, { mode: 0o700 });
  const value: RuntimeInstallLockRecord = { version: 1, type: "installer", nonce: randomUUID(), ...own, pid: 123456, ...extra };
  writeFileSync(join(lock, "owner.json"), JSON.stringify(value), { mode: 0o600 }); return value;
}
afterEach(() => { vi.mocked(rmdirSync).mockClear(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
it("serializes installer and supervisor ownership without assuming a PowerShell process is a dead Runtime", async () => {
  const path = root(), first = await acquireRuntimeInstallLock(path, { type: "installer", ownProof: own });
  expect(first.record.type).toBe("installer"); first.assert();
  const observe = vi.fn(async (): Promise<RuntimeProcessObservation> => ({ state: "alive", proof: own }));
  await expect(acquireRuntimeInstallLock(path, { ownProof: own, observe })).rejects.toThrow(/held/);
  expect(observe).toHaveBeenCalledWith(process.pid);
  first.release(); first.release();
  const second = await acquireRuntimeInstallLock(path, { ownProof: own });
  expect(second.record.nonce).not.toBe(first.record.nonce); expect(() => first.assert()).toThrow(/changed/);
  second.release(); expect(existsSync(join(path, RUNTIME_INSTALL_LOCK))).toBe(false);
});
it.each(["gone", "birth", "boot"])("reclaims only positive %s proof, not a process-name guess", async cause => {
  const path = root(), old = previous(path);
  const observed: RuntimeProcessObservation = cause === "gone" ? { state: "gone" } : { state: "alive", proof: { pid: old.pid, birth: old.birth, boot: old.boot, ...(cause === "birth" ? { birth: "638990000000000000" } : { boot: "b".repeat(64) }) } };
  const lock = await acquireRuntimeInstallLock(path, { ownProof: own, observe: async () => observed });
  expect(lock.record.nonce).not.toBe(old.nonce); lock.assert(); lock.release();
});
it("keeps unknown, mismatched-PID and malformed owners held", async () => {
  for (const observation of [{ state: "unknown" }, { state: "alive", proof: own }] as RuntimeProcessObservation[]) {
    const path = root(), old = previous(path), original = readFileSync(join(path, RUNTIME_INSTALL_LOCK, "owner.json"), "utf8");
    await expect(acquireRuntimeInstallLock(path, { ownProof: own, observe: async () => observation })).rejects.toThrow(/unknown/);
    expect(JSON.parse(original).nonce).toBe(old.nonce); expect(readFileSync(join(path, RUNTIME_INSTALL_LOCK, "owner.json"), "utf8")).toBe(original);
  }
  const path = root(); mkdirSync(join(path, RUNTIME_INSTALL_LOCK));
  writeFileSync(join(path, RUNTIME_INSTALL_LOCK, "owner.json"), "{}", { mode: 0o600 });
  await expect(acquireRuntimeInstallLock(path, { ownProof: own })).rejects.toThrow(/unsafe/);
});
it("does not remove a replacement owner that arrives while the old PID is being observed", async () => {
  const path = root(); previous(path);
  let release!: (value: RuntimeProcessObservation) => void;
  const acquiring = acquireRuntimeInstallLock(path, { ownProof: own, observe: () => new Promise(done => { release = done; }) });
  const rejected = expect(acquiring).rejects.toThrow(/changed/);
  rmSync(join(path, RUNTIME_INSTALL_LOCK), { recursive: true }); const replacement = previous(path, { nonce: randomUUID() });
  release({ state: "gone" }); await rejected;
  expect(JSON.parse(readFileSync(join(path, RUNTIME_INSTALL_LOCK, "owner.json"), "utf8")).nonce).toBe(replacement.nonce);
});
it("elects only one stale reclaimer and leaves an uncertain previous reclaim marker held", async () => {
  const path = root(); previous(path); mkdirSync(join(path, RUNTIME_INSTALL_LOCK, "reclaim"));
  await expect(acquireRuntimeInstallLock(path, { ownProof: own, observe: async () => ({ state: "gone" }) })).rejects.toThrow(/held/);
  expect(existsSync(join(path, RUNTIME_INSTALL_LOCK, "owner.json"))).toBe(true);
});
it("retains ownership when removal fails and permits a later positive release", async () => {
  const path = root(), lock = await acquireRuntimeInstallLock(path, { ownProof: own });
  vi.mocked(rmdirSync).mockImplementationOnce(() => { throw Object.assign(Error("inert removal failure"), { code: "ENOTEMPTY" }); });
  expect(() => lock.release()).toThrow("inert removal failure"); expect(() => lock.assert()).not.toThrow();
  expect(JSON.parse(readFileSync(join(path, RUNTIME_INSTALL_LOCK, "owner.json"), "utf8")).nonce).toBe(lock.record.nonce);
  lock.release(); expect(existsSync(join(path, RUNTIME_INSTALL_LOCK))).toBe(false);
});
it("never deletes an unknown lock entry to manufacture a successful release", async () => {
  const path = root(), lock = await acquireRuntimeInstallLock(path, { ownProof: own }), extra = join(path, RUNTIME_INSTALL_LOCK, "unknown");
  writeFileSync(extra, "preserve"); expect(() => lock.release()).toThrow(/held/); lock.assert();
  expect(readFileSync(extra, "utf8")).toBe("preserve"); rmSync(extra); lock.release();
});
it("rejects writable/symlink/overlarge state and strict record extras", async () => {
  const path = root(), file = join(path, "state"); writeFileSync(file, "x".repeat(3000), { mode: 0o600 });
  expect(() => readRuntimeInstallFile(file, 2048)).toThrow(/unsafe/);
  symlinkSync(file, join(path, "link")); expect(() => readRuntimeInstallFile(join(path, "link"))).toThrow(/unsafe/);
  const value = { version: 1, type: "installer", nonce: randomUUID(), ...own };
  expect(parseRuntimeInstallLock(value)).toEqual(value);
  for (const bad of [{ ...value, command: "anything" }, { ...value, nonce: null }, { ...value, birth: "unknown" }, { ...value, type: "runtime-cli" }]) expect(() => parseRuntimeInstallLock(bad)).toThrow(/unsafe/);
  expect(runtimeProcessMatches(own, { state: "unknown" })).toBeUndefined();
});
it("bounds raw binary reads and rejects hardlinks without decoding code assets as text", () => {
  const path = root(), file = join(path, "binary"), bytes = Buffer.from([0xff, 0, 0xfe]); writeFileSync(file, bytes, { mode: 0o600 });
  expect(readRuntimeInstallBytes(file, 3)?.bytes).toEqual(bytes);
  expect(() => readRuntimeInstallFile(file, 3)).toThrow();
  expect(() => readRuntimeInstallBytes(file, 2)).toThrow(/unsafe/);
  linkSync(file, join(path, "alias")); expect(() => readRuntimeInstallBytes(file, 3)).toThrow(/unsafe/);
});
