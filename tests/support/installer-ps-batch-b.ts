/**
 * Batch runner for the Windows installer tests (#2650 / #2710 / #1853 family). Test-only.
 * One pwsh process per file: the installer's functions are sliced in Node (installer-ps-extract.ts), each case runs in
 * its own child scope (its stubs vanish when it ends), and its output is captured with `*>&1`. The results come back as
 * one JSON document between markers. Test code never ParseFile's the installer.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractInstallerPrelude } from "./installer-ps-extract.js";

export interface PsCase {
  name: string;
  /** PowerShell statements; they may define stubs, which stay local to this case. */
  body: string;
}
export interface CaseOutcome {
  Out: string | null;
  Error: string | null;
}
export type BatchResults = Record<string, CaseOutcome>;

/** A PowerShell single-quoted literal. */
export function psq(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const RUNNER = `$script:AgendBatch = [ordered]@{}
function Invoke-BatchCase([string]$Name, [scriptblock]$Body) {
  $text = $null; $err = $null
  try { $text = (& $Body *>&1 | Out-String) } catch { $err = [string]$_ }
  $script:AgendBatch[$Name] = @{ Out = $text; Error = $err }
}
function Write-BatchResults {
  Write-Output '<<<AGEND-BATCH'
  Write-Output ($script:AgendBatch | ConvertTo-Json -Depth 4 -Compress)
  Write-Output 'AGEND-BATCH>>>'
}`;

/**
 * The batch script: the sliced installer prelude, a no-op Start-Sleep (no wall-clock waits), the runner, the file's own
 * `header`, one Invoke-BatchCase per case, and the JSON footer.
 */
export function buildBatch(installer: string, header: string, cases: readonly PsCase[]): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    extractInstallerPrelude(installer),
    "function Start-Sleep {}",
    RUNNER,
    header,
    ...cases.map(c => `Invoke-BatchCase ${psq(c.name)} {\n${c.body}\n}`),
    "Write-BatchResults",
  ].join("\n");
}

/** Writes the script into `dir`, runs one pwsh with `env`, and parses the per-case results. */
export function runBatch(dir: string, script: string, env: Record<string, string>, timeout: number): BatchResults {
  const file = join(dir, "batch.ps1");
  writeFileSync(file, script);
  const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", file], {
    encoding: "utf8",
    timeout,
    env: { ...process.env, ...env },
  });
  if (r.error || r.signal || r.status !== 0) {
    throw new Error(`pwsh batch ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  }
  const m = /<<<AGEND-BATCH\n([\s\S]*?)\nAGEND-BATCH>>>/.exec(r.stdout);
  if (!m) throw new Error(`pwsh batch printed no results:\n${r.stdout}${r.stderr}`);
  return JSON.parse(m[1]!) as BatchResults;
}

/** The captured output of one case; a case that threw fails the caller with its message and output. */
export function caseOut(results: BatchResults, name: string): string {
  const c = results[name];
  if (!c) throw new Error(`batch case ${name} did not run`);
  if (c.Error !== null) throw new Error(`batch case ${name} threw: ${c.Error}\n${c.Out ?? ""}`);
  return c.Out ?? "";
}
