import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Tests for the health command's paused instance classification.
 *
 * Bug: paused instances were misclassified as having "Tmux window missing" issues
 * because the health command only checked for crashed/stopped before the tmux check.
 *
 * Fix: paused instances should:
 * 1. Be classified as "paused" status (not "no-ipc" or "degraded")
 * 2. Have no issues (empty issues array)
 * 3. Not contribute to fleet "degraded" status
 * 4. Not trigger "Tmux window missing" warning
 */

const cliPath = resolve("src/cli.ts");
const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTestEnv() {
  const root = join(tmpdir(), `agend-health-${process.pid}-${Date.now()}`);
  created.push(root);
  const agendHome = join(root, "agend");
  mkdirSync(agendHome, { recursive: true });
  return { root, agendHome };
}

function runHealth(agendHome: string, args: string[] = []) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, "health", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      AGEND_HOME: agendHome,
      HOME: agendHome,
      // Ensure no tmux session interferes
      TMUX: "",
    },
  });
}

function setupInstance(agendHome: string, name: string, status: "paused" | "stopped" | "crashed") {
  const instDir = join(agendHome, "instances", name);
  mkdirSync(instDir, { recursive: true });
  if (status === "paused") {
    writeFileSync(join(instDir, "paused"), "");
  } else if (status === "crashed") {
    // Stale pid file pointing to non-existent process
    writeFileSync(join(instDir, "daemon.pid"), "999999999");
  }
  // stopped: no files needed, just the directory
}

function setupFleetConfig(agendHome: string, instances: Record<string, { general_topic?: boolean }>) {
  const config = {
    defaults: { backend: "claude-code" },
    instances,
  };
  writeFileSync(join(agendHome, "fleet.yaml"), JSON.stringify(config));
}

describe("agend health CLI paused classification", () => {
  it("classifies paused instance with status=paused and no issues", () => {
    const { agendHome } = makeTestEnv();
    setupFleetConfig(agendHome, { "test-paused": {} });
    setupInstance(agendHome, "test-paused", "paused");

    const result = runHealth(agendHome, ["--json"]);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.fleet.classification).toBe("healthy");
    const inst = output.instances.find((i: any) => i.name === "test-paused");
    expect(inst).toBeDefined();
    expect(inst.status).toBe("paused");
    expect(inst.issues).toEqual([]);
  });

  it("does not report 'Tmux window missing' for paused instances", () => {
    const { agendHome } = makeTestEnv();
    setupFleetConfig(agendHome, { "paused-no-tmux": {} });
    setupInstance(agendHome, "paused-no-tmux", "paused");

    const result = runHealth(agendHome);

    // Full output should not contain "Tmux window missing" for paused
    expect(result.stdout).not.toContain("Tmux window missing");
    expect(result.status).toBe(0);
  });

  it("paused general instance does not make fleet unhealthy", () => {
    const { agendHome } = makeTestEnv();
    setupFleetConfig(agendHome, { "general-paused": { general_topic: true } });
    setupInstance(agendHome, "general-paused", "paused");

    const result = runHealth(agendHome, ["--json"]);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.fleet.classification).toBe("healthy");
  });

  it("stopped instance classified as stopped (not paused)", () => {
    const { agendHome } = makeTestEnv();
    setupFleetConfig(agendHome, { "test-stopped": {} });
    setupInstance(agendHome, "test-stopped", "stopped");

    const result = runHealth(agendHome, ["--json"]);

    const output = JSON.parse(result.stdout);
    const inst = output.instances.find((i: any) => i.name === "test-stopped");
    expect(inst.status).toBe("stopped");
    expect(inst.issues).toContain("Not running");
    // stopped doesn't degrade fleet
    expect(output.fleet.classification).toBe("healthy");
  });

  it("crashed instance classified as crash and makes fleet unhealthy", () => {
    const { agendHome } = makeTestEnv();
    setupFleetConfig(agendHome, { "test-crashed": {} });
    setupInstance(agendHome, "test-crashed", "crashed");

    const result = runHealth(agendHome, ["--json"]);

    expect(result.status).not.toBe(0);
    const output = JSON.parse(result.stdout);
    const inst = output.instances.find((i: any) => i.name === "test-crashed");
    expect(inst.status).toBe("crash");
    expect(inst.issues.some((i: string) => i.includes("dead"))).toBe(true);
    expect(output.fleet.classification).toBe("unhealthy");
  });

  it("quiet output includes paused count", () => {
    const { agendHome } = makeTestEnv();
    setupFleetConfig(agendHome, {
      "inst-paused": {},
      "inst-stopped": {},
    });
    setupInstance(agendHome, "inst-paused", "paused");
    setupInstance(agendHome, "inst-stopped", "stopped");

    const result = runHealth(agendHome, ["--quiet"]);

    expect(result.stdout).toMatch(/1 paused/);
    expect(result.status).toBe(0);
  });

  it("full output includes paused count and excludes paused from unhealthy list", () => {
    const { agendHome } = makeTestEnv();
    setupFleetConfig(agendHome, {
      "healthy-paused": {},
      "another-stopped": {},
    });
    setupInstance(agendHome, "healthy-paused", "paused");
    setupInstance(agendHome, "another-stopped", "stopped");

    const result = runHealth(agendHome);

    expect(result.stdout).toMatch(/1 paused/);
    // Paused should not appear in unhealthy list with issues
    expect(result.stdout).not.toContain("healthy-paused");
    expect(result.stdout).toContain("All instances healthy");
  });

  it("mixed fleet: paused does not affect healthy count classification", () => {
    const { agendHome } = makeTestEnv();
    // Simulate user scenario: would be 30 healthy + 21 paused in real fleet
    // Here we test with smaller numbers
    setupFleetConfig(agendHome, {
      "running-1": {},
      "running-2": {},
      "paused-1": {},
      "paused-2": {},
      "paused-3": {},
    });
    // No daemon.pid = stopped, but we want to test paused
    setupInstance(agendHome, "paused-1", "paused");
    setupInstance(agendHome, "paused-2", "paused");
    setupInstance(agendHome, "paused-3", "paused");
    setupInstance(agendHome, "running-1", "stopped");
    setupInstance(agendHome, "running-2", "stopped");

    const result = runHealth(agendHome, ["--json"]);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.fleet.classification).toBe("healthy");

    const pausedInsts = output.instances.filter((i: any) => i.status === "paused");
    const stoppedInsts = output.instances.filter((i: any) => i.status === "stopped");
    expect(pausedInsts).toHaveLength(3);
    expect(stoppedInsts).toHaveLength(2);

    // None should have "Tmux window missing"
    for (const inst of pausedInsts) {
      expect(inst.issues).toEqual([]);
    }
  });
});
