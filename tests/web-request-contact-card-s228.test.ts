/**
 * M-3736 J (S-228; design #4456 §6; slice I's V1 contract, docs/design/request-contact-same-card-api.md on #4492): the web
 * same card, over a faked server in the V1 shape (src/request-contact-types.ts, merged with #4492).
 * - The host, from the collection only (Sentinel, #4492): 200 → the same card; 404 (dormant) → today's page; anything
 *   else (401, 403, 503, a network failure) → why, with Try again — never today's less-scoped reads.
 * - The card: the route by the server's labels, who asked (the recorded person, a Hub person, unknown, or none), how it
 *   came in, the message, where replies go, the reason; Continue's D1 scope for a root request, the old words for a
 *   legacy one; a continued request has no actions.
 * - A decision: the snapshot exactly as read; Always allow only through the card's grant candidates, their server keys;
 *   a 409 reads the same card again and shows it, never retried.
 * - Not verified: the same card, its buttons off, with Authorize this browser; verifying decides nothing — the card is
 *   read again and one click decides. Changed meanwhile: its outcome.
 * - A decision whose answer is unknown (no answer, an unreadable one, a server error) reads the same card again; never
 *   resent. Always allow sends only the card's candidate keys, whichever copy of the grant editor the page holds.
 * - Permissions: with the host installed, Clear retained origin is gone and its section is history.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

import type { RequestContactCardV1 } from "../src/request-contact-types.js";
type CardV1 = RequestContactCardV1;

const g = globalThis as any;
const mounted: AppPage[] = [];
const realFetch = g.fetch;
const ID = "R0a1b2c3d-1111-4222-8333-444455556666", ID2 = "R9f8e7d6c-1111-4222-8333-444455556666";
const SHA = "a".repeat(64);
const card = (o: Partial<CardV1> = {}, t: Partial<CardV1["ticket"]> = {}): CardV1 => ({
  version: 1, engine: "request-v1",
  ticket: { id: ID, revision: 3, state: "pending", source: "front-desk", target: "billing", verb: "send_to_instance", message: "Please refund order 1042.",
    createdAt: "2026-11-26T08:00:00Z", expiresAt: "2026-11-26T09:00:00Z", ...t },
  sourceLabel: "Front desk", targetLabel: "Billing", requester: { kind: "person", platform: "discord", userId: "1001", displayName: "Alex" },
  ingress: "restricted-room", sourceAudience: { kind: "room", ref: "11111111-1111-4111-8111-111111111111" }, returnAudience: { kind: "room", ref: "11111111-1111-4111-8111-111111111111" },
  grantCandidates: [{ key: '["discord","1001"]', label: "Alex", platform: "discord" }],
  reason: "restricted-room-request", approvalScope: "root-request", authority: "none",
  snapshot: { ticketRevision: 3, policyRevision: 7, imageSha256: SHA },
  actions: { canDecide: true, canGrant: true, requiresVerification: false }, ...o,
});
const BASE = "/ui/api/request-contact-authorizations";

type Route = (body: any, url: string) => { status?: number; body?: unknown };
function api(routes: Record<string, Route>) {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  g.fetch = async (url: string, init: any = {}) => {
    const method = (init.method || "GET").toUpperCase(), body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const hit = routes[`${method} ${url}`] || routes[`${method} ${url.split("?")[0]}`];
    const r = hit ? hit(body, url) : { status: 404, body: {} };
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body ?? {} };
  };
  return calls;
}
const NOT_VERIFIED = { state: "none", reason: "not_authorized" };
const VERIFIED = { state: "verified", until: Date.now() + 3_600_000 };

let client: any, cardMod: any, auth: any, i18n: any;
beforeEach(async () => {
  client = await import("/ui/js/request-contact-client.js");
  cardMod = await import("/ui/js/request-contact-card.js");
  auth = await import("/assets/web-authorize.js");
  i18n = await import("/assets/app-i18n.js");
  client.resetSameCardActive(); auth.resetWebAuthorization(); i18n.setLang("en");
});
afterEach(async () => { for (const p of mounted.splice(0).reverse()) { await p.unmount(); p.restore(); } g.fetch = realFetch; });

async function mountWith(Comp: any, props: any, url = "http://127.0.0.1:19280/ui/fleet/authorizations") {
  const pg = page({ url, storage: { agend_tour_done: "1" } }); mounted.push(pg);
  const store = await import("/assets/app-store.js") as any;
  store.appStore.set({ streamOn: () => () => {}, instances: [{ name: "front-desk" }, { name: "billing" }] });
  const { Toasts } = await import("/assets/ui-toast.js") as any;
  await pg.mount(h("div", null, h(Comp, props), h(Toasts, null)));
  await settle(6);
  return pg;
}
const text = (el: any) => (el?.textContent || "").replace(/\s+/g, " ").trim();
const buttons = (root: any) => [...root.querySelectorAll(".rc-card button")] as any[];
const choice = (root: any, which: string) => root.querySelector(`.rc-card button[data-choice="${which}"]`) as any;
const decisions = (calls: Array<{ method: string; url: string; body: any }>) => calls.filter((c) => c.method === "POST" && c.url.endsWith("/decision"));
const toasts = (root: any) => [...root.querySelectorAll(".toasts .toast")].map(text);

describe("J: the host decides which page (Sentinel #4492: only the collection's 404 is off)", () => {
  it.each([[200, "on"], [404, "off"], [401, "unknown"], [403, "unknown"], [503, "unknown"]] as const)("the collection answers %s → %s", async (status, host) => {
    const calls = api({ [`GET ${BASE}`]: () => ({ status, body: status === 200 ? { version: 1, items: [card()], nextCursor: null } : { error: status === 503 ? "unavailable" : status === 401 ? "sign-in-required" : "forbidden" } }),
      "GET /ui/authorization": () => ({ body: VERIFIED }), "GET /ui/api/contact-authorizations": () => ({ body: { items: [], nextCursor: null } }) });
    const { ContactAuthorizations } = await import("/ui/js/contact-authorizations.js") as any;
    const pg = await mountWith(ContactAuthorizations, {});
    expect(!!pg.root.querySelector(".rc-card"), "the same card").toBe(host === "on");
    const legacyRead = calls.some((c) => c.url.startsWith("/ui/api/contact-authorizations"));
    expect(legacyRead, "today's less-scoped read").toBe(host === "off");
    expect(!!pg.root.querySelector(".rc-unknown"), "why, not a fallback").toBe(host === "unknown");
    if (status === 503) {
      expect(text(pg.root.querySelector(".rc-unknown"))).toContain("Contact requests are unavailable right now.");
      calls.length = 0;
      ([...pg.root.querySelectorAll(".rc-unknown button")] as any[])[0].click(); await settle(6);
      expect(calls.filter((c) => c.url.startsWith(BASE)).length, "not remembered: asked again").toBe(1);
    }
    if (status === 401) expect(text(pg.root.querySelector(".rc-unknown"))).toBe("Sign in to see contact requests.");
  });
});

describe("J: the card", () => {
  it("names the route, who asked and how, the message, where replies go and why; Continue says its D1 scope", async () => {
    api({ "GET /ui/authorization": () => ({ body: VERIFIED }) });
    const pg = await mountWith(cardMod.RequestContactCard, { card: card() });
    const c = text(pg.root.querySelector(".rc-card"));
    for (const s of ["Front desk", "Billing", "Asked by Alex", "Restricted room", "Please refund order 1042.", "Replies go back to the original room.",
      "This was sent while Front desk was working on Alex's request from a restricted room.", "Front desk wants to contact Billing"]) expect(c, s).toContain(s);
    // The credits card's layout (the leader): a standard Needs-you item, one detail line, the rest folded, normal buttons.
    const item = pg.root.querySelector("article.n-item.rc-card") as any;
    expect(item, "a standard .n-item").toBeTruthy();
    expect(item.className.split(/\s+/)).not.toContain("card");                     // no raised card
    expect(item.className).not.toContain("lbar");
    expect(item.querySelectorAll(".n-title").length).toBe(1);
    // The detail line: the reason, then this card's scope in a few words (the leader's capture check); the long wording folded.
    expect(text(item.querySelector(".n-detail"))).toBe("This was sent while Front desk was working on Alex's request from a restricted room. Continue = this request and its follow-up contacts only.");
    expect(item.querySelector("details.n-raw .rc-message")).toBeTruthy();
    expect(buttons(pg.root).every((b) => b.className.includes("btn-sm"))).toBe(true);
    expect(text(pg.root.querySelector(".rc-scope"))).toBe("Continue = this request and its follow-up contacts only.");
    expect(text(pg.root.querySelector("details.rc-more .rc-scope-more"))).toBe("Continue this request and its later Agent contacts. This does not approve what Agents do or authorize unrelated requests.");
    expect(buttons(pg.root).map(text)).toEqual(["Continue (approve once)", "Always allow…", "Decline"]);
    expect(c).not.toContain("Clear retained origin");
  });
  it("zh-TW: the same, in its words (「Agent」, no 代理)", async () => {
    i18n.setLang("zh-TW");
    api({ "GET /ui/authorization": () => ({ body: VERIFIED }) });
    const pg = await mountWith(cardMod.RequestContactCard, { card: card() });
    expect(text(pg.root.querySelector(".rc-scope"))).toBe("繼續＝只放行這筆請求和它後續的聯絡。");
    expect(text(pg.root.querySelector(".rc-scope-more"))).toBe("繼續這筆請求及它後續的 Agent 聯絡；這不代表核准 Agent 的操作，也不會授權其他請求。");
    expect(buttons(pg.root).map(text)).toEqual(["繼續（核准這次）", "一律允許…", "拒絕"]);
    expect(text(pg.root.querySelector(".rc-card"))).toContain("由 Alex 提出");
    expect(text(pg.root.querySelector(".rc-card"))).not.toMatch(/代理|艦隊|公司/);
  });
  it("who asked: a Hub person, an unknown one, none; a legacy ticket keeps its one-request words", async () => {
    api({ "GET /ui/authorization": () => ({ body: VERIFIED }) });
    expect(cardMod.requesterText({ kind: "person", platform: "hub", hubId: "h", id: "u7", displayName: "Sam" })).toBe("Asked by Sam (Hub)");
    expect(cardMod.requesterText({ kind: "unknown", reason: "unidentified" })).toBe("Asked by Unknown person");
    expect(cardMod.requesterText(null)).toBe("No single known person asked");
    const pg = await mountWith(cardMod.RequestContactCard, { card: card({ engine: "legacy", approvalScope: "operation", ingress: "legacy", requester: null, returnAudience: null }) });
    expect(text(pg.root.querySelector(".rc-scope"))).toBe("Approve once = this one request only.");
    expect(text(pg.root.querySelector(".rc-scope-more"))).toBe("Approve = forward this request once.");
    expect(buttons(pg.root).map(text)[0]).toBe("Approve once");
    expect(pg.root.querySelector(".rc-ingress")).toBeNull();
    expect(pg.root.querySelector(".rc-return")).toBeNull();
  });
  it("a continued request says so and has no actions", async () => {
    api({ "GET /ui/authorization": () => ({ body: VERIFIED }) });
    const pg = await mountWith(cardMod.RequestContactCard, { card: card({ continuedFrom: ID2 }) });
    expect(text(pg.root.querySelector(".rc-reason"))).toBe("Continued from request #R9f8e7d6c: it needs no decision here.");
    expect(buttons(pg.root)).toEqual([]);
  });
});

describe("J: deciding (a verified browser)", () => {
  it("Continue sends the snapshot exactly as read, once, and shows the fresh card", async () => {
    const calls = api({ "GET /ui/authorization": () => ({ body: VERIFIED }),
      [`POST ${BASE}/${ID}/decision`]: () => ({ body: card({ actions: { canDecide: false, canGrant: false, requiresVerification: false } }, { state: "approved", decidedAt: "2026-11-26T08:10:00Z" }) }) });
    let shown = card();
    const pg = await mountWith(cardMod.RequestContactCard, { card: shown, onChange: (c: CardV1) => { shown = c; } });
    choice(pg.root, "continue").click(); await settle(6);
    expect(decisions(calls).map((c) => c.body)).toEqual([{ snapshot: { ticketRevision: 3, policyRevision: 7, imageSha256: SHA }, decision: "approve-once" }]);
    expect(shown.ticket.state).toBe("approved");
  });
  it("Decline sends decline; Always allow sends the grant with the card's candidate keys only", async () => {
    const calls = api({ "GET /ui/authorization": () => ({ body: VERIFIED }), [`POST ${BASE}/${ID}/decision`]: () => ({ body: card({}, { state: "approved" }) }) });
    const pg = await mountWith(cardMod.RequestContactCard, { card: card() });
    choice(pg.root, "always").click(); await settle(6);
    const dialog = pg.document.querySelector("dialog.contact-grant-dialog") as any;
    expect(dialog, "the rule opens first").toBeTruthy();
    expect(decisions(calls)).toEqual([]);
    ([...dialog.querySelectorAll("button")] as any[]).find((b) => b.className.includes("btn-primary")).click(); await settle(8);
    const sent = decisions(calls)[0]!.body;
    expect(sent.decision).toBe("approve-once");
    expect(sent.grant.personKeys).toEqual(['["discord","1001"]']);
    expect(Object.keys(sent.grant).sort()).toEqual(["expiresAt", "personKeys", "remainingUses"]);
    const pg2 = await mountWith(cardMod.RequestContactCard, { card: card() });
    choice(pg2.root, "decline").click(); await settle(6);
    expect(decisions(calls).at(-1)!.body.decision).toBe("decline");
  });
  it("no grant candidate (a Hub or unknown person): Always allow is off and says why", async () => {
    api({ "GET /ui/authorization": () => ({ body: VERIFIED }) });
    const pg = await mountWith(cardMod.RequestContactCard, { card: card({ grantCandidates: [], actions: { canDecide: true, canGrant: false, requiresVerification: false } }) });
    expect(choice(pg.root, "always").disabled).toBe(true);
    expect(text(pg.root.querySelector(".rc-no-grant"))).toBe("This request's person can't become an allowed contact; Continue or Decline it.");
  });
  it("409 already-decided: reads the same card again, shows its outcome, never sends again", async () => {
    const calls = api({ "GET /ui/authorization": () => ({ body: VERIFIED }),
      [`POST ${BASE}/${ID}/decision`]: () => ({ status: 409, body: { error: "already-decided" } }),
      [`GET ${BASE}/${ID}`]: () => ({ body: card({ actions: { canDecide: false, canGrant: false, requiresVerification: false } }, { state: "declined", decidedAt: "2026-11-26T08:05:00Z" }) }) });
    let shown = card();
    const pg = await mountWith(cardMod.RequestContactCard, { card: shown, onChange: (c: CardV1) => { shown = c; } });
    choice(pg.root, "continue").click(); await settle(8);
    expect(decisions(calls).length).toBe(1);
    expect(calls.filter((c) => c.method === "GET" && c.url === `${BASE}/${ID}`).length).toBe(1);
    expect(shown.ticket.state).toBe("declined");
    expect(toasts(pg.root)).toContain("This request was decided elsewhere. Here is its outcome.");
  });
});

describe("J: the merged server's other answers", () => {
  it("409 upgrade-required: the server's own words, shown in full, the card read again, never resent", async () => {
    const said = "This request stays held: its target needs an upgraded request-input path before it can continue.";
    const calls = api({ "GET /ui/authorization": () => ({ body: VERIFIED }),
      [`POST ${BASE}/${ID}/decision`]: () => ({ status: 409, body: { error: "upgrade-required", message: said } }), [`GET ${BASE}/${ID}`]: () => ({ body: card() }) });
    const pg = await mountWith(cardMod.RequestContactCard, { card: card({ engine: "legacy", approvalScope: "operation" }) });
    choice(pg.root, "continue").click(); await settle(8);
    expect(decisions(calls).length).toBe(1);
    expect(toasts(pg.root)).toContain(said);
    expect(calls.filter((c) => c.method === "GET" && c.url === `${BASE}/${ID}`).length).toBe(1);
  });
  it("Show more with a cursor the server no longer takes (400 invalid-cursor) reads the list from the top", async () => {
    let first = true;
    const calls = api({ "GET /ui/authorization": () => ({ body: VERIFIED }),
      [`GET ${BASE}`]: (_b, url) => (url.includes("cursor=") ? { status: 400, body: { error: "invalid-cursor" } }
        : first ? (first = false, { body: { version: 1, items: [card()], nextCursor: "c1" } }) : { body: { version: 1, items: [card()], nextCursor: null } }) });
    const { RequestContactAuthorizations } = await import("/ui/js/request-contact-page.js") as any;
    const pg = await mountWith(RequestContactAuthorizations, {});
    ([...pg.root.querySelectorAll("button")] as any[]).find((b) => text(b) === "Show more").click(); await settle(8);
    const lists = calls.filter((c) => c.url.startsWith(BASE) && !c.url.startsWith(`${BASE}/`)).map((c) => c.url);
    expect(lists).toEqual([`${BASE}?status=pending`, `${BASE}?status=pending&cursor=c1`, `${BASE}?status=pending`]);
    expect(pg.root.querySelectorAll(".rc-card").length).toBe(1);
  });
});

describe("J: #4497 review — a decision whose answer is unknown, and the grant editor's keys", () => {
  const committed = () => card({ actions: { canDecide: false, canGrant: false, requiresVerification: false } }, { state: "approved", decidedAt: "2026-11-26T08:10:00Z" });
  it.each([
    ["no answer (a network failure)", () => { throw new TypeError("network"); }],
    ["an answer that can't be read (200, bad JSON)", () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } })],
    ["a server error (503)", () => ({ ok: false, status: 503, json: async () => ({ error: "unavailable" }) })],
  ] as const)("%s: reads the same card once, shows what it is now, never resends", async (_name, answer) => {
    const calls: Array<{ method: string; url: string; body: any }> = [];
    g.fetch = async (url: string, init: any = {}) => {
      const method = (init.method || "GET").toUpperCase(); calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined });
      if (url === "/ui/authorization") return { ok: true, status: 200, json: async () => VERIFIED };
      if (method === "POST" && url === `${BASE}/${ID}/decision`) return (answer as any)();
      if (method === "GET" && url === `${BASE}/${ID}`) return { ok: true, status: 200, json: async () => committed() };   // the server had committed
      return { ok: false, status: 404, json: async () => ({}) };
    };
    let shown = card();
    const pg = await mountWith(cardMod.RequestContactCard, { card: shown, onChange: (c: CardV1) => { shown = c; } });
    choice(pg.root, "continue").click(); await settle(10);
    expect(decisions(calls).length).toBe(1);
    expect(calls.filter((c) => c.method === "GET" && c.url === `${BASE}/${ID}`).length).toBe(1);
    expect(shown.ticket.state).toBe("approved");
    expect(toasts(pg.root)).toContain("Couldn't confirm the decision. Here is the request as it stands now; nothing was sent again.");
  });
  it("a definite refusal (403 forbidden) is said, not read again", async () => {
    const calls = api({ "GET /ui/authorization": () => ({ body: VERIFIED }), [`POST ${BASE}/${ID}/decision`]: () => ({ status: 403, body: { error: "forbidden" } }) });
    const pg = await mountWith(cardMod.RequestContactCard, { card: card() });
    choice(pg.root, "continue").click(); await settle(8);
    expect(calls.filter((c) => c.method === "GET" && c.url === `${BASE}/${ID}`).length).toBe(0);
    expect(toasts(pg.root)).toContain("You can't decide this request.");
  });
  it("an older cached grant editor (no keyOf) still selects the server's keys: the candidates carry the userId their key names", async () => {
    const c = card({ grantCandidates: [{ key: '["discord","1001"]', label: "Alex", platform: "discord" }, { key: '["telegram","2002"]', label: "Robin", platform: "telegram" }] });
    const people = cardMod.candidatePeople(c);
    const { personKey } = await import("/ui/js/contact-auth-client.js") as any;
    expect(people.map(personKey)).toEqual(['["discord","1001"]', '["telegram","2002"]']);              // what the old editor sends
    const { ContactGrantEditor } = await import("/ui/js/contact-grant-editor.js") as any;
    let saved: any = null;
    api({});
    const pg = await mountWith(ContactGrantEditor, { people: [people[0]], source: "Front desk", target: "Billing", verb: "send_to_instance", onClose: () => {}, onSave: async (x: any) => { saved = x; return true; } });
    ([...pg.document.querySelectorAll("dialog.contact-grant-dialog button")] as any[]).find((b) => b.className.includes("btn-primary")).click(); await settle(6);
    expect(saved.personKeys).toEqual(['["discord","1001"]']);                                         // no keyOf: the default key, the server's
    expect(cardMod.candidateUserId({ key: "opaque", platform: "discord" })).toBeNull();
  });
  it("save control: a rule is sent only for keys the card offered", () => {
    const c = card();
    const choice1 = { personKeys: ['["discord","1001"]'], expiresAt: "2026-12-01T00:00:00.000Z", remainingUses: null };
    expect(cardMod.grantFromChoice(c, choice1)).toEqual(choice1);
    for (const bad of [[], ['["discord",null]'], ['["discord","1001"]', '["discord","9999"]'], [7]]) expect(cardMod.grantFromChoice(c, { ...choice1, personKeys: bad }), JSON.stringify(bad)).toBeNull();
    expect(cardMod.grantFromChoice(c, { expiresAt: "x" })).toBeNull();
  });
  it("the current editor sends the card's own key, even one that isn't [platform, userId]", async () => {
    const calls = api({ "GET /ui/authorization": () => ({ body: VERIFIED }), [`POST ${BASE}/${ID}/decision`]: () => ({ body: card({}, { state: "approved" }) }) });
    // A candidate whose key isn't [platform, userId]: the old editor's own key would differ from it — so nothing is sent.
    const pg = await mountWith(cardMod.RequestContactCard, { card: card({ grantCandidates: [{ key: "opaque-key", label: "Alex", platform: "discord" }] }) });
    choice(pg.root, "always").click(); await settle(6);
    expect(pg.document.querySelector("dialog.contact-grant-dialog")).toBeTruthy();
    ([...pg.document.querySelectorAll("dialog.contact-grant-dialog button")] as any[]).find((b) => b.className.includes("btn-primary")).click(); await settle(8);
    const sent = decisions(calls).map((x) => x.body.grant?.personKeys);
    expect(sent.every((k: string[]) => k.every((x) => x === "opaque-key"))).toBe(true);               // the new editor keys by the card's key
  });
});

describe("J: not verified yet — the same card, then an explicit decision", () => {
  it("the buttons are off until verified (one line, Authorize inline); once verified the card is read again and one click decides", async () => {
    let authState: unknown = NOT_VERIFIED;
    const unverified = card({ actions: { canDecide: false, canGrant: true, requiresVerification: true } });
    const calls = api({ "GET /ui/authorization": () => ({ body: authState }), "POST /ui/authorization": () => { authState = { state: "pending", expiresInMs: 300_000 }; return { body: { ok: true, expiresInMs: 300_000 } }; },
      [`GET ${BASE}/${ID}`]: () => ({ body: card() }),
      [`POST ${BASE}/${ID}/decision`]: () => ({ body: card({ actions: { canDecide: false, canGrant: false, requiresVerification: false } }, { state: "approved" }) }) });
    let shown: CardV1 = unverified;
    let pg!: AppPage;
    const remount = async () => { await pg.mount(h("div", null, h(cardMod.RequestContactCard, { card: shown, onChange: (c: CardV1) => { shown = c; void remount(); } }))); await settle(6); };
    pg = await mountWith(cardMod.RequestContactCard, { card: shown, onChange: (c: CardV1) => { shown = c; void remount(); } });
    const c = text(pg.root.querySelector(".rc-card"));
    expect(c).toContain("Asked by Alex");                                                   // the scoped read before verification
    expect(text(pg.root.querySelector(".rc-verify > span"))).toBe("Authorize this browser to decide.");
    expect(text(pg.root.querySelector(".rc-verify .rc-auth-ask"))).toBe("Authorize this browser");
    expect(buttons(pg.root).filter((b) => b.dataset.choice).every((b) => b.disabled)).toBe(true);
    expect(c).not.toMatch(/Your choice|marked/);
    choice(pg.root, "continue").click(); fire(pg.document as any, "keydown", { key: "Enter" }); await settle(6);
    expect(decisions(calls)).toEqual([]);
    // Authorize this browser → pending → (the account confirms) → verified: the card is read again; verifying decides nothing.
    pg.root.querySelector(".rc-verify .rc-auth-ask").click(); await settle(6);
    authState = VERIFIED;
    await vi.waitFor(() => expect(calls.some((x) => x.method === "GET" && x.url === `${BASE}/${ID}`)).toBe(true), { timeout: 6000 });
    await settle(10);
    expect(decisions(calls)).toEqual([]);
    expect(pg.root.querySelector(".rc-verify")).toBeNull();
    expect(choice(pg.root, "continue").disabled).toBe(false);
    choice(pg.root, "continue").click(); await settle(6);
    expect(decisions(calls).map((x) => x.body.decision)).toEqual(["approve-once"]);
  }, 15_000);
  it("changed while authorizing: the read-again card shows its outcome, nothing decided", async () => {
    let authState: unknown = NOT_VERIFIED;
    const calls = api({ "GET /ui/authorization": () => ({ body: authState }), "POST /ui/authorization": () => { authState = { state: "pending", expiresInMs: 300_000 }; return { body: { ok: true, expiresInMs: 300_000 } }; },
      [`GET ${BASE}/${ID}`]: () => ({ body: card({ actions: { canDecide: false, canGrant: false, requiresVerification: false } }, { state: "expired" }) }) });
    let shown: CardV1 = card({ actions: { canDecide: false, canGrant: true, requiresVerification: true } });
    const pg = await mountWith(cardMod.RequestContactCard, { card: shown, onChange: (c: CardV1) => { shown = c; } });
    pg.root.querySelector(".rc-verify .rc-auth-ask").click(); await settle(6);
    authState = VERIFIED;
    await vi.waitFor(() => expect(shown.ticket.state).toBe("expired"), { timeout: 6000 });
    expect(decisions(calls)).toEqual([]);
  }, 15_000);
  it("a decision refused for verification (it lapsed) reads the card again instead of retrying", async () => {
    const calls = api({ "GET /ui/authorization": () => ({ body: VERIFIED }),
      [`POST ${BASE}/${ID}/decision`]: () => ({ status: 403, body: { error: "verification-required" } }),
      [`GET ${BASE}/${ID}`]: () => ({ body: card({ actions: { canDecide: false, canGrant: true, requiresVerification: true } }) }) });
    let shown = card();
    const pg = await mountWith(cardMod.RequestContactCard, { card: shown, onChange: (c: CardV1) => { shown = c; } });
    choice(pg.root, "continue").click(); await settle(8);
    expect(decisions(calls).length).toBe(1);
    expect(shown.actions.requiresVerification).toBe(true);
  });
});

describe("J: the reason, by its stable code", () => {
  it.each([
    ["restricted-room-request", "This was sent while Front desk was working on Alex's request from a restricted room.", "這是 Front desk 處理 Alex 在受限模式房間提出的請求時送出的。"],
    ["guest-request", "This was sent while Front desk was working on a request from Alex, a guest.", "這是 Front desk 處理訪客 Alex 的請求時送出的。"],
    ["hub-request", "This was sent while Front desk was working on Alex's request from the Hub.", "這是 Front desk 處理 Alex 從 Hub 提出的請求時送出的。"],
    ["unproved-recovery", "Front desk resumed work whose requester couldn't be proven, so this contact needs approval.", "Front desk 接續的工作無法證明是誰提出的，因此這次聯絡需要核准。"],
    ["unknown-origin", "Front desk's retained history has an unknown origin, so this contact needs approval.", "Front desk 保留的歷史來源不明，因此這次聯絡需要核准。"],
    ["something-new", "This contact needs an admin's approval.", "這次聯絡需要管理員核准。"],
  ] as const)("%s", (reason, en, zh) => {
    expect(cardMod.reasonText(card({ reason }))).toBe(en);
    i18n.setLang("zh-TW");
    expect(cardMod.reasonText(card({ reason }))).toBe(zh);
  });
  it("names the requester by a verified display name, else the identity; an unknown one is \"someone\", never invented", () => {
    expect(cardMod.reasonText(card({ reason: "hub-request", requester: { kind: "person", platform: "hub", hubId: "h1", id: "u7" } }))).toBe("This was sent while Front desk was working on u7's request from the Hub.");
    expect(cardMod.reasonText(card({ reason: "guest-request", requester: { kind: "person", platform: "telegram", userId: "5005" } }))).toBe("This was sent while Front desk was working on a request from 5005, a guest.");
    expect(cardMod.reasonText(card({ reason: "restricted-room-request", requester: null }))).toBe("This was sent while Front desk was working on someone's request from a restricted room.");
  });
});

describe("J: Needs you's request item", () => {
  const ITEM = { id: `contact:${ID}`, type: "contact", reason: "contact_request", instance: "billing", since: 0, contactTicket: { id: ID, source: "front-desk", target: "billing" } };
  it.each([["on", 200], ["off", 404], ["unknown", 503]] as const)("host %s: the one card / today's card / only its title", async (host, status) => {
    const calls = api({ [`GET ${BASE}`]: () => ({ status, body: status === 200 ? { version: 1, items: [], nextCursor: null } : {} }),
      [`GET ${BASE}/${ID}`]: () => ({ body: card({ actions: { canDecide: false, canGrant: true, requiresVerification: true } }) }),
      "GET /ui/authorization": () => ({ body: NOT_VERIFIED }), [`GET /ui/api/contact-authorizations/${ID}`]: () => ({ status: 403, body: { error: "verification-required" } }) });
    const { ContactNeedsItem } = await import("/ui/js/contact-needs.js") as any;
    const pg = await mountWith(ContactNeedsItem, { item: ITEM }, "http://127.0.0.1:19280/ui/needs");
    await settle(6);
    expect(!!pg.root.querySelector(".rc-card"), "the one card").toBe(host === "on");
    expect(calls.some((c) => c.url.startsWith("/ui/api/contact-authorizations")), "today's read").toBe(host === "off");
    if (host === "on") expect(text(pg.root.querySelector(".rc-card"))).toContain("Authorize this browser to decide.");   // unverified: the same card
    expect(text(pg.root.querySelector(".n-title"))).toContain("wants to contact");
  });
});

describe("J: Permissions with the host installed", () => {
  const perm = { instance: "billing", revision: 9, classicRoom: false, mode: "legacy", approvers: [], inheritedApprovers: true,
    nativeGuard: { state: "not-covered", backend: "codex" }, roomTools: { publicRead: false, allowedMcpTools: [], wouldDisable: [] }, canManage: true, suggestRestricted: false,
    grants: [], history: [{ id: "h1", at: "2026-11-18T08:00:00Z", actor: { platform: "host", adapterId: "host", userId: "operator", label: "Owner" }, action: "origin-clear" }],
    originRestriction: { active: true, reason: "unknown-origin" },
    originState: { kind: "unknown", people: [], chain: [], receiptCount: 2, revision: 1, generation: "g1", canClear: true,
      lastCleared: { actor: { platform: "host", adapterId: "host", userId: "operator", label: "Owner" }, at: "2026-11-18T08:00:00Z" } } };
  it.each([["on", 200], ["off", 404], ["unknown", 503]] as const)("host %s: Clear retained origin only where it is known off", async (host, status) => {
    const installed = host === "on";
    api({ [`GET ${BASE}`]: () => (status === 200 ? { body: { version: 1, items: [], nextCursor: null } } : { status }),
      "GET /ui/api/instances/billing/contact-permissions": () => ({ body: perm }) });
    const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
    const pg = await mountWith(ContactPermissionsPanel, { name: "billing" });
    await settle(6);
    const all = text(pg.root);
    expect(!!pg.root.querySelector(".contact-origin-clear"), "the button").toBe(host === "off");
    expect(all.includes("Press Clear retained origin") || all.includes("Permissions → Clear retained origin"), "a note pointing to it").toBe(host === "off");
    expect(all.includes("Retained origin (history)")).toBe(installed);
    expect(all).toContain("Retained origin cleared");                                       // the old audit stays as history
  });
});
