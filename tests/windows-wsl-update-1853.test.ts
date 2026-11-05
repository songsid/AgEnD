/**
 * #1853 follow-up (the user's real run on a shared office IP, 2026-10-20): `wsl --update` hit GitHub's rate limit, and
 * the install stopped. GitHub gives unauthenticated requests 60 an hour per IP (403/429 beyond), so many people behind
 * one address exhaust it; `wsl --update` itself uses the Microsoft Store unless `--web-download` asks for GitHub
 * (learn.microsoft.com/windows/wsl/basic-commands). The installer now:
 * - reads the installed WSL's version from %ProgramFiles%\WSL\wsl.exe's file version (never running it) and skips the
 *   update at 2.0.0 or later ("WSL 2.x.y 已安裝，略過更新");
 * - still updates an older or inbox WSL: the Store first, GitHub only as the fallback;
 * - goes on with a warning when an update fails but a usable WSL (2.0.0+) is there;
 * - says in plain zh-TW what happened when GitHub refused (rate limit) or the network failed, and what to try.
 * The stage is the installer's own Invoke-WslUpdateStage, run in one pwsh batch with its steps stubbed. Real WSL, Store
 * and GitHub are the user's Windows checklist.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBatch, caseOut, psq, runBatch, type BatchResults, type PsCase } from "./support/installer-ps-batch-b.js";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const text = readFileSync(INSTALLER, "utf8");
const code = text.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");

describe("the WSL update stage (static)", () => {
  it("stage 1 runs Invoke-WslUpdateStage and acts only on reboot and failure; the Store is asked before GitHub", () => {
    expect(code).toMatch(/switch \(Invoke-WslUpdateStage\) \{\n\s+'reboot' \{ Request-Reboot [^\n]+\}\n\s+'verify-reboot' \{ Mark-Stage "1b"; Request-Reboot [^\n]+\}\n\s+'failed' \{ Set-InstallFailure 'download'; Read-Host "按 Enter 結束"; exit 1 \}\n\s+\}/);
    const fn = code.slice(code.indexOf("function Invoke-WslUpdateStage"));
    expect(fn.indexOf('-Arguments @("--update")')).toBeLessThan(fn.indexOf('-Arguments @("--update", "--web-download")'));
    expect(code).not.toMatch(/Get-InstalledWslVersion[^\n]*wsl(\.exe)? --version/);   // the version is read from the file
  });
});

const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;

/**
 * One Invoke-WslUpdateStage run. `versions`: what the installed wsl.exe's file version reads, in turn (null: no
 * Store/MSI WSL at all). `codes`: the exit codes of the watched wsl --update calls, in turn; `lines`: what the GitHub
 * one prints. `rest`: "ok" or an error message Invoke-RestMethod throws.
 */
interface StageOpts {
  versions: (string | null)[];
  codes?: number[];
  lines?: string[];
  rest?: string;
  msi?: number;
  verify?: number;
}

const STAGES: [string, StageOpts][] = [
  ["skip-2.6.1", { versions: ["2.6.1.0"] }],
  ["old-1.2.5", { versions: ["1.2.5.0"], codes: [0] }],
  ["none-store-ok", { versions: [null], codes: [0] }],
  ["store-fails-web-ok", { versions: [null], codes: [1, 0] }],
  ["usable", { versions: ["1.2.5.0", "2.3.26.0"], codes: [1, 1] }],
  ["rate-limit-wsl", { versions: [null], codes: [1, 1], lines: ["Error: API rate limit exceeded for 118.0.0.1. (403)"] }],
  ["msi-rate-limited", { versions: [null], codes: [1, 1], rest: "The remote server returned an error: (403) Forbidden. API rate limit exceeded" }],
  ["msi-timeout", { versions: [null], codes: [1, 1], rest: "The operation has timed out." }],
  ["msi-ok", { versions: [null], codes: [1, 1] }],
  ["msi-reboot", { versions: [null], codes: [1, 1], msi: 3010 }],
  ["msi-verify", { versions: [null], codes: [1, 1], verify: 1 }],
  ["version-1.9.9", { versions: ["1.9.9.0"], codes: [0] }],
  ["version-garbage", { versions: ["garbage"], codes: [0] }],
  ["version-2.0.0", { versions: ["2.0.0.0"] }],
];

function stageCase(batch: string, name: string, o: StageOpts): PsCase {
  const ps = (v: string | null) => (v === null ? "$null" : psq(v));
  const rest = o.rest && o.rest !== "ok"
    ? `throw ${psq(o.rest)}`
    : `return [PSCustomObject]@{ tag_name = '2.6.1'; assets = @([PSCustomObject]@{ name = 'wsl.2.6.1.0.x64.msi'; browser_download_url = 'https://example.invalid/wsl.msi' }) }`;
  return {
    name,
    body: `$env:ProgramFiles = ${psq(join(batch, name, "pf"))}; $env:TEMP = ${psq(join(batch, name))}
$script:versions = [System.Collections.ArrayList]@(${o.versions.map(ps).join(",")})
$script:codes = [System.Collections.ArrayList]@(${(o.codes ?? []).join(",")})
$script:log = @()
function Get-FileVersionString([string]$path) { $v = $script:versions[0]; if ($script:versions.Count -gt 1) { $script:versions.RemoveAt(0) }; return $v }
function Invoke-Watched { param($Label, $Usually, $File, [string[]]$Arguments, $UpperMinutes, $Encoding, $OnLine)
  $script:log += ($File + ' ' + ($Arguments -join ' '))
  if ($File -eq 'msiexec.exe') { return ${o.msi ?? 0} }
  if ($OnLine) { foreach ($l in @(${(o.lines ?? []).map(l => psq(l)).join(",")})) { & $OnLine $l } }
  $c = $script:codes[0]; $script:codes.RemoveAt(0); return $c }
function Invoke-RestMethod { $script:log += 'github-api'; ${rest} }
function Invoke-InstallDownload { $script:log += 'download' }
function Invoke-BoundedWsl { return @{Code=${o.verify ?? 0};Text=''} }
$r = Invoke-WslUpdateStage
Write-Output ("RESULT=" + $r + " LOG=" + ($script:log -join ' | '))`,
  };
}

describe.skipIf(!pwsh)("with pwsh: the WSL update stage", { timeout: 90_000 }, () => {
  let batch = "";
  let results: BatchResults = {};
  beforeAll(() => {
    batch = mkdtempSync(join(tmpdir(), "agend-1853upd-"));
    const cases: PsCase[] = [];
    for (const [name, o] of STAGES) {
      const dir = join(batch, name);
      mkdirSync(dir);
      // A Store/MSI WSL is present when any version is read: its wsl.exe sits under %ProgramFiles%\WSL.
      if (o.versions.some(v => v !== null)) {
        mkdirSync(join(dir, "pf", "WSL"), { recursive: true });
        writeFileSync(join(dir, "pf", "WSL", "wsl.exe"), "");
      }
      cases.push(stageCase(batch, name, o));
    }
    results = runBatch(batch, buildBatch(text, "", cases), { TMPDIR: batch }, 60_000);
  });
  afterAll(() => { if (batch) rmSync(batch, { recursive: true, force: true }); });

  it("WSL 2 or later installed: no update at all, one line", () => {
    const out = caseOut(results, "skip-2.6.1");
    expect(out).toContain("WSL 2.6.1.0 已安裝，略過更新");
    expect(out).toContain("RESULT=skipped LOG=\n");
  });
  it("an older WSL (1.2.5) or none at all: updated, from the Store first", () => {
    expect(caseOut(results, "old-1.2.5")).toContain("RESULT=updated LOG=wsl.exe --update\n");
    expect(caseOut(results, "none-store-ok")).toContain("RESULT=updated LOG=wsl.exe --update\n");
  });
  it("the Store fails: GitHub as the fallback; that works: updated", () => {
    expect(caseOut(results, "store-fails-web-ok")).toContain("RESULT=updated LOG=wsl.exe --update | wsl.exe --update --web-download\n");
  });
  it("both fail, but a usable WSL is there now: a warning and on — no GitHub API call", () => {
    const out = caseOut(results, "usable");
    expect(out).toContain("WSL 更新沒有完成，但這台電腦已經有可以用的 WSL 2.3.26.0，繼續安裝。");
    expect(out).toContain("RESULT=usable LOG=wsl.exe --update | wsl.exe --update --web-download\n");
  });
  it("GitHub said rate limit (wsl's own output): the plain reason, and no API call that would only be refused again", () => {
    const out = caseOut(results, "rate-limit-wsl");
    expect(out).toContain("GitHub 暫時限制了這個網路的下載次數");
    expect(out).toContain("請過一小時左右再執行同一行安裝指令，或換一個網路（例如手機熱點）再試。");
    expect(out).toContain("RESULT=failed LOG=wsl.exe --update | wsl.exe --update --web-download\n");
  });
  it("the MSI fallback refused by GitHub (403) or timing out: the matching plain reason, and failed", () => {
    const limited = caseOut(results, "msi-rate-limited");
    expect(limited).toContain("GitHub 暫時限制了這個網路的下載次數");
    expect(limited).toContain("RESULT=failed LOG=wsl.exe --update | wsl.exe --update --web-download | github-api\n");
    const slow = caseOut(results, "msi-timeout");
    expect(slow).toContain("連不上 GitHub（逾時、連線失敗，或被防火牆擋住）。");
    expect(slow).toContain("RESULT=failed");
  });
  it("the MSI fallback works: installed (or asks for a reboot on 3010)", () => {
    expect(caseOut(results, "msi-ok")).toContain("RESULT=updated LOG=wsl.exe --update | wsl.exe --update --web-download | github-api | download | msiexec.exe /i ");
    expect(caseOut(results, "msi-reboot")).toContain("RESULT=reboot");
    expect(caseOut(results, "msi-verify")).toContain("RESULT=verify-reboot");
  });
  it("the version read: a file version below 2, odd text or none is not 'current'", () => {
    expect(caseOut(results, "version-1.9.9")).toContain("RESULT=updated");
    expect(caseOut(results, "version-garbage")).toContain("RESULT=updated");
    expect(caseOut(results, "version-2.0.0")).toContain("RESULT=skipped");
  });
});
