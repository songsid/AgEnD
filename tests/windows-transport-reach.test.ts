import { describe, expect, it, vi } from "vitest";
import { WINDOWS_BRIDGE_MESSAGES, WindowsBridgeUnavailableError, nativeWindowsTransport, type WindowsTransportDeps } from "../src/windows-cli.js";
import { detectWsl, findPowershell, windowsReach, type WslHost } from "../src/wsl-host.js";

/**
 * "CLI diagnostics · Windows local" said `spawn /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ENOENT`
 * in a Docker Desktop container — a Linux with no /mnt/c at all. The bridge took every Linux for a WSL and spawned a hard-coded path.
 * Each way a Linux can fail to reach Windows now has its own answer, decided before anything is spawned.
 */
const PS = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const NODE = "C:\\Program Files\\nodejs\\node.exe";
function host(over: Partial<WslHost> & { files?: string[] } = {}): WslHost {
  const files = new Set(over.files ?? [PS]);
  return { env: { WSL_DISTRO_NAME: "Ubuntu", PATH: "/usr/bin" }, osRelease: "6.6.0-microsoft-standard-WSL2\n", binfmt: ["register", "status", "WSLInterop"], exists: p => files.has(p), ...over };
}
/**
 * What a node:22-bookworm container on Docker Desktop really shows, read from the running container: the WSL2 kernel's
 * release string, no WSL_DISTRO_NAME, an empty binfmt_misc, /.dockerenv, and no /mnt/c.
 */
const dockerDesktopContainer = () => host({ env: { PATH: "/usr/local/bin:/usr/bin" }, osRelease: "6.6.114.1-microsoft-standard-WSL2\n", binfmt: [], files: ["/.dockerenv"] });
/** A plain Linux server: an ordinary kernel. */
const plainLinux = () => host({ env: { PATH: "/usr/local/bin:/usr/bin" }, osRelease: "5.15.0-1030-generic\n", binfmt: ["register", "status"], files: [] });

type Run = WindowsTransportDeps["run"];
function deps(over: Partial<WindowsTransportDeps> = {}, run?: Run): WindowsTransportDeps & { run: ReturnType<typeof vi.fn> } {
  const fake = vi.fn<Run>(run ?? (async (file, args) => file === "wslpath" ? { stdout: args[0] === "-u" ? "/mnt/c/Program Files/nodejs/node.exe\n" : "C:\\agend\\windows-cli-worker.js\n" } : { stdout: NODE }));
  return { platform: "linux", host: () => host(), cwd: () => "/home/user/agend", wslpath: async () => null, ...over, run: fake } as WindowsTransportDeps & { run: ReturnType<typeof vi.fn> };
}
const failure = async (d: WindowsTransportDeps) => nativeWindowsTransport(d).then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as WindowsBridgeUnavailableError);

describe("nativeWindowsTransport on Linux: where Windows PowerShell can't be reached", () => {
  it.each([
    ["a Docker Desktop container (on WSL2's kernel)", dockerDesktopContainer],
    ["a plain Linux server", plainLinux],
  ])("%s says it is not WSL, and spawns nothing — not `spawn … ENOENT`", async (_name, make) => {
    const d = deps({ host: make });
    const error = await failure(d);
    expect(error).toBeInstanceOf(WindowsBridgeUnavailableError);
    expect(error.code).toBe("not-wsl");
    expect(error.message).toBe(WINDOWS_BRIDGE_MESSAGES["not-wsl"]);
    expect(error.message).not.toMatch(/ENOENT|spawn /);
    expect(d.run).not.toHaveBeenCalled();
  });
  it("a distro that names itself (WSL_DISTRO_NAME) is WSL even when a /.dockerenv is there", async () => {
    const d = deps({ host: () => host({ files: [PS, "/.dockerenv"] }) });
    await nativeWindowsTransport(d);
    expect(d.run).toHaveBeenCalled();
  });
  it("another platform (macOS) is the same answer", async () => {
    const d = deps({ platform: "darwin" });
    expect((await failure(d)).code).toBe("not-wsl");
    expect(d.run).not.toHaveBeenCalled();
  });
  it("WSL with interop off is told how to turn it on, and nothing is spawned (the exec would run powershell.exe as a shell script)", async () => {
    const d = deps({ host: () => host({ binfmt: ["register", "status", "python3.10"] }) });
    const error = await failure(d);
    expect(error.code).toBe("interop-off");
    expect(error.message).toContain("/etc/wsl.conf");
    expect(d.run).not.toHaveBeenCalled();
  });
  it("WSL with no powershell.exe on PATH or on a mounted drive asks `wslpath`, then says where to look", async () => {
    const wslpath = vi.fn(async () => null);
    const d = deps({ host: () => host({ files: [], env: { WSL_DISTRO_NAME: "Ubuntu", PATH: "/usr/bin" } }), wslpath });
    const error = await failure(d);
    expect(error.code).toBe("powershell-missing");
    expect(wslpath).toHaveBeenCalledWith("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", {});
    expect(error.message).toContain("/mnt/c");
    expect(d.run).not.toHaveBeenCalled();
  });
  it("a Windows drive mounted somewhere else (automount root) is found through wslpath", async () => {
    const custom = "/win/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    const d = deps({ host: () => host({ files: [custom] }), wslpath: async () => custom });
    await nativeWindowsTransport(d);
    expect(d.run.mock.calls[0]![0]).toBe(custom);
  });
  it("a `wslpath` answer that does not exist is not trusted", async () => {
    const d = deps({ host: () => host({ files: [] }), wslpath: async () => "/not/there/powershell.exe" });
    expect((await failure(d)).code).toBe("powershell-missing");
  });
});

describe("nativeWindowsTransport on Linux: a PowerShell that is there", () => {
  it("finds the Windows node.exe and the worker as WSL paths", async () => {
    const d = deps();
    expect(await nativeWindowsTransport(d)).toEqual({ executable: "/mnt/c/Program Files/nodejs/node.exe", args: ["C:\\agend\\windows-cli-worker.js"] });
    const [file, args, options] = d.run.mock.calls[0]!;
    expect(file).toBe(PS);
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(options).toMatchObject({ timeout: 8000, encoding: "utf8" });
  });
  it("prefers powershell.exe on PATH (WSL appends Windows' PATH) over the mounted drive", async () => {
    const onPath = "/mnt/c/windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    const d = deps({ host: () => host({ env: { WSL_DISTRO_NAME: "Ubuntu", PATH: "/usr/bin:/mnt/c/windows/System32/WindowsPowerShell/v1.0" }, files: [onPath, PS] }) });
    await nativeWindowsTransport(d);
    expect(d.run.mock.calls[0]![0]).toBe(onPath);
  });
  it("keeps the process's own working directory when it exists — no call and no worker gets a cwd", async () => {
    const wslpath = vi.fn(async () => null);
    const d = deps({ host: () => host({ files: [PS], env: { WSL_DISTRO_NAME: "Ubuntu", PATH: "/usr/bin" } }), wslpath });
    const transport = await nativeWindowsTransport(d);
    expect(d.run).toHaveBeenCalledTimes(3);   // PowerShell, wslpath -u node.exe, wslpath -w worker
    for (const call of d.run.mock.calls) expect(call[2]).not.toHaveProperty("cwd");
    expect(transport).not.toHaveProperty("cwd");
  });
  it("a working directory that was deleted (the daemon started from a removed checkout) is `/` for EVERY process: PowerShell, both wslpath, the system-PowerShell lookup and the worker", async () => {
    const custom = "/win/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    const wslpath = vi.fn(async () => custom);
    const d = deps({ cwd: () => null, host: () => host({ files: [custom] }), wslpath });
    const transport = await nativeWindowsTransport(d);
    expect(wslpath).toHaveBeenCalledWith(expect.any(String), { cwd: "/" });
    expect(d.run.mock.calls.map(call => [call[0], call[2].cwd])).toEqual([[custom, "/"], ["wslpath", "/"], ["wslpath", "/"]]);
    expect(transport.cwd).toBe("/");
  });
  it.each([
    ["fails", async () => { throw Object.assign(new Error("Command failed: wslpath -w /home/someone/agend/dist/windows-cli-worker.js"), { code: 1, stderr: "wslpath: No such file or directory" }); }],
    ["answers nothing", async () => ({ stdout: "" })],
  ])("`wslpath` that %s is `wslpath-failed` — never its command line or a local path", async (_name, wslpathRun) => {
    const error = await failure(deps({}, async (file, args, options) => file === "wslpath" ? wslpathRun() : { stdout: NODE }));
    expect(error).toBeInstanceOf(WindowsBridgeUnavailableError);
    expect(error.code).toBe("wslpath-failed");
    expect(`${error.message} ${error.detail ?? ""}`).not.toMatch(/Command failed|\/home\/|windows-cli-worker/);
  });
  it.each([
    ["exits non-zero without saying why", Object.assign(new Error("Command failed: powershell.exe -EncodedCommand AAAA"), { code: 1, stderr: "" }), "exit code 1"],
    ["can't be started (ENOENT, ELOOP…)", Object.assign(new Error("spawn /mnt/c/x ENOENT"), { code: "ENOENT" }), "ENOENT"],
    ["is killed after the timeout", Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", code: null }), "stopped (SIGTERM)"],
  ])("PowerShell that %s is `powershell-failed`, with one short fact and never the command line", async (_name, cause, detail) => {
    const error = await failure(deps({}, async () => { throw cause; }));
    expect(error.code).toBe("powershell-failed");
    expect(error.detail).toBe(detail);
    expect(error.message).toBe(WINDOWS_BRIDGE_MESSAGES["powershell-failed"]);
    expect(`${error.message} ${error.detail}`).not.toMatch(/EncodedCommand|spawn /);
    expect(error.cause).toBe(cause);
  });
  it("no node.exe on Windows PATH (Get-Command's error) is `node-missing`", async () => {
    const error = await failure(deps({}, async () => { throw Object.assign(new Error("Command failed"), { code: 1, stderr: "Get-Command : The term 'node.exe' is not recognized" }); }));
    expect(error.code).toBe("node-missing");
  });
  it.each(["", "node", "/usr/bin/node", "C:\\x\\node.exe\r\nC:\\y\\node.exe"])("an answer that is not a Windows node.exe path (%j) is `node-missing`", async answer => {
    const error = await failure(deps({}, async () => ({ stdout: answer })));
    expect(error.code).toBe("node-missing");
  });
});

describe("a container marker never decides alone", () => {
  const PATH_PS = "/mnt/c/windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  /** A WSL distro made by `docker export | wsl --import` (it carries /.dockerenv), run by systemd / ssh (no WSL_DISTRO_NAME). */
  const importedDistro = (over: Partial<WslHost> & { files?: string[] } = {}) => host({ env: { PATH: "/usr/bin:/mnt/c/windows/System32/WindowsPowerShell/v1.0" }, files: [PATH_PS, "/.dockerenv"], ...over });
  it("no WSL_DISTRO_NAME + /.dockerenv + WSLInterop + powershell on PATH → it runs", async () => {
    expect(windowsReach(importedDistro())).toEqual({ ok: true, powershell: PATH_PS });
    const d = deps({ host: () => importedDistro() });
    await nativeWindowsTransport(d);
    expect(d.run.mock.calls[0]![0]).toBe(PATH_PS);
  });
  it("…with binfmt_misc unreadable (interop unknown) and PowerShell found, too", () => {
    expect(windowsReach(importedDistro({ binfmt: null }))).toEqual({ ok: true, powershell: PATH_PS });
  });
  it("…with interop on but no PowerShell, it is told PowerShell is missing (and `wslpath` is asked), not that it is no WSL", async () => {
    const wslpath = vi.fn(async () => null);
    const d = deps({ host: () => importedDistro({ files: ["/.dockerenv"] }), wslpath });
    expect((await failure(d)).code).toBe("powershell-missing");
    expect(wslpath).toHaveBeenCalledOnce();
  });
  it("…with interop off and PowerShell on disk, it is told to turn interop on", () => {
    expect(windowsReach(importedDistro({ binfmt: [] }))).toEqual({ ok: false, problem: "interop-off" });
  });
  it("only no interop AND no PowerShell in a container is `not-wsl` (a Docker Desktop container), and `wslpath` is still asked first", async () => {
    const wslpath = vi.fn(async () => null);
    const d = deps({ host: dockerDesktopContainer, wslpath });
    expect((await failure(d)).code).toBe("not-wsl");
    expect(wslpath).toHaveBeenCalledOnce();
    expect(d.run).not.toHaveBeenCalled();
  });
});

describe("the host facts (shared with `agend shortcuts`)", () => {
  it("the bridge looks under /mnt/c only (a stat on an offline d:/e: network drive would hold the daemon); `agend shortcuts` still tries d: and e:", () => {
    const onE = "/mnt/e/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    const exists = vi.fn((p: string) => p === onE);
    expect(windowsReach({ ...host(), exists })).toEqual({ ok: false, problem: "powershell-missing" });
    expect(exists.mock.calls.map(c => c[0]).filter(p => /^\/mnt\/[de]\//.test(p))).toEqual([]);
    expect(findPowershell(host({ files: [onE] }))).toBe(onE);
  });
  it("findPowershell takes PATH first, then c: d: e: under either spelling of the Windows folder", () => {
    expect(findPowershell(host({ files: ["/mnt/c/windows/System32/WindowsPowerShell/v1.0/powershell.exe"] }))).toBe("/mnt/c/windows/System32/WindowsPowerShell/v1.0/powershell.exe");
    expect(findPowershell(host({ files: ["/mnt/e/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"] }))).toBe("/mnt/e/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
    expect(findPowershell(host({ files: [] }))).toBeNull();
  });
  it("windowsReach names the first thing that is wrong, in the order a person fixes them", () => {
    expect(windowsReach(plainLinux())).toEqual({ ok: false, problem: "not-wsl" } satisfies ReturnType<typeof windowsReach>);
    expect(detectWsl(dockerDesktopContainer()).wsl).toBe(true);   // the kernel string alone is not enough…
    expect(windowsReach(dockerDesktopContainer())).toEqual({ ok: false, problem: "not-wsl" });   // …a container is not WSL
    expect(windowsReach(host({ binfmt: [], files: [] }))).toEqual({ ok: false, problem: "interop-off" });
    expect(windowsReach(host({ files: [] }))).toEqual({ ok: false, problem: "powershell-missing" });
    expect(windowsReach(host({ binfmt: null }))).toEqual({ ok: true, powershell: PS });
    expect(windowsReach(host({ binfmt: [], files: [PS] }))).toEqual({ ok: false, problem: "interop-off" });   // interop off is never spawned, PowerShell or not
    expect(windowsReach(host({ files: [], env: { PATH: "/usr/bin" }, binfmt: null }))).toEqual({ ok: false, problem: "powershell-missing" });   // no container: not named
    expect(windowsReach(host())).toEqual({ ok: true, powershell: PS });
  });
});
