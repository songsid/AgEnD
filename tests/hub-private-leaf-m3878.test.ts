import Database from "better-sqlite3";
import { HubTransportStore, migrateHubTransportStore } from "../src/hub/store.js";
import { HubFileVersionFloor } from "../src/hub/version-floor.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Stats, BigIntStats } from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privatePath, readPrivateFile } from "../src/hub/private-files.js";
import { readHubIdentityIfPresent } from "../src/hub/tls.js";
const hooks = vi.hoisted(() => ({
  stats: [] as string[], reads: [] as string[], realpaths: [] as string[], blockRead: false,
  beforeRealpath: undefined as undefined | ((path: string) => void),
  afterRealpath: undefined as undefined | ((path: string) => void),
  stat: undefined as undefined | ((path: string, value: Stats | BigIntStats) => Stats | BigIntStats),
}));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    lstatSync(...args: Parameters<typeof fs.lstatSync>) {
      hooks.stats.push(String(args[0])); const s = fs.lstatSync(...args);
      return s === undefined ? s : hooks.stat?.(String(args[0]), s) ?? s;
    },
    realpathSync(...args: Parameters<typeof fs.realpathSync>) {
      hooks.realpaths.push(String(args[0])); hooks.beforeRealpath?.(String(args[0]));
      const result = fs.realpathSync(...args); hooks.afterRealpath?.(String(args[0])); return result;
    },
    readFileSync(...args: Parameters<typeof fs.readFileSync>) {
      hooks.reads.push(String(args[0])); if (hooks.blockRead) throw Error("M3878 read guard reached");
      return fs.readFileSync(...args);
    },
  };
});
const roots: string[] = [];
function reset() { hooks.stats = []; hooks.reads = []; hooks.realpaths = []; hooks.blockRead = false; hooks.beforeRealpath = undefined; hooks.afterRealpath = undefined; hooks.stat = undefined; }
afterEach(() => { reset(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "hub-leaf-")); roots.push(home); chmodSync(home, 0o700);
  const hub = join(home, "hub"), dir = join(hub, "floors"); mkdirSync(hub, { mode: 0o700 }); mkdirSync(dir, { mode: 0o700 });
  const leaf = join(dir, "state"), other = join(home, "other");
  writeFileSync(leaf, "0", { mode: 0o600 }); writeFileSync(other, "inert", { mode: 0o600 }); reset();
  return { home, hub, dir, leaf, other, read: (max?: number) => readPrivateFile(home, "hub/floors/state", max) };
}
describe.skipIf(process.platform === "win32")("M3878 fresh private leaf metadata", () => {
  it("reads each ancestor and one final leaf stat on every file read", () => {
    const r = fixture(); expect(r.read()).toBe("0"); expect(hooks.reads).toEqual([r.leaf]);
    expect(hooks.stats.filter(p => p === r.leaf)).toHaveLength(1);
    for (const p of [r.home, r.hub, r.dir]) expect(hooks.stats.filter(x => x === p)).toHaveLength(1);
    reset(); writeFileSync(r.leaf, "1"); expect(r.read()).toBe("1");
    expect(hooks.stats.filter(p => p === r.leaf)).toHaveLength(1);
  });
  it.each(["mode", "uid", "directory", "symlink"] as const)("refuses a late %s change after realpath before any read", mode => {
    const r = fixture(); hooks.blockRead = true; let late = false;
    hooks.afterRealpath = path => {
      if (path !== r.leaf) return; hooks.afterRealpath = undefined; late = true;
      if (mode === "mode") chmodSync(r.leaf, 0o644);
      if (mode === "directory") { rmSync(r.leaf); mkdirSync(r.leaf, { mode: 0o700 }); }
      if (mode === "symlink") { rmSync(r.leaf); symlinkSync(r.other, r.leaf); }
    };
    if (mode === "uid") hooks.stat = (path, s) => path === r.leaf && late
      ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { uid: typeof s.uid === "bigint" ? s.uid + 1n : s.uid + 1 }) : s;
    expect(r.read).toThrow("permissions"); expect(late).toBe(true); expect(hooks.reads).toEqual([]);
  });
  it("retains the late size check after realpath", () => {
    const r = fixture(); hooks.blockRead = true;
    hooks.afterRealpath = path => { if (path === r.leaf) { hooks.afterRealpath = undefined; writeFileSync(r.leaf, "oversized"); } };
    expect(() => r.read(4)).toThrow("too large"); expect(hooks.reads).toEqual([]);
  });
  it("rejects a leaf swapped to a symlink between ancestors and realpath", () => {
    const r = fixture(); hooks.blockRead = true;
    hooks.beforeRealpath = path => { if (path === r.leaf) { hooks.beforeRealpath = undefined; rmSync(r.leaf); symlinkSync(r.other, r.leaf); } };
    expect(r.read).toThrow(); expect(hooks.reads).toEqual([]);
  });
  it("refuses a changed canonical path when an ancestor is replaced after its stat", () => {
    const r = fixture(); hooks.blockRead = true;
    hooks.beforeRealpath = path => {
      if (path !== r.leaf) return; hooks.beforeRealpath = undefined;
      const target = join(r.home, "replacement"); mkdirSync(target, { mode: 0o700 });
      writeFileSync(join(target, "state"), "inert", { mode: 0o600 });
      renameSync(r.dir, join(r.hub, "retired")); symlinkSync(target, r.dir);
    };
    expect(r.read).toThrow("path changed"); expect(hooks.reads).toEqual([]);
  });
  it.each(["mode", "uid", "symlink"] as const)("keeps the %s ancestor guard before resolving or reading", mode => {
    const r = fixture(); hooks.blockRead = true;
    if (mode === "mode") chmodSync(r.hub, 0o755);
    if (mode === "uid") hooks.stat = (path, s) => path === r.hub
      ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { uid: typeof s.uid === "bigint" ? s.uid + 1n : s.uid + 1 }) : s;
    if (mode === "symlink") { rmSync(r.dir, { recursive: true }); const target = join(r.home, "target"); mkdirSync(target, { mode: 0o700 }); symlinkSync(target, r.dir); }
    expect(r.read).toThrow("permissions"); expect(hooks.realpaths).toEqual([]); expect(hooks.reads).toEqual([]);
  });
  it("never reads a real FIFO leaf", () => {
    const r = fixture(); rmSync(r.leaf); execFileSync("mkfifo", [r.leaf]); chmodSync(r.leaf, 0o600); hooks.blockRead = true;
    expect(r.read).toThrow("permissions"); expect(hooks.reads).toEqual([]);
  });
  it("never reads a device leaf (synthetic metadata, no device creation)", () => {
    const r = fixture(); hooks.blockRead = true;
    hooks.stat = (path, s) => path === r.leaf ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { mode: 0o020600 }) : s;
    expect(r.read).toThrow("permissions"); expect(hooks.reads).toEqual([]);
  });
  it("keeps directory-only public calls, root-as-leaf and native missing errors", () => {
    const r = fixture(); expect(privatePath(r.home, "", true)).toBe(r.home); expect(privatePath(r.home, ".", true)).toBe(r.home);
    expect(privatePath(r.home, "hub/floors", true)).toBe(r.dir);
    expect(() => privatePath(r.home, "hub/floors")).toThrow("permissions");
    expect(() => privatePath(r.home, "hub/floors/state", true)).toThrow("permissions");
    try { privatePath(r.home, "hub/missing"); throw Error("missing path accepted"); }
    catch (e) { expect((e as NodeJS.ErrnoException).code).toBe("ENOENT"); }
  });
  it("does not reinterpret a dangling identity-directory symlink as an unprovisioned Hub", () => {
    const r = fixture(); symlinkSync(join(r.home, "not-created"), join(r.hub, "keys"));
    expect(() => readHubIdentityIfPresent(r.home)).toThrow();
  });
  it("preserves genuine absent-identity detection", () => {
    const r = fixture(); expect(readHubIdentityIfPresent(r.home)).toBeUndefined();
  });
  it.each(["revision", "permissions"] as const)("keeps the post-4601 scalar reader fresh after a file-floor %s change", mode => {
    const r = fixture(); rmSync(r.leaf);
    const floor = new HubFileVersionFloor(r.home, "hub/floors/state"); floor.initialize();
    const db = new Database(":memory:");
    try {
      migrateHubTransportStore(db);
      const store = new HubTransportStore(db, { floor, appendAudit() {} }); store.initialize();
      expect(store.readVersion()).toEqual({ revision: 0, revocationVersion: 0 });
      if (mode === "revision") writeFileSync(r.leaf, "1"); else chmodSync(r.leaf, 0o644);
      expect(() => store.readVersion()).toThrow("uncertain");
      writeFileSync(r.leaf, "0"); chmodSync(r.leaf, 0o600);
      expect(() => store.readVersion()).toThrow("uncertain");
    } finally { db.close(); }
  });
  it("retains fatal UTF-8 and BOM behavior", () => {
    const r = fixture(); writeFileSync(r.leaf, Buffer.from([0xff])); expect(r.read).toThrow();
    writeFileSync(r.leaf, Buffer.from([0xef, 0xbb, 0xbf, 0x6f, 0x6b]));
    expect(r.read()).toBe("ok"); expect(readPrivateFile(r.home, "hub/floors/state", undefined, { preserveBom: true })).toBe(String.fromCodePoint(0xfeff) + "ok");
  });
});
