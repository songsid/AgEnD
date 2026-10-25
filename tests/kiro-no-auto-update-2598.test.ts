/**
 * #2598 (D1): every kiro chat AgEnD starts carries KIRO_NO_AUTO_UPDATE=1, so kiro-cli-chat never replaces itself
 * under a running fleet. Checked by RUNNING what AgEnD builds against a stub kiro-cli that reports what it received —
 * the instance launch through `sh -c` (as tmux runs it), and the probes through their default runners. No real kiro.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KIRO_NO_AUTO_UPDATE, KiroBackend, kiroChildEnv, probeKiroCliCompatibility } from "../src/backend/kiro.js";
import type { CliBackendConfig } from "../src/backend/types.js";
import { registerExecutableFixture } from "./support/process-guard.js";

const dirs: string[] = [];
const savedEnv = { AGEND_HOME: process.env.AGEND_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, KIRO_NO_AUTO_UPDATE: process.env.KIRO_NO_AUTO_UPDATE };
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string { const d = mkdtempSync(join(tmpdir(), "kiro-nau-")); dirs.push(d); return d; }

/** A kiro-cli stand-in: answers --version and --list-models with what KIRO_NO_AUTO_UPDATE was, and echoes it for chat. */
function stubKiro(): string {
  const bin = join(tempDir(), "kiro-cli");
  writeFileSync(bin, `#!/bin/sh
v="\${KIRO_NO_AUTO_UPDATE-unset}"
case "$1" in
  --version) echo "kiro-cli 2.30.0-nau$v" ;;
  chat)
    for a in "$@"; do [ "$a" = "--list-models" ] && { echo "{\\"models\\":[{\\"model_id\\":\\"nau-$v\\"}]}"; exit 0; }; done
    echo "chat KIRO_NO_AUTO_UPDATE=$v" ;;
esac
`);
  chmodSync(bin, 0o700);
  registerExecutableFixture(bin); // the process guard lets exactly this file run under the name kiro-cli
  return bin;
}

const compat = {
  supportsLegacyUi: true, supportsTui: true, supportsV3: true, agentEngines: ["v2", "v1", "v3"],
  supportsEffortFlag: false, version: "2.30.0",
} as never;
function backend(bin: string): KiroBackend {
  const b = new KiroBackend(tempDir(), compat);
  (b as unknown as { binaryPath: string }).binaryPath = bin;
  return b;
}
function config(overrides: Partial<CliBackendConfig> = {}): CliBackendConfig {
  return { workingDirectory: tempDir(), instanceDir: tempDir(), instanceName: "nau", mcpServers: {}, skipResume: true, ...overrides } as CliBackendConfig;
}
/** Run the launch command the way tmux does — a shell string — with the variable absent from our own env. */
function runLaunch(cmd: string): string {
  const env = { ...process.env };
  delete env.KIRO_NO_AUTO_UPDATE;
  return execFileSync("/bin/sh", ["-c", cmd], { encoding: "utf8", env }).trim();
}

describe("the instance launch carries KIRO_NO_AUTO_UPDATE=1 (#2598)", () => {
  for (const kiroUi of ["legacy", "tui"] as const) {
    it(`${kiroUi}: the chat process receives it`, () => {
      delete process.env.KIRO_NO_AUTO_UPDATE;
      const bin = stubKiro();
      const cmd = backend(bin).buildCommand(config({ kiroUi }));
      expect(cmd).toContain(`${KIRO_NO_AUTO_UPDATE}=1 ${bin} chat`);
      expect(runLaunch(cmd)).toBe("chat KIRO_NO_AUTO_UPDATE=1");
    });
  }

  it("with a credential profile, both prefixes reach the chat", () => {
    process.env.AGEND_HOME = tempDir();
    process.env.XDG_DATA_HOME = tempDir();
    const bin = stubKiro();
    const cmd = backend(bin).buildCommand(config({ backendOptions: { credential_profile: "work" } }));
    expect(cmd.startsWith("XDG_DATA_HOME="), "the credential prefix still leads").toBe(true);
    expect(runLaunch(cmd)).toBe("chat KIRO_NO_AUTO_UPDATE=1");
  });
});

describe("the probes carry it too", () => {
  it("--version / chat --help (the compatibility probe's default runner)", () => {
    delete process.env.KIRO_NO_AUTO_UPDATE;
    expect(probeKiroCliCompatibility(stubKiro()).version).toBe("kiro-cli 2.30.0-nau1");
  });

  it("chat --list-models (model list and probeCLIEnv)", async () => {
    delete process.env.KIRO_NO_AUTO_UPDATE;
    const b = backend(stubKiro());
    expect((await b.listModels()).map(m => m.id)).toEqual(["nau-1"]);
    expect((await b.probeCLIEnv()).models.map(m => m.id)).toEqual(["nau-1"]);
  });

  it("kiroChildEnv keeps the rest of the environment and overrides a stray value", () => {
    expect(kiroChildEnv({ PATH: "/x", KIRO_NO_AUTO_UPDATE: "0" })).toEqual({ PATH: "/x", KIRO_NO_AUTO_UPDATE: "1" });
  });
});
