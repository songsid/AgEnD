import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, statSync, utimesSync, constants, openSync, closeSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const hooks = vi.hoisted(() => ({ mkdir: undefined as undefined | (() => void), lstat: undefined as undefined | ((path: string) => void) }));
vi.mock("node:fs/promises", async original => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, mkdir: async (...args: Parameters<typeof real.mkdir>) => { const value = await real.mkdir(...args); const hook = hooks.mkdir; hooks.mkdir = undefined; hook?.(); return value; },
    lstat: async (...args: Parameters<typeof real.lstat>) => { const value = await real.lstat(...args); hooks.lstat?.(String(args[0])); return value; } };
});
const home = mkdtempSync(join(tmpdir(), "agend-assets-2965-"));
const file = "prebuilds/win32-x64/conpty.node";
const verified = Buffer.alloc(256); verified.write("MZ"); verified.writeUInt32LE(64, 0x3c); verified.writeUInt32LE(0x4550, 64); verified.writeUInt16LE(0x8664, 68); verified.write("napi_register_module_v1", 90);
const digest = createHash("sha256").update(verified).digest("hex");
let copy: (out: string, assets: unknown[], source: string) => Promise<void>;
beforeAll(async () => {
  const compiled = join(home, "compiled"); mkdirSync(compiled);
  writeFileSync(join(compiled, "runtime-pane-assets.mjs"), `export const RUNTIME_PANE_ASSETS=[], RUNTIME_PANE_MODULES=[], PANE_NATIVE_SHA256=${JSON.stringify({ [file]: digest })};`);
  // The build script imports this exact filename, as in the real compiled build.
  renameSync(join(compiled, "runtime-pane-assets.mjs"), join(compiled, "runtime-pane-assets.js"));
  writeFileSync(join(compiled, "package.json"), '{"type":"module"}');
  const argv = process.argv; process.argv = [argv[0]!, "build-runtime-assets.mjs", join(home, "initial"), compiled];
  try { copy = (await import(pathToFileURL(resolve("scripts/build-runtime-assets.mjs")).href)).copyRuntimePaneAssets; }
  finally { process.argv = argv; }
});
afterEach(() => { hooks.mkdir = hooks.lstat = undefined; });
afterAll(() => rmSync(home, { recursive: true, force: true }));
function fixture(name: string) {
  const source = join(home, name, "source"), input = join(source, "node-pty", file), out = join(home, name, "output");
  mkdirSync(dirname(input), { recursive: true }); writeFileSync(input, verified); utimesSync(input, 1700000000, 1700000000);
  writeFileSync(join(source, "node-pty", "package.json"), '{"name":"node-pty","version":"1.1.0"}');
  return { source, input, out, assets: [{ name: "node-pty", version: "1.1.0", files: [file] }] };
}
it("copies exactly the verified bytes when the source is replaced after hashing, before output creation", async () => {
  const f = fixture("hash-copy"); hooks.mkdir = () => { renameSync(f.input, f.input + ".old"); writeFileSync(f.input, Buffer.alloc(256, 88)); };
  await copy(f.out, f.assets, f.source);
  expect(createHash("sha256").update(readFileSync(join(f.out, "node-pty", file))).digest("hex")).toBe(digest);
  expect(readFileSync(f.input)).not.toEqual(verified);
});
it("refuses an inode replacement with the same size and restored mtime between identity check and read", async () => {
  const f = fixture("identity"), before = statSync(f.input);
  hooks.lstat = path => { if (path !== f.input) return; hooks.lstat = undefined; renameSync(f.input, f.input + ".old"); writeFileSync(f.input, verified); utimesSync(f.input, before.atime, before.mtime); };
  await expect(copy(f.out, f.assets, f.source)).rejects.toThrow(/changed|identity|unsafe/i);
  expect(statSync(f.input).size).toBe(before.size); expect(statSync(f.input).ino).not.toBe(before.ino);
});
it.skipIf(process.platform === "win32")("refuses a regular source swapped for a real FIFO without waiting for a writer", async () => {
  const f = fixture("fifo");
  hooks.lstat = path => { if (path !== f.input) return; hooks.lstat = undefined; renameSync(f.input, f.input + ".old"); execFileSync("mkfifo", [f.input]); };
  const flight = copy(f.out, f.assets, f.source).then(() => ({ state: "copied", error: "" }), error => ({ state: "refused", error: String(error) }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([flight, new Promise<{ state: string; error: string }>(resolve => { timer = setTimeout(() => resolve({ state: "waiting for writer", error: "" }), 1000); })]);
    expect(statSync(f.input).isFIFO()).toBe(true);
    expect(result.state).toBe("refused"); expect(result.error).toMatch(/changed|identity|unsafe/i);
    expect(existsSync(join(f.out, "node-pty", file))).toBe(false);
  } finally {
    if (timer) clearTimeout(timer);
    // Release a regressed blocking open before asserting cleanup: no orphan writer/reader or unfinished copy.
    const writer = statSync(f.input).isFIFO() ? openSync(f.input, constants.O_RDWR | constants.O_NONBLOCK) : undefined;
    try { await flight; } finally { if (writer !== undefined) closeSync(writer); }
  }
});
it("refuses a same-inode rewrite even when size and mtime are restored", async () => {
  const f = fixture("ctime"), before = statSync(f.input, { bigint: true });
  hooks.lstat = path => { if (path !== f.input) return; hooks.lstat = undefined; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); writeFileSync(f.input, verified); utimesSync(f.input, new Date(Number(before.atimeMs)), new Date(Number(before.mtimeMs))); };
  await expect(copy(f.out, f.assets, f.source)).rejects.toThrow(/changed|identity/i);
  const after = statSync(f.input, { bigint: true }); expect(after.ino).toBe(before.ino); expect(after.size).toBe(before.size); expect(after.mtimeNs).toBe(before.mtimeNs); expect(after.ctimeNs).not.toBe(before.ctimeNs);
});
it("ordinary stable native assets retain their pinned bytes", async () => {
  const f = fixture("control"); await copy(f.out, f.assets, f.source); expect(createHash("sha256").update(readFileSync(join(f.out, "node-pty", file))).digest("hex")).toBe(digest);
});
it("refuses a stable PE with changed native bytes even if its headers still match", async () => {
  const f = fixture("bad-hash"), changed = Buffer.from(verified); changed[200] = 99; writeFileSync(f.input, changed);
  await expect(copy(f.out, f.assets, f.source)).rejects.toThrow(/unverified/i);
});
it("bounds non-native assets before copying them", async () => {
  const f = fixture("oversized"); writeFileSync(join(f.source, "node-pty", "large.js"), Buffer.alloc(2 * 1024 * 1024 + 1));
  await expect(copy(f.out, [{ name: "node-pty", version: "1.1.0", files: ["large.js"] }], f.source)).rejects.toThrow(/unsafe/i);
});
