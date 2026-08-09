import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { FleetManager } from "../src/fleet-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";

const dirs: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-model-persist-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runtime model persistence", () => {
  it("writes a Claude fleet instance model to fleet.yaml before the runtime switch", async () => {
    const dataDir = makeDataDir();
    const configPath = join(dataDir, "fleet.yaml");
    writeFileSync(configPath, yaml.dump({
      defaults: { backend: "kiro-cli" },
      instances: {
        alpha: { backend: "claude-code", working_directory: dataDir },
      },
    }));

    const fm = new FleetManager(dataDir);
    fm.loadConfig(configPath);
    const send = vi.fn().mockReturnValue(true);
    fm.instanceIpcClients.set("alpha", { connected: true, send } as never);

    await expect(fm.applyModel("alpha", "opus")).resolves.toContain("(runtime)");

    const saved = yaml.load(readFileSync(configPath, "utf-8")) as {
      instances: Record<string, { model?: string }>;
    };
    expect(saved.instances.alpha.model).toBe("opus");
    expect(send).toHaveBeenCalledWith({ type: "raw_paste", content: "/model opus" });
  });

  it("writes a Claude Classic instance model to classicBot.yaml before the runtime switch", async () => {
    const dataDir = makeDataDir();
    const configPath = join(dataDir, "fleet.yaml");
    writeFileSync(configPath, yaml.dump({ defaults: { backend: "kiro-cli" }, instances: {} }));

    const fm = new FleetManager(dataDir);
    fm.loadConfig(configPath);
    const classic = new ClassicChannelManager(dataDir, fm.logger);
    classic.setPrimaryAdapterId("discord");
    classic.register("channel-1", "discord", "classic-alpha", "Alpha", "owner", "claude-code");
    fm.classicChannels = classic;
    const send = vi.fn().mockReturnValue(true);
    fm.instanceIpcClients.set("classic-alpha", { connected: true, send } as never);

    await expect(fm.applyModel("classic-alpha", "sonnet")).resolves.toContain("(runtime)");

    const saved = yaml.load(readFileSync(join(dataDir, "classicBot.yaml"), "utf-8")) as {
      channels: Record<string, { instanceName: string; model?: string }>;
    };
    expect(Object.values(saved.channels).find(ch => ch.instanceName === "classic-alpha")?.model).toBe("sonnet");
    expect(send).toHaveBeenCalledWith({ type: "raw_paste", content: "/model sonnet" });
  });
});
