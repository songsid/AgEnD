/**
 * M-3007 (alpha.2 re-run at b1788ade): an agent the owner switched on, which the Hub refused to list by policy (no sharing
 * permission; #3759 answers with an error frame for that snapshot), no longer shows as "Shared" on the owner's Fleet.
 * - The sender records a policy refusal ("denied") of the LAST snapshot sent only; "unavailable" is not one; a later send
 *   (a reconnect after the administrator allows sharing, an owner's change) clears it. (The real-Hub walk — refused,
 *   reconnect still refused, allowed clears, unavailable isn't a refusal — is in hub-code-member-link-a2.)
 * - The exposure list marks a PUBLISHED row "hub_refused" (still shareable); a withdrawn row never.
 * - Settings: that row's switch is off and disabled, it says the administrator hasn't allowed sharing, offers
 *   "Don't share it" (a withdraw), and no "allow on the Hub" link; EN and zh-TW.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { exposureSnapshotSender } from "../src/hub/member/exposures.js";
import { createMemberReceive } from "../src/hub/compose/member.js";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

describe("the sender's record of a policy refusal", () => {
  const link = () => { const sent: any[] = []; return { sent, link: { current: () => true, linkEpoch: 1, send: vi.fn(async (f: any) => { sent.push(f); }) } as any }; };
  it("only the last snapshot's denied counts; unavailable never; a later send clears it", async () => {
    const s = exposureSnapshotSender({ snapshot: () => ({ revision: 1, exposures: [] }) }), a = link();
    await s.publishSnapshot(a.link);
    const first = a.sent[0].requestId;
    s.refused(first, "unavailable"); expect(s.isRefused()).toBe(false);
    s.refused(randomUUID(), "denied"); expect(s.isRefused()).toBe(false);
    s.refused(first, "denied"); expect(s.isRefused()).toBe(true);
    await s.afterCommit(); expect(s.isRefused()).toBe(false);
    s.refused(first, "denied"); expect(s.isRefused()).toBe(false);              // a late answer for an older snapshot
    s.refused(a.sent[1].requestId, "denied"); expect(s.isRefused()).toBe(true);
    s.refused(first, "denied"); expect(s.isRefused()).toBe(true);               // a late older answer never hides the current refusal
  });
  it("the member's receive hands the error frame's requestId and code to it", async () => {
    const refused = vi.fn();
    const receive = createMemberReceive({ admission: { admit: vi.fn(), fence: vi.fn() }, journal: { acknowledge: vi.fn() }, live: () => true, log: vi.fn(), publicationRefused: refused });
    const requestId = randomUUID();
    await receive({ v: 1, type: "error", requestId, linkEpoch: 1, payload: { code: "denied", retryable: false } } as any, { current: () => true } as any);
    expect(refused).toHaveBeenCalledExactlyOnceWith(requestId, "denied");
  });
});

describe("the exposure list and the owner's Settings row", () => {
  let api: any, client: any, card: any, i18n: any;
  const mounted: AppPage[] = [];
  beforeAll(async () => {
    api = await import("../src/hub/member/exposure-api.js");
    const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
    (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
    i18n = await import("/assets/app-i18n.js"); await import("/assets/app-store.js");
    client = await import("/ui/js/hub-client.js"); card = await import("/ui/js/settings-hub.js");
    pg.restore();
  });
  afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); i18n.setLang("en", { store: false }); });

  it("a published row is hub_refused (still shareable) while the Hub refuses; a withdrawn row never; cleared when accepted", async () => {
    const { agentPolicyDigest } = await import("../src/hub/member/agent-mode.js");
    let refused = true, state = "published";
    const id = randomUUID();
    // A representative-agent consent exactly as publish stores it (isAgentDescriptor), so no other reason applies.
    const store = { list: () => [{ agent: "atlas", committed: { agent: "atlas", providerId: "agent",
      exposure: { id, state, revision: 2, dataViewId: "agent", allowedTools: [], policyDigest: agentPolicyDigest("atlas") } } }] };
    const a = api.createHubMemberExposureApi({ store, agents: () => [{ name: "atlas", display: "Atlas" }], afterCommit: async () => "pending",
      readinessCandidate: () => ({ ok: true }), refused: () => refused });
    expect(a.list()[0]).toMatchObject({ state: "published", reason: "hub_refused", enforceable: true });
    refused = false; expect(a.list()[0].reason).toBeUndefined();
    refused = true; state = "withdrawn"; expect(a.list()[0].reason).toBeUndefined();
  });

  const ROW = { agent: "atlas", display: "Atlas", exposureId: "11111111-2222-4333-8444-555555555555", revision: 2, state: "published",
    policy: { dataView: "agent", tools: [] }, enforceable: true, reason: "hub_refused", choices: { dataViews: [{ id: "agent", label: "Atlas" }], tools: [] }, pending: null };
  it.each([["en", "Not shared: your Hub administrator hasn't allowed you to share agents. It will be shared once they do.", "Don't share it"],
    ["zh-TW", "未分享：Hub 管理員還沒有允許你分享 Agent。管理員允許後就會自動分享。", "不要分享"]])("Settings shows it as not allowed, switch off; the owner can withdraw (%s)", async (lang, note, withdraw) => {
    i18n.setLang(lang, { store: false });
    const setExposed = vi.fn(async () => ({ ok: true, remote: "pending" }));
    client.setHubClient({ stub: false, subscribe: () => () => {}, exposures: async () => [ROW], setExposed,
      pairing: async () => ({ state: "paired", hub: { hubId: "h", name: "Team", memberOrigin: "https://hub.test", webOrigin: "https://hub.test", fingerprint: { kind: "hub-key", digest: "a".repeat(64) } }, link: "online" }) });
    const pg = page({ url: "http://127.0.0.1:19280/settings/hub", storage: { agend_tour_done: "1", agend_lang: lang } }); mounted.push(pg);
    pg.document.body.setAttribute("data-hub", "member");
    await pg.mount(h(card.HubConnectCard, {}));
    for (let i = 0; i < 200 && !pg.root.querySelector(".hub-exposure-refused"); i++) await settle(5);
    const box = pg.root.querySelector(".hub-exposure input") as any;
    expect([box.checked, box.disabled]).toEqual([false, true]);
    const why = pg.root.querySelector(".hub-exposure-refused")!;
    expect(why.textContent).toContain(note);
    expect(pg.root.textContent).not.toContain(lang === "en" ? "Shared: Hub questions go" : "已分享：Hub 的提問");
    expect([...pg.root.querySelectorAll("a")].map((x: any) => x.getAttribute("href")).filter((x: string) => /grant=1/.test(x))).toEqual([]);
    const button = [...why.querySelectorAll("button")].find((b: any) => b.textContent === withdraw) as any;
    fire(button, "click"); for (let i = 0; i < 100 && !setExposed.mock.calls.length; i++) await settle(5);
    expect(setExposed).toHaveBeenCalledWith("atlas", false, 2, null);
  });
});

// Prism #3763 r1: the open page follows the Hub's answer — refused, then accepted — without a remount, on the card's own
// visible pairing poll; bounded (one read per tick, none in flight twice, none while a switch is saved), newest-wins, and
// nothing after the connection goes away.
describe("the open Settings page follows a refusal and its clearing (no remount)", () => {
  let client: any, card: any, i18n: any;
  const mounted: AppPage[] = [];
  beforeAll(async () => {
    const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
    (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
    i18n = await import("/assets/app-i18n.js"); await import("/assets/app-store.js");
    client = await import("/ui/js/hub-client.js"); card = await import("/ui/js/settings-hub.js");
    pg.restore();
  });
  afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); i18n.setLang("en", { store: false }); });
  const BASE = { agent: "atlas", display: "Atlas", exposureId: "11111111-2222-4333-8444-555555555555", revision: 2, state: "published",
    policy: { dataView: "agent", tools: [] }, enforceable: true, choices: { dataViews: [{ id: "agent", label: "Atlas" }], tools: [] }, pending: null };
  const PAIRED = { state: "paired", binding: "b1", hub: { hubId: "h", name: "Team", memberOrigin: "https://hub.test", webOrigin: "https://hub.test", fingerprint: { kind: "hub-key", digest: "a".repeat(64) } }, link: "online" };
  async function rig(answer: () => Promise<any[]>, extra: Record<string, unknown> = {}) {
    const listeners = new Set<(p: any) => void>(); let pairing: any = PAIRED;
    const exposures = vi.fn(answer);
    const c = { stub: false, pairing: async () => pairing, exposures, setExposed: vi.fn(async () => ({ ok: true, remote: "pending" })),
      subscribe: (fn: (p: any) => void) => { listeners.add(fn); return () => listeners.delete(fn); }, ...extra };
    client.setHubClient(c);
    const pg = page({ url: "http://127.0.0.1:19280/settings/hub", storage: { agend_tour_done: "1" } }); mounted.push(pg);
    pg.document.body.setAttribute("data-hub", "member");
    await pg.mount(h(card.HubConnectCard, {}));
    for (let i = 0; i < 200 && !pg.root.querySelector(".hub-exposure input"); i++) await settle(5);
    const tick = async (p: any = pairing) => { pairing = p; for (const fn of [...listeners]) fn(p); await settle(15); };
    const box = () => pg.root.querySelector(".hub-exposure input") as any;
    const shown = () => ({ checked: box()?.checked, disabled: box()?.disabled, refused: !!pg.root.querySelector(".hub-exposure-refused"),
      grant: [...pg.root.querySelectorAll("a")].some((a: any) => /grant=1/.test(a.getAttribute("href") || "")) });
    return { pg, c, exposures, tick, shown, listeners };
  }
  it("published → refused → accepted again, each within one poll tick", async () => {
    let row: any = BASE;
    const r = await rig(async () => [row]);
    expect(r.shown()).toEqual({ checked: true, disabled: false, refused: false, grant: true });
    row = { ...BASE, reason: "hub_refused" }; await r.tick();
    expect(r.shown()).toEqual({ checked: false, disabled: true, refused: true, grant: false });
    row = BASE; await r.tick();
    expect(r.shown()).toEqual({ checked: true, disabled: false, refused: false, grant: true });
    expect(r.exposures).toHaveBeenCalledTimes(3);
  });
  it("bounded: a tick while a read is in flight reads nothing more; a tick while a switch is being saved reads nothing", async () => {
    let release!: () => void, row: any = BASE, hold = false;
    const r = await rig(() => hold ? new Promise<any[]>((ok) => { release = () => ok([row]); }) : Promise.resolve([row]));
    hold = true; await r.tick(); await r.tick(); await r.tick();
    expect(r.exposures).toHaveBeenCalledTimes(2);                           // the mount's read + one in flight
    release(); await settle(15); hold = false;
    let save!: () => void;
    r.c.setExposed.mockImplementation(() => new Promise((ok) => { save = () => ok({ ok: true, remote: "pending" }); }));
    const box = r.pg.root.querySelector(".hub-exposure input") as any; box.checked = false; fire(box, "change"); await settle(10);
    const before = r.exposures.mock.calls.length;
    await r.tick();
    expect(r.exposures.mock.calls.length).toBe(before);                     // no background read while saving
    save(); await settle(20);
  });
  it("newest wins: an older, slower answer never overwrites a newer one", async () => {
    const answers: Array<(rows: any[]) => void> = [];
    const r = await rig(() => answers.length === 0 ? (answers.push(() => {}), Promise.resolve([BASE])) : new Promise<any[]>((ok) => { answers.push(ok); }));
    await r.tick();                                                          // background read #1 (slow)
    const box = r.pg.root.querySelector(".hub-exposure input") as any;
    r.c.setExposed.mockResolvedValue({ ok: false, error: "conflict" });      // a conflict reloads at once (read #2)
    box.checked = false; fire(box, "change"); await settle(10);
    answers[2]!([{ ...BASE, reason: "hub_refused" }]); await settle(10);   // the newer answer: refused
    answers[1]!([BASE]); await settle(10);                                   // the older answer arrives late
    expect(r.shown().refused).toBe(true);
  });
  it("after the connection goes away, a tick reads nothing for the old list", async () => {
    const r = await rig(async () => [BASE]);
    await r.tick({ state: "unpaired" }); await settle(20);
    const n = r.exposures.mock.calls.length;
    await r.tick({ state: "unpaired" });
    expect(r.exposures.mock.calls.length).toBe(n);
    expect(r.pg.root.querySelector(".hub-exposure")).toBeNull();
  });
});
