/**
 * S3c (S-55): the member card's exposures on the real endpoints (createMemberClient) and the owner's picker.
 * - The member client: the list; publish with the picked view and tools (a 202 is "waiting for your confirmation":
 *   pending + settled); withdraw by the row's exposureId (remote "pending"); an older host's 404 is "unavailable".
 * - The card: switching on opens the picker under that row (one choice preselected), Share sends the pick; a row with a
 *   pending confirmation says so and its switch waits; the refusals' words (limit, not available).
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
  choices: { dataViews: [{ id: "notes", label: "notes" }], tools: [{ name: "documents.read", label: "Read documents" }] }, pending: null };
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
    const r = await c.setExposed("atlas", true, 0, { dataViewId: "notes", tools: ["documents.read"] });
    expect(r).toMatchObject({ ok: true, pending: { expiresAt: 123 }, view: { agent: "atlas", pending: { expiresAt: 123 } } });
    expect(await r.settled).toEqual({ state: "applied" });
    expect(JSON.parse(f.calls[1]![1].body)).toEqual({ agent: "atlas", dataViewId: "notes", tools: ["documents.read"], expectedRevision: 0 });
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

describe("the card's picker and pending rows", () => {
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
  it("switching on opens the picker (one choice preselected); Share sends the pick; a 202 says it waits for confirmation", async () => {
    const setExposed = vi.fn(async () => ({ ok: true, pending: { expiresAt: 9 }, view: { ...ROW, pending: { expiresAt: 9 } }, settled: new Promise(() => {}) }));
    const pg = await cardWith(fakeClient([ROW], setExposed));
    const box = pg.root.querySelector(".hub-exposure input") as any;
    box.checked = true; fire(box, "change");
    await until(() => pg.root.querySelector(".hub-exposure-pick"));
    expect((pg.root.querySelector(".hub-exposure-pick select") as any).value).toBe("notes");
    expect((pg.root.querySelector(".hub-exposure-tools input") as any).checked).toBe(true);
    (pg.root.querySelector(".hub-exposure-pick .btn-primary") as any).click();
    await until(() => setExposed.mock.calls.length > 0 && pg.root.querySelector(".hub-exposures .note[role=status]"));
    expect(setExposed).toHaveBeenCalledWith("atlas", true, 0, { dataViewId: "notes", tools: ["documents.read"] });
    expect(pg.root.querySelector(".hub-exposures [role=status]")!.textContent).toContain("Sent for confirmation");
  });
  it("a pending row says so and its switch waits", async () => {
    const pg = await cardWith(fakeClient([{ ...ROW, pending: { expiresAt: 9 } }]));
    expect(pg.root.querySelector(".hub-exposure-pending")!.textContent).toBe("Waiting for your confirmation");
    expect((pg.root.querySelector(".hub-exposure input") as any).disabled).toBe(true);
  });
  it.each([["limit", "At most 64 agents can be shared."], ["unavailable", "Not available on this AgEnD version."]])("a refusal %s has its words", async (error, words) => {
    const pg = await cardWith(fakeClient([ROW], vi.fn(async () => ({ ok: false, error }))));
    const box = pg.root.querySelector(".hub-exposure input") as any; box.checked = true; fire(box, "change");
    await until(() => pg.root.querySelector(".hub-exposure-pick .btn-primary"));
    (pg.root.querySelector(".hub-exposure-pick .btn-primary") as any).click();
    await until(() => pg.root.querySelector(".hub-exposures .err"));
    expect(pg.root.querySelector(".hub-exposures .err")!.textContent).toBe(words);
  });
  it("Cancel closes the picker; nothing sent", async () => {
    const setExposed = vi.fn();
    const pg = await cardWith(fakeClient([ROW], setExposed));
    const box = pg.root.querySelector(".hub-exposure input") as any; box.checked = true; fire(box, "change");
    await until(() => pg.root.querySelector(".hub-exposure-pick"));
    (pg.root.querySelectorAll(".hub-exposure-pick .btn")[1] as any).click();
    await until(() => !pg.root.querySelector(".hub-exposure-pick"));
    expect(pg.root.querySelector(".hub-exposure-pick")).toBeNull();
    expect(setExposed).not.toHaveBeenCalled();
  });
});
