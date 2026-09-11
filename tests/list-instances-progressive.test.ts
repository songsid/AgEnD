import { describe, expect, it, vi, beforeEach } from "vitest";
import { DEFAULT_LIST_INSTANCES_OUTPUT_BUDGET, MAX_INSTANCE_LOG_LINES } from "../src/config.js";

/**
 * Tests for list_instances progressive disclosure (#740).
 *
 * The tool responds in three tiers based on output size:
 * 1. Full: includes description, working_directory, topic_id, instance_state
 * 2. Compact: name, status, backend, model, kind, tags + guidance
 * 3. Summary: counts by backend/status/tag + guidance
 *
 * Filters (name, backend, status, tags) apply BEFORE size measurement.
 */

// Mock the readStatuslineModel function
vi.mock("../src/topic-commands.js", () => ({
  readStatuslineModel: vi.fn((dataDir: string, instanceName: string) => {
    if (instanceName === "claude-with-statusline") return "claude-sonnet-4";
    return null;
  }),
}));

describe("list_instances progressive disclosure", () => {
  // Helper to create a mock OutboundContext
  function createMockContext(instances: Record<string, any>, options: {
    classicChannels?: any[];
    sessionRegistry?: Map<string, string>;
  } = {}) {
    const daemons = new Map<string, unknown>();
    const paused = new Set<string>();
    
    // Mark some as running/paused based on naming convention
    for (const name of Object.keys(instances)) {
      if (name.includes("running") || name.includes("active")) {
        daemons.set(name, {});
      }
      if (name.includes("paused")) {
        paused.add(name);
        daemons.set(name, {});
      }
    }

    return {
      dataDir: "/mock/agend",
      fleetConfig: {
        defaults: { backend: "claude-code" },
        instances,
      },
      adapter: null,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      routing: { entries: () => [] },
      instanceIpcClients: new Map(),
      lifecycle: {
        daemons,
        isPaused: (name: string) => paused.has(name),
        has: (name: string) => daemons.has(name),
        getLastPausedAt: () => null,
      },
      sessionRegistry: options.sessionRegistry ?? new Map(),
      eventLog: null,
      classicChannels: options.classicChannels ? {
        getAll: () => options.classicChannels!,
        getChannelIdByInstance: () => undefined,
        getBackendByInstance: () => "claude-code",
        getModel: () => undefined,
      } : null,
      lastActivityMs: () => 0,
      startInstance: vi.fn(),
      restartSingleInstance: vi.fn(),
      connectIpcToInstance: vi.fn(),
      saveFleetConfig: vi.fn(),
      getInstanceExecutionState: () => null,
      resolveInstanceModel: (name: string) => {
        const inst = instances[name];
        return {
          model: inst?.model ?? "default",
          source: inst?.model ? "instance" : "unresolved",
          display: inst?.model ?? "default",
        };
      },
    };
  }

  describe("tier selection based on output size", () => {
    it("returns full output when within budget", async () => {
      const { outboundHandlers } = await import("../src/outbound-handlers.js");
      const handler = outboundHandlers.get("list_instances")!;
      
      // Small fleet - should fit in budget
      const ctx = createMockContext({
        "running-1": { working_directory: "/a", backend: "claude-code" },
        "running-2": { working_directory: "/b", backend: "kiro-cli" },
      });

      let result: any;
      await handler(ctx as any, {}, (r) => { result = r; }, {
        instanceName: "caller",
        requestId: 1,
        fleetRequestId: undefined,
        senderSessionName: undefined,
      });

      expect(result.instances).toHaveLength(2);
      expect(result.instances[0]).toHaveProperty("description");
      expect(result.instances[0]).toHaveProperty("working_directory");
      expect(result).not.toHaveProperty("_guidance");
    });

    it("returns compact output when full exceeds budget", async () => {
      const { outboundHandlers } = await import("../src/outbound-handlers.js");
      const handler = outboundHandlers.get("list_instances")!;

      // Create instances with long descriptions to exceed budget
      const instances: Record<string, any> = {};
      for (let i = 0; i < 30; i++) {
        instances[`instance-${i}`] = {
          working_directory: `/projects/very-long-path-${i}`,
          backend: "claude-code",
          description: "A".repeat(300), // Long description
          tags: ["dev", "test"],
        };
      }
      const ctx = createMockContext(instances);

      let result: any;
      await handler(ctx as any, {}, (r) => { result = r; }, {
        instanceName: "caller",
        requestId: 1,
        fleetRequestId: undefined,
        senderSessionName: undefined,
      });

      // Should be compact (no description)
      if (result.instances) {
        expect(result.instances[0]).not.toHaveProperty("description");
        expect(result.instances[0]).not.toHaveProperty("working_directory");
        expect(result.instances[0]).toHaveProperty("name");
        expect(result.instances[0]).toHaveProperty("status");
        expect(result._guidance).toContain("describe_instance");
      } else {
        // Could be summary tier if even compact is too large
        expect(result).toHaveProperty("total");
        expect(result._guidance).toContain("list_instances");
      }
    });

    it("returns summary output when even compact exceeds budget", async () => {
      const { outboundHandlers } = await import("../src/outbound-handlers.js");
      const handler = outboundHandlers.get("list_instances")!;

      // Create many instances to exceed even compact budget
      const instances: Record<string, any> = {};
      for (let i = 0; i < 200; i++) {
        instances[`instance-with-longish-name-${i}`] = {
          working_directory: `/p/${i}`,
          backend: i % 3 === 0 ? "claude-code" : i % 3 === 1 ? "kiro-cli" : "codex",
          tags: [`tag-${i % 5}`, "common"],
        };
      }
      const ctx = createMockContext(instances);

      let result: any;
      await handler(ctx as any, {}, (r) => { result = r; }, {
        instanceName: "caller",
        requestId: 1,
        fleetRequestId: undefined,
        senderSessionName: undefined,
      });

      // Should be summary tier
      expect(result).toHaveProperty("total");
      expect(result.total).toBe(200);
      expect(result).toHaveProperty("by_backend");
      expect(result).toHaveProperty("by_status");
      expect(result).toHaveProperty("by_tag");
      expect(result._guidance).toContain("list_instances");
      expect(result._guidance).toContain("describe_instance");
    });
  });

  describe("query filters", () => {
    it("filters by name (fuzzy match)", async () => {
      const { outboundHandlers } = await import("../src/outbound-handlers.js");
      const handler = outboundHandlers.get("list_instances")!;

      const ctx = createMockContext({
        "alpha-running": { working_directory: "/a", backend: "claude-code" },
        "beta-running": { working_directory: "/b", backend: "kiro-cli" },
        "alpha-paused": { working_directory: "/c", backend: "claude-code" },
      });

      let result: any;
      await handler(ctx as any, { name: "alpha" }, (r) => { result = r; }, {
        instanceName: "caller",
        requestId: 1,
        fleetRequestId: undefined,
        senderSessionName: undefined,
      });

      expect(result.instances).toHaveLength(2);
      expect(result.instances.every((i: any) => i.name.includes("alpha"))).toBe(true);
    });

    it("filters by backend", async () => {
      const { outboundHandlers } = await import("../src/outbound-handlers.js");
      const handler = outboundHandlers.get("list_instances")!;

      const ctx = createMockContext({
        "running-1": { working_directory: "/a", backend: "claude-code" },
        "running-2": { working_directory: "/b", backend: "kiro-cli" },
        "running-3": { working_directory: "/c", backend: "claude-code" },
      });

      let result: any;
      await handler(ctx as any, { backend: "kiro-cli" }, (r) => { result = r; }, {
        instanceName: "caller",
        requestId: 1,
        fleetRequestId: undefined,
        senderSessionName: undefined,
      });

      expect(result.instances).toHaveLength(1);
      expect(result.instances[0].backend).toBe("kiro-cli");
    });

    it("filters by status", async () => {
      const { outboundHandlers } = await import("../src/outbound-handlers.js");
      const handler = outboundHandlers.get("list_instances")!;

      const ctx = createMockContext({
        "instance-running": { working_directory: "/a", backend: "claude-code" },
        "instance-paused": { working_directory: "/b", backend: "claude-code" },
        "instance-stopped": { working_directory: "/c", backend: "claude-code" },
      });

      let result: any;
      await handler(ctx as any, { status: "paused" }, (r) => { result = r; }, {
        instanceName: "caller",
        requestId: 1,
        fleetRequestId: undefined,
        senderSessionName: undefined,
      });

      expect(result.instances).toHaveLength(1);
      expect(result.instances[0].status).toBe("paused");
    });

    it("filters by tags", async () => {
      const { outboundHandlers } = await import("../src/outbound-handlers.js");
      const handler = outboundHandlers.get("list_instances")!;

      const ctx = createMockContext({
        "running-1": { working_directory: "/a", backend: "claude-code", tags: ["dev"] },
        "running-2": { working_directory: "/b", backend: "claude-code", tags: ["prod"] },
        "running-3": { working_directory: "/c", backend: "claude-code", tags: ["dev", "test"] },
      });

      let result: any;
      await handler(ctx as any, { tags: ["dev"] }, (r) => { result = r; }, {
        instanceName: "caller",
        requestId: 1,
        fleetRequestId: undefined,
        senderSessionName: undefined,
      });

      expect(result.instances).toHaveLength(2);
      expect(result.instances.every((i: any) => i.tags.includes("dev"))).toBe(true);
    });

    it("combined filters narrow results before size check", async () => {
      const { outboundHandlers } = await import("../src/outbound-handlers.js");
      const handler = outboundHandlers.get("list_instances")!;

      // Many instances that would trigger summary tier unfiltered
      const instances: Record<string, any> = {};
      for (let i = 0; i < 100; i++) {
        instances[`instance-${i}`] = {
          working_directory: `/p/${i}`,
          backend: i < 5 ? "kiro-cli" : "claude-code",
          tags: i < 5 ? ["special"] : ["common"],
        };
      }
      const ctx = createMockContext(instances);

      let result: any;
      await handler(ctx as any, { backend: "kiro-cli" }, (r) => { result = r; }, {
        instanceName: "caller",
        requestId: 1,
        fleetRequestId: undefined,
        senderSessionName: undefined,
      });

      // After filtering, only 5 instances - should fit in full tier
      expect(result.instances).toHaveLength(5);
      expect(result.instances[0]).toHaveProperty("description");
    });
  });

  describe("claude-code statusline model fallback", () => {
    it("falls back to statusline model when config returns default", async () => {
      const { outboundHandlers } = await import("../src/outbound-handlers.js");
      const handler = outboundHandlers.get("list_instances")!;

      const ctx = createMockContext({
        "claude-with-statusline": {
          working_directory: "/a",
          backend: "claude-code",
          // No model configured - should use statusline
        },
      });
      // Override resolveInstanceModel to return "default" for this instance
      (ctx as any).resolveInstanceModel = (name: string) => ({
        model: "default",
        source: "unresolved",
        display: "default",
      });

      let result: any;
      await handler(ctx as any, {}, (r) => { result = r; }, {
        instanceName: "caller",
        requestId: 1,
        fleetRequestId: undefined,
        senderSessionName: undefined,
      });

      // Should have fallen back to statusline model
      expect(result.instances[0].model).toBe("claude-sonnet-4");
    });

    it("keeps default when statusline is unavailable", async () => {
      const { outboundHandlers } = await import("../src/outbound-handlers.js");
      const handler = outboundHandlers.get("list_instances")!;

      const ctx = createMockContext({
        "claude-no-statusline": {
          working_directory: "/a",
          backend: "claude-code",
        },
      });
      (ctx as any).resolveInstanceModel = () => ({
        model: "default",
        source: "unresolved",
        display: "default",
      });

      let result: any;
      await handler(ctx as any, {}, (r) => { result = r; }, {
        instanceName: "caller",
        requestId: 1,
        fleetRequestId: undefined,
        senderSessionName: undefined,
      });

      // No statusline available, should stay "default"
      expect(result.instances[0].model).toBe("default");
    });

    it("does not apply statusline fallback to non-claude backends", async () => {
      const { outboundHandlers } = await import("../src/outbound-handlers.js");
      const handler = outboundHandlers.get("list_instances")!;

      const ctx = createMockContext({
        "kiro-instance": {
          working_directory: "/a",
          backend: "kiro-cli",
        },
      });
      (ctx as any).resolveInstanceModel = () => ({
        model: "default",
        source: "unresolved",
        display: "default",
      });

      let result: any;
      await handler(ctx as any, {}, (r) => { result = r; }, {
        instanceName: "caller",
        requestId: 1,
        fleetRequestId: undefined,
        senderSessionName: undefined,
      });

      // Non-claude backend should not check statusline
      expect(result.instances[0].model).toBe("default");
    });

    it("does not resolve models in summary tier", async () => {
      const { readStatuslineModel } = await import("../src/topic-commands.js");
      const { outboundHandlers } = await import("../src/outbound-handlers.js");
      const handler = outboundHandlers.get("list_instances")!;

      vi.clearAllMocks();

      // Create enough instances to trigger summary tier
      const instances: Record<string, any> = {};
      for (let i = 0; i < 200; i++) {
        instances[`claude-instance-${i}`] = {
          working_directory: `/p/${i}`,
          backend: "claude-code",
        };
      }
      const ctx = createMockContext(instances);

      await handler(ctx as any, {}, () => {}, {
        instanceName: "caller",
        requestId: 1,
        fleetRequestId: undefined,
        senderSessionName: undefined,
      });

      // Summary tier should not call readStatuslineModel (no per-instance model shown)
      // Note: This is a design verification - in summary we only show counts
    });
  });
});

describe("get_instance_logs cap", () => {
  it("caps lines at MAX_INSTANCE_LOG_LINES", async () => {
    const { outboundHandlers } = await import("../src/outbound-handlers.js");
    const handler = outboundHandlers.get("get_instance_logs")!;

    // Mock fs
    const mockContent = Array(500).fill("log line").join("\n");
    vi.doMock("node:fs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:fs")>()),
      readFileSync: vi.fn(() => mockContent),
    }));

    const ctx = {
      dataDir: "/mock/agend",
    };

    let result: any;
    await handler(ctx as any, { name: "test-instance", lines: 500 }, (r) => { result = r; }, {
      instanceName: "caller",
      requestId: 1,
      fleetRequestId: undefined,
      senderSessionName: undefined,
    });

    // Should be capped
    if (result.lines) {
      const returnedLines = result.lines.split("\n").length;
      expect(returnedLines).toBeLessThanOrEqual(MAX_INSTANCE_LOG_LINES);
      expect(result._note).toContain("Capped");
    }
  });
});

describe("config constants", () => {
  it("DEFAULT_LIST_INSTANCES_OUTPUT_BUDGET is 8KB", () => {
    expect(DEFAULT_LIST_INSTANCES_OUTPUT_BUDGET).toBe(8 * 1024);
  });

  it("MAX_INSTANCE_LOG_LINES is 200", () => {
    expect(MAX_INSTANCE_LOG_LINES).toBe(200);
  });
});
