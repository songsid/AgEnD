import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function root() {
  const dir = mkdtempSync(join(tmpdir(), "agend-cli-logs-")); dirs.push(dir); return dir;
}
const args = ["--import", "tsx", "src/cli.ts", "logs"];
function run(dir: string, options: string[] = []) {
  return spawnSync(process.execPath, [...args, ...options], {
    cwd: process.cwd(), env: { ...process.env, AGEND_HOME: dir }, encoding: "utf8", timeout: 8_000,
  });
}

describe("agend logs", () => {
  it("reads daemon.log when both files exist, preserving line limits, instance filtering and ANSI stripping", () => {
    const dir = root();
    writeFileSync(join(dir, "fleet.log"), "old-service-stdout\nbootstrap-error\n");
    writeFileSync(join(dir, "daemon.log"), "worker-one old\nworker-two other\n\u001b[32mworker-one new\u001b[0m\n");
    const child = run(dir, ["--instance", "worker-one", "-n", "1"]);
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe("worker-one new\n");
  });

  it("falls back to service diagnostics when the runtime log does not exist yet", () => {
    const dir = root();
    writeFileSync(join(dir, "fleet.log"), "bootstrap-error\n");
    const child = run(dir);
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe("bootstrap-error\n");
  });

  it("keeps the missing-log error", () => {
    const child = run(root());
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("No fleet log found");
  });

  it("follows new runtime entries without displaying the bootstrap log", async () => {
    const dir = root();
    const runtime = join(dir, "daemon.log");
    writeFileSync(runtime, "worker-one first\n");
    writeFileSync(join(dir, "fleet.log"), "bootstrap-error\n");
    const child = spawn(process.execPath, [...args, "-f", "--instance", "worker-one"], {
      cwd: process.cwd(), env: { ...process.env, AGEND_HOME: dir }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = ""; let stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    const exited = once(child, "exit");
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`log follow did not see runtime entries: ${output}; ${stderr}`)), 7_000);
        child.once("error", reject);
        child.once("exit", () => { clearTimeout(timer); reject(new Error(`CLI exited early: ${stderr}`)); });
        let appended = false;
        child.stdout.on("data", chunk => {
          output += chunk;
          if (!appended && output.includes("worker-one first")) {
            appended = true;
            appendFileSync(runtime, "worker-two hidden\nworker-one second\n");
          }
          if (output.includes("worker-one second")) { clearTimeout(timer); resolve(); }
        });
      });
      expect(output).toContain("worker-one first");
      expect(output).toContain("worker-one second");
      expect(output).not.toContain("worker-two");
      expect(output).not.toContain("bootstrap-error");
    } finally { child.kill("SIGINT"); await exited; }
  });
});
