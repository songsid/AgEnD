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
  it("held after a refused report: contact is allowed again; a question still being answered keeps the refusal", withDir(async dir => {
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
      expect(fm.hubContactRestricted("worker")).toBe(false); // this turn
      expect(fm.hubContactRestricted("worker")).toBe(false); // and every later one: nothing is open
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

});

