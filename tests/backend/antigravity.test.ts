import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { AntigravityBackend } from "../../src/backend/antigravity.js";
import type { CliBackendConfig } from "../../src/backend/types.js";

describe("AntigravityBackend MCP and workspace isolation", () => {
  let root: string;
  let home: string;
  let agendHome: string;
  let instanceDir: string;
  let workspace: string;
  let backend: AntigravityBackend;

  function config(overrides: Partial<CliBackendConfig> = {}): CliBackendConfig {
    return {
      workingDirectory: workspace,
      instanceDir,
      instanceName: "agy-worker",
      agentMode: "mcp",
      instructions: "# Fleet instructions",
      mcpServers: {
        agend: {
          command: "node",
          args: ["/opt/agend/dist/channel/mcp-server.js"],
          env: {
            AGEND_SOCKET_PATH: join(instanceDir, "channel.sock"),
            AGEND_DECISIONS: "private decision",
          },
        },
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    root = join(tmpdir(), `agend-agy-backend-${process.pid}-${Math.random()}`);
    home = join(root, "home");
    agendHome = join(root, "agend-home");
    instanceDir = join(agendHome, "instances", "agy-worker");
    workspace = join(home, ".agend", "instances", "agy-worker", "workspace");
    mkdirSync(instanceDir, { recursive: true });
    backend = new AntigravityBackend(instanceDir, home, agendHome);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("keeps hidden workspaces at their configured persistent path", () => {
    expect(backend.resolveWorkingDirectory(workspace, "agy-worker")).toBe(workspace);
    expect(existsSync(workspace)).toBe(true);
  });

  it("writes a shared env-free MCP launcher and a private per-instance wrapper", () => {
    const configDir = join(home, ".gemini", "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "mcp_config.json"), JSON.stringify({
      custom: "preserved",
      mcpServers: {
        user: { command: "user-server", args: [] },
        "agend-old": {
          command: "node",
          args: ["/old/dist/channel/mcp-server.js"],
          env: { AGEND_SOCKET_PATH: "/old/channel.sock" },
        },
      },
    }));

    const cfg = config();
    backend.writeConfig(cfg);

    const wrapper = join(instanceDir, "agy-mcp-env.sh");
    expect(statSync(wrapper).mode & 0o777).toBe(0o700);
    const wrapperText = readFileSync(wrapper, "utf-8");
    expect(wrapperText).toContain("AGEND_SOCKET_PATH");
    expect(wrapperText).toContain("AGEND_DECISIONS");
    expect(wrapperText).toContain('exec "$@"');

    const saved = JSON.parse(readFileSync(join(configDir, "mcp_config.json"), "utf-8"));
    expect(statSync(join(configDir, "mcp_config.json")).mode & 0o777).toBe(0o600);
    expect(saved.custom).toBe("preserved");
    expect(saved.mcpServers.user).toEqual({ command: "user-server", args: [] });
    expect(saved.mcpServers["agend-old"]).toBeUndefined();
    expect(saved.mcpServers["agend-fleet"]).toEqual({
      command: "node",
      args: ["/opt/agend/dist/channel/agy-mcp-launcher.js"],
    });
    expect(JSON.stringify(saved)).not.toContain("private decision");
    expect(JSON.stringify(saved)).not.toContain("channel.sock");
    expect(backend.buildCommand(cfg)).toMatch(/^'.*agy-mcp-env\.sh' .*agy --dangerously-skip-permissions/);
  });

  it("refuses to overwrite corrupt shared MCP config", () => {
    const configDir = join(home, ".gemini", "config");
    mkdirSync(configDir, { recursive: true });
    const path = join(configDir, "mcp_config.json");
    writeFileSync(path, "not json\n");

    expect(() => backend.writeConfig(config())).toThrow(/Refusing to overwrite invalid/);
    expect(readFileSync(path, "utf-8")).toBe("not json\n");
  });

  it("does not remove a fresh config lock owned by another writer", () => {
    const configDir = join(home, ".gemini", "config");
    mkdirSync(configDir, { recursive: true });
    const lockPath = join(configDir, ".agend-mcp.lock");
    writeFileSync(lockPath, "someone-else");

    backend.writeConfig(config());

    expect(readFileSync(lockPath, "utf-8")).toBe("someone-else");
    expect(existsSync(join(configDir, "mcp_config.json"))).toBe(false);
  });

  it("cleanup removes only AgEnD-owned files and preserves the workspace", () => {
    const cfg = config();
    backend.writeConfig(cfg);
    const userFile = join(workspace, "user-data.txt");
    writeFileSync(userFile, "keep me");

    backend.cleanup(cfg);

    expect(existsSync(workspace)).toBe(true);
    expect(readFileSync(userFile, "utf-8")).toBe("keep me");
    expect(existsSync(join(instanceDir, "agy-mcp-env.sh"))).toBe(false);
    expect(existsSync(join(workspace, ".agents", "agents.md"))).toBe(false);
  });

  it("explicit CLI mode removes a stale wrapper and does not use it", () => {
    backend.writeConfig(config());
    const cliConfig = config({ agentMode: "cli", mcpServers: {} });

    backend.writeConfig(cliConfig);

    expect(existsSync(join(instanceDir, "agy-mcp-env.sh"))).toBe(false);
    expect(backend.buildCommand(cliConfig)).not.toContain("agy-mcp-env.sh");
  });
});
