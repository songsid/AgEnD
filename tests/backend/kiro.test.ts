import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  KiroBackend,
  getCachedKiroCliCompatibility,
  probeKiroCliCompatibility,
  resetKiroCompatibilityCacheForTests,
  type KiroCliCompatibility,
} from "../../src/backend/kiro.js";
import type { CliBackendConfig } from "../../src/backend/types.js";

// Use unique temp directories per test run to avoid collisions when multiple
// vitest processes run in parallel (issue #669)
const TEST_DIR = mkdtempSync(join(tmpdir(), "ccd-test-kiro-backend-"));
const WORK_DIR = mkdtempSync(join(tmpdir(), "ccd-test-kiro-workdir-"));

function makeConfig(overrides?: Partial<CliBackendConfig>): CliBackendConfig {
  return {
    workingDirectory: WORK_DIR,
    instanceDir: TEST_DIR,
    instanceName: "test-kiro",
    mcpServers: {
      "agend": {
        command: "node",
        args: ["/path/to/mcp-server.js"],
        env: { AGEND_SOCKET_PATH: "/tmp/test.sock" },
      },
    },
    ...overrides,
  };
}

const LATEST_KIRO: KiroCliCompatibility = {
  version: "kiro-cli 2.21.0",
  supportsRequireMcpStartup: true,
  supportsLegacyUi: true,
  supportsEffortFlag: true,
  source: "version",
};

function makeBackend(compatibility: KiroCliCompatibility = LATEST_KIRO): KiroBackend {
  return new KiroBackend(TEST_DIR, compatibility);
}

function compatibilityForVersion(version: string): KiroCliCompatibility {
  return probeKiroCliCompatibility("/fake/kiro-cli", (_binary, args) => {
    if (args[0] === "--version") return `kiro-cli ${version}\n`;
    throw new Error("unexpected help fallback");
  });
}

describe("KiroBackend", () => {
  beforeEach(() => {
    resetKiroCompatibilityCacheForTests();
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(WORK_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(WORK_DIR, { recursive: true, force: true });
  });

  describe("delivery capabilities (Enter dropped while busy)", () => {
    it("declares that Enter is dropped while busy and supplies a bottom-anchored prompt pattern", () => {
      const backend = makeBackend();
      expect(backend.dropsEnterWhileBusy()).toBe(true);
      const prompt = backend.getBottomReadyPattern();
      // Live legacy-UI bottom rows (kiro-cli 2.21.0, 2026-09-03).
      for (const row of ["51% !>", "1% !> How can I help?", "2% !> Not sure where to start? Ask me about my features", "20% λ !>", "8% ❯"]) {
        expect(prompt.test(row), row).toBe(true);
      }
      // Busy-phase bottom rows must NOT read as ready.
      for (const row of ["⠇ Thinking...", "Purpose: Sleep 9 seconds then echo marker", "I will run the following command: sleep 9 (using tool: shell)", " ▸ Time: 15s"]) {
        expect(prompt.test(row), row).toBe(false);
      }
    });
  });

  describe("buildCommand", () => {
    it("generates chat command with --trust-all-tools and --resume", () => {
      const backend = makeBackend();
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("chat");
      expect(cmd).toContain("--legacy-ui");
      expect(cmd).toContain("--trust-all-tools");
      expect(cmd).toContain("--resume");
      expect(cmd).toContain("--require-mcp-startup");
    });

    it("uses Kiro's default TUI without a UI override flag", () => {
      const backend = makeBackend();
      const cmd = backend.buildCommand(makeConfig({ kiroUi: "tui" }));
      expect(cmd).not.toContain("--legacy-ui");
      expect(cmd).not.toContain("--v3");
    });

    it("opts into the next-generation agent with --v3", () => {
      const backend = makeBackend();
      const cmd = backend.buildCommand(makeConfig({ kiroUi: "v3" }));
      expect(cmd).toContain("chat --v3");
      expect(cmd).not.toContain("--legacy-ui");
    });

    it("always includes --resume (boolean flag, resumes latest session for CWD)", () => {
      const backend = makeBackend();
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("--resume");
    });

    it("includes --model when model is set", () => {
      const backend = makeBackend();
      const cmd = backend.buildCommand(makeConfig({ model: "claude-sonnet-4.5" }));
      expect(cmd).toContain("--model 'claude-sonnet-4.5'");
    });

    it("omits --trust-all-tools when skipPermissions is false", () => {
      const backend = makeBackend();
      const cmd = backend.buildCommand(makeConfig({ skipPermissions: false }));
      expect(cmd).not.toContain("--trust-all-tools");
    });

    it.each([
      {
        version: "1.24.9",
        expected: { requireMcp: false, legacyUi: false, effort: false },
      },
      {
        version: "1.25.0",
        expected: { requireMcp: true, legacyUi: false, effort: false },
      },
      {
        version: "1.26.9",
        expected: { requireMcp: true, legacyUi: false, effort: false },
      },
      {
        version: "1.27.0",
        expected: { requireMcp: true, legacyUi: true, effort: false },
      },
      {
        version: "2.5.99",
        expected: { requireMcp: true, legacyUi: true, effort: false },
      },
      {
        version: "2.6.0",
        expected: { requireMcp: true, legacyUi: true, effort: true },
      },
    ])("gates launch flags for kiro-cli $version", ({ version, expected }) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const backend = makeBackend(compatibilityForVersion(version));
      const cmd = backend.buildCommand(makeConfig({ effort: "high" }));

      expect(cmd.includes("--require-mcp-startup")).toBe(expected.requireMcp);
      expect(cmd.includes("--legacy-ui")).toBe(expected.legacyUi);
      expect(cmd.includes("--effort high")).toBe(expected.effort);
      expect(cmd).not.toContain("--classic");
      expect(warn).toHaveBeenCalledTimes(expected.effort ? 0 : 1);
      warn.mockRestore();
    });

    it("warns only once when configured effort is unsupported", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const backend = makeBackend(compatibilityForVersion("2.5.0"));

      backend.buildCommand(makeConfig({ effort: "high" }));
      backend.buildCommand(makeConfig({ effort: "high" }));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("requires >= 2.6.0"));
      warn.mockRestore();
    });
  });

  describe("CLI compatibility probe", () => {
    it("falls back to chat --help when the version probe fails", () => {
      const calls: string[][] = [];
      const compatibility = probeKiroCliCompatibility("/fake/kiro-cli", (_binary, args) => {
        calls.push(args);
        if (args[0] === "--version") throw new Error("version unavailable");
        return `
          --require-mcp-startup  Require MCP startup
          --legacy-ui            Use the legacy UI
          --effort <EFFORT>      Initial effort
        `;
      });

      expect(calls).toEqual([["--version"], ["chat", "--help"]]);
      expect(compatibility).toEqual({
        version: undefined,
        supportsRequireMcpStartup: true,
        supportsLegacyUi: true,
        supportsEffortFlag: true,
        source: "help",
      });
    });

    it("uses help fallback for an unparseable version string", () => {
      const compatibility = probeKiroCliCompatibility("/fake/kiro-cli", (_binary, args) => {
        if (args[0] === "--version") return "kiro-cli development build";
        return "  --require-mcp-startup  Require MCP startup\n";
      });

      expect(compatibility).toMatchObject({
        version: "kiro-cli development build",
        supportsRequireMcpStartup: true,
        supportsLegacyUi: false,
        supportsEffortFlag: false,
        source: "help",
      });
    });

    it("probes a binary generation only once per process", () => {
      const binary = join(TEST_DIR, "kiro-cli-cache-test");
      writeFileSync(binary, "generation-one");
      const run = vi.fn(() => "kiro-cli 2.21.0\n");

      expect(getCachedKiroCliCompatibility(binary, run).source).toBe("version");
      expect(getCachedKiroCliCompatibility(binary, run).source).toBe("version");
      expect(run).toHaveBeenCalledTimes(1);

      writeFileSync(binary, "generation-two-with-a-different-size");
      expect(getCachedKiroCliCompatibility(binary, run).source).toBe("version");
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("conservatively omits all gated flags when version and help both fail", () => {
      const compatibility = probeKiroCliCompatibility("/fake/kiro-cli", () => {
        throw new Error("binary unavailable");
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const backend = makeBackend(compatibility);
      const cmd = backend.buildCommand(makeConfig({ effort: "max" }));

      expect(compatibility.source).toBe("unknown");
      expect(cmd).not.toContain("--require-mcp-startup");
      expect(cmd).not.toContain("--legacy-ui");
      expect(cmd).not.toContain("--effort");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown version"));
      warn.mockRestore();
    });

    it("keeps the effort configuration surface stable while gating only the launch flag", () => {
      expect(makeBackend(compatibilityForVersion("2.5.0")).getEffortStrategy()).toBe("restart");
      expect(makeBackend(compatibilityForVersion("2.6.0")).getEffortStrategy()).toBe("restart");
    });
  });

  describe("writeConfig", () => {
    it("writes mcp.json with wrapper script to .kiro/settings/ in working directory", () => {
      const backend = makeBackend();
      backend.writeConfig(makeConfig());
      const mcpConfigPath = join(WORK_DIR, ".kiro", "settings", "mcp.json");
      expect(existsSync(mcpConfigPath)).toBe(true);
      const config = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
      expect(config.mcpServers["agend-test-kiro"]).toBeDefined();
      // kiro-cli ignores env block in mcp.json, so we use a wrapper script
      const wrapperPath = config.mcpServers["agend-test-kiro"].command;
      expect(wrapperPath).toContain("mcp-wrapper-agend.sh");
      expect(existsSync(wrapperPath)).toBe(true);
      const wrapperContent = readFileSync(wrapperPath, "utf-8");
      expect(wrapperContent).toContain("AGEND_SOCKET_PATH");
      expect(wrapperContent).toContain("exec node");
    });

    it("uses instance-namespaced key to avoid conflicts", () => {
      const backend = makeBackend();
      backend.writeConfig(makeConfig({ instanceName: "instance-a" }));
      backend.writeConfig(makeConfig({ instanceName: "instance-b" }));
      const config = JSON.parse(readFileSync(join(WORK_DIR, ".kiro", "settings", "mcp.json"), "utf-8"));
      expect(config.mcpServers["agend-instance-a"]).toBeDefined();
      expect(config.mcpServers["agend-instance-b"]).toBeDefined();
    });

    it("cleans up old non-namespaced key", () => {
      const mcpDir = join(WORK_DIR, ".kiro", "settings");
      mkdirSync(mcpDir, { recursive: true });
      writeFileSync(join(mcpDir, "mcp.json"), JSON.stringify({ mcpServers: { agend: { command: "old" } } }));
      const backend = makeBackend();
      backend.writeConfig(makeConfig());
      const config = JSON.parse(readFileSync(join(mcpDir, "mcp.json"), "utf-8"));
      expect(config.mcpServers["agend"]).toBeUndefined();
      expect(config.mcpServers["agend-test-kiro"]).toBeDefined();
    });

    it("writes steering file when instructions provided", () => {
      const backend = makeBackend();
      backend.writeConfig(makeConfig({ instructions: "# Fleet Context" }));
      const steeringFile = join(WORK_DIR, ".kiro", "steering", "agend-test-kiro.md");
      expect(existsSync(steeringFile)).toBe(true);
      expect(readFileSync(steeringFile, "utf-8")).toContain("# Fleet Context");
    });

    it("does not write steering file when instructions absent", () => {
      const backend = makeBackend();
      backend.writeConfig(makeConfig());
      expect(existsSync(join(WORK_DIR, ".kiro", "steering", "agend-test-kiro.md"))).toBe(false);
    });
  });

  describe("cleanup", () => {
    it("removes instance MCP entry from mcp.json", () => {
      const backend = makeBackend();
      backend.writeConfig(makeConfig());
      backend.cleanup(makeConfig());
      const config = JSON.parse(readFileSync(join(WORK_DIR, ".kiro", "settings", "mcp.json"), "utf-8"));
      expect(config.mcpServers["agend-test-kiro"]).toBeUndefined();
    });

    it("removes steering file on cleanup", () => {
      const backend = makeBackend();
      backend.writeConfig(makeConfig({ instructions: "# Fleet" }));
      const steeringFile = join(WORK_DIR, ".kiro", "steering", "agend-test-kiro.md");
      expect(existsSync(steeringFile)).toBe(true);
      backend.cleanup(makeConfig());
      expect(existsSync(steeringFile)).toBe(false);
    });
  });

  describe("getSessionId", () => {
    it("returns null (Kiro manages sessions internally)", () => {
      const backend = makeBackend();
      expect(backend.getSessionId()).toBeNull();
    });
  });

  describe("getContextUsage", () => {
    it("returns null (not supported)", () => {
      const backend = makeBackend();
      expect(backend.getContextUsage()).toBeNull();
    });
  });

  describe("getErrorPatterns", () => {
    it.each([
      "The selected model is not available",
      "Please use '/model' to choose another model",
    ])("notifies when Kiro requires a model switch: %s", (output) => {
      const backend = makeBackend();
      const error = backend.getErrorPatterns().find(({ pattern }) => pattern.test(output));

      expect(error).toMatchObject({
        type: "model_error",
        action: "notify",
        message: "Model unavailable — use /model to switch",
      });
    });
  });
});
