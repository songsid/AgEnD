import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCli, nativeCliEnvironment } from "../src/windows-cli-worker.js";
import { INSTALLABLE_CLIS, MANAGED_CLI_ROOT_ENV } from "../src/runtime-cli-install.js";
import { readRuntimeInfo } from "../src/runtime-build-info.js";
import { runtimeMain } from "../src/runtime-cli.js";
import { RuntimeClient, type RuntimeBridge } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { credentialProfilesRoot } from "../src/runtime-credential-profiles.js";
import type { WindowsCliProbe, WindowsCliTask } from "../src/windows-cli.js";

// Finding a CLI Windows' `where.exe` would report is not what this file is about, and a test must not start a Windows program: the program lookup finds nothing.
vi.mock("../src/child-process.js", async original => ({
  ...(await original<typeof import("../src/child-process.js")>()),
  execFile: (_file: string, _args: unknown, _options: unknown, callback: (error: Error) => void) => callback(Object.assign(new Error("not here"), { code: "ENOENT" })),
}));

// A Windows drive path on this test's file system: `C:/...` is a relative path under the current directory, and the code under test accepts it as a drive path.
const scratch: string[] = [];
let cwd: string, work: string;
beforeEach(() => {
  cwd = process.cwd(); work = mkdtempSync(join(tmpdir(), "agend-managed-find-")); scratch.push(work); process.chdir(work);
  vi.stubEnv("HOME", "C:/home"); vi.stubEnv("USERPROFILE", "C:/home"); delete process.env[MANAGED_CLI_ROOT_ENV];
});
afterEach(() => {
  process.chdir(cwd); vi.unstubAllEnvs();
  for (const path of scratch.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); }
});
// #3234 skips a claude.exe under 1 MiB (the ~500 byte placeholder `npm i --ignore-scripts` leaves), so a stand-in for a real copy found elsewhere must be at least that big.
const REAL_SIZE = 1024 * 1024;
const touch = (path: string, size = 2): void => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, Buffer.alloc(size, "M")); };
const MANAGED = "C:/managed/cli";
const managedProgram = (version = INSTALLABLE_CLIS["claude-code"].version): string => join(MANAGED, "claude-code", version, INSTALLABLE_CLIS["claude-code"].native.path);
const pointTo = (version: string): void => { mkdirSync(join(MANAGED, "claude-code"), { recursive: true }); writeFileSync(join(MANAGED, "claude-code", "current.json"), JSON.stringify({ version })); };
const OUTSIDE = "C:/home/.local/bin/claude.exe";

describe("findCli: the CLI this Runtime installed comes first", () => {
  it("uses the managed version, not the one found elsewhere, when AGEND_MANAGED_CLI_ROOT names a folder that holds it", async () => {
    touch(managedProgram()); pointTo(INSTALLABLE_CLIS["claude-code"].version); touch(OUTSIDE, REAL_SIZE);
    vi.stubEnv(MANAGED_CLI_ROOT_ENV, MANAGED);
    const found = await findCli("claude-code");
    expect(found).toEqual({ path: managedProgram(), command: managedProgram(), args: [] });
    expect(found!.path.replace(/\\/g, "/")).toMatch(/node_modules\/@anthropic-ai\/claude-code-win32-x64\/claude\.exe$/);   // the real nested binary, never the bin\claude.exe placeholder
  });
  it("falls back to the one found on the computer when the pointer's version is not the pin", async () => {
    touch(managedProgram()); pointTo("2.1.0"); touch(OUTSIDE, REAL_SIZE);
    vi.stubEnv(MANAGED_CLI_ROOT_ENV, MANAGED);
    expect(await findCli("claude-code")).toEqual({ path: OUTSIDE, command: OUTSIDE, args: [] });
  });
  it("falls back when there is no pointer, when the pointed-at program is missing, and when the variable is not a drive path or is not set", async () => {
    touch(OUTSIDE, REAL_SIZE);
    vi.stubEnv(MANAGED_CLI_ROOT_ENV, MANAGED);
    expect((await findCli("claude-code"))?.path).toBe(OUTSIDE);                       // no pointer
    pointTo(INSTALLABLE_CLIS["claude-code"].version);
    expect((await findCli("claude-code"))?.path).toBe(OUTSIDE);                       // a pointer, no program
    touch(managedProgram());
    vi.stubEnv(MANAGED_CLI_ROOT_ENV, "/home/someone/cli");                            // a WSL-style path is not a Windows folder
    expect((await findCli("claude-code"))?.path).toBe(OUTSIDE);
    delete process.env[MANAGED_CLI_ROOT_ENV];
    expect((await findCli("claude-code"))?.path).toBe(OUTSIDE);
    expect(existsSync(managedProgram())).toBe(true);                                  // the managed one was there all along
  });
  it("finds nothing at all when neither a managed nor another copy is there", async () => {
    vi.stubEnv(MANAGED_CLI_ROOT_ENV, MANAGED);
    expect(await findCli("claude-code")).toBeNull();
  });
});

describe("AGEND_MANAGED_CLI_ROOT reaches the helper processes", () => {
  it("nativeCliEnvironment (what every child the Runtime starts gets) carries it when it is a drive path, and drops anything else", () => {
    const env = nativeCliEnvironment({ [MANAGED_CLI_ROOT_ENV]: "C:\\Users\\a\\pairing\\cli", PATH: "p", ANTHROPIC_API_KEY: "sk-secret", AGEND_TOKEN: "t" });
    expect(env[MANAGED_CLI_ROOT_ENV]).toBe("C:\\Users\\a\\pairing\\cli");
    expect(Object.keys(env).join(",")).not.toMatch(/KEY|TOKEN/);
    expect(nativeCliEnvironment({ [MANAGED_CLI_ROOT_ENV]: "/home/a/cli" })[MANAGED_CLI_ROOT_ENV]).toBeUndefined();
    expect(nativeCliEnvironment({ [MANAGED_CLI_ROOT_ENV]: "..\\cli" })[MANAGED_CLI_ROOT_ENV]).toBeUndefined();
  });
});

const bridge: RuntimeBridge = { probe: async (): Promise<WindowsCliProbe> => ({ home: "C:\\fixture", clis: [], probedAt: 1 }), prepareWorkspace: async () => "C:\\w", start: () => { throw Error("unused"); },
  get: (): WindowsCliTask | null => null, cancel: () => { throw Error("unused"); }, close: () => {}, releaseUnknown: () => {} };
function asPlatform(platform: string, arch: string): () => void {
  const was = { platform: Object.getOwnPropertyDescriptor(process, "platform")!, arch: Object.getOwnPropertyDescriptor(process, "arch")! };
  Object.defineProperty(process, "platform", { value: platform, configurable: true }); Object.defineProperty(process, "arch", { value: arch, configurable: true });
  return () => { Object.defineProperty(process, "platform", was.platform); Object.defineProperty(process, "arch", was.arch); };
}
const clientHere = (): RuntimeClient => {
  const store = new RuntimeClientStore(join(work, "state"));
  return new RuntimeClient({ store, bridge, credentialProfilesRoot: credentialProfilesRoot(store.directory) });
};
const capabilitiesOf = (client: RuntimeClient): string[] => (client as unknown as { runtimeInfo: { capabilities: string[] } }).runtimeInfo.capabilities;
const installerOf = (client: RuntimeClient): unknown => (client as unknown as { managed: unknown }).managed;

describe("N4: cli-install is reported, and an installer built, only on win32 x64 (the version information and the real connection)", () => {
  it.each([["win32", "x64", true], ["win32", "arm64", false], ["linux", "x64", false], ["darwin", "arm64", false]] as const)("%s/%s: the version information %s", (platform, arch, claims) => {
    const restore = asPlatform(platform, arch);
    try { expect(readRuntimeInfo({ panes: false }).capabilities.includes("cli-install")).toBe(claims); } finally { restore(); }
  });
  it.each([["win32", "x64", true], ["win32", "arm64", false], ["linux", "x64", false]] as const)("%s/%s: a Runtime client that is built here reports cli-install and holds an installer: %s", (platform, arch, installs) => {
    const restore = asPlatform(platform, arch);
    try {
      const client = clientHere();
      expect(capabilitiesOf(client).includes("cli-install")).toBe(installs);
      expect(installerOf(client) !== null).toBe(installs);
      if (platform === "win32") expect(capabilitiesOf(client)).toContain("remote-signin");        // arm64 still signs in; it only cannot install
    } finally { restore(); }
  });
  it.each([["x64", true], ["arm64", false]] as const)("`agend-runtime --version` on win32/%s says cli-install: %s", async (arch, claims) => {
    const restore = asPlatform("win32", arch), chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write);
    try { await runtimeMain(["--version"]); } finally { write.mockRestore(); restore(); }
    const printed = JSON.parse(chunks.join("")) as { capabilities: string[] };
    expect(printed.capabilities.includes("cli-install")).toBe(claims);
  });
});
