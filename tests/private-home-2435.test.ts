import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAgendHome } from "../src/agend-home.js";
import { assertOperatorRoot } from "../src/operator-control-paths.js";
const require = createRequire(import.meta.url);
const { ensurePrivateHome } = require("../launcher/private-home.cjs") as { ensurePrivateHome(dir: string, options?: any): void };
const installer = require("../launcher/agend-install.cjs") as { main(args: string[], deps: Record<string, unknown>): number };
const dirs: string[] = [];
function scratch() { const dir = fs.mkdtempSync(join(tmpdir(), "agend-home-2435-")); dirs.push(dir); return dir; }
const mode = (dir: string) => fs.statSync(dir).mode & 0o777;
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("private AGEND_HOME (#2435)", () => {
  it("creates a missing home and its missing parents 0700 under umask 0002", () => {
    const dir = join(scratch(), "nested", "agend"), mask = process.umask(0o002);
    try { ensureAgendHome(dir); } finally { process.umask(mask); }
    expect([mode(dir), mode(dirname(dir))]).toEqual([0o700, 0o700]);
  });
  it("repairs an owned 0775 home once, preserving its contents, and operator admission succeeds", async () => {
    const dir = scratch(), log = vi.fn(); fs.chmodSync(dir, 0o775);
    fs.writeFileSync(join(dir, "keep"), "unchanged", { mode: 0o640 });
    fs.chmodSync(join(dir, "keep"), 0o640);
    ensureAgendHome(dir, { log }); await assertOperatorRoot(dir, "Test control"); ensureAgendHome(dir, { log });
    expect(mode(dir)).toBe(0o700); expect(log).toHaveBeenCalledExactlyOnceWith("AgEnD: tightened owned AGEND_HOME permissions to 0700.");
    expect(fs.readFileSync(join(dir, "keep"), "utf8")).toBe("unchanged"); expect(mode(join(dir, "keep"))).toBe(0o640);
  });
  it("operator admission itself repairs an existing writable root, but keeps an existing 0755 root unchanged", async () => {
    const dir = scratch(); fs.chmodSync(dir, 0o777); const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    await assertOperatorRoot(dir, "Test control"); expect(mode(dir)).toBe(0o700); expect(log).toHaveBeenCalledOnce();
    fs.chmodSync(dir, 0o755); await assertOperatorRoot(dir, "Test control"); expect(mode(dir)).toBe(0o755);
  });
  it("refuses foreign ownership without any chmod (including the descriptor recheck)", () => {
    const dir = scratch(); fs.chmodSync(dir, 0o775); const change = vi.fn();
    expect(() => ensurePrivateHome(dir, { uid: process.getuid!() + 1, fs: { ...fs, fchmodSync: change } })).toThrow("owned real AGEND_HOME");
    expect(() => ensurePrivateHome(dir, { fs: { ...fs, fstatSync: (fd: number) => ({ ...fs.fstatSync(fd), isDirectory: () => true, uid: process.getuid!() + 1 }), fchmodSync: change } })).toThrow("owned real AGEND_HOME");
    expect(change).not.toHaveBeenCalled(); expect(mode(dir)).toBe(0o775);
  });
  it.each(["leaf", "ancestor"])("refuses a %s symlink without changing its target", async kind => {
    const root = scratch(), target = join(root, "target"), alias = join(root, "alias"); fs.mkdirSync(target, { mode: 0o775 }); fs.chmodSync(target, 0o775);
    fs.symlinkSync(target, alias);
    const path = kind === "leaf" ? alias : join(alias, "home");
    if (kind === "ancestor") { fs.mkdirSync(join(target, "home"), { mode: 0o775 }); fs.chmodSync(join(target, "home"), 0o775); }
    expect(() => ensureAgendHome(path)).toThrow("owned real AGEND_HOME");
    await expect(assertOperatorRoot(path, "Test control")).rejects.toThrow("owned real AGEND_HOME");
    expect(mode(target)).toBe(0o775); if (kind === "ancestor") expect(mode(join(target, "home"))).toBe(0o775);
    expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
  });
  it("a path replaced after open is refused without changing either directory", () => {
    const root = scratch(), dir = join(root, "home"), kept = join(root, "kept"), target = join(root, "target");
    fs.mkdirSync(dir); fs.mkdirSync(target); fs.chmodSync(dir, 0o775); fs.chmodSync(target, 0o775);
    expect(() => ensurePrivateHome(dir, { afterOpen: () => { fs.renameSync(dir, kept); fs.symlinkSync(target, dir); } })).toThrow("owned real AGEND_HOME");
    expect([mode(kept), mode(target)]).toEqual([0o775, 0o775]);
  });
  it("the target installer prepares a fresh home before running any npm operation", () => {
    const dir = join(scratch(), "new-home"), mask = process.umask(0o002), observed: number[] = [];
    try {
      expect(installer.main([], { env: { AGEND_HOME: dir }, log: () => {}, run: () => { observed.push(mode(dir)); return { status: 1, stdout: "", stderr: "" }; } })).toBe(1);
    } finally { process.umask(mask); }
    expect(observed.length).toBeGreaterThan(0); expect(observed.every(v => v === 0o700)).toBe(true);
  });
});

const repo = join(import.meta.dirname, "..");
const sh = fs.readFileSync(join(repo, "install.sh"), "utf8");
const ps = fs.readFileSync(join(repo, "website/public/install-agend.ps1"), "utf8");
const helper = fs.readFileSync(join(repo, "launcher/private-home.cjs"), "utf8");
const shellBootstrap = sh.match(/# >>> private-home bootstrap\n([\s\S]*?)# <<< private-home bootstrap/)?.[1] ?? "";
const psEnv = ps.match(/^\$AGEND_ENV = '((?:[^']|'')*)'$/m)?.[1].replace(/''/g, "'") ?? "";
const psBootstrap = psEnv.slice(psEnv.indexOf("umask 077;"));
function runBootstrap(script: string, dir: string) {
  return spawnSync("bash", ["-c", `set -euo pipefail\nerror() { echo "$*" >&2; exit 1; }\numask 0002\n${script}`], {
    encoding: "utf8", env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dirname(dir), AGEND_HOME: dir }, timeout: 10_000,
  });
}
describe("live one-liner bootstrap, independent of the installed npm release", () => {
  it("shell bootstrap is the same helper, and website/root scripts remain identical", () => {
    expect(shellBootstrap).toContain(helper); expect(fs.readFileSync(join(repo, "website/public/install.sh"), "utf8")).toBe(sh);
    const compactHelper = helper.replace(/\/\/[^\n]*/g, "").split("\n").join(" ").replace(/"/g, "`");
    expect(psBootstrap).toContain(compactHelper);
    expect(psBootstrap).not.toContain('"'); expect(psBootstrap).not.toBe("");
  });
  it.each(["shell", "WSL"])("%s creates and repairs homes under 0002 before old 2.2.6/beta.25 setup runs", kind => {
    const dir = join(scratch(), "home with [spaces]"), script = kind === "shell" ? shellBootstrap : psBootstrap;
    const fresh = runBootstrap(script, dir); expect(fresh.status, fresh.stderr).toBe(0); expect(mode(dir)).toBe(0o700);
    fs.chmodSync(dir, 0o775); const repaired = runBootstrap(script, dir); expect(repaired.status, repaired.stderr).toBe(0); expect(mode(dir)).toBe(0o700);
    expect(repaired.stderr).toContain("tightened owned AGEND_HOME");
  });
  it.each(["shell", "WSL"])("%s rejects a symlink without repairing its target", kind => {
    const root = scratch(), target = join(root, "target"), link = join(root, "link"); fs.mkdirSync(target); fs.chmodSync(target, 0o775); fs.symlinkSync(target, link);
    const result = runBootstrap(kind === "shell" ? shellBootstrap : psBootstrap, link);
    expect(result.status).not.toBe(0); expect(mode(target)).toBe(0o775);
  });
});
