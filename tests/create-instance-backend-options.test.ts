import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { CodexBackend } from "../src/backend/codex.js";
import type { CliBackendConfig } from "../src/backend/types.js";
import { FleetManager } from "../src/fleet-manager.js";
import { CreateInstanceArgs } from "../src/outbound-schemas.js";

const dirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("create_instance backend_options", () => {
  it("persists a Codex custom provider and passes it to the launch command", async () => {
    const dataDir = makeTempDir("agend-create-backend-options-");
    const projectDir = makeTempDir("agend-create-backend-options-project-");
    const configPath = join(dataDir, "fleet.yaml");
    writeFileSync(configPath, "instances: {}\n");

    const fm = new FleetManager(dataDir);
    fm.loadConfig(configPath);
    vi.spyOn(fm, "createForumTopic").mockResolvedValue("901");
    vi.spyOn(fm.lifecycle, "start").mockResolvedValue(undefined);
    vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined);

    // Parse through the production MCP schema first: this catches a schema
    // that documents backend_options but accidentally strips it before the
    // lifecycle handler receives the arguments.
    const args = CreateInstanceArgs.parse({
      directory: projectDir,
      topic_name: "glm-worker",
      backend: "codex",
      model: "GLM-5.2",
      backend_options: { codex: { provider: "glm" } },
    });
    let result: unknown;
    let error: string | undefined;
    await fm.lifecycle.handleCreate(args, (value, message) => {
      result = value;
      error = message;
    });

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ success: true, name: "glm-worker-t901", topic_id: "901" });

    const saved = yaml.load(readFileSync(configPath, "utf-8")) as {
      instances: Record<string, {
        working_directory: string;
        model?: string;
        backend_options?: Record<string, Record<string, unknown>>;
      }>;
    };
    const instance = saved.instances["glm-worker-t901"];
    expect(instance.backend_options).toEqual({ codex: { provider: "glm" } });

    const backend = new CodexBackend(fm.getInstanceDir("glm-worker-t901"));
    const commandConfig: CliBackendConfig = {
      workingDirectory: instance.working_directory,
      instanceDir: fm.getInstanceDir("glm-worker-t901"),
      instanceName: "glm-worker-t901",
      mcpServers: {},
      model: instance.model,
      backendOptions: instance.backend_options?.codex,
    };
    expect(backend.buildCommand(commandConfig)).toContain(`-c 'model_provider="glm"'`);
  });
});
