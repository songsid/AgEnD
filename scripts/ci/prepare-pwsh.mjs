#!/usr/bin/env node
/** CI preparation only: make cold runtime work visible before the existing test timers. */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** @param {{run?: (file: string, args: string[], options: {stdio: 'inherit', timeout: number, killSignal: 'SIGKILL'}) => {status: number|null, signal?: string|null, error?: unknown}, now?: () => number, log?: (line: string) => void}} options */
export function preparePowerShell({ run = spawnSync, now = () => performance.now(), log = console.log } = {}) {
  const started = now();
  const version = "[Console]::WriteLine($PSVersionTable.PSVersion.ToString())";
  const compile = "Add-Type -TypeDefinition 'public static class AgendWarm { public static int Ready() { return 1; } }'; [Console]::WriteLine([AgendWarm]::Ready()); [Console]::WriteLine([scriptblock]::Create('1 + 1').Invoke())";
  for (const [phase, command] of [["version-1", version], ["version-2", version], ["compile", compile]]) {
    const at = now();
    const result = run("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { stdio: "inherit", timeout: 30_000, killSignal: "SIGKILL" });
    log(`[pwsh-preparation] ${JSON.stringify({ phase, elapsedMs: Math.round(now() - at), status: result.status, signal: result.signal ?? null, error: Boolean(result.error) })}`);
    if (result.error || result.status !== 0 || result.signal) throw Error(`PowerShell preparation ${phase} failed`);
  }
  log(`[pwsh-preparation] ${JSON.stringify({ phase: "complete", elapsedMs: Math.round(now() - started) })}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { preparePowerShell(); }
  catch (error) { console.error(error instanceof Error ? error.message : "PowerShell preparation failed"); process.exitCode = 1; }
}
