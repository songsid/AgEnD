import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(empty = false, locale = "en") {
  const dir = mkdtempSync(join(tmpdir(), "agend-cli-resources-")); roots.push(dir);
  const bin = join(dir, "bin"); mkdirSync(bin);
  const script = (name: string, body: string) => {
    const path = join(bin, name); writeFileSync(path, `#!${process.execPath}\n${body}`); chmodSync(path, 0o755);
  };
  // No real tmux process, socket or fleet lifecycle handler is driven by this harness.
  script("tmux", `require('node:fs').appendFileSync(${JSON.stringify(join(dir, "tmux-calls"))}, JSON.stringify(process.argv.slice(2))+'\\n'); process.exit(1);`);
  script("du", `require('node:fs').appendFileSync(${JSON.stringify(join(dir, "du-calls"))}, JSON.stringify(process.argv.slice(2))+'\\n'); console.log('16\\t'+process.argv.at(-1));`);
  for (const name of ["agend", "systemctl", "launchctl"]) script(name, "throw new Error('Unexpected lifecycle/service command');");
  writeFileSync(join(dir, "fleet.yaml"), yaml.dump({ health_port: 0, defaults: { backend: "mock", locale }, instances: empty ? {} : { worker: {} } }));
  for (const name of ["worker", "retired"]) mkdirSync(join(dir, "instances", name), { recursive: true });
  mkdirSync(join(dir, "workspaces", "worker"), { recursive: true });
  return dir;
}
function run(dir: string, args: string[]) {
  const child = spawnSync(process.execPath, ["--require", join(process.cwd(), "tests/helpers/health-process-stub.cjs"), "--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(), encoding: "utf8", timeout: 8000,
    env: { ...process.env, AGEND_HOME: dir, HOME: dir, NOTIFY_SOCKET: "", PATH: `${join(dir, "bin")}:${process.env.PATH}` },
  });
  expect(child.status, child.stderr).toBe(0); return child.stdout;
}
describe("CLI resource wiring", () => {
  it("fleet status adds the resource report after real row composition", () => {
    const dir = fixture(); const before = readFileSync(join(dir, "fleet.yaml"), "utf8");
    const text = run(dir, ["fleet", "status"]);
    expect(text).toContain("worker"); expect(text).toContain("Storage and host resources");
    expect(text).toContain("Host RAM"); expect(text).toContain("Host swap");
    expect(text).toContain(join(dir, "workspaces", "worker")); expect(text).toContain("16.0 KiB");
    expect(text).toContain("1 not listed in fleet.yaml or classicBot.yaml");
    expect(readFileSync(join(dir, "fleet.yaml"), "utf8")).toBe(before);
    expect(existsSync(join(dir, "fleet.pid"))).toBe(false); expect(existsSync(join(dir, "workspaces", "worker", ".git"))).toBe(false);
  });
  it("ordinary ls remains fast, while ls --resources explicitly requests scanning", () => {
    const dir = fixture();
    expect(run(dir, ["ls"])).not.toContain("Storage and host resources");
    expect(existsSync(join(dir, "du-calls"))).toBe(false);
    expect(run(dir, ["ls", "--resources"])).toContain("Storage and host resources");
    expect(existsSync(join(dir, "du-calls"))).toBe(true);
  });
  it("preserves the status JSON row array and never scans for shell completion", () => {
    const dir = fixture(); const rows = JSON.parse(run(dir, ["fleet", "status", "--json"]));
    expect(Array.isArray(rows)).toBe(true); expect(rows).toHaveLength(1); expect(rows[0].name).toBe("worker");
    expect(existsSync(join(dir, "du-calls"))).toBe(false);
    const completionDir = fixture();
    expect(run(completionDir, ["ls", "--names-only", "--resources"])).toBe("worker\n");
    expect(existsSync(join(completionDir, "du-calls"))).toBe(false);
    expect(existsSync(join(completionDir, "tmux-calls"))).toBe(false);
  });
  it("reports retained directories even with an empty roster, and honors zh-TW", () => {
    const dir = fixture(true, "zh-TW");
    const text = run(dir, ["fleet", "status"]);
    expect(text).toContain("磁碟與主機資源"); expect(text).toContain("有 2 個未列於 fleet.yaml 或 classicBot.yaml");
    expect(text).toContain(join(dir, "instances", "retired"));
    expect(existsSync(join(dir, "tmux-calls"))).toBe(false);
  });
});
