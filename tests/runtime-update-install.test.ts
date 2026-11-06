/** Real private files and producer ZIPs; inert module bytes, no process, installer, account or native CLI. */
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeBundle, type RuntimeBundle } from "../src/runtime-bundle.js";
import { runtimeCodeBuildId } from "../src/runtime-build-info.js";
import { runtimeBundleFixture } from "./support/runtime-bundle-fixture.js";
import { acquireRuntimeInstallLock, type RuntimeInstallLock } from "../src/runtime-update-lock.js";
import { parseRuntimeInstallReceipt, readRuntimeInstallReceipt, readRuntimeInstalledProgram, readRuntimeSelectedProgram, registerRuntimeInstallOrigin, selectRuntimeProgram, stageRuntimeUpdate, RUNTIME_INSTALL_RECEIPT, type RuntimeInstallReceipt } from "../src/runtime-update-install.js";
let sourceA: ReturnType<typeof runtimeBundleFixture>, sourceB: ReturnType<typeof runtimeBundleFixture>, a: RuntimeBundle, b: RuntimeBundle;
const roots: string[] = [], own = { pid: process.pid, birth: "638980000000000000", boot: "a".repeat(64) };
const receipt = (): RuntimeInstallReceipt => ({ version: 1, id: randomUUID(), createdAt: 1, revision: 1, origins: ["https://paired.example.test"], shared: false });
function root(initial: RuntimeInstallReceipt | null = receipt()) {
  const path = mkdtempSync(join(tmpdir(), "agend-managed-install-")); roots.push(path);
  if (initial) writeFileSync(join(path, RUNTIME_INSTALL_RECEIPT), JSON.stringify(initial), { mode: 0o600 });
  mkdirSync(join(path, "bin"), { mode: 0o700 }); writeFileSync(join(path, "bin", "agend-runtime.cmd"), "stable shim fixture", { mode: 0o600 }); return path;
}
const metadata = (bundle: RuntimeBundle) => ({ version: bundle.version, sha256: bundle.sha256, bytes: bundle.bytes.length });
const lockAt = (path: string) => acquireRuntimeInstallLock(path, { ownProof: own });
beforeAll(() => { sourceA = runtimeBundleFixture("2.3.5-fixture.1"); sourceB = runtimeBundleFixture("2.3.5-fixture.2"); a = createRuntimeBundle(sourceA); b = createRuntimeBundle(sourceB); });
afterAll(() => { sourceA?.cleanup(); sourceB?.cleanup(); });
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
it("strictly bounds the public origin receipt without accepting a selected path or command", () => {
  const good = receipt(); expect(parseRuntimeInstallReceipt(good)).toEqual(good);
  for (const bad of [{ ...good, path: "anything" }, { ...good, origins: ["http://nonloopback.example.test"] }, { ...good, origins: ["https://paired.example.test/"] },
    { ...good, origins: [...good.origins, ...good.origins] }, { ...good, origins: [...good.origins, "https://other.example.test"] }, { ...good, origins: [] },
    { ...good, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...good, id: "unknown" }]) expect(() => parseRuntimeInstallReceipt(bad)).toThrow();
});
it("does not adopt a legacy or ZIP installation without a fresh installer receipt", async () => {
  const path = root(null), lock = await lockAt(path);
  try {
    expect(readRuntimeInstallReceipt(path)).toBeUndefined();
    expect(() => registerRuntimeInstallOrigin(path, "https://paired.example.test", lock)).toThrow(/unmanaged/);
    expect(() => stageRuntimeUpdate(path, a.bytes, metadata(a), lock)).toThrow(/unmanaged/);
    expect(existsSync(join(path, RUNTIME_INSTALL_RECEIPT))).toBe(false);
    expect(readdirSync(path).some(name => name.startsWith(".install-"))).toBe(false);
  } finally { lock.release(); }
});
it("permanently records a second origin under the install lock, including after reconnect to the first", async () => {
  const path = root(), before = readRuntimeInstallReceipt(path)!, lock = await lockAt(path);
  try {
    expect(registerRuntimeInstallOrigin(path, before.origins[0], lock)).toEqual(before);
    const shared = registerRuntimeInstallOrigin(path, "https://other.example.test", lock);
    expect(shared).toMatchObject({ id: before.id, createdAt: before.createdAt, revision: 2, shared: true }); expect(shared.origins).toHaveLength(2);
    expect(registerRuntimeInstallOrigin(path, before.origins[0], lock)).toEqual(shared);
    expect(readRuntimeInstallReceipt(path)).toEqual(shared);
  } finally { lock.release(); }
});
it("refuses an origin receipt overflow without silently dropping origins or bumping revisions", async () => {
  const initial = { ...receipt(), origins: Array.from({ length: 8 }, (_, i) => `https://fleet-${i}.example.test`), shared: true }, path = root(initial), lock = await lockAt(path);
  try { expect(() => registerRuntimeInstallOrigin(path, "https://ninth.example.test", lock)).toThrow(/unsafe/); expect(readRuntimeInstallReceipt(path)).toEqual(initial); }
  finally { lock.release(); }
});
it("refuses an on-disk manifest Build ID that differs from its actual modules", async () => {
  const path = root(), lock = await lockAt(path);
  try {
    const installed = stageRuntimeUpdate(path, a.bytes, metadata(a), lock), manifestFile = join(path, installed.folder, "bundle-manifest.json"), manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest.buildId = "f".repeat(64); writeFileSync(manifestFile, JSON.stringify(manifest));
    expect(() => readRuntimeInstalledProgram(path, installed.folder)).toThrow(/unsafe/);
  } finally { lock.release(); }
});
it.each(["hash", "build"] as const)("refuses an existing short-prefix target with a different full %s identity", async variant => {
  const path = root(), lock = await lockAt(path);
  try {
    const installed = stageRuntimeUpdate(path, a.bytes, metadata(a), lock), base = join(path, installed.folder), marker = join(base, ".agend-install-sha256");
    if (variant === "hash") writeFileSync(marker, a.sha256.slice(0, 8) + "0".repeat(56));
    else {
      const manifestFile = join(base, "bundle-manifest.json"), manifest = JSON.parse(readFileSync(manifestFile, "utf8")), bytes = Buffer.from("// different verified fixture module\nexport {};\n");
      writeFileSync(join(base, "dist", "runtime-cli.js"), bytes); manifest.sha256["dist/runtime-cli.js"] = createHash("sha256").update(bytes).digest("hex");
      manifest.buildId = runtimeCodeBuildId(a.version, manifest.modules.map((name: string) => [name, readFileSync(join(base, "dist", name))] as const));
      writeFileSync(manifestFile, JSON.stringify(manifest));
    }
    const changed = readRuntimeInstalledProgram(path, installed.folder); expect(changed).not.toEqual(installed);
    expect(() => stageRuntimeUpdate(path, a.bytes, metadata(a), lock)).toThrow(/collision/);
    expect(readRuntimeInstalledProgram(path, installed.folder)).toEqual(changed);
  } finally { lock.release(); }
});
it("resolves relative roots without changing the verified program identity", async () => {
  const path = root(), lock = await lockAt(path);
  try { const installed = stageRuntimeUpdate(path, a.bytes, metadata(a), lock); expect(readRuntimeInstalledProgram(relative(process.cwd(), path), installed.folder)).toEqual(installed); }
  finally { lock.release(); }
});
it("stages verified programs side by side, hashes disk bytes and atomically selects forward and back", async () => {
  const path = root(), lock = await lockAt(path), journal = join(path, "pairing-fixture.json"); writeFileSync(journal, "unchanged pairing fixture", { mode: 0o600 });
  try {
    const old = stageRuntimeUpdate(path, a.bytes, metadata(a), lock); writeFileSync(join(path, "bin", "current.txt"), old.folder, { mode: 0o600 });
    const next = stageRuntimeUpdate(path, b.bytes, metadata(b), lock);
    expect(readRuntimeSelectedProgram(path)).toEqual(old); expect(stageRuntimeUpdate(path, b.bytes, metadata(b), lock)).toEqual(next);
    expect(next).toMatchObject({ version: b.version, sha256: b.sha256, folder: `${b.version}+${b.sha256.slice(0, 8)}` }); expect(next.buildId).not.toBe(old.buildId);
    selectRuntimeProgram(path, old, next, lock); expect(readRuntimeSelectedProgram(path)).toEqual(next);
    selectRuntimeProgram(path, next, old, lock); expect(readRuntimeSelectedProgram(path)).toEqual(old);
    expect(readRuntimeInstalledProgram(path, next.folder)).toEqual(next);
    expect(readFileSync(journal, "utf8")).toBe("unchanged pairing fixture"); expect(readFileSync(join(path, "bin", "agend-runtime.cmd"), "utf8")).toBe("stable shim fixture");
    expect(readdirSync(path).some(name => name.startsWith(".install-"))).toBe(false);
  } finally { lock.release(); }
});
it("rejects a SHA mismatch before creating staging or switching the pointer", async () => {
  const path = root(), lock = await lockAt(path);
  try { const wrong = Buffer.from(a.bytes); wrong[100] ^= 1; expect(() => stageRuntimeUpdate(path, wrong, metadata(a), lock)).toThrow(); expect(readdirSync(path).some(name => name.startsWith(".install-") || name.includes("+"))).toBe(false); expect(existsSync(join(path, "bin", "current.txt"))).toBe(false); }
  finally { lock.release(); }
});
it("never repairs or overwrites an existing incomplete target", async () => {
  const path = root(), lock = await lockAt(path), folder = `${a.version}+${a.sha256.slice(0, 8)}`; mkdirSync(join(path, folder), { mode: 0o700 }); writeFileSync(join(path, folder, "keep"), "incomplete target", { mode: 0o600 });
  try { expect(() => stageRuntimeUpdate(path, a.bytes, metadata(a), lock)).toThrow(); expect(readFileSync(join(path, folder, "keep"), "utf8")).toBe("incomplete target"); expect(existsSync(join(path, folder, "bundle-manifest.json"))).toBe(false); }
  finally { lock.release(); }
});
it.each(["LICENSE", "dist/runtime-cli.js"])("refuses changed declared %s bytes even when the full archive marker is retained", async name => {
  const path = root(), lock = await lockAt(path);
  try { const installed = stageRuntimeUpdate(path, a.bytes, metadata(a), lock), file = join(path, installed.folder, name); writeFileSync(file, "changed program fixture"); expect(() => readRuntimeInstalledProgram(path, installed.folder)).toThrow(/changed/); expect(() => stageRuntimeUpdate(path, a.bytes, metadata(a), lock)).toThrow(/changed/); expect(readFileSync(file, "utf8")).toBe("changed program fixture"); }
  finally { lock.release(); }
});
it("refuses symlink targets without changing their contents", async () => {
  const path = root(), outside = root(null), lock = await lockAt(path), folder = `${a.version}+${a.sha256.slice(0, 8)}`; symlinkSync(outside, join(path, folder));
  try { const before = readdirSync(outside); expect(() => stageRuntimeUpdate(path, a.bytes, metadata(a), lock)).toThrow(/unsafe/); expect(readdirSync(outside)).toEqual(before); }
  finally { lock.release(); }
});
it("cleans only this staging attempt when lock ownership changes before publication", async () => {
  const path = root(), lock = await lockAt(path); let checks = 0;
  const changed: RuntimeInstallLock = { record: lock.record, release: () => lock.release(), assert: () => { lock.assert(); if (++checks === 2) throw Error("changed owner fixture"); } };
  try { expect(() => stageRuntimeUpdate(path, a.bytes, metadata(a), changed)).toThrow("changed owner fixture"); expect(readdirSync(path).some(name => name.startsWith(".install-") || name.includes("+"))).toBe(false); expect(readRuntimeInstallReceipt(path)?.shared).toBe(false); }
  finally { lock.release(); }
});
it("a stale selected-program snapshot cannot overwrite a newer selection", async () => {
  const path = root(), lock = await lockAt(path);
  try { const old = stageRuntimeUpdate(path, a.bytes, metadata(a), lock), next = stageRuntimeUpdate(path, b.bytes, metadata(b), lock); writeFileSync(join(path, "bin", "current.txt"), next.folder, { mode: 0o600 }); expect(() => selectRuntimeProgram(path, old, next, lock)).toThrow(/changed/); expect(readRuntimeSelectedProgram(path)).toEqual(next); }
  finally { lock.release(); }
});
it("rechecks the exact pointer immediately before the atomic rename", async () => {
  const path = root(), lock = await lockAt(path); let checks = 0;
  try {
    const old = stageRuntimeUpdate(path, a.bytes, metadata(a), lock), next = stageRuntimeUpdate(path, b.bytes, metadata(b), lock), pointer = join(path, "bin", "current.txt"); writeFileSync(pointer, old.folder, { mode: 0o600 });
    const raced: RuntimeInstallLock = { record: lock.record, release: () => lock.release(), assert: () => { lock.assert(); if (++checks === 2) writeFileSync(pointer, "concurrent-selection-fixture"); } };
    expect(() => selectRuntimeProgram(path, old, next, raced)).toThrow(/changed/); expect(readFileSync(pointer, "utf8")).toBe("concurrent-selection-fixture"); expect(readdirSync(join(path, "bin")).filter(name => name.endsWith(".tmp"))).toEqual([]);
  } finally { lock.release(); }
});
