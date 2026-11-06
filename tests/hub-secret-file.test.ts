import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, symlinkSync, mkdirSync, renameSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const state = vi.hoisted(() => ({ opened: 0, closed: 0, afterRead: undefined as undefined | (() => void) }));
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real,
    openSync: (...args: Parameters<typeof real.openSync>) => { const fd = real.openSync(...args); state.opened++; return fd; },
    closeSync: (fd: number) => { state.closed++; return real.closeSync(fd); },
    readSync: (fd: number, bytes: Buffer, offset: number, length: number, position: number | null) => {
      const n = real.readSync(fd, bytes, offset, length, position), hook = state.afterRead; state.afterRead = undefined; hook?.(); return n;
    },
  };
});
import { readHubSecretFile } from "../src/hub/init/secret-file.js";
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "agend-secret-import-"))); state.opened = state.closed = 0; state.afterRead = undefined; });
afterEach(() => { state.afterRead = undefined; vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); expect(state.opened).toBe(state.closed); });
function file(content: string | Buffer = "Dummy-private-file-only", mode = 0o600) {
  const path = join(root, "secret"); writeFileSync(path, content, { mode }); chmodSync(path, mode); return path;
}
describe("local owner private-file secret snapshot", () => {
  it.each([0o400, 0o600])("preserves all UTF-8 bytes including spaces, BOM and CRLF for mode %s, and leaves the source intact", mode => {
    const exact = Buffer.from("\uFEFF  Dummy-秘密-ä\r\n", "utf8"), path = file(exact, mode);
    expect(Buffer.from(readHubSecretFile(path), "utf8")).toEqual(exact); expect(readFileSync(path)).toEqual(exact);
    expect(state.opened).toBe(1); expect(state.closed).toBe(1);
  });
  it("refuses empty/oversized/NUL/invalid UTF-8 material and accepts the exact upper bound", () => {
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(1025, 65), Buffer.from("x\0y"), Buffer.from([0xc3, 0x28])]) {
      const path = file(bytes); expect(() => readHubSecretFile(path)).toThrow("hub_secret_file_invalid"); expect(readFileSync(path)).toEqual(bytes);
    }
    expect(readHubSecretFile(file("x".repeat(1024)))).toBe("x".repeat(1024));
  });
  it("refuses group/other permissions, executable/special modes, directories and another owner", () => {
    for (const mode of [0o644, 0o640, 0o604, 0o700, 0o4600]) expect(() => readHubSecretFile(file("dummy", mode))).toThrow("hub_secret_file_invalid");
    expect(() => readHubSecretFile(root)).toThrow("hub_secret_file_invalid");
    const path = file(); vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    expect(() => readHubSecretFile(path)).toThrow("hub_secret_file_invalid"); expect(state.opened).toBe(0);
  });
  it("refuses final and ancestor symlinks, relative or noncanonical paths before opening", () => {
    const path = file(), link = join(root, "link"); symlinkSync(path, link);
    const directory = join(root, "real"); mkdirSync(directory); const child = join(directory, "inside"); writeFileSync(child, "dummy", { mode: 0o600 });
    const alias = join(root, "alias"); symlinkSync(directory, alias);
    for (const input of [link, join(alias, "inside"), "secret", root + "/real/../secret"]) expect(() => readHubSecretFile(input)).toThrow("hub_secret_file_invalid");
    expect(state.opened).toBe(0);
  });
  it("rejects replacement, growth, permission changes and ancestor retargeting during the actual read; closes every descriptor", () => {
    const path = file(), original = readFileSync(path);
    state.afterRead = () => { renameSync(path, join(root, "before")); writeFileSync(path, original, { mode: 0o600 }); };
    expect(() => readHubSecretFile(path)).toThrow("hub_secret_file_invalid");
    state.afterRead = () => writeFileSync(path, "grown by an owner edit", { mode: 0o600 });
    expect(() => readHubSecretFile(path)).toThrow("hub_secret_file_invalid");
    state.afterRead = () => chmodSync(path, 0o644);
    expect(() => readHubSecretFile(path)).toThrow("hub_secret_file_invalid");
    const parent = join(root, "parent"); mkdirSync(parent); writeFileSync(join(parent, "secret"), original, { mode: 0o600 });
    state.afterRead = () => { renameSync(parent, join(root, "old-parent")); symlinkSync(join(root, "old-parent"), parent); };
    expect(() => readHubSecretFile(join(parent, "secret"))).toThrow("hub_secret_file_invalid");
  });
});
