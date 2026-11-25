/**
 * M-3720 (the user, 11-25): 馬斯克Bot, a ClassicBot room, sat in the office's Help desk (求救區) only because Needs you
 * listed the low-key "this room can switch to restricted mode" suggestion for it (contact_restricted_suggestion).
 * Needs you folds those into one quiet group; the office and the org chart (buildOrgView → orgState) now leave them
 * out. Every real call still counts (#4415's lesson: a change to who is drawn calling must not silence a real call).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

let p: AppPage, F: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  F = await import("/ui/js/fleet-org.js");
});
afterAll(() => { p.restore(); });

const ROOM = "classic-room-grok";
const ORG = { general: ["general"], teams: [], instances: {} };
const running = (name: string) => ({ name, status: "running", backend: "grok" });
const suggestion = { id: `contact-suggest:${ROOM}`, type: "contact", reason: "contact_restricted_suggestion", instance: ROOM, since: 1, detail: "", contactSuggestion: { instance: ROOM } };
const stateOf = (app: Record<string, unknown>, name = ROOM) => {
  const view = F.buildOrgView(ORG, { ready: true, instances: [running("general"), running(ROOM)], exec: {}, awaiting: {}, ...app });
  const node = [...view.top, ...view.teams.flatMap((t: any) => t.nodes), ...view.rest.nodes].find((n: any) => n.name === name);
  return node?.state;
};

describe("M-3720: a restricted-mode suggestion is not a call", () => {
  it("a room whose only Needs you item is the suggestion stays where its state puts it (idle), not in the Help desk", () => {
    expect(stateOf({ needs: [suggestion] })).toBe("idle");
    expect(stateOf({ needs: [suggestion], exec: { [ROOM]: "working" } })).toBe("working");
  });
  it.each([
    ["a held contact request to it", { id: "contact:R1", type: "contact", reason: "contact_request", instance: ROOM, since: 1, detail: "", contactTicket: { id: "R1", source: "lead", target: ROOM } }],
    ["a failed delivery", { id: "delivery:d1", type: "delivery", reason: "delivery_failed", instance: ROOM, since: 1, detail: "" }],
    ["a crash", { id: `crashed:${ROOM}:1`, type: "instance", reason: "crashed", instance: ROOM, since: 1, detail: "" }],
    ["a lapsed Hub share", { id: `hub-share-lapsed:${ROOM}:k`, type: "hub", reason: "hub_share_lapsed", instance: ROOM, since: 1, detail: "" }],
  ])("every real call still counts, alone or beside the suggestion: %s", (_label, item) => {
    expect(stateOf({ needs: [item] })).toBe("needs");
    expect(stateOf({ needs: [suggestion, item] })).toBe("needs");
  });
  it("waiting at its terminal still calls, whatever the suggestion", () => {
    expect(stateOf({ needs: [suggestion], awaiting: { [ROOM]: "a prompt" } })).toBe("needs");
  });
});
