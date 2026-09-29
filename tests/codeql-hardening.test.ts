import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ensureWorkspaceGit } from "../src/paths.js";
import { FleetManager } from "../src/fleet-manager.js";

const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), "agend-codeql-")); tempDirs.push(d); return d; };

describe("ensureWorkspaceGit runs no shell", () => {
  it("initialises a repository in an ordinary directory", () => {
    const dir = temp();
    ensureWorkspaceGit(dir);
    expect(existsSync(join(dir, ".git"))).toBe(true);
  });

  it("treats quotes, $(…) and backticks in the path as part of the name, not as commands", () => {
    const root = temp();
    const marker = join(root, "PWNED");
    for (const name of [`a"; touch ${marker}; "`, `$(touch ${marker})`, "`touch " + marker + "`", `x' && touch ${marker} && '`]) {
      const dir = join(root, name.replace(/\//g, "_"));
      execFileSync("mkdir", ["-p", dir]);
      ensureWorkspaceGit(dir);
      expect(existsSync(join(dir, ".git")), name).toBe(true);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("does not read a directory named like an option as an option", () => {
    const cwd = process.cwd();
    const root = temp();
    process.chdir(root);
    try {
      execFileSync("mkdir", ["-p", "--", "--bare"]);
      ensureWorkspaceGit("--bare");
      expect(existsSync(join(root, "--bare", ".git"))).toBe(true);
      expect(statSync(join(root, "--bare")).isDirectory()).toBe(true);
    } finally { process.chdir(cwd); }
  });
});

describe("setting an instance's display name or description cannot reach Object.prototype", () => {
  function fleet() {
    const fm = new FleetManager(temp());
    (fm as unknown as { fleetConfig: unknown }).fleetConfig = { instances: { alpha: { working_directory: "/tmp" } }, defaults: {} };
    (fm as unknown as { saveFleetConfig(): void }).saveFleetConfig = () => {};
    return fm as unknown as {
      setInstanceDisplayName(n: string, v: string): boolean;
      setInstanceDescription(n: string, v: string): boolean;
      fleetConfig: { instances: Record<string, { display_name?: string; description?: string }> };
    };
  }

  it("still sets them on a real instance", () => {
    const fm = fleet();
    expect(fm.setInstanceDisplayName("alpha", "Alpha")).toBe(true);
    expect(fm.setInstanceDescription("alpha", "does things")).toBe(true);
    expect(fm.fleetConfig.instances.alpha).toMatchObject({ display_name: "Alpha", description: "does things" });
  });

  it("refuses __proto__, constructor and prototype as instance names and changes nothing global", () => {
    const fm = fleet();
    for (const name of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]) {
      expect(fm.setInstanceDisplayName(name, "pwned"), name).toBe(false);
      expect(fm.setInstanceDescription(name, "pwned"), name).toBe(false);
    }
    expect(({} as { display_name?: string }).display_name).toBeUndefined();
    expect(({} as { description?: string }).description).toBeUndefined();
    expect((Object.prototype as { display_name?: string }).display_name).toBeUndefined();
    expect(Object.keys(fm.fleetConfig.instances)).toEqual(["alpha"]);
  });
});
