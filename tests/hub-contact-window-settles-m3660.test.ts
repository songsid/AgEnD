/**
 * M-3660 (live on the beta.21 host): a Hub-shared agent's answer to hub-19a46113 was refused ("no longer open": the
 * release came back stale), so the question was held — but its contact window stayed, and for its remaining 30 minutes
 * every send_to_instance / report_result to an agent was refused in every turn, though no Hub question was open.
 * A window now ends as soon as its question is no longer being answered; one that is still open keeps the refusal.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HubContactWindows } from "../src/hub-contact-windows.js";
import { FleetManager } from "../src/fleet-manager.js";
import { outboundHandlers } from "../src/outbound-handlers.js";

function withDir(run: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-contact-m3660-"));
    try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

describe("HubContactWindows with a settled-question reader (M-3660)", () => {
  it("a settled question no longer restricts; an open one still does", withDir(dir => {
    const windows = new HubContactWindows(join(dir, "w.json"), () => 0);
    windows.begin("worker", "hub-old");
    const settled = new Set(["hub-old"]);
    const reader = (_agent: string, cid: string) => settled.has(cid);
    expect(windows.restricted("worker", reader)).toBe(false);
    windows.begin("worker", "hub-new"); // a genuinely open answer turn
    expect(windows.restricted("worker", reader)).toBe(true);
    settled.add("hub-new");
    expect(windows.restricted("worker", reader)).toBe(false);
  }));

  it("no reader, a reader that throws, or one that cannot say: the window holds (fail closed)", withDir(dir => {
    const windows = new HubContactWindows(join(dir, "w.json"), () => 0);
    windows.begin("worker", "hub-old");
    expect(windows.restricted("worker")).toBe(true);
    expect(windows.restricted("worker", () => { throw new Error("db closed"); })).toBe(true);
    expect(windows.restricted("worker", () => false)).toBe(true);
  }));
});

describe("FleetManager: the contact window ends when its question settles, across turns (M-3660)", () => {
  it("held after a refused report: the window holds while that answer turn still works, ends with the turn, and no later turn is refused", withDir(async dir => {
    const fm = new FleetManager(dir);
    try {
      (fm as any).fleetConfig = { instances: { worker: {} } };
      vi.spyOn(fm, "deliverToInstance").mockImplementation(async (_name, _payload, options) => { await options?.beforeInput?.(); return true; });
      await (fm as any).deliverHubQuestion({ agent: "worker", correlationId: "hub-19a46113", text: "Q", stillCurrent: () => true, beforeInput: async () => true });
      (fm as any).hubQuestionInput("worker", "hub-19a46113");   // the daemon writes it into the idle pane
      const state = new Map<string, "open" | "held">([["hub-19a46113", "open"]]);
      // What the member service attaches (attachQuestionSettled): the representative's row state.
      (fm as any).hubQuestionSettled = (_agent: string, cid: string) => state.get(cid) === "held";
      expect(fm.hubContactRestricted("worker")).toBe(true); // answering now: refused, as before
      // The answer was refused as "no longer open" (the question is held), not ok: the window was never closed.
      (fm as any).hubReports = () => Promise.resolve({ ok: false, message: "Not delivered to the Hub asker: the question is no longer open" });
      await fm.hubReport({ caller: "worker", correlationId: "hub-19a46113", text: "answer", callerCurrent: () => true });
      state.set("hub-19a46113", "held");
      // M-3660 review: the turn is still working on the asker's text — settling (a hold, expiry, revoke) lifts nothing yet.
      expect(fm.hubContactRestricted("worker")).toBe(true);
      expect(fm.hubContactQuestion("worker")).toBe("hub-19a46113");
      (fm as any).hubQuestionTurnEnded("worker", "hub-19a46113");
      expect(fm.hubContactRestricted("worker")).toBe(false); // the turn is over: every later turn may contact agents
      // A new question in progress restricts again, and only it.
      state.set("hub-2006708e", "open");
      await (fm as any).deliverHubQuestion({ agent: "worker", correlationId: "hub-2006708e", text: "Q2", stillCurrent: () => true, beforeInput: async () => true });
      (fm as any).hubQuestionInput("worker", "hub-2006708e");
      expect(fm.hubContactRestricted("worker")).toBe(true);
      expect(fm.hubContactRestricted("peer")).toBe(false);
    } finally { fm.stormWindow.shutdown(); }
  }));

  it("with no member service attached the window holds until it expires (the question's fate is unknown)", withDir(async dir => {
    const fm = new FleetManager(dir);
    try {
      (fm as any).fleetConfig = { instances: { worker: {} } };
      vi.spyOn(fm, "deliverToInstance").mockImplementation(async (_name, _payload, options) => { await options?.beforeInput?.(); return true; });
      await (fm as any).deliverHubQuestion({ agent: "worker", correlationId: "hub-x", text: "Q", stillCurrent: () => true, beforeInput: async () => true });
      (fm as any).hubQuestionInput("worker", "hub-x");
      expect((fm as any).hubQuestionSettled).toBeNull();
      expect(fm.hubContactRestricted("worker")).toBe(true);
    } finally { fm.stormWindow.shutdown(); }
  }));
});

describe("FleetManager: the window covers only the Hub answer turn (M-3660)", () => {
  it("a question waiting behind the owner's turn blocks nothing; its own turn does; the turn's end lifts it, answered or not", withDir(async dir => {
    const fm = new FleetManager(dir);
    try {
      (fm as any).fleetConfig = { instances: { worker: {} } };
      vi.spyOn(fm, "deliverToInstance").mockImplementation(async (_name, _payload, options) => { await options?.beforeInput?.(); return true; });
      await (fm as any).deliverHubQuestion({ agent: "worker", correlationId: "hub-q1", text: "Q", stillCurrent: () => true, beforeInput: async () => true });
      expect(fm.hubContactRestricted("worker")).toBe(false);   // the owner's / fleet's turn is still running: never blocked
      (fm as any).hubQuestionInput("worker", "hub-q1");        // the daemon writes it into the idle pane: its own turn
      expect(fm.hubContactRestricted("worker")).toBe(true);    // inside the answer turn: refused, with the reason
      (fm as any).hubQuestionTurnEnded("worker", "hub-q1");    // the turn is over (it did not even answer)
      expect(fm.hubContactRestricted("worker")).toBe(false);   // the next turn (owner, fleet) may contact agents
    } finally { fm.stormWindow.shutdown(); }
  }));

  it("an accepted answer inside its own running turn does not lift it; the turn's end does", withDir(async dir => {
    const fm = new FleetManager(dir);
    try {
      (fm as any).hubQuestionInput("worker", "hub-q2");
      (fm as any).hubQuestionSettled = () => true;             // released: the Hub has the answer
      (fm as any).hubReports = () => Promise.resolve({ ok: true });
      await fm.hubReport({ caller: "worker", correlationId: "hub-q2", text: "answer", callerCurrent: () => true });
      expect(fm.hubContactRestricted("worker")).toBe(true);    // the same turn may still be working on the asker's text
      (fm as any).hubQuestionTurnEnded("worker", "hub-q2");
      expect(fm.hubContactRestricted("worker")).toBe(false);
    } finally { fm.stormWindow.shutdown(); }
  }));

  it("lost signals are made good on reconnect: a dropped end (no turn running) and a dropped input (one running)", withDir(async dir => {
    const fm = new FleetManager(dir);
    try {
      (fm as any).hubQuestionInput("worker", "hub-old");       // its hub_question_turn_ended never arrived
      expect(fm.hubContactRestricted("worker")).toBe(true);
      (fm as any).hubQuestionTurnState("worker", null);        // the daemon, on (re)connect: no Hub turn running
      expect(fm.hubContactRestricted("worker")).toBe(false);
      (fm as any).hubQuestionTurnState("worker", "hub-new", true);   // its hub_question_input was lost; the turn runs
      expect(fm.hubContactRestricted("worker")).toBe(true);
      expect(fm.hubContactQuestion("worker")).toBe("hub-new");
      (fm as any).hubQuestionInput("worker", "hub-stale");     // a window left from before (a fleet restart)…
      (fm as any).hubQuestionTurnState("worker", "hub-new", true);   // …ends when the daemon names another turn
      expect(new HubContactWindows(join(dir, "hub-contact-windows.json")).restrictingQuestion("worker")).toBe("hub-new");
      (fm as any).hubQuestionTurnState("worker", "hub-off", false);  // an opted-out share's turn opens nothing
      expect(fm.hubContactRestricted("worker")).toBe(false);
    } finally { fm.stormWindow.shutdown(); }
  }));

  it("a Classic room opens no window before the write: a question never written (declined, failed) leaves nothing", withDir(async dir => {
    const fm = new FleetManager(dir);
    try {
      (fm as any).fleetConfig = { instances: { room: {} } };
      vi.spyOn(fm as any, "isClassicInstance").mockReturnValue(true);
      vi.spyOn(fm as any, "waitForInstanceIdle").mockResolvedValue(true);
      vi.spyOn(fm as any, "classicPrivacy").mockReturnValue({ begin: vi.fn() });
      vi.spyOn(fm, "deliverToInstance").mockImplementation(async (_name, _payload, options) => { await options?.beforeInput?.(); return false; });
      await (fm as any).deliverHubQuestion({ agent: "room", correlationId: "hub-c1", text: "Q", stillCurrent: () => true, beforeInput: async () => true });
      expect(fm.hubContactRestricted("room")).toBe(false);
      (fm.deliverToInstance as any).mockImplementation(async (_n: string, _p: unknown, options: any) => { await options?.beforeInput?.(); return true; });
      await (fm as any).deliverHubQuestion({ agent: "room", correlationId: "hub-c2", text: "Q", stillCurrent: () => true, beforeInput: async () => true });
      expect(fm.hubContactRestricted("room")).toBe(false);    // handed over, not yet written
      (fm as any).hubTurnSignal("room", { type: "hub_question_input", correlationId: "hub-c2", contactLimit: true });   // Lumen R2-C: written
      expect(fm.hubContactQuestion("room")).toBe("hub-c2");
    } finally { fm.stormWindow.shutdown(); }
  }));

  it("the opt-out travels in the question's delivery meta (nothing kept in fleet memory)", withDir(async dir => {
    const fm = new FleetManager(dir);
    try {
      (fm as any).fleetConfig = { instances: { worker: {} } };
      const payloads: any[] = [];
      vi.spyOn(fm, "deliverToInstance").mockImplementation(async (_name, payload, options) => { payloads.push(payload); await options?.beforeInput?.(); return true; });
      for (const limit of [false, true, undefined]) await (fm as any).deliverHubQuestion({ agent: "worker", correlationId: "hub-o", text: "Q", contactLimit: limit, stillCurrent: () => true, beforeInput: async () => true });
      expect(payloads.map(p => p.meta.hub_contact_limit)).toEqual(["off", undefined, undefined]);
    } finally { fm.stormWindow.shutdown(); }
  }));
});

describe("Prism P2-1: after a fleet restart the turn state is unknown until the daemon says (M-3660)", () => {
  it("a persisted window of a settled question holds — the outbound handler refuses — until the daemon's replay", withDir(async dir => {
    const before = new FleetManager(dir);
    try { (before as any).hubQuestionInput("worker", "hub-run"); } finally { before.stormWindow.shutdown(); }
    const fm = new FleetManager(dir);                          // the fleet restarted; the daemon has not reconnected yet
    try {
      (fm as any).hubQuestionSettled = () => true;             // the member service says the question is settled (held)
      expect(fm.hubContactRestricted("worker")).toBe(true);    // unknown is not "no turn running": fail closed
      const respond = vi.fn();
      await outboundHandlers.get("send_to_instance")!({ hubContactRestricted: (a: string) => fm.hubContactRestricted(a), hubContactQuestion: (a: string) => fm.hubContactQuestion(a),
        fleetConfig: { defaults: {}, instances: { worker: {}, peer: {} } }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, deliverToInstance: vi.fn() } as any,
        { instance_name: "peer", message: "hi" }, respond, { instanceName: "worker", requestId: 1 } as any);
      expect(respond).toHaveBeenCalledWith(null, expect.stringContaining("Hub question hub-run"));
      (fm as any).hubQuestionTurnState("worker", "hub-run", true);   // replay: that turn is still running
      expect(fm.hubContactRestricted("worker")).toBe(true);
      (fm as any).hubQuestionTurnEnded("worker", "hub-run");
      expect(fm.hubContactRestricted("worker")).toBe(false);
    } finally { fm.stormWindow.shutdown(); }
  }));

  it("the daemon saying 'unknown' changes nothing; 'none' lets a settled window go", withDir(async dir => {
    const before = new FleetManager(dir);
    try { (before as any).hubQuestionInput("worker", "hub-old"); } finally { before.stormWindow.shutdown(); }
    const fm = new FleetManager(dir);
    try {
      (fm as any).hubQuestionSettled = () => true;
      expect(fm.hubContactRestricted("worker")).toBe(true);
      (fm as any).hubAnswerTurns.set("other", null);           // another agent's state says nothing about this one
      expect(fm.hubContactRestricted("worker")).toBe(true);
      (fm as any).hubTurnSignal("worker", { type: "hub_question_turn_state", correlationId: null, unknown: true });   // the daemon cannot tell
      expect(fm.hubContactRestricted("worker")).toBe(true);
      (fm as any).hubTurnSignal("worker", { type: "hub_question_turn_state", correlationId: "not-a-hub-id" });   // malformed: ignored
      expect(fm.hubContactRestricted("worker")).toBe(true);
      (fm as any).hubTurnSignal("worker", { type: "hub_question_turn_state", correlationId: null });
      expect(fm.hubContactRestricted("worker")).toBe(false);
      (fm as any).hubTurnSignal("worker", { type: "hub_question_input", correlationId: "hub-n", contactLimit: true });
      expect(fm.hubContactQuestion("worker")).toBe("hub-n");
      (fm as any).hubTurnSignal("worker", { type: "hub_question_turn_ended", correlationId: "hub-n" });
      expect(fm.hubContactRestricted("worker")).toBe(false);
    } finally { fm.stormWindow.shutdown(); }
  }));
});

describe("HubContactWindows fails closed (M-3660)", () => {
  it("a window that cannot be saved still holds in memory", withDir(dir => {
    const windows = new HubContactWindows(join(dir, "missing-dir", "w.json"), () => 0);
    expect(() => windows.begin("worker", "hub-x")).toThrow();
    expect(windows.restricted("worker")).toBe(true);
  }));
});
