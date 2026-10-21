/**
 * #2359: hidden aliases, removed leftovers, and help that no longer advertises them.
 * Spawns src/cli.ts like tests/cli-resources-1119.test.ts. No live fleet, tmux, or service.
 */
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agend-cli-cleanup-")); roots.push(dir);
  const bin = join(dir, "bin"); mkdirSync(bin);
  const script = (name: string, body: string) => {
    const path = join(bin, name); writeFileSync(path, `#!${process.execPath}\n${body}`); chmodSync(path, 0o755);
  };
  script("tmux", `require('node:fs').appendFileSync(${JSON.stringify(join(dir, "tmux-calls"))}, JSON.stringify(process.argv.slice(2))+'\\n'); process.exit(1);`);
  script("du", `require('node:fs').appendFileSync(${JSON.stringify(join(dir, "du-calls"))}, JSON.stringify(process.argv.slice(2))+'\\n'); console.log('16\\t'+process.argv.at(-1));`);
  for (const name of ["agend", "systemctl", "launchctl"]) script(name, "throw new Error('Unexpected lifecycle/service command');");
  writeFileSync(join(dir, "fleet.yaml"), yaml.dump({ health_port: 0, defaults: { backend: "mock", locale: "en" }, instances: { worker: {} } }));
  mkdirSync(join(dir, "instances", "worker"), { recursive: true });
  mkdirSync(join(dir, "workspaces", "worker"), { recursive: true });
  return dir;
}

function spawnCli(dir: string, args: string[]) {
  return spawnSync(process.execPath, ["--require", join(process.cwd(), "tests/helpers/health-process-stub.cjs"), "--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, AGEND_HOME: dir, HOME: dir, NOTIFY_SOCKET: "", PATH: `${join(dir, "bin")}:${process.env.PATH}` },
  });
}

function run(dir: string, args: string[]) {
  const child = spawnCli(dir, args);
  expect(child.status, child.stderr).toBe(0);
  return child.stdout;
}

describe("#2359 hidden aliases", () => {
  it("status matches ls, and is hidden from top-level help", () => {
    const dir = fixture();
    expect(run(dir, ["status", "--names-only"])).toBe(run(dir, ["ls", "--names-only"]));
    const help = run(dir, ["--help"]);
    expect(help).not.toMatch(/^\s+status\b/m);
    expect(help).toMatch(/^\s+ls\b/m);
  }, 30_000);

  it("fleet status still matches ls --resources, and is hidden from fleet help", () => {
    const dir = fixture();
    const viaAlias = run(dir, ["fleet", "status"]);
    const viaLs = run(dir, ["ls", "--resources"]);
    expect(viaAlias).toContain("Storage and host resources");
    expect(viaLs).toContain("Storage and host resources");
    expect(viaAlias).toContain("worker");
    expect(viaLs).toContain("worker");
    expect(run(dir, ["fleet", "status", "--json"])).toBe(run(dir, ["ls", "--json"]));
    const help = run(dir, ["fleet", "--help"]);
    expect(help).not.toMatch(/^\s+status\b/m);
    expect(help).not.toMatch(/^\s+logs\b/m);
  }, 60_000);
});

describe("#2359 removed leftovers", () => {
  it("schedule trigger, fleet logs, and backend trust print a one-line pointer", () => {
    const dir = fixture();
    const trigger = spawnCli(dir, ["schedule", "trigger", "abc"]);
    expect(trigger.status).not.toBe(0);
    expect(`${trigger.stderr}${trigger.stdout}`).toContain("`agend schedule trigger` was removed");
    expect(run(dir, ["schedule", "--help"])).not.toMatch(/^\s+trigger\b/m);

    const logs = spawnCli(dir, ["fleet", "logs"]);
    expect(logs.status).not.toBe(0);
    expect(`${logs.stderr}${logs.stdout}`).toContain("`agend fleet logs` was removed. Use `agend logs`.");

    const trust = spawnCli(dir, ["backend", "trust"]);
    expect(trust.status).not.toBe(0);
    expect(`${trust.stderr}${trust.stdout}`).toContain("`agend backend trust` was removed");
  }, 40_000);

  it("install --activate is hidden from help; logs is no longer an alias of fleet logs", () => {
    const dir = fixture();
    const installHelp = run(dir, ["install", "--help"]);
    expect(installHelp).not.toMatch(/--activate/);
    expect(installHelp).toMatch(/--no-activate/);
    const logsHelp = run(dir, ["logs", "--help"]);
    expect(logsHelp).not.toMatch(/alias for `agend fleet logs`/i);
    expect(logsHelp).toMatch(/daemon\.log/);
    const src = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
    expect(src).toContain("`agend install --activate` was removed; service activation is the default.");
  }, 30_000);
});
