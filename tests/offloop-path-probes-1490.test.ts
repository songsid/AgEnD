/**
 * M-2333 (#1490): unattended-install.loginShell and tmux-exec-helper.resolveOnPath still walk PATH
 * with accessSync on the fleet loop. #3009 showed a kernel D-state hang from the same class of probe.
 * These pin the replacement: the existing binary-probe child (never a new helper), no accessSync.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hooks = vi.hoisted(() => ({ access: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    accessSync: ((path: Parameters<typeof real.accessSync>[0], mode?: number) => {
      if (mode === real.constants.X_OK) hooks.access.push(String(path));
      return real.accessSync(path, mode);
    }) as typeof real.accessSync,
  };
});

import { loginShell, unattendedInstallCommand } from "../src/unattended-install.js";
import { ExecHelper, resolveOnPath, type HelperExecOptions } from "../src/tmux-exec-helper.js";

const dirs: string[] = [];
afterEach(() => {
  hooks.access.length = 0;
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch() {
  const d = mkdtempSync(join(tmpdir(), "agend-1490-path-"));
  dirs.push(d);
  return d;
}

function helper(bin: string) {
  const direct = vi.fn((file: string, args: string[], _opts: HelperExecOptions) =>
    Promise.resolve({ stdout: `direct:${file} ${args.join(" ")}`, stderr: "" }));
  const h = new ExecHelper({ direct, path: () => `${bin}:${process.env.PATH}` });
  return { h, direct };
}

describe("loginShell does not accessSync", () => {
  it("an absolute executable login shell is returned without accessSync", async () => {
    hooks.access.length = 0;
    expect(await loginShell(() => "/bin/sh")).toBe("/bin/sh");
    expect(hooks.access).toEqual([]);
  });

  it("a relative path, a missing file, and a throwing reader stay undefined without accessSync", async () => {
    const missing = join(scratch(), "no-such-shell");
    hooks.access.length = 0;
    expect(await loginShell(() => "relative/zsh")).toBeUndefined();
    expect(await loginShell(() => missing)).toBeUndefined();
    expect(await loginShell(() => { throw new Error("no passwd entry"); })).toBeUndefined();
    expect(hooks.access).toEqual([]);
  });
});

describe("resolveOnPath / ExecHelper do not accessSync", () => {
  it("initial start + exec (cache fill) does not accessSync", async () => {
    const root = scratch();
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "tmux"), "#!/bin/sh\nprintf ok\n", { mode: 0o755 });
    chmodSync(join(bin, "tmux"), 0o755);
    const { h, direct } = helper(bin);
    hooks.access.length = 0;
    await h.start();
    expect(await h.exec("tmux", ["-L", "agend-test-1490-path", "display-message", "-p", "x"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })).toEqual({ stdout: "ok", stderr: "" });
    expect(direct).not.toHaveBeenCalled();
    expect(hooks.access).toEqual([]);
    await h.stop();
  });

  it("a cache miss when the call's PATH changes does not accessSync", async () => {
    const root = scratch();
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "tmux"), "#!/bin/sh\nprintf ok\n", { mode: 0o755 });
    chmodSync(join(bin, "tmux"), 0o755);
    const other = join(root, "other");
    mkdirSync(other);
    writeFileSync(join(other, "tmux"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(join(other, "tmux"), 0o755);
    const { h, direct } = helper(bin);
    await h.start();
    hooks.access.length = 0;
    await h.exec("tmux", ["-L", "agend-test-1490-path", "z"], { env: { ...process.env, PATH: other } });
    expect(direct).toHaveBeenCalledOnce();
    expect(hooks.access).toEqual([]);
    await h.stop();
  });

  it("resolveOnPath finds the first executable on a custom PATH without accessSync", async () => {
    const root = scratch();
    const bin = join(root, "bin");
    mkdirSync(bin);
    const tmux = join(bin, "tmux");
    writeFileSync(tmux, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(tmux, 0o755);
    hooks.access.length = 0;
    expect(await resolveOnPath("tmux", `${bin}:/no/such/dir`)).toBe(tmux);
    expect(await resolveOnPath("tmux", "/no/such/dir")).toBeNull();
    expect(hooks.access).toEqual([]);
  });
});

describe("unattendedInstallCommand still wraps when the shell is given", () => {
  it("an explicit shell is quoted; null keeps the inherited one", async () => {
    expect(unattendedInstallCommand("x", null)).not.toContain("SHELL=");
    expect(unattendedInstallCommand("x", "/bin/zsh")).toMatch(/^SHELL='\/bin\/zsh' /);
  });
});
