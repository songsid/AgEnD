/**
 * Hub UX U2 (spec 1.2, A-L9): the welcome. An administrator, while no Fleet is connected to the Hub, sees 「讓同仁加入」 and never
 * the "your Hub admin pairs fleets for you" line; a person with no Fleet reads step 3's sentence; 連接我的 Fleet (the code path)
 * sits folded under 其他方式. An older panel (no `admin`) keeps the person view.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
const g = globalThis as any;
let client: any, welcome: any; const mounted: AppPage[] = [];
beforeAll(async () => {
  const pg = page({ url: "https://hub.example.test/ui/hub", storage: { agend_tour_done: "1", agend_lang: "en" } });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, enabled: false, revision: 1, companyLink: null }), text: async () => "" });
  client = await import("/ui/js/hub-client.js"); welcome = await import("/ui/js/hub-welcome.js"); pg.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); vi.unstubAllGlobals(); });
afterAll(() => { client.setHubClient(null); });
const MANUAL = /pairs fleets for you|Ask them for a pairing code/;
function fake(o: { admin?: boolean; fleets?: any[]; connect?: any; quick?: boolean; on?: boolean } = {}) {
  return {
    stub: false, web: true, groupPolicyV1: true, quickPairingV1: o.quick ?? false, onSignedOut: () => () => {},
    session: vi.fn(async () => ({ ok: true, signedIn: true, displayName: "Ada", login: "ada", admin: o.admin ?? true, csrf: "x", features: ["group-policy-v1", "company-join-v1"] })),
    catalog: vi.fn(async () => ({ ok: true, askable: [] })),
    adminOverview: vi.fn(async () => ({ ok: true, fleets: o.fleets ?? [], pairings: [] })),
    welcome: vi.fn(async () => ({ ok: true, v: 1, mode: "enabled", chat: { state: "allow" }, publish: { state: "allow" }, connect: o.connect ?? { state: "allow", maxFleets: 1, fleets: [] } })),
    groupPolicy: vi.fn(async () => ({ ok: true, groupPolicyV1: true, supported: true, binding: "ready", policy: { realm: "example", generation: "g", revision: 1, state: "never-enabled", groups: [], denies: [] }, paused: [] })),
    searchGroups: vi.fn(async () => ({ ok: true, groups: [], truncated: false })),
    quickPairing: vi.fn(async () => ({ ok: true, state: "none" })),
    // The public metadata a Fleet reads: company-join-v1 only while joining is switched on.
    joinMetadata: vi.fn(async () => ({ ok: true, v: 1, features: o.on === false ? [] : ["company-join-v1", "join-supersedes-v1", "member-leave-v1"] })),
  };
}
async function mount(c: any, props: any) {
  client.setHubClient(c);
  const pg = page({ url: "https://hub.example.test/ui/hub", storage: { agend_tour_done: "1", agend_lang: "en" } }); mounted.push(pg);
  await pg.mount(h(welcome.HubWelcome, { name: "Ada", ...props })); for (let i = 0; i < 40; i++) await settle(5); return pg;
}
describe("the welcome after U2", () => {
  it("A-L9: an administrator with no Fleet on the Hub — the three-step card, never the pairing-code line", async () => {
    const pg = await mount(fake(), { admin: true, features: ["group-policy-v1", "company-join-v1"] });
    expect(pg.root.querySelector(".hub-welcome-admin .hub-join-card")).toBeTruthy();
    expect([...pg.root.querySelectorAll(".hub-join-card li[data-step]")]).toHaveLength(3);
    expect(pg.root.textContent).not.toMatch(MANUAL);
  });
  it("an administrator once a Fleet is connected on the Hub: no card on the welcome (Administration keeps it)", async () => {
    const pg = await mount(fake({ fleets: [{ id: "f1", status: "active" }] }), { admin: true, features: ["group-policy-v1", "company-join-v1"] });
    expect(pg.root.querySelector(".hub-welcome-admin")).toBeNull(); expect(pg.root.textContent).not.toMatch(MANUAL);
  });
  it("a person with no Fleet: step 3's sentence for this Hub is the primary text; no admin card, no admin read", async () => {
    const c = fake({ admin: false }); const pg = await mount(c, { admin: false, features: ["group-policy-v1", "company-join-v1"] });
    expect(pg.root.querySelector("[data-welcome='sentence']").textContent).toBe("In AgEnD, open Settings → Hub, enter hub.example.test, then sign in with the company account.");
    expect(pg.root.querySelector(".hub-welcome-admin")).toBeNull(); expect(c.adminOverview).not.toHaveBeenCalled();
  });
  it("連接我的 Fleet (the pairing-code path) is folded under 其他方式", async () => {
    const pg = await mount(fake({ admin: false, quick: true }), { admin: false, quick: true, features: ["group-policy-v1", "company-join-v1", "quick-pairing-v1"] });
    const d = pg.root.querySelector("details.hub-welcome-other"); expect(d).toBeTruthy(); expect(d.open).toBeFalsy();
    expect(d.querySelector("summary").textContent).toBe("Other ways");
  });
  it("#3698 r1: joining switched off (composed, not on) — a person keeps the earlier pairing-code line, never the sentence", async () => {
    const c = fake({ admin: false, on: false }); const pg = await mount(c, { admin: false, features: ["group-policy-v1", "company-join-v1"] });
    expect(c.joinMetadata).toHaveBeenCalled();
    expect(pg.root.querySelector("[data-welcome='sentence']")).toBeNull(); expect(pg.root.textContent).toMatch(MANUAL);
  });
  it("#3698 r1: an administrator never reads the pairing-code line — with joining off too (no sentence either)", async () => {
    const pg = await mount(fake({ admin: true, on: false, fleets: [{ id: "f1", status: "active" }] }), { admin: true, features: ["group-policy-v1", "company-join-v1"] });
    expect(pg.root.querySelector("[data-welcome='sentence']")).toBeNull(); expect(pg.root.textContent).not.toMatch(MANUAL);
  });
  it("an older client without the metadata read: no sentence (joining cannot be confirmed on) — the earlier line", async () => {
    const c: any = fake({ admin: false }); delete c.joinMetadata;
    const pg = await mount(c, { admin: false, features: ["group-policy-v1", "company-join-v1"] });
    expect(pg.root.querySelector("[data-welcome='sentence']")).toBeNull(); expect(pg.root.textContent).toMatch(MANUAL);
  });
  it("an older panel (no admin, no features): the person view as before — the pairing-code line, no card", async () => {
    const pg = await mount(fake({ admin: false }), {});
    expect(pg.root.textContent).toMatch(MANUAL); expect(pg.root.querySelector(".hub-welcome-admin")).toBeNull();
  });
});
