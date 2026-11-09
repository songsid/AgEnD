/**
 * #1490 row 40: a rollback whose second rename (the preimage back into the install path) fails must not leave the
 * install path empty. The tree that call moved aside goes back — only when it moved it, and only while the install path
 * is still empty. Scratch directories only: no npm, no real prefix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One rename can be made to fail (or to have something appear first), every other one runs for real.
const inject = vi.hoisted(() => ({ onRename: null as ((from: string, to: string) => void) | null }));
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real, renameSync: (from: string, to: string) => { inject.onRename?.(from, to); return real.renameSync(from, to); } };
});

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restorePackagePreimage, type PackagePreimage } from "../src/package-preimage.js";

let root: string, nodeModules: string, prefix: string, pkg: string, pre: PackagePreimage;
const tree = (dir: string, version: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@songsid/agend", version }));
};
const versionAt = (dir: string) => (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-1490r40-"));
  prefix = join(root, "prefix"); nodeModules = join(prefix, "lib", "node_modules"); pkg = join(nodeModules, "@songsid", "agend");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  tree(pkg, "2.3.5");                                   // what npm installed
  const dir = join(prefix, ".agend-rollback", "2.3.4-x");
  tree(join(dir, "agend"), "2.3.4");                    // the preimage
  pre = { dir, version: "2.3.4", links: { agend: null, "agend-agent": null } };
});
afterEach(() => { inject.onRename = null; rmSync(root, { recursive: true, force: true }); });

describe("#1490 row 40 (TS compatibility path): the second rollback rename fails", () => {
  it("the preimage is gone: the installed tree goes back, never an empty install path", () => {
    rmSync(join(pre.dir, "agend"), { recursive: true });
    const r = restorePackagePreimage(nodeModules, prefix, pre);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("the installed package was left in place") });
    expect(versionAt(pkg)).toBe("2.3.5");
    expect(existsSync(join(pre.dir, "replaced"))).toBe(false);
  });

  it("something else took the install path in between: it is not replaced, the aside tree stays where it is", () => {
    // An empty directory: the one thing a rename would silently replace.
    inject.onRename = (from, to) => {
      if (from === join(pre.dir, "agend") && to === pkg) { mkdirSync(pkg); throw Object.assign(new Error("EEXIST"), { code: "EEXIST" }); }
    };
    const r = restorePackagePreimage(nodeModules, prefix, pre);
    expect(r).toMatchObject({ ok: false, reason: expect.not.stringContaining("left in place") });
    expect(readdirSync(pkg)).toEqual([]);
    expect(versionAt(join(pre.dir, "replaced"))).toBe("2.3.5");
  });

  it("nothing was installed to move aside: a stray `replaced` tree is never moved into the install path", () => {
    rmSync(pkg, { recursive: true });
    tree(join(pre.dir, "replaced"), "not-ours");
    rmSync(join(pre.dir, "agend"), { recursive: true });
    const r = restorePackagePreimage(nodeModules, prefix, pre);
    expect(r).toMatchObject({ ok: false });
    expect(existsSync(pkg)).toBe(false);
    expect(versionAt(join(pre.dir, "replaced"))).toBe("not-ours");
  });

  it("moving it back fails too: said, with where the installed tree is", () => {
    rmSync(join(pre.dir, "agend"), { recursive: true });
    inject.onRename = (from) => { if (from === join(pre.dir, "replaced")) throw new Error("EIO"); };
    const r = restorePackagePreimage(nodeModules, prefix, pre);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining(`also could not be moved back from ${join(pre.dir, "replaced")}`) });
  });

  it("control: a normal restore still swaps the preimage in", () => {
    expect(restorePackagePreimage(nodeModules, prefix, pre)).toEqual({ ok: true });
    expect(versionAt(pkg)).toBe("2.3.4");
    expect(existsSync(pre.dir)).toBe(false);
  });
});
