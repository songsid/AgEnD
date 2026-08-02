import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

/**
 * "reply 之後按鈕失效" — a click that did nothing at all.
 *
 * Every reply re-posts the cancel button, and sendCancelButton used to delete
 * the old one *before* awaiting the new one. For the length of a chat API round
 * trip the instance had no tracked button while the old message was still on
 * screen, and the click handler acted only while an entry existed — so a click
 * in that window was dropped with no cancel, no message and no log line. A
 * failed post left the instance with no button at all.
 *
 * Two changes, tested here: post before retiring, and honour a click on an
 * untracked button when the instance is genuinely running.
 */

type Internals = {
  getInstanceStatus(name: string): string;
  lifecycle: { isPaused(name: string): boolean };
  cancelButtons: Map<string, { instanceName: string; messageId: string; retiring?: boolean }>;
  daemons: Map<string, unknown>;
  sendCancelButton(name: string): Promise<void>;
  handleCancelClick(name: string, adapter: unknown, data: unknown): void;
  hasCancelButton(name: string): boolean;
  deleteButtonMessage(entry: unknown): Promise<void>;
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
};

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeFleet(notifyAlert: ReturnType<typeof vi.fn>) {
  const dir = mkdtempSync(join(tmpdir(), "agend-btn-swap-"));
  dirs.push(dir);
  const fm = new FleetManager(dir);
  const internals = fm as unknown as Internals;
  internals.lifecycle.isPaused = () => false;
  internals.getInstanceStatus = () => "running";
  (fm as unknown as { fleetConfig: unknown }).fleetConfig = {
    defaults: {}, channel: { group_id: "g1" },
    instances: { alpha: { working_directory: "/tmp", topic_id: "123" } },
  };
  (fm as unknown as { adapter: unknown }).adapter = { notifyAlert, editMessage: vi.fn().mockResolvedValue(undefined) };
  return { fm, internals };
}

describe("replacing a button never leaves the instance without one", () => {
  it("posts the new button before retiring the old", async () => {
    const order: string[] = [];
    let n = 0;
    const notifyAlert = vi.fn(async () => { order.push("post"); return { messageId: `m${++n}`, chatId: "g1", threadId: "123" }; });
    const { fm, internals } = makeFleet(notifyAlert);
    internals.deleteButtonMessage = vi.fn(async () => { order.push("delete"); });

    await internals.sendCancelButton("alpha");
    order.length = 0;
    await internals.sendCancelButton("alpha");   // the re-post a reply triggers

    expect(order).toEqual(["post", "delete"]);
  });

  it("keeps exactly one live entry — the newest", async () => {
    let n = 0;
    const notifyAlert = vi.fn(async () => ({ messageId: `m${++n}`, chatId: "g1", threadId: "123" }));
    const { internals } = makeFleet(notifyAlert);
    internals.deleteButtonMessage = vi.fn().mockResolvedValue(undefined);

    await internals.sendCancelButton("alpha");
    await internals.sendCancelButton("alpha");
    await internals.sendCancelButton("alpha");

    const live = [...internals.cancelButtons.values()].filter(e => e.instanceName === "alpha");
    expect(live).toHaveLength(1);
    expect(live[0].messageId).toBe("m3");
  });

  it("keeps the old button when posting the new one fails", async () => {
    // Retiring first meant a failed post left nothing at all: the user's button
    // vanished and no cancel was possible until the next turn.
    let n = 0;
    const notifyAlert = vi.fn()
      .mockImplementationOnce(async () => ({ messageId: `m${++n}`, chatId: "g1", threadId: "123" }))
      .mockRejectedValueOnce(new Error("discord 500"));
    const { internals } = makeFleet(notifyAlert);
    internals.deleteButtonMessage = vi.fn().mockResolvedValue(undefined);

    await internals.sendCancelButton("alpha");
    await internals.sendCancelButton("alpha");

    expect(internals.hasCancelButton("alpha")).toBe(true);
  });

  it("never reports zero buttons while a replacement is in flight", async () => {
    // The window the silent click fell into. Only the *replacement* is under
    // test — before the first send there is legitimately no button.
    let watching = false;
    let seenEmpty = false;
    let n = 0;
    const notifyAlert = vi.fn(async () => {
      // Not just "an entry exists": one already being deleted is on its way off
      // the screen. The window under test is "nothing the user can still press".
      if (watching) {
        seenEmpty ||= ![...internals.cancelButtons.values()]
          .some(e => e.instanceName === "alpha" && !e.retiring);
      }
      return { messageId: `m${++n}`, chatId: "g1", threadId: "123" };
    });
    const { internals } = makeFleet(notifyAlert);
    internals.deleteButtonMessage = vi.fn().mockResolvedValue(undefined);

    await internals.sendCancelButton("alpha");
    watching = true;
    await internals.sendCancelButton("alpha");

    expect(seenEmpty).toBe(false);
  });
});

describe("a click on a button the fleet no longer tracks", () => {
  const clickData = { chatId: "g1", messageId: "old-msg", threadId: "123" };

  it("still cancels when the instance is running", () => {
    const { fm, internals } = makeFleet(vi.fn());
    const sendEscape = vi.fn().mockResolvedValue(undefined);
    internals.daemons.set("alpha", { sendEscape });

    internals.handleCancelClick("alpha", (fm as unknown as { adapter: unknown }).adapter, clickData);

    expect(sendEscape).toHaveBeenCalledOnce();
  });

  it("tells the user the button expired when there is nothing to cancel", () => {
    const { fm, internals } = makeFleet(vi.fn());
    const adapter = (fm as unknown as { adapter: { editMessage: ReturnType<typeof vi.fn> } }).adapter;

    internals.handleCancelClick("alpha", adapter, clickData);   // no daemon

    // Silence here is what made a dead button indistinguishable from a bug.
    expect(adapter.editMessage).toHaveBeenCalledWith(
      "g1", "old-msg", expect.stringContaining("alpha"), "123",
    );
  });

  it("does not fire a second interrupt on a double click", () => {
    // The original guard's real concern: an instance that has already begun a
    // new turn must not be interrupted by a stale second click.
    const { fm, internals } = makeFleet(vi.fn());
    const sendEscape = vi.fn().mockResolvedValue(undefined);
    internals.daemons.set("alpha", { sendEscape });
    const adapter = (fm as unknown as { adapter: unknown }).adapter;

    internals.handleCancelClick("alpha", adapter, clickData);
    internals.handleCancelClick("alpha", adapter, clickData);
    internals.handleCancelClick("alpha", adapter, clickData);

    expect(sendEscape).toHaveBeenCalledOnce();
  });

  it("takes the normal path while the button is live", async () => {
    let n = 0;
    const notifyAlert = vi.fn(async () => ({ messageId: `m${++n}`, chatId: "g1", threadId: "123" }));
    const { fm, internals } = makeFleet(notifyAlert);
    internals.deleteButtonMessage = vi.fn().mockResolvedValue(undefined);
    const sendEscape = vi.fn().mockResolvedValue(undefined);
    internals.daemons.set("alpha", { sendEscape });
    await internals.sendCancelButton("alpha");

    internals.handleCancelClick("alpha", (fm as unknown as { adapter: unknown }).adapter, clickData);

    expect(sendEscape).toHaveBeenCalledOnce();
    // The delete resolves on a microtask, so let the retire settle first.
    await vi.waitFor(() => expect(internals.hasCancelButton("alpha")).toBe(false));
  });
});
