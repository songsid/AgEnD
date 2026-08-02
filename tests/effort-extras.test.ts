import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { TopicCommands } from "../src/topic-commands.js";
import { TOOLS, TOOL_SETS } from "../src/channel/mcp-tools.js";
import { outboundHandlers } from "../src/outbound-handlers.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "agend-effort-extras-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("/status shows effort", () => {
  it("renders a per-instance effort column", async () => {
    const commands = new TopicCommands({
      fleetConfig: { defaults: {}, instances: { alpha: { backend: "claude-code" }, beta: { backend: "opencode" } } },
      dataDir: tmp(),
      getInstanceStatus: () => "running",
      getInstanceExecutionState: () => "idle",
      instanceIpcClients: new Map(),
      getAdapterStates: () => new Map(),
      classicChannels: null,
      costGuard: null,
      resolveInstanceEffort: (n: string) =>
        n === "alpha" ? { effort: "xhigh", source: "instance" } : { effort: null, source: "unset" },
    } as never);

    const text = await commands.getStatusText();
    expect(text).toContain("| Instance | Backend | Ctx | Effort |");
    expect(text).toMatch(/\| alpha \| claude-code \| - \| xhigh \|/);
    // "-" rather than blank: an empty cell reads as missing data, not "unset".
    expect(text).toMatch(/\| beta \| opencode \| - \| - \|/);
  });
});

describe("/model reply carries the current effort", () => {
  function makeFleet(backend: string, effort?: string) {
    const fm = new FleetManager(tmp());
    (fm as unknown as { fleetConfig: unknown }).fleetConfig = {
      defaults: { backend },
      instances: { alpha: { working_directory: "/tmp", ...(effort ? { effort } : {}) } },
    };
    (fm as unknown as { saveFleetConfig(): void }).saveFleetConfig = () => {};
    (fm as unknown as { restartSingleInstance(n: string): Promise<void> }).restartSingleInstance = async () => {};
    return fm;
  }

  it("appends the configured effort after a switch", async () => {
    const fm = makeFleet("kiro-cli", "high"); // restart strategy → no IPC needed
    const reply = await fm.applyModel("alpha", "sonnet");
    expect(reply).toContain("Current effort: high");
  });

  it("says (CLI default) when nothing is configured", async () => {
    const fm = makeFleet("kiro-cli");
    expect(await fm.applyModel("alpha", "sonnet")).toContain("Current effort: (CLI default)");
  });

  it("adds nothing for a backend with no effort setting", async () => {
    const fm = makeFleet("opencode");
    expect(await fm.applyModel("alpha", "some-model")).not.toContain("Current effort");
  });
});

describe("get_effort MCP tool", () => {
  it("is defined and available to ordinary instances", () => {
    expect(TOOLS.find(t => t.name === "get_effort")).toBeDefined();
    expect(TOOL_SETS.standard).toContain("get_effort");
    expect(TOOL_SETS.general).toContain("get_effort");
    expect(TOOL_SETS.minimal).not.toContain("get_effort");
  });

  it("reports level, levels and the change strategy", async () => {
    const fm = new FleetManager(tmp());
    (fm as unknown as { fleetConfig: unknown }).fleetConfig = {
      defaults: { backend: "kiro-cli" },
      instances: { alpha: { working_directory: "/tmp", effort: "xhigh" } },
    };
    const handler = outboundHandlers.get("get_effort")!;
    const respond = vi.fn();
    await handler(fm as never, {}, respond, { instanceName: "alpha" } as never);

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      instance: "alpha",
      backend: "kiro-cli",
      effort: "xhigh",
      source: "instance",
      available_levels: ["low", "medium", "high", "xhigh", "max"],
      // kiro reads effort only at launch — the agent needs to know a change
      // costs it a respawn before it changes its own mid-task.
      change_strategy: "restart",
    }));
  });

  it("reports unsupported cleanly rather than an empty-looking success", async () => {
    const fm = new FleetManager(tmp());
    (fm as unknown as { fleetConfig: unknown }).fleetConfig = {
      defaults: { backend: "opencode" }, instances: { alpha: { working_directory: "/tmp" } },
    };
    const respond = vi.fn();
    await outboundHandlers.get("get_effort")!(fm as never, {}, respond, { instanceName: "alpha" } as never);

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      effort: null, source: "unsupported", available_levels: [], change_strategy: "unsupported",
    }));
  });
});
