import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeClientStore as Store } from "../src/runtime-client-store.js";

const pairing = vi.hoisted(() => ({ pair: vi.fn(), started: vi.fn(), boot: "b".repeat(64) }));
vi.mock("../src/runtime-pane-boot.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/runtime-pane-boot.js")>(), readPaneSystemBootId: async () => pairing.boot }));
vi.mock("../src/runtime-client.js", () => ({
  pairRuntime: pairing.pair,
  rotateRuntimeCredentials: vi.fn(),
  RuntimeClient: class { constructor(options: { store: Store }) { pairing.started(options.store.directory); } async start() {} async stop() {} async waitUntilStopped() {} },
}));
vi.mock("node:readline/promises", () => ({ createInterface: () => ({ question: async () => "ABCD-EFGH", close() {} }) }));

// Profile-selection tests model an already-authorized NTFS boundary; actual gate ordering/refusal is tested in runtime-profile-privacy-2965.
vi.mock("../src/runtime-pane-private.js", async original => ({ ...await original<typeof import("../src/runtime-pane-private.js")>(), protectRuntimeProfileDirectorySync(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 }); const stat = lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Unsafe profile fixture");
} }));
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { chooseRuntimeProfile, runtimeProfileName, runtimeServerProfile, RUNTIME_SERVER_FILE } from "../src/runtime-connection.js";
import { runtimeMain } from "../src/runtime-cli.js";
import { rotateRuntimeCredentials } from "../src/runtime-client.js";
import { reusedRuntimeLockPid } from "../src/runtime-pane-boot.js";
import { runtimeProfileLabel } from "../src/runtime-background.js";

const A = "https://fleet.example.test:10443", B = "https://preview.example.test:8445";
const roots: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
function fixture(): { home: string; program: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "agend-runtime-profile-")); roots.push(root);
  const home = join(root, "home"), program = join(root, "zip"); mkdirSync(home); mkdirSync(program);
  return { home, program, base: join(home, ".agend-runtime") };
}
function pairTo(directory: string, server: string, seed: string): string {
  new RuntimeClientStore(directory).saveCredentials({ server, machineId: "11111111-2222-3333-4444-555555555555", credential: seed.repeat(64).slice(0, 64), name: "Test PC" });
  return readFileSync(join(directory, "connection.json"), "utf8");
}
beforeEach(() => {
  pairing.boot = "b".repeat(64);
  pairing.pair.mockReset(); pairing.started.mockReset();
  pairing.pair.mockImplementation(async (options: { server: string; store: Store }) => {
    options.store.saveCredentials({ server: options.server, machineId: "99999999-2222-3333-4444-555555555555", credential: "b".repeat(64), name: "New PC" });
  });
  Object.defineProperty(process, "platform", { value: "win32" });
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true }); Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform); vi.restoreAllMocks();
  for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe test path"); rmSync(root, { recursive: true, force: true }); }
});

describe("per-server Runtime profile selection", () => {
  it("names a server's profile from its host and port, safe for Windows paths", () => {
    expect(runtimeProfileName(B)).toBe("preview.example.test-8445");
    expect(runtimeProfileName("https://fleet.example.test")).toBe("fleet.example.test-443");
    expect(runtimeProfileName("http://localhost:19280")).toBe("localhost-19280");
    expect(runtimeProfileName("http://[::1]:19280")).toMatch(/^_+1_-19280-[a-f0-9]{8}$/);
    expect(runtimeServerProfile("C:\\u\\.agend-runtime", B)).toContain("profiles");
  });
  it("keeps the default profile when it is unpaired or already paired to the bundled server, and reuses a saved per-server profile", () => {
    const { base } = fixture(), stored = (map: Record<string, string>) => (dir: string) => map[dir];
    expect(chooseRuntimeProfile(base, undefined, true, stored({ [base]: A }))).toMatchObject({ directory: base, separate: false });
    expect(chooseRuntimeProfile(base, B, true, stored({}))).toMatchObject({ directory: base, separate: false });
    expect(chooseRuntimeProfile(base, B, true, stored({ [base]: B + "/" }))).toMatchObject({ directory: base, separate: false });
    expect(chooseRuntimeProfile(base, B, true, stored({ [base]: A }))).toEqual({ directory: runtimeServerProfile(base, B), separate: true, defaultServer: A });
    expect(chooseRuntimeProfile(base, B, true, stored({ [base]: A, [runtimeServerProfile(base, B)]: B }))).toMatchObject({ directory: runtimeServerProfile(base, B), separate: true });
    // run/status/rotate/disconnect never invent a profile: they follow an existing one, else stay on the default.
    expect(chooseRuntimeProfile(base, B, false, stored({ [base]: A }))).toMatchObject({ directory: base, separate: false });
    expect(chooseRuntimeProfile(base, B, false, stored({ [base]: A, [runtimeServerProfile(base, B)]: B }))).toMatchObject({ directory: runtimeServerProfile(base, B), separate: true });
  });
});

describe("connect-agend.bat with a default profile paired to another server", () => {
  it("pairs a separate profile for the bundled server without touching or sending the old credentials, then reuses it", async () => {
    const { home, program, base } = fixture();
    writeFileSync(join(program, RUNTIME_SERVER_FILE), JSON.stringify({ server: B }));
    const before = pairTo(base, A, "a"), own = runtimeServerProfile(base, B);

    await runtimeMain(["connect", "--foreground"], { home, programDirectory: program, env: {} });
    expect(pairing.pair).toHaveBeenCalledTimes(1);
    const call = pairing.pair.mock.calls[0][0] as { server: string; store: Store };
    expect(call.server).toBe(B); expect(call.store.directory).toBe(own);
    expect(pairing.started).toHaveBeenCalledWith(own);
    expect(readFileSync(join(base, "connection.json"), "utf8")).toBe(before);
    expect(new RuntimeClientStore(own).credentials()?.server).toBe(B);
    const printed = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join("");
    expect(printed).toContain(A); expect(printed).toContain(own);

    pairing.pair.mockClear(); pairing.started.mockClear();
    await runtimeMain(["connect", "--foreground"], { home, programDirectory: program, env: {} });
    expect(pairing.pair).not.toHaveBeenCalled();
    expect(pairing.started).toHaveBeenCalledWith(own);
    expect(readFileSync(join(base, "connection.json"), "utf8")).toBe(before);
  });
  it("lets status, run and disconnect from the same folder find that profile, and disconnect forgets only it", async () => {
    const { home, program, base } = fixture();
    writeFileSync(join(program, RUNTIME_SERVER_FILE), JSON.stringify({ server: B }));
    const before = pairTo(base, A, "a"), own = runtimeServerProfile(base, B);
    await runtimeMain(["connect", "--foreground"], { home, programDirectory: program, env: {} });

    await runtimeMain(["status", "--json"], { home, programDirectory: program, env: {} });
    const status = JSON.parse(String(vi.mocked(process.stdout.write).mock.calls.at(-1)![0])) as { profiles: Record<string, unknown>[] };
    // status lists every profile on this computer, the old pairing and the separate one for the bundled server
    expect(status.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ profile: own, paired: true, server: B, label: runtimeProfileLabel(own, home) }), expect.objectContaining({ profile: base, paired: true, server: A, label: "default" })]));
    pairing.started.mockClear();
    await runtimeMain(["run"], { home, programDirectory: program, env: {} });
    expect(pairing.started).toHaveBeenCalledWith(own);
    await runtimeMain(["disconnect"], { home, programDirectory: program, env: {} });
    expect(existsSync(join(own, "connection.json"))).toBe(false);
    expect(readFileSync(join(base, "connection.json"), "utf8")).toBe(before);
  });
  it("keeps the default profile when it is unpaired or already paired to the bundled server", async () => {
    const { home, program, base } = fixture();
    writeFileSync(join(program, RUNTIME_SERVER_FILE), JSON.stringify({ server: B }));
    await runtimeMain(["connect", "--foreground"], { home, programDirectory: program, env: {} });
    expect((pairing.pair.mock.calls[0][0] as { store: Store }).store.directory).toBe(base);
    expect(existsSync(join(base, "profiles"))).toBe(false);
  });
  it("never changes behaviour when --profile or AGEND_RUNTIME_HOME is given, and the failure names both servers with next steps", async () => {
    const { home, program, base } = fixture();
    writeFileSync(join(program, RUNTIME_SERVER_FILE), JSON.stringify({ server: B }));
    const explicit = join(home, "chosen"); pairTo(explicit, A, "c");
    for (const [argv, env] of [[["connect", "--profile", explicit], {}], [["connect"], { AGEND_RUNTIME_HOME: explicit }]] as const) {
      await expect(runtimeMain([...argv], { home, programDirectory: program, env })).rejects.toThrow(new RegExp(`${A}.*${B}[^]*--profile[^]*disconnect`));
    }
    // The follow-up commands must name the profile the user chose, not fall back to the default one.
    const failure = (argv: string[], env: NodeJS.ProcessEnv) => runtimeMain(argv, { home, programDirectory: program, env }).then(() => "", (error: Error) => error.message);
    const withFlag = await failure(["connect", "--profile", explicit], {}), withEnv = await failure(["connect"], { AGEND_RUNTIME_HOME: explicit });
    expect(withFlag).toContain(`disconnect --profile "${resolve(explicit)}"`);
    expect(withFlag).toContain(`connect --server ${B} --profile "${resolve(explicit)}"`);
    expect(withFlag).toContain("pass the same --profile to run, status, rotate and disconnect");
    expect(withEnv).not.toContain("disconnect --profile"); expect(withEnv).toContain("disconnect, then connect again");
    expect(pairing.pair).not.toHaveBeenCalled(); expect(pairing.started).not.toHaveBeenCalled();
    expect(existsSync(join(base, "profiles"))).toBe(false);
    pairTo(base, A, "a");
    // An explicit --server is not redirected either: it fails with the same guidance instead of silently picking another profile.
    await expect(runtimeMain(["connect", "--foreground", "--server", B], { home, programDirectory: program, env: {} })).rejects.toThrow(runtimeServerProfile(base, B));
    // An explicit profile that is already paired to the bundled server still connects.
    const matching = join(home, "matching"); pairTo(matching, B, "d");
    await runtimeMain(["connect", "--foreground", "--profile", matching], { home, programDirectory: program, env: {} });
    expect(pairing.started).toHaveBeenCalledWith(matching);
  });
});

describe("--connection-dir: the one-line installer's reconnect folder picks the profile exactly as the ZIP's connect-agend.bat does", () => {
  const connectDir = (root: string, server: string, name = "reconnect"): string => { const dir = join(root, "connect", name); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, RUNTIME_SERVER_FILE), JSON.stringify({ server }, null, 2) + "\n"); return dir; };
  const printed = (): string => vi.mocked(process.stdout.write).mock.calls.map(call => String(call[0])).join("");
  it("pairs a new profile from the folder's address, asks for the code, and never takes the address from anywhere else", async () => {
    const { home, program, base } = fixture();
    const dir = connectDir(program, B);
    await runtimeMain(["connect", "--foreground", "--connection-dir", dir], { home, env: {} });
    expect(pairing.pair).toHaveBeenCalledTimes(1);
    const call = pairing.pair.mock.calls[0][0] as { server: string; store: Store; code: string };
    expect(call.server).toBe(B); expect(call.store.directory).toBe(base); expect(call.code).toBe("ABCD-EFGH");   // the code came from the interactive prompt
    expect(pairing.started).toHaveBeenCalledWith(base); expect(printed()).toContain(`AgEnD server: ${B}`);
  });
  it("reconnects a profile already paired to this AgEnD without asking for a code, and leaves the stored credentials byte for byte alone", async () => {
    const { home, program, base } = fixture();
    const before = pairTo(base, B, "a"), dir = connectDir(program, B);
    await runtimeMain(["connect", "--foreground", "--connection-dir", dir], { home, env: {} });
    expect(pairing.pair).not.toHaveBeenCalled(); expect(pairing.started).toHaveBeenCalledWith(base);
    expect(readFileSync(join(base, "connection.json"), "utf8")).toBe(before);
  });
  it("gives another AgEnD its own profile and keeps the existing pairing, then finds it again, and run/status/disconnect land there too", async () => {
    const { home, program, base } = fixture();
    const before = pairTo(base, A, "a"), dir = connectDir(program, B), own = runtimeServerProfile(base, B);
    await runtimeMain(["connect", "--foreground", "--connection-dir", dir], { home, env: {} });
    expect((pairing.pair.mock.calls[0][0] as { store: Store }).store.directory).toBe(own); expect(printed()).toContain(`using a separate profile for this server:\n  ${own}`);
    expect(readFileSync(join(base, "connection.json"), "utf8")).toBe(before);
    pairing.pair.mockClear(); pairing.started.mockClear();
    await runtimeMain(["connect", "--foreground", "--connection-dir", dir], { home, env: {} });
    expect(pairing.pair).not.toHaveBeenCalled(); expect(pairing.started).toHaveBeenCalledWith(own);
    await runtimeMain(["status", "--json", "--connection-dir", dir], { home, env: {} });
    expect(JSON.parse(String(vi.mocked(process.stdout.write).mock.calls.at(-1)![0])).profiles).toEqual([expect.objectContaining({ profile: own, paired: true, server: B })]);
    pairing.started.mockClear(); await runtimeMain(["run", "--connection-dir", dir], { home, env: {} }); expect(pairing.started).toHaveBeenCalledWith(own);
    await runtimeMain(["disconnect", "--connection-dir", dir], { home, env: {} });
    expect(existsSync(join(own, "connection.json"))).toBe(false); expect(readFileSync(join(base, "connection.json"), "utf8")).toBe(before);
  });
  it("is not combined with --server, does not fall back to a stored address when the folder has none, and refuses a bad file", async () => {
    const { home, program, base } = fixture();
    pairTo(base, A, "a");
    await expect(runtimeMain(["connect", "--foreground", "--connection-dir", connectDir(program, B), "--server", B], { home, env: {} })).rejects.toThrow(/cannot be used together/);
    const empty = join(program, "empty"); mkdirSync(empty);
    for (const command of ["connect", "run", "status"]) await expect(runtimeMain([command, "--connection-dir", empty], { home, env: {} }), command).rejects.toThrow(/No agend-server\.json in the --connection-dir folder/);
    const bad = join(program, "bad"); mkdirSync(bad); writeFileSync(join(bad, RUNTIME_SERVER_FILE), JSON.stringify({ server: "http://192.168.1.2:19280", password: "x" }));
    await expect(runtimeMain(["connect", "--foreground", "--connection-dir", bad], { home, env: {} })).rejects.toThrow(/Invalid agend-server\.json/);
    expect(pairing.pair).not.toHaveBeenCalled(); expect(pairing.started).not.toHaveBeenCalled();
  });
  it("still takes the pairing code only from the interactive prompt: a code in the arguments is refused, and without a console nothing is asked", async () => {
    const { home, program } = fixture(), dir = connectDir(program, B);
    for (const argv of [["connect", "--connection-dir", dir, "--code", "ABCD-EFGH"], ["connect", "--connection-dir", dir, "ABCD-EFGH"]]) await expect(runtimeMain(argv, { home, env: {} })).rejects.toThrow(/Pairing codes must be entered interactively/);
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    await expect(runtimeMain(["connect", "--foreground", "--connection-dir", dir], { home, env: {} })).rejects.toThrow(/Pairing requires an interactive terminal/);
    expect(pairing.pair).not.toHaveBeenCalled();
  });
  it("documents the flag in --help", async () => {
    await runtimeMain(["--help"], { env: {} });
    expect(printed()).toContain("connect --connection-dir DIRECTORY"); expect(printed()).toContain("--connection-dir and --server are exclusive");
  });
});

describe("disconnect and rotate with a stale profile lock", () => {
  const lockFile = (directory: string): string => join(directory, "runtime.lock");
  function stale(directory: string, boot: string): void { writeFileSync(lockFile(directory), JSON.stringify({ pid: process.pid, bootId: "old-run", systemBootId: boot }), { mode: 0o600 }); }
  it("disconnect works after a Windows restart even though the old lock's PID is now in use by something else", async () => {
    const { home, base } = fixture(); pairTo(base, A, "a"); stale(base, "a".repeat(64));
    await runtimeMain(["disconnect"], { home, env: {} });
    expect(existsSync(join(base, "connection.json"))).toBe(false); expect(existsSync(lockFile(base))).toBe(false);
  });
  it("rotate also replaces a lock left from before a Windows restart, and keeps one from this boot", async () => {
    const { home, base } = fixture(); pairTo(base, A, "a"); stale(base, "a".repeat(64));
    vi.mocked(rotateRuntimeCredentials).mockClear();
    await runtimeMain(["rotate"], { home, env: {} });
    expect(rotateRuntimeCredentials).toHaveBeenCalledTimes(1); expect(existsSync(lockFile(base))).toBe(false);
    stale(base, pairing.boot); vi.mocked(rotateRuntimeCredentials).mockClear();
    await expect(runtimeMain(["rotate"], { home, env: {} })).rejects.toThrow(/Another runtime already uses this profile/);
    expect(rotateRuntimeCredentials).not.toHaveBeenCalled(); expect(existsSync(lockFile(base))).toBe(true);
  });
  it("never unlocks a profile whose lock belongs to the current boot: the message names the PID and the manual check", async () => {
    const { home, base } = fixture(); pairTo(base, A, "a"); stale(base, pairing.boot);
    for (const command of ["disconnect", "rotate"]) {
      await expect(runtimeMain([command], { home, env: {} })).rejects.toThrow(new RegExp(`Another runtime already uses this profile \\(process ${process.pid}\\)[^]*Task Manager[^]*runtime-cli\\.js`));
    }
    expect(existsSync(join(base, "connection.json"))).toBe(true); expect(JSON.parse(readFileSync(lockFile(base), "utf8")).pid).toBe(process.pid);
  });
  it("only treats the lock holder as reused when a readable command line is not a Runtime", async () => {
    const line = (text: string | undefined) => async () => text;
    expect(await reusedRuntimeLockPid(4321, line('"C:\\Program Files\\nodejs\\node.exe" "C:\\agend\\dist\\runtime-cli.js" run'))).toBeUndefined();
    expect(await reusedRuntimeLockPid(4321, line("C:\\Windows\\explorer.exe"))).toBe(4321);
    expect(await reusedRuntimeLockPid(4321, line(undefined))).toBeUndefined();
    expect(await reusedRuntimeLockPid(undefined, line("anything"))).toBeUndefined();
    expect(await reusedRuntimeLockPid(process.pid, line("anything"))).toBeUndefined();
  });
  it("store.lock replaces a lock only for the PID verified as not a Runtime", () => {
    const { base } = fixture(), store = new RuntimeClientStore(base);
    writeFileSync(lockFile(base), JSON.stringify({ pid: process.pid, bootId: "old-run" }), { mode: 0o600 });
    expect(store.lockHolder()).toBe(process.pid);
    expect(() => store.lock("new")).toThrow(/Another runtime already uses this profile/);
    expect(() => store.lock("new", undefined, process.pid + 1)).toThrow(/Another runtime/);
    store.lock("new", undefined, process.pid)();
    expect(store.lockHolder()).toBeUndefined();
  });
});
