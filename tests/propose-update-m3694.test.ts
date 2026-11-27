// M-3694 (S-265): General proposes an AgEnD update — when the agents are idle, or at a time — and nothing changes until
// a fleet admin presses Confirm on the card in General. The Confirm answers the fleet's one update card
// (UpdateOfferCard.answer, as its own buttons and the web do), so pin, pause, preflight and the idle wait still apply;
// a newer offer since the card voids it. Nothing real is started.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { outboundHandlers } from "../src/outbound-handlers.js";

const rigs: any[] = [];
afterEach(() => { for (const r of rigs.splice(0)) for (const e of r.fm.pendingNonceButtons.values()) clearTimeout(e.timer); vi.restoreAllMocks(); });

function rig(o: { pin?: boolean; state?: string; version?: string } = {}) {
  const adapter: any = { id: "demo", type: "discord", getBotUserId: () => "fake-bot",
    notifyAlert: vi.fn(async () => ({ chatId: "channel", messageId: "prompt", threadId: "thread" })), editMessageRemoveButtons: vi.fn(async () => {}) };
  let offer: any = { version: o.version ?? "2.5.1", state: o.state ?? "offered", channel: "beta", installable: true };
  const answer = vi.fn(async () => ({ ok: true, status: 200, body: {} }));
  const fm: any = Object.assign(Object.create(FleetManager.prototype), {
    fleetConfig: { defaults: {}, instances: { general: { general_topic: true }, worker: {} }, updates: o.pin ? { pin: "2.5.0" } : {} },
    pendingNonceButtons: new Map(), adapters: new Map([["demo", adapter]]), webPromptClicks: new WeakSet(), webPromptClaims: new WeakSet(),
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() }, renderPlaces: (_id: string, text: string) => ({ text, opts: {} }),
    webPromptGone: vi.fn(), collapseNoncePrompt: vi.fn(async () => {}), retireNonceButtons: vi.fn(async () => {}),
    updateOfferView: () => offer, runningAgendVersion: () => "2.5.0", usageZone: () => "Asia/Taipei",
    updateChatCardPlace: () => ({ general: "general", adapter, adapterId: "demo", chatId: "channel", threadId: "thread" }),
    ensureUpdateCard: () => ({ answer }), syncUpdateChatCard: vi.fn(async () => {}), updateChatCardText: () => "AgEnD 2.5.1 will update when your agents are idle.",
    isFleetAdmin: (userId: string) => userId === "fake-admin", pendingUpdateAsks: new Map(),
  });
  const propose = (at?: string, caller = "general") => new Promise<{ result: any; error?: string }>(resolve => {
    void outboundHandlers.get("propose_update")!(fm, (at === undefined ? {} : { at }) as never, (result, error) => resolve({ result, error }), { instanceName: caller } as never);
  });
  const card = () => [...fm.pendingNonceButtons.values()].at(-1);
  const click = (entry: any, action = "confirm", userId = "fake-admin") => fm.handleUpdateAskCallback({ callbackData: `update-ask:${entry.nonce}:${action}`, chatId: entry.chatId,
    messageId: entry.messageId, threadId: entry.threadId, userId, username: "Demo admin", ack: vi.fn() }, "demo", adapter);
  const r = { fm, adapter, answer, propose, card, click, setOffer: (v: any) => { offer = v; } };
  rigs.push(r);
  return r;
}

describe("M-3694 S-265: propose_update", () => {
  it("when idle: the card asks a fleet admin; proposing changes nothing; the admin's Confirm answers the update card (when-idle)", async () => {
    const r = rig();
    expect((await r.propose()).result).toEqual({ status: "awaiting_admin_confirmation", note: "Asked: a fleet admin confirms the card in General (15 min)." });
    const text = JSON.stringify(r.adapter.notifyAlert.mock.calls[0]![1]);
    expect(text).toContain("General asks to update AgEnD to 2.5.1 (you have 2.5.0), when your agents are idle.");
    expect(r.answer).not.toHaveBeenCalled();
    const e = r.card();
    await r.click(e, "confirm", "fake-someone");                                                    // not a fleet admin
    expect(r.answer).not.toHaveBeenCalled();
    await r.click(e);
    expect(r.answer).toHaveBeenCalledWith(`general-${e.nonce}`, "Demo admin", { action: "when-idle" });
    expect(r.fm.syncUpdateChatCard).toHaveBeenCalled();
  });

  it("at a time: the card names it; the Confirm answers pick-time with that instant", async () => {
    const r = rig();
    const at = new Date(Date.now() + 3 * 3600_000);
    await r.propose(at.toISOString());
    expect(JSON.stringify(r.adapter.notifyAlert.mock.calls[0]![1])).toMatch(/General asks to update AgEnD to 2\.5\.1 \(you have 2\.5\.0\), at .+\. It still waits/);
    await r.click(r.card());
    expect(r.answer).toHaveBeenCalledWith(expect.any(String), "Demo admin", { action: "pick-time", at: at.getTime() });
  });

  it("#4560 F1: a person's answer since the proposal (a time picked on the web) stands; the admin's Confirm of General's card answers nothing", async () => {
    const r = rig();
    await r.propose();
    r.setOffer({ version: "2.5.1", state: "scheduled", scheduledAt: Date.now() + 3600_000, channel: "beta", installable: true, lastAnswer: { action: "pick-time", at: Date.now(), by: "Demo person" } });
    await r.click(r.card());
    expect(r.answer).not.toHaveBeenCalled();
    expect(r.fm.retireNonceButtons).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "Not applied: the update offer changed since this proposal (someone answered it, or a newer version came). Nothing was changed.");
    // Moved on with no answer recorded (the Hub's queue took it to waiting): voided by its state alone.
    const q = rig();
    await q.propose();
    q.setOffer({ version: "2.5.1", state: "waiting-idle", channel: "beta", installable: true });
    await q.click(q.card());
    expect(q.answer).not.toHaveBeenCalled();
    // Same state but answered again since (Not now → offered by a later answer): voided too.
    const s = rig({ state: "not-now" });
    await s.propose();
    s.setOffer({ version: "2.5.1", state: "not-now", channel: "beta", installable: true, lastAnswer: { action: "not-now", at: Date.now() + 1, by: "Demo person" } });
    await s.click(s.card());
    expect(s.answer).not.toHaveBeenCalled();
  });

  it("a newer offer since the card voids it; Cancel answers nothing", async () => {
    const r = rig();
    await r.propose();
    r.setOffer({ version: "2.5.2", state: "offered", channel: "beta", installable: true });
    await r.click(r.card());
    expect(r.answer).not.toHaveBeenCalled();
    const s = rig();
    await s.propose();
    await s.click(s.card(), "cancel");
    expect(s.answer).not.toHaveBeenCalled();
  });

  it("refused, with a sentence and no card: not General, pinned, nothing offered (or already waiting), a bad or far time", async () => {
    expect((await rig().propose(undefined, "worker")).error).toBe("Only General can propose an update.");
    expect((await rig({ pin: true }).propose()).error).toBe("Updates are pinned. Nothing is offered until the pin is removed.");
    const waiting = rig({ state: "waiting-idle" });
    waiting.fm.describeUpdateOffer = () => "AgEnD 2.5.1 will update when your agents are idle.";
    expect((await waiting.propose()).error).toBe("Nothing to propose: AgEnD 2.5.1 will update when your agents are idle.");
    expect((await rig().propose("tomorrow")).error).toBe("Not proposed: `at` must be an ISO date and time, e.g. 2026-11-28T03:00:00+08:00.");
    expect((await rig().propose(new Date(Date.now() + 8 * 86400_000).toISOString())).error).toBe("Not proposed: the time must be in the future, within 7 days.");
    expect((await rig().propose(new Date(Date.now() - 60_000).toISOString())).error).toBe("Not proposed: the time must be in the future, within 7 days.");
  });
});
