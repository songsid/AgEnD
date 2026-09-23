import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "🔄 Refresh models" at the top of /model (#886).
 *
 * A vendor ships a model and the picker keeps serving the cached list. The
 * refresh item has to go past BOTH caches — AgEnD's cli-env cache and, for a
 * backend that only reads a catalog file its CLI maintains, the CLI's own —
 * and redraw the menu. A failed refresh must keep the old list and say so,
 * never blank the menu.
 *
 * The backend factory is mocked so the probe is deterministic: `probeCLIEnv`
 * answers with LIVE, and `refreshModelCatalog` is the CLI-side refetch.
 */
const LIVE = [{ id: "gpt-6-astra", label: "GPT-6 Astra" }, { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }];
const CACHED = [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }];

const probeCLIEnv = vi.fn();
const refreshModelCatalog = vi.fn();
vi.mock("../src/backend/factory.js", () => ({
  createBackend: () => ({ probeCLIEnv, refreshModelCatalog }),
}));

const { FleetManager } = await import("../src/fleet-manager.js");

// Under the vitest-injected AGEND_HOME, which the config removes at exit.
const agendHome = process.env.AGEND_HOME as string;
let dataDir: string;

function seedCache(backend: string, models: Array<{ id: string; label: string }>, ageMs = 0) {
  mkdirSync(join(agendHome, "cli-env"), { recursive: true });
  writeFileSync(join(agendHome, "cli-env", `${backend}.json`),
    JSON.stringify({ backend, models, probedAt: Date.now() - ageMs }));
}

function setup(backend = "codex") {
  const fm = new FleetManager(dataDir);
  fm.fleetConfig = { defaults: {}, instances: { worker: { working_directory: "/tmp", backend } } } as any;
  const promptUser = vi.fn().mockResolvedValue("menu-1");
  const sendText = vi.fn().mockResolvedValue({ messageId: "m1" });
  const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
  const adapter = { id: "telegram", type: "telegram", promptUser, sendText, editMessageRemoveButtons } as any;
  return { fm, adapter, promptUser, sendText };
}

const ids = (choices: Array<{ id: string }>) => choices.map(c => c.id.split(":").slice(2).join(":"));

async function openAndRefresh(ctx: ReturnType<typeof setup>) {
  await ctx.fm.promptModelMenu("worker", "admin", "chan", ctx.adapter, "chat", "topic");
  const refreshId = (ctx.promptUser.mock.calls[0][2] as Array<{ id: string }>)[0].id;
  const consumed = await (ctx.fm as any).handleModelSelection({
    callbackData: refreshId, userId: "admin", chatId: "chan", threadId: undefined, messageId: "menu-1",
  });
  expect(consumed).toBe(true);
  return {
    text: ctx.promptUser.mock.calls[1]?.[1] as string | undefined,
    choices: ctx.promptUser.mock.calls[1]?.[2] as Array<{ id: string; label: string }> | undefined,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(agendHome, "model-refresh-data-"));
  rmSync(join(agendHome, "cli-env"), { recursive: true, force: true });
  probeCLIEnv.mockReset().mockResolvedValue({ models: LIVE });
  refreshModelCatalog.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("the /model picker's refresh item", () => {
  it("comes first, and the cached menu is otherwise unchanged", async () => {
    // A fresh cache: opening the menu must not probe at all, exactly as before.
    seedCache("codex", CACHED);
    const ctx = setup();

    await ctx.fm.promptModelMenu("worker", "admin", "chan", ctx.adapter, "chat", "topic");

    const choices = ctx.promptUser.mock.calls[0][2] as Array<{ id: string; label: string }>;
    expect(ids(choices)[0]).toBe("__refresh__");
    expect(choices[0].label).toContain("🔄");
    expect(ids(choices).slice(1)).toEqual(["gpt-5.6-sol"]);
    expect(probeCLIEnv, "the cached path must not start a probe").not.toHaveBeenCalled();
  });

  it("re-probes past a FRESH cache, and past the CLI's own catalog, then redraws with the live list", async () => {
    // The cache is minutes old — well inside the window the normal menu trusts —
    // so only a refresh that really bypasses it can reach the new model.
    seedCache("codex", CACHED);
    const ctx = setup();

    const redrawn = await openAndRefresh(ctx);

    expect(refreshModelCatalog, "the CLI-side catalog must be refetched too").toHaveBeenCalledTimes(1);
    expect(refreshModelCatalog.mock.invocationCallOrder[0])
      .toBeLessThan(probeCLIEnv.mock.invocationCallOrder[0]);
    expect(ids(redrawn.choices!)).toEqual(["__refresh__", "gpt-6-astra", "gpt-5.6-sol"]);
    expect(redrawn.text).toContain("refreshed");
    // The new rows are selectable: a pending entry exists for the redrawn menu.
    expect((ctx.fm as any).pendingModelSelects.size).toBe(1);
  });

  it("keeps the previous list and says so when the refresh fails", async () => {
    seedCache("codex", CACHED);
    refreshModelCatalog.mockRejectedValue(new Error("failed to fetch models"));
    const ctx = setup();

    const redrawn = await openAndRefresh(ctx);

    expect(redrawn.choices, "a failed refresh must still draw a menu").toBeDefined();
    expect(ids(redrawn.choices!)).toEqual(["__refresh__", "gpt-5.6-sol"]);
    expect(redrawn.text).toContain("Could not refresh");
  });

  it("does not refetch the CLI's catalog on an ordinary probe", async () => {
    // The vendor refresh is the button's alone. Startup and the stale-cache
    // re-probe keep the behaviour they had.
    const ctx = setup();

    await (ctx.fm as any).probeBackend("codex");

    expect(probeCLIEnv).toHaveBeenCalledTimes(1);
    expect(refreshModelCatalog).not.toHaveBeenCalled();
  });

  it("fits inside Discord's 25-option cap with refresh first and more-models last", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, label: `m${i}` }));
    seedCache("claude-code", many);
    const ctx = setup("claude-code");

    await ctx.fm.promptModelMenu("worker", "admin", "chan", ctx.adapter, "chat", "topic");

    const choices = ids(ctx.promptUser.mock.calls[0][2]);
    expect(choices).toHaveLength(25);
    expect(choices[0]).toBe("__refresh__");
    expect(choices.at(-1)).toBe("__more__");
  });

  it("appears first in the Discord slash menu too", async () => {
    seedCache("codex", CACHED);
    const ctx = setup();
    vi.spyOn(ctx.fm as any, "isModelAdmin").mockReturnValue(true);
    vi.spyOn(ctx.fm as any, "resolveSlashTarget").mockReturnValue("worker");
    const respondChoices = vi.fn().mockResolvedValue("menu");

    await (ctx.fm as any).handleModelSlash({
      userId: "admin", channelId: "chan", options: {}, text: "",
      respond: vi.fn().mockResolvedValue(undefined), respondChoices,
    }, "discord");

    expect(ids(respondChoices.mock.calls[0][1])[0]).toBe("__refresh__");
  });
});
