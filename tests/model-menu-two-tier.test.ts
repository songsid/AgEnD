import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { FleetManager } from "../src/fleet-manager.js";

describe("/model two-tier menu", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(tmpdir(), `model-menu-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  function setup(backend = "claude-code") {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = {
      defaults: {},
      instances: { worker: { working_directory: "/tmp", backend } },
    } as any;
    const promptUser = vi.fn().mockResolvedValue("menu-1");
    const sendText = vi.fn().mockResolvedValue({ messageId: "m1" });
    const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
    const adapter = { id: "discord", type: "discord", promptUser, sendText, editMessageRemoveButtons } as any;
    vi.spyOn(fm as any, "getModelOptions").mockResolvedValue([
      { id: "default", label: "default" }, { id: "sonnet", label: "sonnet" }, { id: "opus", label: "opus" },
    ]);
    return { fm, adapter, promptUser, sendText };
  }

  it("tier 1 for claude ends with the more-models entry; other backends do not get it", async () => {
    const { fm, adapter, promptUser } = setup();
    expect(await fm.promptModelMenu("worker", "admin", "chan", adapter, "chat", "topic")).toBeNull();
    const choices = promptUser.mock.calls[0][2] as Array<{ id: string; label: string }>;
    expect(choices.at(-1)!.id).toMatch(/^model-select:[0-9a-f]{12}:__more__$/);

    const other = setup("kiro-cli");
    await other.fm.promptModelMenu("worker", "admin", "chan", other.adapter, "chat", "topic");
    const otherChoices = other.promptUser.mock.calls[0][2] as Array<{ id: string }>;
    expect(otherChoices.some(c => c.id.endsWith(":__more__"))).toBe(false);
  });

  it("selecting more-models swaps in the API catalog with [1m] variants (TG path)", async () => {
    const { fm, adapter, promptUser } = setup();
    vi.spyOn(fm as any, "claudeApiModelOptions").mockResolvedValue([
      { id: "claude-opus-5", label: "claude-opus-5" },
      { id: "claude-opus-5[1m]", label: "claude-opus-5[1m]" },
    ]);
    await fm.promptModelMenu("worker", "admin", "chan", adapter, "chat", "topic");
    const moreId = (promptUser.mock.calls[0][2] as Array<{ id: string }>).at(-1)!.id;

    const consumed = await (fm as any).handleModelSelection({
      callbackData: moreId, userId: "admin", chatId: "chan", threadId: undefined, messageId: "menu-1",
    });
    expect(consumed).toBe(true);
    expect(promptUser).toHaveBeenCalledTimes(2);
    const expanded = promptUser.mock.calls[1][2] as Array<{ id: string; label: string }>;
    expect(expanded.map(c => c.id.split(":")[2])).toEqual(["claude-opus-5", "claude-opus-5[1m]"]);
    // The expanded entries are selectable: a fresh pending exists for the new nonce.
    expect((fm as any).pendingModelSelects.size).toBe(1);
  });

  it("empty API catalog degrades to the unavailable notice, aliases untouched", async () => {
    const { fm, adapter, promptUser, sendText } = setup();
    vi.spyOn(fm as any, "claudeApiModelOptions").mockResolvedValue([]);
    await fm.promptModelMenu("worker", "admin", "chan", adapter, "chat", "topic");
    const moreId = (promptUser.mock.calls[0][2] as Array<{ id: string }>).at(-1)!.id;
    await (fm as any).handleModelSelection({
      callbackData: moreId, userId: "admin", chatId: "chan", threadId: undefined, messageId: "menu-1",
    });
    expect(promptUser).toHaveBeenCalledTimes(1); // no second menu
    expect(String(sendText.mock.calls.at(-1)![1])).toContain("/model");
  });

  it("Discord select path re-renders through respondChoices on the same reply", async () => {
    const { fm } = setup();
    vi.spyOn(fm as any, "claudeApiModelOptions").mockResolvedValue([
      { id: "claude-sonnet-5", label: "claude-sonnet-5" },
    ]);
    const respond = vi.fn().mockResolvedValue(undefined);
    const respondChoices = vi.fn().mockResolvedValue("edited");
    await (fm as any).expandClaudeModelMenu({
      instanceName: "worker", userId: "admin", channelId: "chan", respond, respondChoices,
    });
    expect(respondChoices).toHaveBeenCalledTimes(1);
    const choices = respondChoices.mock.calls[0][1] as Array<{ id: string }>;
    expect(choices[0].id).toMatch(/^model-select:[0-9a-f]{12}:claude-sonnet-5$/);
    expect(respond).not.toHaveBeenCalled();
  });
});
