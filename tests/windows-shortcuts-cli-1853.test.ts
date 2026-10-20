/**
 * #1853 (the leader's task, from the user's 2026-10-20 request): people who only run `agend update` get the two Windows
 * desktop shortcuts too.
 * - `agend shortcuts`, in WSL only, runs the installer's own shortcut code (templates/windows-shortcuts.ps1,
 *   byte-identical to the installer's) in Windows PowerShell through interop, for this Linux (WSL_DISTRO_NAME) and this
 *   user. Interop off (no WSLInterop binfmt entry, no powershell.exe, or no answer from the script) is said plainly,
 *   with the other way: the one-liner on Windows, which on an existing install only offers the shortcuts.
 * - After `agend update`, in a WSL terminal without the shortcuts, one line says how to make them, once. Nothing makes a
 *   desktop item unasked.
 * The real shortcuts are the user's Windows checklist; here the script runs in pwsh with COM and wsl.exe faked.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SHORTCUTS_HINT_MARKER, SHORTCUTS_MARKER, buildShortcutsScript, detectWsl, encodePowershell, findPowershell, interopState,
  powershellArgs, runShortcuts, sharedShortcutsPs, shortcutsHintOnce, type RunResult, type ShortcutsHost,
} from "../src/windows-shortcuts.js";

const ROOT = join(import.meta.dirname, "..");
const installer = readFileSync(join(ROOT, "website", "public", "install-agend.ps1"), "utf8");
const shared = sharedShortcutsPs();
const PS = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

function host(o: Partial<ShortcutsHost> & { files?: string[] } = {}): ShortcutsHost {
  const files = new Set(o.files ?? [PS]);
  return {
    env: o.env ?? { WSL_DISTRO_NAME: "Ubuntu-22.04", PATH: "/usr/bin" },
    osRelease: o.osRelease === undefined ? "6.6.114.1-microsoft-standard-WSL2\n" : o.osRelease,
    binfmt: o.binfmt === undefined ? ["register", "status", "WSLInterop"] : o.binfmt,
    exists: o.exists ?? (p => files.has(p)),
  };
}
function deps(h: ShortcutsHost, answer: RunResult = { status: 0, stdout: "AGEND_SHORTCUTS_MADE=2\r\n", stderr: "" }) {
  const runs: Array<{ command: string; args: string[] }> = [];
  const markers: Array<[string, string]> = [];
  const lines: string[] = [];
  return {
    runs, markers, lines,
    d: {
      host: h, user: "han", dataDir: "/home/han/.agend", shared: () => shared,
      run: (command: string, args: string[]) => { runs.push({ command, args }); return answer; },
      writeMarker: (path: string, content: string) => { markers.push([path, content]); },
      log: (line: string) => { lines.push(line); },
      now: () => new Date("2026-10-20T12:00:00Z"),
    },
  };
}
const decode = (args: string[]) => Buffer.from(args[args.indexOf("-EncodedCommand") + 1]!, "base64").toString("utf16le");

describe("one copy of the shortcut code", () => {
  it("the template below its header is byte-for-byte the installer's, from the WSL command builder to Install-AgendShortcuts", () => {
    expect(shared.startsWith("$WSL_COMMAND_FN = @'\n")).toBe(true);
    expect(shared.trimEnd().endsWith("    return $made\n}")).toBe(true);
    expect(installer.includes(shared)).toBe(true);
    expect(shared).toContain("function Install-AgendShortcuts([string]$distro, [string]$user)");
  });
  it("the encoded command fits Windows' 32,767-character command line with room to spare", () => {
    const args = powershellArgs(buildShortcutsScript(shared, "Ubuntu-24.04", "a-rather-long-user-name"));
    expect(PS.length + args.join(" ").length).toBeLessThan(30_000);
  });
});

describe("where it runs", () => {
  it("WSL: WSL_DISTRO_NAME names the Linux; a Microsoft kernel without it is WSL with no name; elsewhere it is not WSL", () => {
    expect(detectWsl(host())).toEqual({ wsl: true, distro: "Ubuntu-22.04" });
    expect(detectWsl(host({ env: {} }))).toEqual({ wsl: true, distro: null });
    expect(detectWsl(host({ env: {}, osRelease: "6.8.0-45-generic\n" }))).toEqual({ wsl: false, distro: null });
    expect(detectWsl(host({ env: {}, osRelease: null }))).toEqual({ wsl: false, distro: null });
  });
  it("interop is the WSLInterop binfmt entry (or WSLInterop-late); unreadable is unknown", () => {
    expect(interopState(host())).toBe("on");
    expect(interopState(host({ binfmt: ["register", "status", "WSLInterop-late"] }))).toBe("on");
    expect(interopState(host({ binfmt: ["register", "status", "python3.10"] }))).toBe("off");
    expect(interopState(host({ binfmt: null }))).toBe("unknown");
  });
  it("powershell.exe: on PATH first, else Windows' own copy on a mounted drive", () => {
    const onPath = "/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe";
    expect(findPowershell(host({ env: { PATH: "/usr/bin:/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0" }, files: [onPath, PS] }))).toBe(onPath);
    expect(findPowershell(host({ env: { PATH: "/usr/bin" } }))).toBe(PS);
    expect(findPowershell(host({ env: { PATH: "/usr/bin" }, files: ["/mnt/d/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"] }))).toBe("/mnt/d/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
    expect(findPowershell(host({ files: [] }))).toBeNull();
  });
});

describe("agend shortcuts", () => {
  it("makes both through Windows PowerShell for this Linux and user, then leaves the marker", () => {
    const { d, runs, markers, lines } = deps(host());
    expect(runShortcuts(d)).toBe(0);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.command).toBe(PS);
    expect(runs[0]!.args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    expect(runs[0]!.args).toHaveLength(6);
    const script = decode(runs[0]!.args);
    expect(script).toContain(shared);
    expect(script).toContain("$script:OnWindows = $true");
    expect(script).toContain("$made = @(Install-AgendShortcuts 'Ubuntu-22.04' 'han')");
    expect(markers).toEqual([["/home/han/.agend/" + SHORTCUTS_MARKER, "2026-10-20T12:00:00.000Z\n"]]);
    expect(lines.join("\n")).toContain('"AgEnD 儀表板"');
    expect(lines.join("\n")).toContain('"AgEnD 重新啟動"');
  });
  it("a quote in a name stays inside its PowerShell string", () => {
    expect(buildShortcutsScript("", "Ubuntu's", "o'neil")).toContain("Install-AgendShortcuts 'Ubuntu''s' 'o''neil'");
  });
  it.each([
    ["not WSL", host({ env: {}, osRelease: "6.8.0-45-generic\n" }), "This is not WSL"],
    ["WSL without WSL_DISTRO_NAME", host({ env: {} }), "WSL_DISTRO_NAME is not set"],
    ["interop off (this host's own state: the .exe is there, the binfmt entry is not)", host({ binfmt: ["register", "status", "python3.10"] }), "interop is off"],
    ["no powershell.exe anywhere", host({ files: [] }), "interop is off"],
  ])("%s: says why, runs nothing, no marker", (_n, h, why) => {
    const { d, runs, markers, lines } = deps(h);
    expect(runShortcuts(d)).toBe(1);
    expect(runs).toEqual([]);
    expect(markers).toEqual([]);
    expect(lines.join("\n")).toContain(why);
    if (why === "interop is off") expect(lines.join("\n")).toContain("irm https://songsid.github.io/AgEnD/install.ps1 | iex");
  });
  it("no answer from the script (interop off read the .exe as a shell script): the interop message, no marker", () => {
    const { d, markers, lines } = deps(host({ binfmt: null }), { status: 2, stdout: "", stderr: `${PS}: 1: MZ\u0090: not found\n${PS}: 11: Syntax error: ")" unexpected\n` });
    expect(runShortcuts(d)).toBe(1);
    expect(markers).toEqual([]);
    expect(lines.join("\n")).toContain("interop is off");
    expect(lines.join("\n")).toContain("Syntax error");
  });
  it("only one of the two made: says so, no marker", () => {
    const { d, markers, lines } = deps(host(), { status: 0, stdout: "AGEND_SHORTCUTS_MADE=1\n", stderr: "" });
    expect(runShortcuts(d)).toBe(1);
    expect(markers).toEqual([]);
    expect(lines.join("\n")).toContain("were not both made");
  });
});

describe("the hint after agend update", () => {
  const dirs: string[] = [];
  afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
  const dataDir = () => { const dir = mkdtempSync(join(tmpdir(), "agend-1853hint-")); dirs.push(dir); return dir; };
  const real = (h: ShortcutsHost): ShortcutsHost => ({ ...h, exists: existsSync });
  const hint = (dir: string, h: ShortcutsHost, tty = true) => shortcutsHintOnce({ host: real(h), dataDir: dir, tty, write: (p, c) => writeFileSync(p, c) });
  it("#2260 review: two updates at the same moment (both saw no marker) — exactly one shows it", () => {
    const dir = dataDir();
    const racing: ShortcutsHost = { ...host(), exists: () => false };              // each checked before either wrote
    const claim = () => shortcutsHintOnce({ host: racing, dataDir: dir, tty: true, write: (p, c) => writeFileSync(p, c, { flag: "wx" }) });
    expect([claim(), claim()].filter(Boolean)).toHaveLength(1);
    expect(readFileSync(join(ROOT, "src", "windows-shortcuts.ts"), "utf8")).toMatch(/printUpdateShortcutsHint[\s\S]*writeFileSync\(path, content, \{ flag: "wx" \}\)/);
  });
  it("in a WSL terminal without the shortcuts: once, then never again", () => {
    const dir = dataDir();
    expect(hint(dir, host())).toBe("Windows desktop shortcuts: run `agend shortcuts` to make them.");
    expect(existsSync(join(dir, SHORTCUTS_HINT_MARKER))).toBe(true);
    expect(hint(dir, host())).toBeNull();
  });
  it("never: once the shortcuts exist, outside WSL, or with no terminal (a chat /update's log)", () => {
    const made = dataDir(); writeFileSync(join(made, SHORTCUTS_MARKER), "x");
    expect(hint(made, host())).toBeNull();
    const elsewhere = dataDir();
    expect(hint(elsewhere, host({ env: {}, osRelease: "6.8.0-45-generic\n" }))).toBeNull();
    const chat = dataDir();
    expect(hint(chat, host(), false)).toBeNull();
    expect(existsSync(join(chat, SHORTCUTS_HINT_MARKER))).toBe(false);          // the one showing is still to come
  });
  it("agend update calls it after a successful activation and when already up to date; it never makes a shortcut", () => {
    const cli = readFileSync(join(ROOT, "src", "cli.ts"), "utf8");
    const update = cli.slice(cli.indexOf('.command("update")\n  .description("Update AgEnD'), cli.indexOf('\nprogram\n  .command(', cli.indexOf('.command("update")\n  .description("Update AgEnD')));
    const hint = String.raw`await import\("./windows-shortcuts.js"\)\.then\(m => m\.printUpdateShortcutsHint\(DATA_DIR\)\)\.catch\(`;
    expect(update).toMatch(new RegExp(String.raw`if \(outcome\.ok\) ` + hint));
    expect(update).toMatch(new RegExp(String.raw`Already up to date[^\n]*\n[^\n]*setUpdateProgressStage[^\n]*\n\s*` + hint));      // a hint never fails an update
    expect(update).not.toMatch(/runShortcuts|Install-AgendShortcuts|powershell/);
  });
});

const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
describe.skipIf(!pwsh)("with pwsh: the encoded script itself", { timeout: 90_000 }, () => {
  const dirs: string[] = [];
  afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
  it.each(["han", "o'neil"])("decodes, defines the shared code, writes both scripts and the record, and asks WSL for the marker as this user (%s)", (user) => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1853cli-")); dirs.push(dir);
    const bin = join(dir, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "wsl.exe"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(dir, "wsl-calls.txt")}'\nexit 0\n`);
    chmodSync(join(bin, "wsl.exe"), 0o755);
    // WScript.Shell is Windows-only: a function named New-Object comes before the cmdlet and fakes just the COM object.
    const fakeCom = `function New-Object {
  param([Parameter(Position = 0)][string]$TypeName, [Parameter(Position = 1)][object[]]$ArgumentList, [string]$ComObject)
  if ($ComObject) {
    $shell = [pscustomobject]@{}
    $shell | Add-Member ScriptMethod CreateShortcut { param($p)
      $sc = [pscustomobject]@{ Path = $p; TargetPath = ''; Arguments = ''; Description = '' }
      $sc | Add-Member ScriptMethod Save { Add-Content (Join-Path $env:LOCALAPPDATA 'lnk.txt') ($this.Path + ' | ' + $this.TargetPath + ' | ' + $this.Arguments) }
      return $sc }
    return $shell
  }
  if ($PSBoundParameters.ContainsKey('ArgumentList')) { return Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName -ArgumentList $ArgumentList }
  return Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName
}
`;
    const args = powershellArgs(fakeCom + buildShortcutsScript(shared, "Ubuntu-22.04", user));
    const local = join(dir, "local");
    mkdirSync(join(dir, "Desktop"));                                                // .NET on Linux names no Desktop until it exists
    const r = spawnSync("pwsh", args, { encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOCALAPPDATA: local, HOME: dir, SystemRoot: join(dir, "Windows") } });
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^AGEND_SHORTCUTS_MADE=2$/m);
    const restart = readFileSync(join(local, "AgEnD", "restart-agend.ps1"));
    expect([...restart.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);                // UTF-8 with BOM, for 5.1's Chinese
    // #2260 review: each saved script, parsed as PowerShell, has no error and calls with this user exactly.
    const q = user.replace(/'/g, "''");
    expect(restart.toString("utf8")).toContain(`Invoke-RestartAgend 'Ubuntu-22.04' '${q}' -Wait | Out-Null`);
    expect(readFileSync(join(local, "AgEnD", "open-dashboard.ps1"), "utf8")).toContain(`Invoke-OpenDashboard 'Ubuntu-22.04' '${q}' -Wait | Out-Null`);
    for (const [file, call] of [["restart-agend.ps1", "Invoke-RestartAgend"], ["open-dashboard.ps1", "Invoke-OpenDashboard"]]) {
      const check = spawnSync("pwsh", ["-NoProfile", "-Command", `$t = $null; $e = $null; $a = [System.Management.Automation.Language.Parser]::ParseFile('${join(local, "AgEnD", file)}', [ref]$t, [ref]$e)
$c = @($a.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq '${call}' }, $true))[-1]
Write-Output ("ERRORS=" + $e.Count); Write-Output ("USER=" + $c.CommandElements[2].Value)`], { encoding: "utf8" });
      expect(check.stdout, file).toContain("ERRORS=0");
      expect(check.stdout, file).toContain(`USER=${user}\n`);
    }
    expect(JSON.parse(readFileSync(join(local, "AgEnD", "install.json"), "utf8"))).toEqual({ distro: "Ubuntu-22.04", user });
    const lnk = readFileSync(join(local, "lnk.txt"), "utf8");
    expect(lnk).toMatch(/AgEnD 儀表板\.lnk \| .*powershell\.exe \| -NoProfile -ExecutionPolicy Bypass -File ".*open-dashboard\.ps1"/);
    expect(lnk).toMatch(/AgEnD 重新啟動\.lnk \| .*powershell\.exe \| -NoProfile -ExecutionPolicy Bypass -File ".*restart-agend\.ps1"/);
    expect(readFileSync(join(dir, "wsl-calls.txt"), "utf8")).toBe(`-d Ubuntu-22.04 -u ${user} -- bash -lc export PATH=$HOME/.local/bin:$PATH; source $HOME/.nvm/nvm.sh 2>/dev/null; d=\${AGEND_HOME:-$HOME/.agend}; mkdir -p $d && date -u +%FT%TZ > $d/windows-shortcuts\n`);
  });
  it("UTF-16LE base64 is what -EncodedCommand reads: Chinese comes through", () => {
    const r = spawnSync("pwsh", ["-NoProfile", "-EncodedCommand", encodePowershell("Write-Output '重新啟動 OK'")], { encoding: "utf8" });
    expect(r.stdout.trim()).toBe("重新啟動 OK");
  });
});
