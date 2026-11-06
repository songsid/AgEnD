import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeMain } from "../src/runtime-cli.js";
import { credentialProfilesRoot, ensureCredentialProfile } from "../src/runtime-credential-profiles.js";
import { isCreatedProfile } from "../src/runtime-profile-ownership.js";
import { AUDIT_FILE, readRemoteSwitches } from "../src/runtime-remote-setup.js";

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); } });
const scratch = (): string => { const path = mkdtempSync(join(tmpdir(), "agend-cli-remote-setup-")); directories.push(path); return path; };
function setup() {
  const home = scratch(), program = scratch(), runtimeHome = join(home, ".agend-runtime"), out: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
  const run = (argv: string[], extra: Record<string, unknown> = {}) => runtimeMain(argv, { home, programDirectory: program, env: {}, ...extra } as never);
  return { home, runtimeHome, root: credentialProfilesRoot(runtimeHome), run, text: () => out.join("") };
}

describe("agend-runtime remote-setup", () => {
  it("shows both switches off by default", async () => {
    const f = setup(); await f.run(["remote-setup", "status"]);
    expect(f.text()).toBe("accounts: off\ninstall: off\n");
  });
  it("turns a switch on and off on this computer, each independent, and says what it allows", async () => {
    const f = setup();
    await f.run(["remote-setup", "accounts", "on"]);
    expect(readRemoteSwitches(f.runtimeHome)).toEqual({ accounts: { on: true }, install: { on: false } });
    expect(f.text()).toMatch(/accounts: on\n.*add, sign in, sign out and remove Claude accounts that this Runtime creates.*anyone who can sign in to this Windows user can use it.*own Claude sign-in is not touched/s);
    await f.run(["remote-setup", "install", "on"]); await f.run(["remote-setup", "accounts", "off"]);
    expect(readRemoteSwitches(f.runtimeHome)).toEqual({ accounts: { on: false }, install: { on: true } });
  });
  it("--for turns it off by itself, and status says when", async () => {
    const f = setup(); await f.run(["remote-setup", "accounts", "on", "--for", "2h"]);
    const state = readRemoteSwitches(f.runtimeHome).accounts; expect(state.on).toBe(true); expect(state.until! - Date.now()).toBeGreaterThan(2 * 3_600_000 - 5000); expect(state.until! - Date.now()).toBeLessThanOrEqual(2 * 3_600_000);
    expect(f.text()).toMatch(/turns off by itself at/);
    await f.run(["remote-setup", "status"]); expect(f.text()).toMatch(/accounts: on \(turns off in 120 min\)\ninstall: off/);
  });
  it("records each change as `local` in the audit log, and refuses a malformed command without changing anything", async () => {
    const f = setup(); await f.run(["remote-setup", "accounts", "on"]); await f.run(["remote-setup", "accounts", "off"]);
    const rows = readFileSync(join(f.runtimeHome, AUDIT_FILE), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => `${row.actor}:${row.action}:${row.detail}`)).toEqual(["local:switch:on", "local:switch:off"]);
    for (const argv of [["remote-setup"], ["remote-setup", "accounts"], ["remote-setup", "accounts", "maybe"], ["remote-setup", "network", "on"], ["remote-setup", "accounts", "off", "--for", "2h"], ["remote-setup", "accounts", "on", "--for", "0"],
      ["remote-setup", "accounts", "on", "--for", "200h"], ["remote-setup", "status", "--for", "2h"], ["remote-setup", "accounts", "on", "extra"], ["remote-setup", "accounts", "on", "--server", "https://x.example.com"]]) {
      await expect(f.run(argv), argv.join(" ")).rejects.toThrow();
    }
    expect(readRemoteSwitches(f.runtimeHome).accounts.on).toBe(false);
  });
  it("is only for the local command line: `--for` and the switches are not accepted by any other command", async () => {
    const f = setup();
    await expect(f.run(["status", "--for", "2h"])).rejects.toThrow(/Invalid runtime arguments/);
    await expect(f.run(["profile", "list", "--for", "2h"])).rejects.toThrow(/Invalid runtime arguments/);
  });
  it("is in the help, with what the switches allow", async () => {
    const f = setup(); await f.run(["--help"]);
    expect(f.text()).toMatch(/remote-setup status/); expect(f.text()).toMatch(/remote-setup \(accounts \| install\) \(on \| off\) \[--for 2h\]/); expect(f.text()).toMatch(/AgEnD cannot change them/);
  });
});

describe("login records the profiles this Runtime creates", () => {
  const login = (f: ReturnType<typeof setup>) => f.run(["login", "claude-code", "work"], { runLogin: async () => 0, probeLogin: async () => true });
  it("records a new profile (so a fleet admin may later sign it out or remove it), and not one that was already there", async () => {
    const f = setup(); await login(f);
    expect(isCreatedProfile(f.root, "claude-code", "work")).toBe(true);
    ensureCredentialProfile(f.root, "claude-code", "byhand");
    await f.run(["login", "claude-code", "byhand"], { runLogin: async () => 0, probeLogin: async () => true });
    expect(isCreatedProfile(f.root, "claude-code", "byhand")).toBe(false);
    expect(existsSync(join(f.root, "claude-code", "byhand"))).toBe(true);
  });
});
