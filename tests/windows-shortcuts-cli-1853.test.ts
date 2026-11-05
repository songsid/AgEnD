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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { InstallerPsBatch, hasPwsh } from "./support/installer-ps-batch.js";
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
function deps(h: ShortcutsHost, result: RunResult = { status: 0, stdout: "AGEND_SHORTCUTS_MADE=2\r\n", stderr: "" }, answer?: boolean | null) {
  const runs: Array<{ command: string; args: string[] }> = [];
  const markers: Array<[string, string]> = [];
  const lines: string[] = [];
  return {
    runs, markers, lines,
    d: {
      host: h, user: "han", dataDir: "/home/han/.agend", shared: () => shared,
      run: (command: string, args: string[]) => { runs.push({ command, args }); return result; },
      writeMarker: (path: string, content: string) => { markers.push([path, content]); },
      log: (line: string) => { lines.push(line); },
      now: () => new Date("2026-10-20T12:00:00Z"),
      confirm: async () => answer ?? null,
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
  it("makes both through Windows PowerShell for this Linux and user, then leaves the marker", async () => {
    const { d, runs, markers, lines } = deps(host());
    expect(await runShortcuts(d)).toBe(0);
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
  ])("%s: says why, runs nothing, no marker", async (_n, h, why) => {
    const { d, runs, markers, lines } = deps(h);
    expect(await runShortcuts(d)).toBe(1);
    expect(runs).toEqual([]);
    expect(markers).toEqual([]);
    expect(lines.join("\n")).toContain(why);
    if (why === "interop is off") expect(lines.join("\n")).toContain("irm https://songsid.github.io/AgEnD/install.ps1 | iex");
  });
  it("no answer from the script (interop off read the .exe as a shell script): the interop message, no marker", async () => {
    const { d, markers, lines } = deps(host({ binfmt: null }), { status: 2, stdout: "", stderr: `${PS}: 1: MZ\u0090: not found\n${PS}: 11: Syntax error: ")" unexpected\n` });
    expect(await runShortcuts(d)).toBe(1);
    expect(markers).toEqual([]);
    expect(lines.join("\n")).toContain("interop is off");
    expect(lines.join("\n")).toContain("Syntax error");
  });
  describe("install.json names another Linux (the leader, 2026-10-20: never repoint silently)", () => {
    const other: RunResult = { status: 0, stdout: "AGEND_RECORD_OTHER=Ubuntu-24.04|root\r\n", stderr: "" };
    const made: RunResult = { status: 0, stdout: "AGEND_SHORTCUTS_MADE=2\r\n", stderr: "" };
    function sequenced(answer: boolean | null, second: RunResult = made) {
      const runs: string[] = [], lines: string[] = [], markers: string[] = [], asked: string[] = [];
      const answers = [other, second];
      const d = {
        host: host({ env: { WSL_DISTRO_NAME: "AgEnD", PATH: "/usr/bin" } }), user: "root", dataDir: "/root/.agend", shared: () => shared,
        run: (_c: string, args: string[]) => { runs.push(decode(args)); return answers.shift()!; },
        writeMarker: (path: string) => { markers.push(path); }, log: (l: string) => { lines.push(l); },
        now: () => new Date("2026-10-20T12:00:00Z"), confirm: async (q: string) => { asked.push(q); return answer; },
      };
      return { d, runs, lines, markers, asked };
    }
    it("the first run checks and changes nothing; y: the second run, without the check, makes both", async () => {
      const { d, runs, markers, asked } = sequenced(true);
      expect(await runShortcuts(d)).toBe(0);
      expect(runs).toHaveLength(2);
      expect(runs[0]).toContain("if (-not (Test-InstallRecordAsSeen $null 'AgEnD' 'root')) {");
      // #2279 review: the yes is bound to what was shown — the second run checks the record is still that one.
      expect(runs[1]).toContain("if (-not (Test-InstallRecordAsSeen @{ Distro = 'Ubuntu-24.04'; User = 'root' } 'AgEnD' 'root')) {");
      expect(runs[1]).toContain("$made = @(Install-AgendShortcuts 'AgEnD' 'root')");
      expect(asked).toEqual(["The desktop shortcuts now open Ubuntu-24.04 (user root). Point them at AgEnD (user root) instead? (y/N)"]);
      expect(markers).toEqual(["/root/.agend/windows-shortcuts"]);
    });
    it("#2279 review: changed while the person answered (the second run finds another record): nothing written, said", async () => {
      const { d, runs, markers, lines } = sequenced(true, { status: 0, stdout: "AGEND_RECORD_OTHER=Ubuntu-B|root\r\n", stderr: "" });
      expect(await runShortcuts(d)).toBe(1);
      expect(runs).toHaveLength(2);
      expect(markers).toEqual([]);
      expect(lines.join("\n")).toContain("while you answered, the shortcuts were pointed at Ubuntu-B (user root) instead");
    });
    it.each([[false, "Nothing changed: the shortcuts still open Ubuntu-24.04 (user root)."], [null, "Run agend shortcuts in a terminal to answer."]])("no (%s): nothing more runs, nothing changes, it says what stays", async (answer, said) => {
      const { d, runs, markers, lines } = sequenced(answer);
      expect(await runShortcuts(d)).toBe(1);
      expect(runs).toHaveLength(1);
      expect(markers).toEqual([]);
      expect(lines.join("\n")).toContain(said);
    });
  });
  it("only one of the two made: says so, no marker", async () => {
    const { d, markers, lines } = deps(host(), { status: 0, stdout: "AGEND_SHORTCUTS_MADE=1\n", stderr: "" });
    expect(await runShortcuts(d)).toBe(1);
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

const pwsh = hasPwsh;
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

function scratchWindows() {
  const dir = mkdtempSync(join(tmpdir(), "agend-1853cli-"));
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "wsl.exe"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(dir, "wsl-calls.txt")}'\nexit 0\n`);
  chmodSync(join(bin, "wsl.exe"), 0o755);
  const local = join(dir, "local");
  mkdirSync(join(dir, "Desktop"));                                                // .NET on Linux names no Desktop until it exists
  return { dir, bin, local };
}

/** The CLI script after the shared template. Production EncodedCommand still `exit 0`s; a batch dotsources, so that becomes `return`. */
function writeTail(w: { dir: string }, distro: string, user: string, confirmedOver?: { distro: string; user: string }, name = "tail.ps1") {
  const full = buildShortcutsScript(shared, distro, user, confirmedOver);
  const i = full.lastIndexOf(shared);
  if (i < 0) throw new Error("buildShortcutsScript lost the shared template");
  writeFileSync(join(w.dir, name), full.slice(i + shared.length).replace(/\bexit 0\b/g, "return"));
}

async function pwshFile(script: string, env: Record<string, string> = {}, input = "") {
  return shortcutBatch.run("shortcuts", "$script:OnWindows = $true; Remove-Item Function:wsl.exe\n" + script, { env, input });
}

const INVOKE_TAIL = `
$script:OrigPath = $env:PATH
function Invoke-Tail([string]$Root, [string]$TailFile) {
  $env:PATH = (Join-Path $Root 'bin') + [IO.Path]::PathSeparator + $script:OrigPath
  $env:LOCALAPPDATA = Join-Path $Root 'local'
  $env:HOME = $Root
  $env:USERPROFILE = $Root
  $env:SystemRoot = Join-Path $Root 'Windows'
  $env:TMPDIR = $Root
  New-Item -ItemType Directory -Force -Path (Join-Path $Root 'Desktop') | Out-Null
  $global:LASTEXITCODE = 0
  . $TailFile
}
`;

// GrokCore's #3128/#3129 already batches the cases. Keep that template, but charge
// startup/compile only once to fixture setup, not to a monolithic behavior test.
const shortcutBatch = new InstallerPsBatch({ shortcuts: fakeCom + "\n" + shared + "\n" + INVOKE_TAIL });

describe.skipIf(!pwsh)("with pwsh: the encoded script itself", () => {
  beforeAll(async () => {
    expect(await shortcutBatch.run("shortcuts", "Write-Output 'WORKER_READY'")).toContain("WORKER_READY");
  });
  it("the CLI payload is the shared template, not ParseFile of the installer", () => {
    expect(shared).toContain("function Install-AgendShortcuts");
    expect(shared).toContain("function Test-InstallRecordAsSeen");
    expect(shared).not.toContain("Parser]::ParseFile");
    expect(shared).not.toContain("exit 0");
    const full = buildShortcutsScript(shared, "Ubuntu-22.04", "han");
    expect(full.startsWith("$ErrorActionPreference = 'Stop'")).toBe(true);
    expect(full).toContain(shared);
    expect(full).toContain("exit 0");
    expect(powershellArgs(full)[0]).toBe("-NoProfile");
  });

  it("writes both scripts and the record, respecting another Linux and exact confirmation", async () => {
    const han = scratchWindows();
    const oneil = scratchWindows();
    const other = scratchWindows();
    const same = scratchWindows();
    const casing = scratchWindows();
    const dirs = [han, oneil, other, same, casing];
    try {
      writeTail(han, "Ubuntu-22.04", "han");
      writeTail(oneil, "Ubuntu-22.04", "o'neil");
      mkdirSync(join(other.local, "AgEnD"), { recursive: true });
      writeFileSync(join(other.local, "AgEnD", "install.json"), '{"distro":"Ubuntu-24.04","user":"root"}');
      writeTail(other, "AgEnD", "root");
      mkdirSync(join(same.local, "AgEnD"), { recursive: true });
      writeFileSync(join(same.local, "AgEnD", "install.json"), '{"distro":"AgEnD","user":"root"}');
      writeTail(same, "AgEnD", "root");
      mkdirSync(join(casing.local, "AgEnD"), { recursive: true });
      writeFileSync(join(casing.local, "AgEnD", "install.json"), '{"distro":"AgEnD","user":"Han"}');
      writeTail(casing, "agend", "han");
      writeTail(other, "AgEnD", "root", { distro: "Ubuntu-24.04", user: "root" }, "tail-race.ps1");
      writeTail(other, "AgEnD", "root", { distro: "Ubuntu-24.04", user: "root" }, "tail-confirm.ps1");
      writeTail(casing, "agend", "Han", undefined, "tail-han.ps1");
      const out = await pwshFile(`
function CaseOut([string]$name, [string]$text) {
  $made = [bool]($text -match '(?m)^AGEND_SHORTCUTS_MADE=2$')
  $other = if ($text -match '(?m)^AGEND_RECORD_OTHER=(.+)$') { $Matches[1] } else { '' }
  Write-Output ("CASE=" + $name + " MADE=" + $made + " OTHER=" + $other)
}
CaseOut 'han' ((Invoke-Tail $env:HAN_ROOT (Join-Path $env:HAN_ROOT 'tail.ps1')) | Out-String)
CaseOut 'oneil' ((Invoke-Tail $env:ONEIL_ROOT (Join-Path $env:ONEIL_ROOT 'tail.ps1')) | Out-String)
CaseOut 'other' ((Invoke-Tail $env:OTHER_ROOT (Join-Path $env:OTHER_ROOT 'tail.ps1')) | Out-String)
Write-Output ("CASE=other-exists " + (Test-Path -LiteralPath (Join-Path $env:OTHER_LOCAL 'AgEnD/restart-agend.ps1')))
CaseOut 'same' ((Invoke-Tail $env:SAME_ROOT (Join-Path $env:SAME_ROOT 'tail.ps1')) | Out-String)
Set-Content -LiteralPath (Join-Path $env:OTHER_LOCAL 'AgEnD/install.json') -Value '{"distro":"Ubuntu-B","user":"root"}' -Encoding utf8
CaseOut 'raced' ((Invoke-Tail $env:OTHER_ROOT (Join-Path $env:OTHER_ROOT 'tail-race.ps1')) | Out-String)
Set-Content -LiteralPath (Join-Path $env:OTHER_LOCAL 'AgEnD/install.json') -Value '{"distro":"Ubuntu-24.04","user":"root"}' -Encoding utf8
CaseOut 'confirm' ((Invoke-Tail $env:OTHER_ROOT (Join-Path $env:OTHER_ROOT 'tail-confirm.ps1')) | Out-String)
CaseOut 'casing-han' ((Invoke-Tail $env:CASING_ROOT (Join-Path $env:CASING_ROOT 'tail.ps1')) | Out-String)
CaseOut 'casing-Han' ((Invoke-Tail $env:CASING_ROOT (Join-Path $env:CASING_ROOT 'tail-han.ps1')) | Out-String)

`, {
        HAN_ROOT: han.dir, HAN_LOCAL: han.local,
        ONEIL_ROOT: oneil.dir, ONEIL_LOCAL: oneil.local,
        OTHER_ROOT: other.dir, OTHER_LOCAL: other.local,
        SAME_ROOT: same.dir, SAME_LOCAL: same.local,
        CASING_ROOT: casing.dir, CASING_LOCAL: casing.local,
      });

      expect(out).toMatch(/^CASE=han MADE=True /m);
      expect(out).toMatch(/^CASE=oneil MADE=True /m);
      expect(out).toMatch(/^CASE=other MADE=False OTHER=Ubuntu-24\.04\|root$/m);
      expect(out).toMatch(/^CASE=other-exists False$/m);
      expect(out).toMatch(/^CASE=same MADE=True /m);
      expect(out).toMatch(/^CASE=raced MADE=False OTHER=Ubuntu-B\|root$/m);
      expect(out).toMatch(/^CASE=confirm MADE=True /m);
      expect(out).toMatch(/^CASE=casing-han MADE=False OTHER=AgEnD\|Han$/m);
      expect(out).toMatch(/^CASE=casing-Han MADE=True /m);
      expect(existsSync(join(other.local, "AgEnD", "restart-agend.ps1"))).toBe(true); // confirm wrote
      expect(JSON.parse(readFileSync(join(other.local, "AgEnD", "install.json"), "utf8"))).toEqual({ distro: "AgEnD", user: "root" });

      for (const [w, user] of [[han, "han"], [oneil, "o'neil"]] as const) {
        const restart = readFileSync(join(w.local, "AgEnD", "restart-agend.ps1"));
        expect([...restart.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        const q = user.replace(/'/g, "''");
        expect(restart.toString("utf8")).toContain(`Invoke-RestartAgend 'Ubuntu-22.04' '${q}' -Wait | Out-Null`);
        expect(readFileSync(join(w.local, "AgEnD", "open-dashboard.ps1"), "utf8")).toContain(`Invoke-OpenDashboard 'Ubuntu-22.04' '${q}' -Wait | Out-Null`);
        expect(JSON.parse(readFileSync(join(w.local, "AgEnD", "install.json"), "utf8"))).toEqual({ distro: "Ubuntu-22.04", user });
        const lnk = readFileSync(join(w.local, "lnk.txt"), "utf8");
        expect(lnk).toMatch(/AgEnD 儀表板\.lnk \| .*powershell\.exe \| -NoProfile -ExecutionPolicy Bypass -File ".*open-dashboard\.ps1"/);
        expect(lnk).toMatch(/AgEnD 重新啟動\.lnk \| .*powershell\.exe \| -NoProfile -ExecutionPolicy Bypass -File ".*restart-agend\.ps1"/);
        expect(readFileSync(join(w.dir, "wsl-calls.txt"), "utf8")).toBe(`-d Ubuntu-22.04 -u ${user} --exec timeout --signal=TERM --kill-after=2s 25 bash -lc export PATH=$HOME/.local/bin:$PATH; source $HOME/.nvm/nvm.sh 2>/dev/null; set -f; IFS=; d=\${AGEND_HOME:-$HOME/.agend}; umask 077; mkdir -p -m 700 -- $d && date -u +%FT%TZ > $d/windows-shortcuts\n`);
      }
    } finally {
      for (const w of dirs) rmSync(w.dir, { recursive: true, force: true });
    }
  });
  it("the saved restart/dashboard scripts invoke WSL for their recorded target", async () => {
    const saved = scratchWindows();
    try {
      writeTail(saved, "AgEnD", "root");
      const out = await pwshFile(`
$made = (Invoke-Tail $env:SAVED_ROOT (Join-Path $env:SAVED_ROOT 'tail.ps1')) | Out-String
Write-Output ('CASE=saved-make MADE=' + [bool]($made -match '(?m)^AGEND_SHORTCUTS_MADE=2$'))
Remove-Item -LiteralPath (Join-Path $env:SAVED_ROOT 'wsl-calls.txt') -ErrorAction SilentlyContinue
$env:PATH = (Join-Path $env:SAVED_ROOT 'bin') + [IO.Path]::PathSeparator + $script:OrigPath
$env:LOCALAPPDATA = $env:SAVED_LOCAL
$env:HOME = $env:SAVED_ROOT
$env:USERPROFILE = $env:SAVED_ROOT
$env:SystemRoot = Join-Path $env:SAVED_ROOT 'Windows'
. (Join-Path $env:SAVED_LOCAL 'AgEnD/restart-agend.ps1')
. (Join-Path $env:SAVED_LOCAL 'AgEnD/open-dashboard.ps1')
Write-Output 'CASE=saved-ran'
`, { SAVED_ROOT: saved.dir, SAVED_LOCAL: saved.local }, "y\n\n\n");
      expect(out).toMatch(/^CASE=saved-make MADE=True$/m);
      expect(out).toMatch(/^CASE=saved-ran$/m);
      expect(out).toContain("AgEnD（Linux：AgEnD，使用者：root）");
      const calls = readFileSync(join(saved.dir, "wsl-calls.txt"), "utf8").trim().split("\n");
      expect(calls.length).toBeGreaterThanOrEqual(3);
      for (const call of calls) expect(call).toMatch(/^-d AgEnD -u root --exec timeout --signal=TERM --kill-after=2s (?:25|355) bash -lc /);
    } finally { rmSync(saved.dir, { recursive: true, force: true }); }
  });

  it("saved invoke lines parse exact quoted users, and encoded Chinese executes unchanged", async () => {
    const han = scratchWindows(), oneil = scratchWindows();
    try {
      writeTail(han, "Ubuntu-22.04", "han");
      writeTail(oneil, "Ubuntu-22.04", "o'neil");
      const b64 = encodePowershell("Write-Output '重新啟動 OK'");
      const out = await pwshFile(`
$null = Invoke-Tail $env:HAN_ROOT (Join-Path $env:HAN_ROOT 'tail.ps1')
$null = Invoke-Tail $env:ONEIL_ROOT (Join-Path $env:ONEIL_ROOT 'tail.ps1')
$t = $null; $e = $null
foreach ($pair in @(
  @($env:HAN_LOCAL, 'restart-agend.ps1', 'Invoke-RestartAgend', 'han'),
  @($env:HAN_LOCAL, 'open-dashboard.ps1', 'Invoke-OpenDashboard', 'han'),
  @($env:ONEIL_LOCAL, 'restart-agend.ps1', 'Invoke-RestartAgend', "o'neil"),
  @($env:ONEIL_LOCAL, 'open-dashboard.ps1', 'Invoke-OpenDashboard', "o'neil")
)) {
  $path = Join-Path $pair[0] (Join-Path 'AgEnD' $pair[1])
  $text = Get-Content -Raw -LiteralPath $path
  $line = ($text -split [char]10 | ForEach-Object { $_.Trim([char]13) } | Where-Object { $_ -match [regex]::Escape($pair[2]) } | Select-Object -Last 1)
  $a = [System.Management.Automation.Language.Parser]::ParseInput($line, [ref]$t, [ref]$e)
  $c = @($a.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq $pair[2] }, $true))[-1]
  Write-Output ("CASE=parse FILE=" + $pair[1] + " USER=" + $pair[3] + " ERRORS=" + $e.Count + " ASTUSER=" + $c.CommandElements[2].Value)
}
$bytes = [Convert]::FromBase64String('${b64}')
$decoded = [Text.Encoding]::Unicode.GetString($bytes)
Write-Output ("CASE=encoded " + (Invoke-Expression $decoded))
`, { HAN_ROOT: han.dir, HAN_LOCAL: han.local, ONEIL_ROOT: oneil.dir, ONEIL_LOCAL: oneil.local });
      for (const user of ["han", "o'neil"]) for (const file of ["restart-agend.ps1", "open-dashboard.ps1"]) {
        expect(out.split("\n")).toContain(`CASE=parse FILE=${file} USER=${user} ERRORS=0 ASTUSER=${user}`);
      }
      expect(out).toMatch(/^CASE=encoded 重新啟動 OK$/m);
    } finally { for (const w of [han, oneil]) rmSync(w.dir, { recursive: true, force: true }); }
  });

});
