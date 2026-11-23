/**
 * M-3543: a shared agent whose backend or folder changed keeps its #3147 rule (the share's consent does not carry over),
 * but the lapse is now said: the Hub tools answer share_needs_reshare, Needs you lists it until it is shared again, the
 * /backend answer says it, and Settings → Hub marks the row with Share again. In-memory doubles only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { HubRoomPostAdapter, isShareLapsed, SHARE_LAPSED_MESSAGE, type RoomPostLink } from "../src/hub/member/room-post.js";
import { HubMemberAgentIntro } from "../src/hub/member/agent-intro.js";
import { deriveNeedsYou } from "../src/needs-you.js";
import { createHubMemberExposureApi } from "../src/hub/member/exposure-api.js";
import { HUB_AGENT_MODE, agentPolicyDigest } from "../src/hub/member/agent-mode.js";
import * as fleetManagerModule from "../src/fleet-manager.js";
import { t } from "../src/locale.js";

const LAPSED = { ok: false, code: "share_needs_reshare", message: SHARE_LAPSED_MESSAGE };
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

describe("isShareLapsed: only a published share of this agent whose consent token is not its current one", () => {
  const published = { consentId: "c", exposure: { state: "published" } };
  it("lapsed: the agent's token changed", () => {
    expect(isShareLapsed("m", published, { agent: "m", token: "old" }, "new")).toBe(true);
  });
  it("not lapsed: same token, no share, withdrawn, another agent's consent, no consent, no token", () => {
    expect(isShareLapsed("m", published, { agent: "m", token: "same" }, "same")).toBe(false);
    expect(isShareLapsed("m", null, { agent: "m", token: "old" }, "new")).toBe(false);
    expect(isShareLapsed("m", { consentId: "c", exposure: { state: "withdrawn" } }, { agent: "m", token: "old" }, "new")).toBe(false);
    expect(isShareLapsed("m", published, { agent: "other", token: "old" }, "new")).toBe(false);
    expect(isShareLapsed("m", published, undefined, "new")).toBe(false);
    expect(isShareLapsed("m", published, { agent: "m", token: "old" }, null)).toBe(false);
  });
});

describe("the Hub tools say share_needs_reshare for a lapsed agent, and nothing changes for anyone else", () => {
  function rig(lapsed: boolean) {
    const db = new Database(":memory:"); dbs.push(db);
    const link: RoomPostLink & { members: any; people: any } = { features: new Set(["welcome-caps-v1", "room-ask-v1", "room-post-v1"]), current: () => true,
      list: vi.fn(), post: vi.fn(), members: vi.fn(), people: vi.fn() };
    const adapter = new HubRoomPostAdapter({ db, binding: "b", encryptionKey: Buffer.alloc(32, 7), current: () => true, local: () => null, lapsed: () => lapsed });
    adapter.connected(link);
    return { adapter, link, caller: { agent: "m365", current: () => true } };
  }
  it("rooms, members, people and post: the lapse, before any other check, and nothing reaches the Hub", async () => {
    const { adapter, link, caller } = rig(true);
    expect(await adapter.rooms(caller)).toEqual(LAPSED);
    expect(await adapter.members(caller, "room")).toEqual(LAPSED);
    expect(await adapter.people(caller, "ann")).toEqual(LAPSED);
    expect(await adapter.post(caller, { room: "room", text: "hi", operationId: randomUUID() })).toEqual(LAPSED);
    for (const f of [link.list, link.post, link.members, link.people]) expect(f).not.toHaveBeenCalled();
  });
  it("not lapsed (never shared, or no link): the same answers as before", async () => {
    const { adapter, caller } = rig(false);
    expect(await adapter.rooms(caller)).toEqual({ ok: false, code: "unavailable" });
    expect(await adapter.members(caller, "room")).toEqual({ ok: false, code: "invalid" });
    expect(await adapter.people(caller, "ann")).toEqual({ ok: false, code: "invalid" });
  });
  it("hub_set_intro: the lapse too; an agent that was never shared is still denied", async () => {
    const intro = (lapsed: boolean) => { const i = new HubMemberAgentIntro({ current: () => true, exposures: () => [], lapsed: () => lapsed });
      i.connected({ features: new Set(["agent-intro-v1"]), current: () => true } as any); return i; };
    const caller = { agent: "m365", current: () => true };
    expect(await intro(true).set(caller, "Hello", randomUUID())).toEqual(LAPSED);
    expect((await intro(false).set(caller, "Hello", randomUUID())).ok).toBe(false);
    expect(await intro(false).set(caller, "Hello", randomUUID())).not.toEqual(LAPSED);
  });
});

describe("Needs you: one item per agent and change, gone once shared again", () => {
  const base = { prompts: [], instances: [], deliveries: [], ownerOf: () => undefined };
  it("an item under the agent, keyed by its incarnation; none without a lapse", () => {
    const items = deriveNeedsYou({ ...base, hubShareLapses: [{ agent: "m365", key: "inc-2", since: 1000 }] });
    expect(items).toEqual([{ id: "hub-share-lapsed:m365:inc-2", type: "hub", instance: "m365", reason: "hub_share_lapsed", detail: "", since: 1000 }]);
    expect(deriveNeedsYou({ ...base, hubShareLapses: [] })).toEqual([]);
    expect(t("needs.reason.hub_share_lapsed")).not.toBe("needs.reason.hub_share_lapsed");
  });
  it("the fleet keeps its 'since' while the same lapse lasts, and forgets it once the agent is shared again", () => {
    const { FleetManager } = fleetManagerModule as any;
    let agents = ["m365"], now = 1000;
    const fm: any = { hubShareLapse: { agents: () => agents, lapsed: () => true }, hubShareLapseSeen: new Map(), readHubIncarnations: () => ({ m365: { id: "inc-2", fp: "x" } }) };
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      expect(FleetManager.prototype.hubShareLapses.call(fm)).toEqual([{ agent: "m365", key: "inc-2", since: 1000 }]);
      now = 5000;
      expect(FleetManager.prototype.hubShareLapses.call(fm)).toEqual([{ agent: "m365", key: "inc-2", since: 1000 }]);
      agents = [];
      expect(FleetManager.prototype.hubShareLapses.call(fm)).toEqual([]);
      expect(fm.hubShareLapseSeen.size).toBe(0);
    } finally { spy.mockRestore(); }
  });
});

describe("/backend: the answer says the Hub share needs sharing again, only when it lapsed", () => {
  it("one more line for a lapsed agent; the answer is unchanged otherwise", () => {
    const { FleetManager } = fleetManagerModule as any;
    const fm = (lapsed: boolean): any => ({ hubShareLapse: { lapsed: () => lapsed, agents: () => [] }, hubShareLapsed: FleetManager.prototype.hubShareLapsed });
    const done = "✅ m365 now runs claude-code";
    expect(FleetManager.prototype.withHubShareLapse.call(fm(true), "m365", done)).toBe(`${done}\n${t("backend.hub_share_lapsed", "m365")}`);
    expect(FleetManager.prototype.withHubShareLapse.call(fm(false), "m365", done)).toBe(done);
    expect(FleetManager.prototype.withHubShareLapse.call({ hubShareLapse: null, hubShareLapsed: FleetManager.prototype.hubShareLapsed }, "m365", done)).toBe(done);
  });
});

describe("Settings → Hub: the lapsed row says why and offers Share again", () => {
  function api(lapsed: boolean) {
    const committed = { agent: "m365", providerId: HUB_AGENT_MODE, consentId: "c", generation: 1, contactLimit: true,
      exposure: { id: randomUUID(), fleetId: "f", owner: { realm: "r", objectId: "o" }, displayName: "Mira", revision: 3, state: "published",
        dataViewId: HUB_AGENT_MODE, allowedTools: [], policyDigest: agentPolicyDigest("m365") } };
    return createHubMemberExposureApi({
      store: { list: () => [{ id: committed.exposure.id, agent: "m365", committed, staged: null }], contactLimitNotice: () => false } as any,
      agents: () => [{ name: "m365", display: "Mira" } as any], afterCommit: async () => undefined,
      readinessCandidate: () => ({ ok: true }) as any, lapsed: () => lapsed,
    });
  }
  it("lapsed: reason share_lapsed (the page shows its words and Share again); not lapsed: no reason", () => {
    expect(api(true).list()[0]).toMatchObject({ agent: "m365", state: "published", reason: "share_lapsed", revision: 3 });
    expect(api(false).list()[0]!.reason).toBeUndefined();
  });
});
