import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { InstallerPsBatch, hasPwsh, INERT_PWSH_CHILD } from "./support/installer-ps-batch.js";
import { extractPsAssignments, extractPsFunctions } from "./support/installer-ps-extract.js";
import { preparePowerShell } from "../scripts/ci/prepare-pwsh.mjs";

const batch = new InstallerPsBatch({ helpers: "function End-Case { try { exit 3 } finally { Write-Output 'FINALLY' } }" });
const otherBatch = new InstallerPsBatch({ helpers: "function F { 'ok' }" });
const dir = mkdtempSync(join(tmpdir(), "agend-batch-control-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("slices indented bootstrap functions and explicit constants without executing top-level work", () => {
  const source = "Run-Installer\n  function F { return 'yes' }\n$VERSION = [version]'2.4.4'\n$MAP = @{ A = 'B' }\n";
  expect(extractPsFunctions(source)).toBe("function F { return 'yes' }");
  expect(extractPsAssignments(source, ["VERSION", "MAP"])).toBe("$VERSION = [version]'2.4.4'\n$MAP = @{ A = 'B' }");
  expect(() => extractPsAssignments(source, ["MISSING"])).toThrow("missing");
});

describe.skipIf(!hasPwsh)("batch isolation", () => {
  it("reuses one worker, isolates functions/env/input, and unwinds a production exit through finally", async () => {
    const first = await batch.run("helpers", "function Case-Only { 'leaked' }; Read-Host; Write-Output ('PID='+$PID); End-Case; 'UNREACHED'", {
      input: "answer\n", env: { AGEND_BATCH_CASE_ONLY: "yes" }, status: 3,
    });
    expect(first).toContain("answer\n"); expect(first).toContain("FINALLY\n"); expect(first).not.toContain("UNREACHED");
    const second = await batch.run("helpers", "Write-Output ('PID='+$PID); if(Get-Command Case-Only -ErrorAction SilentlyContinue){throw 'function leaked'}; if($env:AGEND_BATCH_CASE_ONLY){throw 'environment leaked'}; Write-Output ('EMPTY=['+(Read-Host)+']')");
    expect(second).toContain(first.match(/PID=\d+/)![0]); expect(second).toContain("EMPTY=[]");
  });
  it("gives independent workers private startup/module caches and restores them after a case", async () => {
    const probe = `Write-Output ('CACHE='+$env:XDG_CACHE_HOME); Write-Output ('MODULE='+$env:PSModuleAnalysisCachePath)`;
    const first = await batch.run("helpers", probe);
    const other = await otherBatch.run("helpers", probe);
    const paths = (out: string) => ({ cache: out.match(/^CACHE=(.+)$/m)![1]!.trim(), module: out.match(/^MODULE=(.+)$/m)![1]!.trim() });
    const a = paths(first), b = paths(other);
    expect(isAbsolute(a.cache) && isAbsolute(a.module)).toBe(true);
    expect(dirname(a.cache)).toBe(dirname(a.module));
    expect(dirname(a.cache)).toMatch(/agend-ps-batch-/);
    expect(b.cache).not.toBe(a.cache); expect(b.module).not.toBe(a.module);
    await batch.run("helpers", probe, { env: { XDG_CACHE_HOME: "case-cache", PSModuleAnalysisCachePath: "case-module" } });
    expect(paths(await batch.run("helpers", probe))).toEqual(a);
  });
  it("keeps raw console output separate from responses and executes only the inert child with named arguments", async () => {
    const file = join(dir, "child.ps1");
    writeFileSync(file, "param([string]$InstallVersion,[switch]$Force); Write-Output (\"VERSION=$InstallVersion FORCE=$Force\"); exit 7");
    const out = await batch.run("helpers", `${INERT_PWSH_CHILD}\n[Console]::Write('RAW-CONS'); pwsh -NoProfile -File '${file}' -InstallVersion beta -Force; Write-Output ('CODE='+$LASTEXITCODE)`);
    expect(out).toContain("RAW-CONS"); expect(out).toContain("VERSION=beta FORCE=True"); expect(out).toContain("CODE=7");
  });
});

describe.skipIf(!hasPwsh)("real PowerShell preparation", () => {
  it.each([false, true])("compiler failure=%s propagates before complete, with a healthy control", invalid => {
    const cache = mkdtempSync(join(dir, "preparation-"));
    const lines: string[] = [];
    const results: Array<{ status: number | null; stderr: string }> = [];
    const prepare = () => preparePowerShell({
      run: (file, args, options) => {
        const command = args.at(-1)!;
        const result = spawnSync(file, [...args.slice(0, -1), invalid ? command.replace("return 1;", "return;") : command], {
          ...options, stdio: "pipe", encoding: "utf8",
          env: { ...process.env, XDG_CACHE_HOME: join(cache, "cache"), PSModuleAnalysisCachePath: join(cache, "module-analysis") },
        });
        results.push({ status: result.status, stderr: result.stderr });
        return result;
      },
      log: line => lines.push(line),
    });
    if (invalid) {
      expect(prepare).toThrow("PowerShell preparation compile failed");
      expect(results.at(-1)!.status).toBe(1);
      expect(results.at(-1)!.stderr).toContain("CS0126");
    } else {
      expect(prepare).not.toThrow();
      expect(results.every(result => result.status === 0 && result.stderr === "")).toBe(true);
    }
    expect(results).toHaveLength(3);
    expect(lines.some(line => line.includes('"phase":"complete"'))).toBe(!invalid);
  });
});
