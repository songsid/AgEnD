/**
 * #1490 P3 (#13 and #48):
 *
 * #13: create_instance caps tool_set at the caller's own profile (M-3733). A worker may set worker,
 *      standard or minimal. full and coordinator stay refused. skipPermissions stays refused for every
 *      caller — same privilege boundary as update_instance_config (#804/#814).
 *
 * #48: update_instance_config must roll back the in-memory patch when
 *      saveFleetConfig throws, so memory and disk do not diverge.
 */
import { describe, expect, it, vi } from "vitest";
import { outboundHandlers } from "../src/outbound-handlers.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function createCtx(extraInstances: Record<string, unknown> = {}) {
  return {
    fleetConfig: { defaults: {}, instances: { "dev": {}, ...extraInstances } },
    classicChannels: { getAll: () => [] },
    saveFleetConfig: vi.fn(),
    lifecycle: {
      handleCreate: vi.fn().mockResolvedValue(undefined),
    },
    getWorldForInstance: vi.fn(),
    dataDir: "/tmp/fake",
    adapters: new Map(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as any;
}

const INERT_META = {
  instanceName: "dev",
  requestId: undefined,
  fleetRequestId: undefined,
  senderSessionName: undefined,
} as const;

async function callCreate(ctx: any, args: Record<string, unknown>) {
  let result: unknown;
  let error: string | null | undefined;
  await outboundHandlers.get("create_instance")!(
    ctx, args,
    (r, e) => { result = r; error = e; },
    INERT_META,
  );
  return { result, error };
}

async function callUpdate(ctx: any, config: Record<string, unknown>) {
  let result: unknown;
  let error: string | null | undefined;
  await outboundHandlers.get("update_instance_config")!(
    ctx, { name: "dev", config },
    (r, e) => { result = r; error = e; },
    INERT_META,
  );
  return { result, error };
}

// ── #13: create_instance privilege boundary ──────────────────────────────────
//
// Reverse mutation: removing the cap lets tool_set full reach lifecycle.handleCreate.
// Inverting toolSetAboveCap (`<` to `<=`) refuses an equal profile, so "worker may set worker" goes red.

describe("create_instance: tool_set cap and skipPermissions (#1490 P3 #13, M-3733)", () => {
  it("refuses tool_set (string value)", async () => {
    const ctx = createCtx();
    const { result, error } = await callCreate(ctx, {
      directory: "/tmp/proj",
      tool_set: "full",
    });
    expect(error).toMatch(/privilege boundary/);
    expect(result).toBeNull();
    expect(ctx.lifecycle.handleCreate).not.toHaveBeenCalled();
  });

  it("refuses tool_set: 'coordinator'", async () => {
    const ctx = createCtx();
    const { result, error } = await callCreate(ctx, {
      directory: "/tmp/proj",
      tool_set: "coordinator",
    });
    expect(error).toMatch(/privilege boundary/);
    expect(ctx.lifecycle.handleCreate).not.toHaveBeenCalled();
  });

  it.each(["worker", "standard", "minimal"])("a worker may set tool_set %s", async (tool_set) => {
    const ctx = createCtx();
    const { error } = await callCreate(ctx, {
      directory: "/tmp/proj",
      topic_name: "child",
      tool_set,
    });
    expect(error).toBeUndefined();
    expect(ctx.lifecycle.handleCreate).toHaveBeenCalledOnce();
  });

  it("refuses skipPermissions: false", async () => {
    const ctx = createCtx();
    const { result, error } = await callCreate(ctx, {
      directory: "/tmp/proj",
      skipPermissions: false,
    });
    expect(error).toMatch(/privilege boundary/);
    expect(ctx.lifecycle.handleCreate).not.toHaveBeenCalled();
  });

  it("refuses skipPermissions: true", async () => {
    const ctx = createCtx();
    const { result, error } = await callCreate(ctx, {
      directory: "/tmp/proj",
      skipPermissions: true,
    });
    expect(error).toMatch(/privilege boundary/);
    expect(ctx.lifecycle.handleCreate).not.toHaveBeenCalled();
  });

  it("names the caller's cap when tool_set is above it", async () => {
    const ctx = createCtx();
    const { error } = await callCreate(ctx, { tool_set: "full" });
    expect(error).toMatch(/highest profile this agent can set is worker/);
    expect(error).toMatch(/privilege boundary, #804\/#814/);
  });

  it("create_instance without tool_set/skipPermissions proceeds normally (no regression)", async () => {
    const ctx = createCtx();
    ctx.lifecycle.handleCreate = vi.fn().mockResolvedValue(undefined);
    await callCreate(ctx, { directory: "/tmp/proj", topic_name: "my-agent" });
    // No refusal: handleCreate was called (or some other downstream path)
    expect(ctx.lifecycle.handleCreate).toHaveBeenCalled();
  });
});

// ── #48: update_instance_config rolls back on save failure ───────────────────
//
// Reverse mutation: removing rollback() from the saveFleetConfig catch block
// makes test 8 fail because memory has the new model but disk (saveFleetConfig)
// was never saved and the error is returned — the caller would find inst.model
// changed even though the save failed.

describe("update_instance_config: rollback memory on save failure (#1490 P3 #48)", () => {
  it("rolls back in-memory patch when saveFleetConfig throws", async () => {
    const ctx = createCtx();
    // Capture the inst reference before the call
    const inst = ctx.fleetConfig.instances["dev"];
    const originalModel = inst.model; // undefined
    ctx.saveFleetConfig = vi.fn(() => { throw new Error("disk full"); });

    const { error } = await callUpdate(ctx, { model: "new-model" });

    expect(error).toMatch(/disk full/);
    // Memory must be rolled back — the model must not be persisted in memory
    expect(inst.model).toBe(originalModel); // still undefined
  });

  it("does NOT rollback when save succeeds", async () => {
    const ctx = createCtx();
    const inst = ctx.fleetConfig.instances["dev"];
    ctx.saveFleetConfig = vi.fn(); // succeeds

    await callUpdate(ctx, { model: "new-model" });

    expect(inst.model).toBe("new-model");
  });
});
