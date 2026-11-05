/**
 * Batch C of the Windows installer tests (after #3110 and #3117): one pwsh per batch, the installer sliced in Node
 * (installer-ps-extract.ts, not changed here), results read back as one JSON line. A batch is a generated script:
 * each case prints nothing itself, it appends a row to a list, and the script ends by printing the rows after BATCH_MARK.
 */
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const BATCH_MARK = "BATCH-RESULTS=";

/** A PowerShell single-quoted literal. */
export function psq(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Writes `script` to `<dir>/batch.ps1`, runs it in one pwsh (-File), resolves with the rows it printed after BATCH_MARK. */
export function runPwshBatch<T>(dir: string, script: string, env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<T> {
  const file = join(dir, "batch.ps1");
  writeFileSync(file, script);
  return new Promise((resolve, reject) => {
    execFile("pwsh", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], { encoding: "utf8", timeout: timeoutMs, env }, (err, stdout, stderr) => {
      const line = stdout.split("\n").find(l => l.startsWith(BATCH_MARK));
      if (err || !line) {
        reject(new Error(`pwsh batch ended ${err?.message ?? "without results"}:\n${stdout}${stderr}`));
        return;
      }
      resolve(JSON.parse(line.slice(BATCH_MARK.length)) as T);
    });
  });
}
