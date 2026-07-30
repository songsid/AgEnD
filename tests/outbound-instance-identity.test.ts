import { describe, expect, it, vi } from "vitest";
import { outboundHandlers } from "../src/outbound-handlers.js";

function makeContext() {
  const classic = {
    instanceName: "classic-no-override",
    name: "No override",
    channelId: "channel-1",
    adapterId: "discord",
  };
  return {
    fleetConfig: {
      defaults: { backend: "kiro-cli", model: "auto" },
      instances: {},
    },
    lifecycle: {
      daemons: new Map([["classic-no-override", {}]]),
      isPaused: vi.fn(() => false),
      getLastPausedAt: vi.fn(() => null),
    },
    classicChannels: {
      getAll: vi.fn(() => [classic]),
      getChannelIdByInstance: vi.fn((name: string) => name === classic.instanceName ? classic.channelId : undefined),
      getBackendByInstance: vi.fn((_name: string, fleetDefault?: string) => fleetDefault ?? "claude-code"),
      getModel: vi.fn((_channelId: string, _adapterId?: string, fleetDefault?: string) => fleetDefault),
    },
    sessionRegistry: new Map(),
    lastActivityMs: vi.fn(() => 0),
    getInstanceExecutionState: vi.fn(() => "idle"),
    resolveInstanceModel: vi.fn(() => ({
      model: "auto",
      source: "classic",
      display: "auto",
    })),
  } as any;
}

describe("outbound instance identity", () => {
  it("list_instances returns effective Classic backend/model and kind", async () => {
    const ctx = makeContext();
    let response: any;

    await outboundHandlers.get("list_instances")!(
      ctx,
      {},
      (result: unknown) => { response = result; },
      { instanceName: "sender" },
    );

    expect(response.instances).toEqual([
      expect.objectContaining({
        name: "classic-no-override",
        kind: "classic",
        backend: "kiro-cli",
        model: "auto",
      }),
    ]);
    expect(ctx.classicChannels.getBackendByInstance)
      .toHaveBeenCalledWith("classic-no-override", "kiro-cli");
  });

  it("describe_instance returns effective Classic model, source, backend, and kind", async () => {
    const ctx = makeContext();
    let response: any;

    await outboundHandlers.get("describe_instance")!(
      ctx,
      { name: "classic-no-override" },
      (result: unknown) => { response = result; },
      { instanceName: "sender" },
    );

    expect(response).toEqual(expect.objectContaining({
      name: "classic-no-override",
      kind: "classic",
      backend: "kiro-cli",
      model: "auto",
      model_source: "classic",
    }));
  });
});
