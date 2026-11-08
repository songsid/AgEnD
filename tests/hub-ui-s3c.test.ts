/**
 * S3c (S-55): the member card's exposures on the real endpoints (createMemberClient) and the owner's picker.
 * - The member client: the list; publish with the picked view and tools (a 202 is "waiting for your confirmation":
 *   pending + settled); withdraw by the row's exposureId (remote "pending"); an older host's 404 is "unavailable".
 * - The card (P1 representative agent, docs/design/hub-representative-agent.md): switching on shares the agent itself
 *   ({ dataViewId: "agent", tools: [] }) for confirmation; a legacy row says republish_required and offers Share again;
 *   a row with a pending confirmation says so and its switch waits; the refusals' words (limit, not available).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let client: any, card: any;
const mounted: AppPage[] = [];
const g = globalThis as any;
const until = async (fn: () => unknown, n = 200) => { for (let i = 0; i < n && !fn(); i++) await settle(5); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  await import("/assets/app-store.js");
  client = await import("/ui/js/hub-client.js");
  card = await import("/ui/js/settings-hub.js");
  pg.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); });

const ROW = { agent: "atlas", display: "Atlas", exposureId: null, revision: 0, state: "withdrawn", policy: null, enforceable: true,
  choices: { dataViews: [{ id: "agent", label: "Atlas" }], tools: [] }, pending: null };
function confirmFake(answers: Record<string, (opts: any) => { ok: boolean; status: number; body: any }>) {
  const calls: Array<[string, any]> = [];
  return { calls, confirm: {
    api: vi.fn(async (path: string, opts: any = {}) => { calls.push([path, opts]); const key = `${opts.method || "GET"} ${path}`; const f = answers[key]; return f ? f(opts) : { ok: false, status: 404, body: { error: "unavailable" } }; }),
    isPendingResponse: (r: any) => r.status === 202 && r.body && r.body.result === "pending_confirmation",
    track: vi.fn(async () => ({ state: "applied" })), newKey: () => "k1" } };
}

describe("the member client", () => {
  it("publish: the pick is sent; a 202 is pending (with when it expires) and settles later", async () => {
    const f = confirmFake({ "GET /api/hub/member/exposures": () => ({ ok: true, status: 200, body: { ok: true, exposures: [ROW] } }),
      "POST /api/hub/member/exposures": () => ({ ok: false, status: 202, body: { ok: true, result: "pending_confirmation", pending_change: { id: "p".repeat(32), expires_at: 123 } } }) });
    const c = client.createMemberClient({ confirm: f.confirm });
    const r = await c.setExposed("atlas", true, 0, { dataViewId: "agent", tools: [] });
    expect(r).toMatchObject({ ok: true, pending: { expiresAt: 123 }, view: { agent: "atlas", pending: { expiresAt: 123 } } });
    expect(await r.settled).toEqual({ state: "applied" });
    expect(JSON.parse(f.calls[1]![1].body)).toEqual({ agent: "atlas", dataViewId: "agent", tools: [], expectedRevision: 0 });
    expect(f.calls[1]![1].headers).toMatchObject({ "Idempotency-Key": "k1" });
    expect(await c.setExposed("atlas", true, 0)).toEqual({ ok: false, error: "not_enforceable" });       // no pick: never sent
    expect(await c.setExposed("ghost", true, 0, { dataViewId: "notes", tools: [] })).toEqual({ ok: false, error: "unknown_agent" });
  });
  it("withdraw by the row's exposureId (remote pending); refusals pass through; an older host is unavailable", async () => {
    const shared = { ...ROW, exposureId: "11111111-2222-4333-8444-555555555555", revision: 1, state: "published" };
    const f = confirmFake({ "GET /api/hub/member/exposures": () => ({ ok: true, status: 200, body: { ok: true, exposures: [shared] } }),
      [`POST /api/hub/member/exposures/${shared.exposureId}/withdraw`]: (o) => (JSON.parse(o.body).expectedRevision === 1
        ? { ok: true, status: 200, body: { ok: true, remote: "pending" } } : { ok: false, status: 409, body: { ok: false, error: "conflict" } }) });
    const c = client.createMemberClient({ confirm: f.confirm });
    expect(await c.setExposed("atlas", false, 1)).toEqual({ ok: true, remote: "pending" });
    expect(await c.setExposed("atlas", false, 0)).toEqual({ ok: false, error: "conflict" });
    const old = client.createMemberClient({ confirm: confirmFake({}).confirm });
    expect(await old.exposures()).toEqual([]);
    expect(await old.setExposed("atlas", true, 0, { dataViewId: "notes", tools: ["documents.read"] })).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("the card's agent share and pending rows", () => {
  async function cardWith(c: any) {
    client.setHubClient(c);
    const pg = page({ url: "http://127.0.0.1:19280/settings/access", storage: { agend_tour_done: "1" } }); mounted.push(pg);
    pg.document.body.setAttribute("data-hub", "member");
    await pg.mount(h(card.HubConnectCard, {}));
    await until(() => pg.root.querySelector(".hub-exposure input"));
    return pg;
  }
  const fakeClient = (rows: any[], setExposed: any = vi.fn(async () => ({ ok: true, view: rows[0] }))) => ({
    stub: false, pairing: async () => ({ state: "paired", hub: { hubId: "h", name: "Team", memberOrigin: "https://hub.test", webOrigin: "https://hub.test", fingerprint: { kind: "hub-key", digest: "a".repeat(64) } }, link: "online" }),
    subscribe: () => () => {}, exposures: async () => rows, setExposed });
  it("switching on shares the agent itself (no picker, no Hub tools); a 202 says it waits for confirmation; the lead says what sharing means", async () => {
    const setExposed = vi.fn(async () => ({ ok: true, pending: { expiresAt: 9 }, view: { ...ROW, pending: { expiresAt: 9 } }, settled: new Promise(() => {}) }));
    const pg = await cardWith(fakeClient([ROW], setExposed));
    expect(pg.root.querySelector(".hub-exposures .note")!.textContent).toContain("answers Hub questions in its own conversation");
    const box = pg.root.querySelector(".hub-exposure input") as any;
    box.checked = true; fire(box, "change");
    await until(() => setExposed.mock.calls.length > 0 && pg.root.querySelector(".hub-exposures .note[role=status]"));
    expect(setExposed).toHaveBeenCalledWith("atlas", true, 0, { dataViewId: "agent", tools: [] });
    expect(pg.root.querySelector(".hub-exposure-pick")).toBeNull();
    expect(pg.root.querySelector(".hub-exposures [role=status]")!.textContent).toContain("Sent for confirmation");
  });
  it("a shared agent says where questions go; switching off withdraws", async () => {
    const shared = { ...ROW, exposureId: "e1", revision: 1, state: "published", policy: { dataView: "agent", tools: [] } };
    const setExposed = vi.fn(async () => ({ ok: true, remote: "pending" }));
    const pg = await cardWith(fakeClient([shared], setExposed));
    expect(pg.root.querySelector(".hub-exposure-why")!.textContent).toBe("Shared: Hub questions go to this agent's own conversation.");
    const box = pg.root.querySelector(".hub-exposure input") as any;
    box.checked = false; fire(box, "change");
    await until(() => setExposed.mock.calls.length > 0);
    expect(setExposed).toHaveBeenCalledWith("atlas", false, 1, null);
  });
  it.each(["en", "zh-TW"])("a legacy row (%s): says republish_required, its switch still withdraws, Share again sends the agent at its revision", async (lang) => {
    const i18n = await import("/assets/app-i18n.js");
    i18n.setLang(lang, { store: false });
    try {
      const legacy = { ...ROW, exposureId: "e1", revision: 3, state: "published", policy: { dataView: "notes", tools: ["documents.read"] }, enforceable: false, reason: "republish_required" };
      const setExposed = vi.fn(async () => ({ ok: true, pending: { expiresAt: 9 }, view: legacy, settled: new Promise(() => {}) }));
      const pg = await cardWith(fakeClient([legacy], setExposed));
      const why = pg.root.querySelector(".hub-exposure-republish")!;
      expect(why.textContent).toContain(lang === "en" ? "Hub questions are refused until you share this agent again" : "重新公開這個 Agent 之前");
      expect((pg.root.querySelector(".hub-exposure input") as any).disabled).toBe(false);          // withdraw stays possible
      const again = why.querySelector("button") as any;
      expect(again.textContent).toBe(lang === "en" ? "Share again" : "重新公開");
      again.click();
      await until(() => setExposed.mock.calls.length > 0);
      expect(setExposed).toHaveBeenCalledWith("atlas", true, 3, { dataViewId: "agent", tools: [] });
    } finally { i18n.setLang("en", { store: false }); }
  });
  it("#3146 r1: no delivery path yet — the switch is disabled and the row says why", async () => {
    const pg = await cardWith(fakeClient([{ ...ROW, enforceable: false, reason: "delivery_unavailable" }]));
    expect((pg.root.querySelector(".hub-exposure input") as any).disabled).toBe(true);
    expect(pg.root.querySelector(".hub-exposure-why")!.textContent).toBe("Sharing isn't available on this fleet yet: Hub questions can't reach an agent here.");
  });
  it("a pending row says so and its switch waits", async () => {
    const pg = await cardWith(fakeClient([{ ...ROW, pending: { expiresAt: 9 } }]));
    expect(pg.root.querySelector(".hub-exposure-pending")!.textContent).toBe("Waiting for your confirmation");
    expect((pg.root.querySelector(".hub-exposure input") as any).disabled).toBe(true);
  });
  it.each([["limit", "At most 64 agents can be shared."], ["unavailable", "Not available on this AgEnD version."], ["unknown_view", "This agent can't be shared right now. Reload the page and try again."], ["not_enforceable", "This agent can't be shared right now. Reload the page and try again."]])("a refusal %s has its words", async (error, words) => {
    const pg = await cardWith(fakeClient([ROW], vi.fn(async () => ({ ok: false, error }))));
    const box = pg.root.querySelector(".hub-exposure input") as any; box.checked = true; fire(box, "change");
    await until(() => pg.root.querySelector(".hub-exposures .err"));
    expect(pg.root.querySelector(".hub-exposures .err")!.textContent).toBe(words);
  });
});

describe("the member card's pairing (S3c PR B)", () => {
  async function cardWith(c: any) {
    client.setHubClient(c);
    const pg = page({ url: "http://127.0.0.1:19280/settings/access", storage: { agend_tour_done: "1" } }); mounted.push(pg);
    pg.document.body.setAttribute("data-hub", "member");
    await pg.mount(h(card.HubConnectCard, {}));
    await until(() => pg.root.querySelector(".hub-state, .hub-connect, .hub-unavailable"));
    return pg;
  }
  const PENDING = { state: "pending", memberOrigin: "https://hub.test", fingerprint: { kind: "pairing", digest: "ab".repeat(32) }, expiresAt: Date.now() + 60_000, ownerConfirmed: null, adminApproved: null, localConfirmed: false };
  const fake = (p: any, over: any = {}) => ({ stub: false, pairing: async () => p, subscribe: () => () => {}, exposures: async () => [], ...over });
  it("pending with unknown Hub progress: the two steps as instructions (no marks); the local check before, its line after", async () => {
    const confirmFingerprint = vi.fn(async (d: string) => ({ ok: true, pairing: { ...PENDING, localConfirmed: true }, digest: d }));
    const pg = await cardWith(fake(PENDING, { confirmFingerprint }));
    expect(pg.root.querySelector(".hub-steps-lead")!.textContent).toBe("Finish the fingerprint check on the Hub too.");
    expect(pg.root.querySelectorAll(".hub-steps-unknown li").map((li: any) => li.textContent)).toEqual([
      "On the Hub, compare this fingerprint and confirm your pairing.", "The Hub checks its group policy, or waits for its administrator's approval."]);
    expect(pg.root.querySelectorAll(".hub-steps-unknown svg").length).toBe(0);
    (pg.root.querySelector(".hub-local-confirm") as any).click();
    await until(() => pg.root.querySelector(".hub-local-confirmed"));
    expect(confirmFingerprint).toHaveBeenCalledWith("ab".repeat(32));
    expect(pg.root.querySelector(".hub-local-confirmed")!.textContent).toBe("You confirmed this fingerprint here.");
    expect(pg.root.querySelector(".hub-local-confirm")).toBeNull();
  });
  it("known progress (true/false) keeps today's marks", async () => {
    const pg = await cardWith(fake({ ...PENDING, ownerConfirmed: true, adminApproved: false, localConfirmed: undefined }));
    expect(pg.root.querySelectorAll(".hub-steps li.is-done").length).toBe(1);
    expect(pg.root.querySelector(".hub-steps-unknown")).toBeNull();
  });
  it("disconnected: its own words and Start over (cancel) back to the form", async () => {
    let p: any = { state: "held", hold: "disconnected", memberOrigin: "https://hub.test" };
    const cancel = vi.fn(async () => { p = { state: "unpaired" }; return p; });
    const pg = await cardWith(fake(p, { pairing: async () => p, cancel }));
    expect(pg.root.querySelector(".hub-held p")!.textContent).toBe("Disconnected here. The Hub still lists this fleet until its administrator revokes it.");
    const btn = pg.root.querySelector(".hub-held .btn") as any;
    expect(btn.textContent).toBe("Start over");
    btn.click();
    await until(() => pg.root.querySelector(".hub-connect"));
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("an older host (404): the single 'not available' line, no form", async () => {
    const c = client.createMemberClient({ confirm: { api: async () => ({ ok: false, status: 404, body: { error: "unavailable" } }), isPendingResponse: () => false, track: vi.fn(), newKey: () => "k" } });
    const pg = await cardWith(c);
    expect(pg.root.querySelector(".hub-unavailable")!.textContent).toBe("Not available on this AgEnD version.");
    expect(pg.root.querySelector(".hub-connect")).toBeNull();
  });
});

describe("the member client's pacing and steps", () => {
  it("subscribe: one poll every pollMs while visible, never two at once, none while hidden; stops with the last listener", async () => {
    let t: (() => void) | null = null, cleared = 0, gets = 0, release: (() => void) | null = null;
    const timers = { setTimeout: (fn: () => void) => { t = fn; return 1; }, clearTimeout: () => { cleared++; t = null; } };
    const doc = { hidden: false };
    const c = client.createMemberClient({ pollMs: 5000, doc, timers, confirm: { api: () => { gets++; return new Promise((ok) => { release = () => ok({ ok: true, status: 200, body: { pairing: { state: "unpaired" } } }); }); }, isPendingResponse: () => false, track: vi.fn(), newKey: () => "k" } });
    const seen: any[] = [];
    const off = c.subscribe((p: any) => seen.push(p));
    const run = t!; t = null; const first = run();                    // a tick: one request in flight
    expect(gets).toBe(1);
    release!(); await first;
    expect(seen).toEqual([{ state: "unpaired" }]);
    doc.hidden = true; const hiddenTick = t!; t = null; await hiddenTick();
    expect(gets).toBe(1);                                             // hidden: no request
    expect(t).not.toBeNull();                                         // still paced
    off();
    expect(cleared).toBe(1);
  });
  it("connect / confirm / disconnect: a 202 is sent for confirmation (followed); disconnect is remote pending; the hints are checked first", async () => {
    const calls: any[] = [];
    const confirm = { api: vi.fn(async (path: string, o: any = {}) => { calls.push([path, o.body]);
        if (path === "/api/hub/member/pairing") return { ok: true, status: 200, body: { ok: true, pairing: { state: "unpaired" } } };
        return { ok: false, status: 202, body: { ok: true, result: "pending_confirmation", pending_change: { id: "p".repeat(32) } } }; }),
      isPendingResponse: (r: any) => r.status === 202, track: vi.fn(async () => ({})), newKey: () => "k" };
    const c = client.createMemberClient({ confirm });
    expect(await c.connect({ address: "http://x", code: "ABCD-EFGH" })).toEqual({ ok: false, error: "address" });
    expect(await c.connect({ address: "https://hub.test", code: "ABCD-EF01-2345" })).toEqual({ ok: true, pendingConfirmation: true, pairing: { state: "unpaired" } });
    expect(JSON.parse(calls[0][1])).toEqual({ address: "https://hub.test", code: "ABCD-EF01-2345" });
    expect(await c.disconnect()).toEqual({ ok: false, error: "conflict" });                       // nothing shown: never sent
    expect(await c.disconnect({ state: "paired", hub: { hubId: "h1" }, binding: "b".repeat(64) })).toEqual({ ok: true, remote: "pending", pendingConfirmation: true });
    expect(JSON.parse(calls.at(-2)[1])).toEqual({ hubId: "h1", binding: "b".repeat(64) });
    expect(confirm.track).toHaveBeenCalledTimes(2);
  });
});
