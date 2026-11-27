/**
 * M-3339 (A2): the web side of contact authorizations, on Sentinel's wire contract (src/contact-auth-types.ts;
 * docs/design/classic-contact-authorizations.md). The fixtures are typed by that contract.
 * - Permissions (contact-permissions.js): a ClassicBot room — its mode (and the suggestion, with what would stop), the
 *   command-line guard (unknown coverage never "ready"), its tools (public read, exact MCP tools, the owner-account
 *   warning); a worker — approvers (inherited), allowed contacts, history. Writes carry the revision read; a 409 reads
 *   again; 403/503 say so; nothing is changeable without canManage / canSetMode. A contact-auth frame with a newer
 *   revision reads again; an older one doesn't.
 * - Fleet → Authorizations (contact-authorizations.js): waiting requests by default, the scoped filters (agent; a person
 *   by exact identity), Show more by cursor, ?ticket= on top, Approve once / Decline with the revision and the separate
 *   "also allow" grant, a request decided elsewhere read again.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import type { ContactPermissions, ContactTicket, ContactPerson } from "../src/contact-auth-types.js";

const g = globalThis as any;
const mounted: AppPage[] = [];
const realFetch = g.fetch;
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } g.fetch = realFetch; });

const ALEX: ContactPerson = { platform: "discord", adapterId: "dc-main", userId: "1001", label: "Alex" };
const ADMIN: ContactPerson = { platform: "host", adapterId: "host", userId: "operator", label: "Owner" };
const roomPerm = (o: Partial<ContactPermissions> = {}): ContactPermissions => ({
  instance: "classic-ops", revision: 4, classicRoom: true, mode: "legacy", approvers: [], inheritedApprovers: true,
  nativeGuard: { state: "restart-required", backend: "claude-code" },
  roomTools: { publicRead: true, allowedMcpTools: [{ name: "mcp__drive__search", kind: "mcp", usesOwnerAccount: true, accountWarning: "Uses the owner's Drive account" }], wouldDisable: ["Bash", "mcp__drive__write"] },
  canManage: false, canSetMode: true, suggestRestricted: true, grants: [], history: [], ...o,
} as ContactPermissions);
const workerPerm = (o: Partial<ContactPermissions> = {}): ContactPermissions => ({
  instance: "web-dev", revision: 9, classicRoom: false, mode: "legacy", approvers: [ADMIN], inheritedApprovers: true,
  nativeGuard: { state: "not-covered", backend: "codex" }, roomTools: { publicRead: false, allowedMcpTools: [], wouldDisable: [] },
  canManage: true, suggestRestricted: false,
  grants: [{ id: "g1", person: ALEX, source: "classic-ops", target: "web-dev", verbs: ["send_to_instance", "request_information"], expiresAt: "2026-12-01T00:00:00Z", remainingUses: 3, createdBy: ADMIN, createdAt: "2026-11-18T00:00:00Z" }],
  history: [{ id: "h1", at: "2026-11-18T08:00:00Z", actor: ADMIN, action: "approve", ticketId: "R12", summary: "classic-ops → web-dev" }], ...o,
} as ContactPermissions);
const ticket = (o: Partial<ContactTicket> = {}): ContactTicket => ({
  id: "R12", revision: 2, scope: "peer.dispatch", state: "pending", source: "classic-ops", target: "web-dev", sourceGeneration: "s1", targetGeneration: "t1",
  verb: "send_to_instance", origin: { kind: "human", people: [ALEX], receiptIds: ["hmsg-1"], chain: ["classic-ops"] }, message: "Please rerun the nightly report.",
  requestHash: "h", correlationId: "c", resultRecipient: "classic-ops", createdAt: "2026-11-18T08:00:00Z", expiresAt: "2026-11-19T08:00:00Z", canDecide: true, ...o,
} as ContactTicket);

/** A fetch stand-in: `routes` answer by "METHOD path" (path with its query); every call is logged. */
function api(routes: Record<string, (body: any) => { status?: number; body?: unknown }>) {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  g.fetch = async (url: string, init: any = {}) => {
    const method = (init.method || "GET").toUpperCase(), body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const hit = routes[`${method} ${url}`] || routes[`${method} ${url.split("?")[0]}`];
    const r = hit ? hit(body) : { status: 404, body: {} };
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body ?? {} };
  };
  return calls;
}
async function mountWith(Comp: any, props: any, url = "http://127.0.0.1:19280/ui/fleet/agent/x") {
  const pg = page({ url, storage: { agend_tour_done: "1" } }); mounted.push(pg);
  asked.length = 0; g.confirm = (m: string) => { asked.push(m); return true; };
  const store = await import("/assets/app-store.js") as any;
  const subs = new Map<string, Set<(d: unknown) => void>>();
  store.appStore.set({ streamOn: (n: string, fn: (d: unknown) => void) => { if (!subs.has(n)) subs.set(n, new Set()); subs.get(n)!.add(fn); return () => subs.get(n)!.delete(fn); },
    instances: [{ name: "web-dev" }, { name: "classic-ops" }] });
  const { Toasts } = await import("/assets/ui-toast.js") as any;
  await pg.mount(h("div", null, h(Comp, props), h(Toasts, null)));
  await settle(4);
  const frame = async (n: string, d: unknown) => { for (const fn of subs.get(n) || []) fn(d); await settle(4); };
  return { pg, frame };
}
// The harness answers each question the app asks with globalThis.confirm (tests/helpers/app-harness.ts): yes, recorded.
const asked: string[] = [];
const yes = async () => { await settle(6); const q = asked.shift(); expect(q, "a confirm was asked").toBeTruthy(); return { message: q! }; };
const text = (el: any) => (el?.textContent || "").replace(/\s+/g, " ").trim();
const button = (root: any, label: string) => [...root.querySelectorAll("button")].find((b: any) => text(b) === label) as any;

describe("Permissions: a ClassicBot room", () => {
  it("legacy, suggested: the banner, what would stop, and Switch confirms (listing it) then PUTs the mode with the revision read", async () => {
    let perm = roomPerm();
    const calls = api({ "GET /ui/api/instances/classic-ops/contact-permissions": () => ({ body: perm }),
      "PUT /ui/api/instances/classic-ops/contact-permissions": (b) => { perm = roomPerm({ revision: 5, mode: b.mode, suggestRestricted: false }); return { body: perm }; } });
    const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
    const { pg } = await mountWith(ContactPermissionsPanel, { name: "classic-ops" });
    expect(text(pg.root.querySelector(".contact-suggest-banner"))).toBe("We suggest switching this room to restricted mode.");
    expect(text(pg.root.querySelector(".contact-mode .contact-pill"))).toBe("Free");
    expect(text(pg.root.querySelector(".contact-origin-switch"))).toContain("existing history is treated as unknown");
    expect([...pg.root.querySelectorAll(".contact-would li")].map(text)).toEqual(["Bash", "mcp__drive__write"]);
    fire(button(pg.root, "Switch to restricted"), "click"); await settle(4);
    const q = await yes();
    expect(q.message).toContain("The AI tool's own tools (2): Bash, mcp__drive__write");   // M-3387: by layer, not raw lines
    expect(q.message).toContain("allowed-contact grants cannot match");
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ revision: 4, mode: "restricted" }]);
    expect(text(pg.root.querySelector(".contact-mode .contact-pill"))).toBe("Restricted");
    expect(pg.root.querySelector(".contact-suggest-banner")).toBeNull();
  });
  it("the guard: its state as said (restart needed), and coverage the contract doesn't name is never shown as Active", async () => {
    api({ "GET /ui/api/instances/classic-ops/contact-permissions": () => ({ body: roomPerm({ nativeGuard: { state: "bogus" as any, backend: "x" } }) }) });
    const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
    const { pg } = await mountWith(ContactPermissionsPanel, { name: "classic-ops" });
    expect(text(pg.root.querySelector(".contact-guard .contact-pill"))).toBe("Failed");
    expect(pg.root.querySelector(".contact-guard")?.getAttribute("data-guard")).toBe("failed");
  });
  it("the guard's reason is a code (A3): said in words; a code this page doesn't know is said generically, never shown raw", async () => {
    let reason = "load-not-verified";
    api({ "GET /ui/api/instances/classic-ops/contact-permissions": () => ({ body: roomPerm({ nativeGuard: { state: "restart-required", backend: "claude-code", reason } }) }) });
    const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
    const { pg } = await mountWith(ContactPermissionsPanel, { name: "classic-ops" });
    expect(text(pg.root.querySelector(".contact-guard-reason"))).toBe("The guard hasn't been confirmed as loaded yet. Restart the agent to load it.");
    reason = "brand-new-code";
    const first = mounted.pop()!; await first.unmount(); first.restore();
    const { pg: pg2 } = await mountWith(ContactPermissionsPanel, { name: "classic-ops" });
    expect([text(pg2.root.querySelector(".contact-guard-reason")), text(pg2.root).includes("brand-new-code")]).toEqual(["The guard reported a state this page doesn't know.", false]);
  });
  it("tools: public read, an exact MCP tool with its owner-account warning; add and remove PUT the room tools with the revision", async () => {
    let perm = roomPerm({ mode: "restricted", suggestRestricted: false });
    const calls = api({ "GET /ui/api/instances/classic-ops/contact-permissions": () => ({ body: perm }),
      "PUT /ui/api/instances/classic-ops/contact-permissions": (b) => { perm = roomPerm({ ...perm, revision: perm.revision + 1, roomTools: { ...b.roomTools, wouldDisable: [] } }); return { body: perm }; } });
    const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
    const { pg } = await mountWith(ContactPermissionsPanel, { name: "classic-ops" });
    expect(text(pg.root.querySelector(".contact-owner-warning"))).toBe("Uses the owner's Drive account");
    const input = pg.root.querySelector(".contact-mcp-add input") as any;
    input.value = "mcp__calendar__read"; fire(input, "input"); await settle(2);
    fire(pg.root.querySelector(".contact-mcp-add") as any, "submit"); await settle(6);
    fire([...pg.root.querySelectorAll(".contact-tools .icon-btn")].find((b: any) => b.getAttribute("aria-label") === "Remove mcp__drive__search") as any, "click"); await settle(6);
    expect(calls.filter((c) => c.method === "PUT").map((c) => [c.body.revision, c.body.roomTools.allowedMcpTools.map((x: any) => x.name)])).toEqual([
      [4, ["mcp__drive__search", "mcp__calendar__read"]], [5, ["mcp__calendar__read"]]]);
  });
  it("someone changed it first (409): read again, and said so; nothing is overwritten", async () => {
    let reads = 0;
    const calls = api({ "GET /ui/api/instances/classic-ops/contact-permissions": () => { reads++; return { body: roomPerm({ revision: 4 + reads }) }; },
      "PUT /ui/api/instances/classic-ops/contact-permissions": () => ({ status: 409, body: { code: "conflict" } }) });
    const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
    const { pg } = await mountWith(ContactPermissionsPanel, { name: "classic-ops" });
    fire(button(pg.root, "Switch to restricted"), "click"); await settle(4); await yes();
    expect(reads).toBe(2);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(text((pg.document as any).body)).toContain("Someone changed these permissions just now.");
  });
  it("without canSetMode (and canManage): read only — no switch, no tool edits", async () => {
    api({ "GET /ui/api/instances/classic-ops/contact-permissions": () => ({ body: roomPerm({ canManage: false, canSetMode: false } as any) }) });
    const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
    const { pg } = await mountWith(ContactPermissionsPanel, { name: "classic-ops" });
    expect(text(pg.root.querySelector(".contact-readonly"))).toContain("You can see these permissions but not change them.");
    expect([button(pg.root, "Switch to restricted"), pg.root.querySelector(".contact-mcp-add"), (pg.root.querySelector(".contact-tools input[type=checkbox]") as any)?.disabled]).toEqual([undefined, null, true]);
  });
  it("the room's mode and tools are the room admins' (canSetMode), not the target's managers' (canManage)", async () => {
    api({ "GET /ui/api/instances/classic-ops/contact-permissions": () => ({ body: roomPerm({ canManage: true, canSetMode: false } as any) }) });
    const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
    const { pg } = await mountWith(ContactPermissionsPanel, { name: "classic-ops" });
    expect([button(pg.root, "Switch to restricted"), !!pg.root.querySelector(".contact-mcp-add"), (pg.root.querySelector(".contact-tools input[type=checkbox]") as any)?.disabled]).toEqual([undefined, false, true]);
  });
  it.each([[403, "Only this agent's managers can see its permissions."], [503, "Permissions are unavailable right now. Try again in a moment."]])("a %s read says so", async (status, said) => {
    api({ "GET /ui/api/instances/classic-ops/contact-permissions": () => ({ status }) });
    const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
    const { pg } = await mountWith(ContactPermissionsPanel, { name: "classic-ops" });
    expect(text(pg.root)).toContain(said);
  });
});

describe("Permissions: what would stop is never shown as everything", () => {
  it("impactComplete false: the known removals and a line that the backend's own list couldn't be read (on the page and in the confirm)", async () => {
    api({ "GET /ui/api/instances/classic-ops/contact-permissions": () => ({ body: roomPerm({ roomTools: { publicRead: true, allowedMcpTools: [], wouldDisable: ["Bash"], impactComplete: false } } as any) }) });
    const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
    const { pg } = await mountWith(ContactPermissionsPanel, { name: "classic-ops" });
    expect([[...pg.root.querySelectorAll(".contact-would li")].map(text), text(pg.root.querySelector(".contact-impact-incomplete"))])
      .toEqual([["Bash"], "The backend's own tool list couldn't be read, so other tools may stop too."]);
    fire(button(pg.root, "Switch to restricted"), "click"); await settle(4);
    expect((await yes()).message).toContain("other tools may stop too");
  });
  it("impactComplete false and nothing known: not \"no tool will stop\" — the line that the list couldn't be read", async () => {
    api({ "GET /ui/api/instances/classic-ops/contact-permissions": () => ({ body: roomPerm({ roomTools: { publicRead: true, allowedMcpTools: [], wouldDisable: [], impactComplete: false } } as any) }) });
    const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
    const { pg } = await mountWith(ContactPermissionsPanel, { name: "classic-ops" });
    expect([text(pg.root.querySelector(".contact-mode")).includes("No tool this room uses now will stop."), !!pg.root.querySelector(".contact-impact-incomplete")]).toEqual([false, true]);
  });
});

describe("Permissions: a worker", () => {
  it("approvers (inherited), allowed contacts and history; removing a contact confirms, then PUTs the table without it", async () => {
    let perm = workerPerm();
    const calls = api({ "GET /ui/api/instances/web-dev/contact-permissions": () => ({ body: perm }),
      "PUT /ui/api/instances/web-dev/contact-permissions": (b) => { perm = workerPerm({ revision: 10, grants: b.grants }); return { body: perm }; } });
    const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
    const { pg } = await mountWith(ContactPermissionsPanel, { name: "web-dev" });
    expect([!!pg.root.querySelector(".contact-mode"), !!pg.root.querySelector(".contact-tools")]).toEqual([false, false]);
    expect(text(pg.root.querySelector(".contact-approvers"))).toContain("Inherited from the agent's channel admins.");
    expect(text(pg.root.querySelector(".contact-grants li"))).toContain("Alex From classic-ops to web-dev");
    expect(text(pg.root.querySelector(".contact-grants li"))).toContain("For: message, question");
    expect(text(pg.root.querySelector(".contact-grants li"))).toContain("3 uses left");
    expect(pg.root.querySelector(".contact-history a")?.getAttribute("href")).toBe("/ui/fleet/authorizations?ticket=R12");
    fire(button(pg.root.querySelector(".contact-grants"), "Remove"), "click"); await settle(4); await yes();
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ revision: 9, grants: [] }]);
    expect(text(pg.root.querySelector(".contact-grants"))).toContain("No allowed contacts.");
  });
  it("the stream's contact-auth frame: a newer revision for this agent reads again; an older one or another agent's doesn't", async () => {
    let reads = 0;
    api({ "GET /ui/api/instances/web-dev/contact-permissions": () => { reads++; return { body: workerPerm() }; } });
    const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
    const { frame } = await mountWith(ContactPermissionsPanel, { name: "web-dev" });
    await frame("contact-auth", { instance: "web-dev", revision: 9 });
    await frame("contact-auth", { instance: "classic-ops", revision: 99 });
    expect(reads).toBe(1);
    await frame("contact-auth", { instance: "web-dev", revision: 10 });
    expect(reads).toBe(2);
  });
});

describe("Permissions: approvers (slice 1: a Fleet admin or the verified host operator)", () => {
  it("adding picks one of the server's eligible people (never a typed name), PUTs the list; a refused one (400) says why", async () => {
    let perm = workerPerm({ inheritedApprovers: false, eligibleApprovers: [ADMIN, { platform: "telegram", adapterId: "tg", userId: "7", label: "Kim" }] } as any);
    let refuse = false;
    const calls = api({ "GET /ui/api/instances/web-dev/contact-permissions": () => ({ body: perm }),
      "PUT /ui/api/instances/web-dev/contact-permissions": (b) => (refuse ? { status: 400, body: { code: "invalid-approver" } } : (perm = workerPerm({ ...perm, revision: perm.revision + 1, approvers: b.approvers } as any), { body: perm })) });
    const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
    const { pg } = await mountWith(ContactPermissionsPanel, { name: "web-dev" });
    expect(text(pg.root.querySelector(".contact-approvers"))).toContain("Approver must be a Fleet admin for now.");
    const sel = () => pg.root.querySelector(".contact-approver-add select") as any;
    expect([...sel().querySelectorAll("option")].map(text), "the ones already approving aren't offered").toEqual(["Choose…", "Kim · telegram"]);
    sel().value = "telegram:tg:7"; fire(sel(), "change"); await settle(2);
    fire(pg.root.querySelector(".contact-approver-add") as any, "submit"); await settle(6);
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body.approvers.map((x: any) => x.label))).toEqual([["Owner", "Kim"]]);
    expect(pg.root.querySelector(".contact-approver-add"), "nobody left to add").toBeNull();
    refuse = true;
    fire(button(pg.root.querySelector(".contact-approvers"), "Remove Kim") ?? [...pg.root.querySelectorAll(".contact-approvers .icon-btn")][1], "click"); await settle(6);
    expect(text((pg.document as any).body)).toContain("That person can't approve. Approver must be a Fleet admin for now.");
  });
});

describe("Fleet → Authorizations", () => {
  it("waiting requests by default; a card says who, from where, to whom; Approve once POSTs the decision with the revision", async () => {
    let tk = ticket();
    const calls = api({ "GET /ui/api/contact-authorizations": () => ({ body: { items: [tk], nextCursor: null } }),
      "POST /ui/api/contact-authorizations/R12/decision": (b) => { tk = ticket({ revision: 3, state: "delivered", canDecide: false, decidedAt: "2026-11-18T09:00:00Z", decidedBy: ADMIN }); return { body: tk }; } });
    const { ContactAuthorizations } = await import("/ui/js/contact-authorizations.js") as any;
    const { pg } = await mountWith(ContactAuthorizations, {});
    expect(calls[0]!.url).toBe("/ui/api/contact-authorizations?status=pending");
    const card = pg.root.querySelector('.contact-ticket[data-ticket="R12"]') as any;
    const seen = [text(card.querySelector(".contact-ticket-head")), text(card.querySelector(".contact-ticket-route")), text(card.querySelector(".contact-ticket-message"))];
    expect([...card.querySelectorAll(".contact-ticket-head > *")].map(text), JSON.stringify(seen)).toEqual(["Contact request", "#R12", "message", "Waiting for approval"]);
    expect([...card.querySelectorAll(".contact-agent-chip")].map(text)).toEqual(["classic-ops", "web-dev"]);
    expect(seen[2]).toBe("Please rerun the nightly report.");
    fire(button(card, "Approve once"), "click"); await settle(6);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ revision: 2, decision: "approve-once" }]);
    const after = pg.root.querySelector('.contact-ticket[data-ticket="R12"]') as any;
    expect([after.getAttribute("data-state"), button(after, "Approve once")]).toEqual(["delivered", undefined]);
    expect(text(after)).toContain("Forwarded means the request was delivered, not that the work is done.");
  });
  it("keeps human identities separate from roster display names for routes and hops", async () => {
    const person = { ...ADMIN, label: "", userId: "web-dev" };
    api({ "GET /ui/api/contact-authorizations": () => ({ body: { items: [ticket({ state: "declined", canDecide: false, decidedAt: "2026-11-18T09:00:00Z", decidedBy: person,
      origin: { kind: "human", people: [person], receiptIds: [], chain: ["classic-ops"] } })], nextCursor: null } }) });
    const { ContactAuthorizations } = await import("/ui/js/contact-authorizations.js") as any;
    const { pg } = await mountWith(ContactAuthorizations, {});
    const { appStore } = await import("/assets/app-store.js") as any;
    appStore.set({ instances: [{ name: "web-dev", display_name: "Release helper" }, { name: "classic-ops", display_name: "Example room" }] }); await settle(4);
    expect([...pg.root.querySelectorAll(".contact-agent-chip")].map(text)).toEqual(["Example room", "Release helper"]);
    expect(pg.root.querySelector(".contact-hop")?.getAttribute("title")).toBe("classic-ops");
    expect(text(pg.root.querySelector(".contact-hop"))).toBe("Example room");
    expect(text(pg.root.querySelector(".contact-ticket-origin .link-btn"))).toBe("web-dev");
    expect(text(pg.root.querySelector(".contact-ticket-times"))).toContain("web-dev");
    expect(text(pg.root.querySelector(".contact-ticket-times"))).not.toContain("Release helper");
    expect([...pg.root.querySelectorAll(".contact-agent-filter option")].map(text)).toContain("Release helper");
    expect(pg.root.querySelectorAll(".contact-time-item")).toHaveLength(2);
  });
  it("empty pending requests explain what appears here and offer all records", async () => {
    const calls = api({ "GET /ui/api/contact-authorizations": () => ({ body: { items: [], nextCursor: null } }) });
    const { ContactAuthorizations } = await import("/ui/js/contact-authorizations.js") as any;
    const { pg } = await mountWith(ContactAuthorizations, {});
    expect(text(pg.root.querySelector(".empty-hint"))).toContain("restricted ClassicBot rooms");
    fire(button(pg.root, "View all records"), "click"); await settle(4);
    expect(calls.at(-1)?.url).toBe("/ui/api/contact-authorizations");
    expect(button(pg.root, "View all records")).toBeUndefined();
  });
  it("the explicit allow-contact choice confirms expiry, selected person and uses separately from approve-once", async () => {
    const calls = api({ "GET /ui/api/contact-authorizations": () => ({ body: { items: [ticket()], nextCursor: null } }),
      "POST /ui/api/contact-authorizations/R12/decision": () => ({ body: ticket({ state: "delivered", canDecide: false }) }) });
    const { ContactAuthorizations } = await import("/ui/js/contact-authorizations.js") as any;
    const { pg } = await mountWith(ContactAuthorizations, {});
    const card = pg.root.querySelector(".contact-ticket") as any;
    expect(card.querySelector('input[type="checkbox"]')).toBeNull();
    fire(button(card, "Allow this person to contact this agent…"), "click"); await settle(3);
    const dialog = pg.document.querySelector("dialog") as any;
    // The expiry is a day and a 24-hour time from selects (#4497): the fifth day from today, 10:00.
    const [day, hour, minute] = [...dialog.querySelectorAll(".contact-until select")] as any[];
    const pick = day.querySelectorAll("option")[5].value;
    day.value = pick; fire(day, "change"); await settle(1);
    hour.value = "10"; fire(hour, "change"); await settle(1); minute.value = "00"; fire(minute, "change");
    const uses = dialog.querySelector('input[type="number"]') as any;
    uses.value = "5"; fire(uses, "input"); await settle(2);
    expect(dialog.querySelector('input[type="datetime-local"]')).toBeNull();
    expect(calls.some(c => c.method === "POST")).toBe(false);
    fire(button(dialog, "Approve this one and allow from now on"), "click"); await settle(6);
    const body = calls.find((c) => c.method === "POST")!.body;
    expect([body.decision, body.grant.remainingUses, body.grant.expiresAt, body.grant.personKeys]).toEqual(["approve-once", 5, new Date(`${pick}T10:00`).toISOString(), [JSON.stringify([ALEX.platform, ALEX.userId])]]);
  });
  it("decided elsewhere (409 already-decided): said, and the request read again", async () => {
    let reads = 0;
    api({ "GET /ui/api/contact-authorizations": () => ({ body: { items: [ticket()], nextCursor: null } }),
      "GET /ui/api/contact-authorizations/R12": () => { reads++; return { body: ticket({ state: "declined", canDecide: false }) }; },
      "POST /ui/api/contact-authorizations/R12/decision": () => ({ status: 409, body: { code: "already-decided" } }) });
    const { ContactAuthorizations } = await import("/ui/js/contact-authorizations.js") as any;
    const { pg } = await mountWith(ContactAuthorizations, {});
    fire(button(pg.root, "Decline"), "click"); await settle(6);
    expect([reads, pg.root.querySelector(".contact-ticket")?.getAttribute("data-state")]).toEqual([1, "declined"]);
  });
  it("filters: All drops the status; an agent; a person picked from a request (its exact identity); Show more by cursor", async () => {
    const calls = api({ "GET /ui/api/contact-authorizations": () => ({ body: { items: [ticket()], nextCursor: "c2" } }) });
    const { ContactAuthorizations } = await import("/ui/js/contact-authorizations.js") as any;
    const { pg } = await mountWith(ContactAuthorizations, {});
    fire(button(pg.root, "All"), "click"); await settle(4);
    const sel = pg.root.querySelector(".contact-agent-filter select") as any; sel.value = "web-dev"; fire(sel, "change"); await settle(4);
    fire(button(pg.root.querySelector(".contact-ticket-origin"), "Alex"), "click"); await settle(4);
    fire(button(pg.root, "Show more"), "click"); await settle(4);
    expect(calls.map((c) => c.url)).toEqual(["/ui/api/contact-authorizations?status=pending", "/ui/api/contact-authorizations",
      "/ui/api/contact-authorizations?agent=web-dev", `/ui/api/contact-authorizations?agent=web-dev&person=${encodeURIComponent('["discord","1001"]')}`,
      `/ui/api/contact-authorizations?agent=web-dev&person=${encodeURIComponent('["discord","1001"]')}&cursor=c2`]);
    fire(pg.root.querySelector(".contact-person-filter .chip-x"), "click"); await settle(4);
    expect(calls.at(-1)?.url).toBe("/ui/api/contact-authorizations?agent=web-dev");
  });
  it("?ticket=R7 opens that request on top (read by itself); a request the reader can't decide has no buttons", async () => {
    api({ "GET /ui/api/contact-authorizations": () => ({ body: { items: [ticket()], nextCursor: null } }),
      "GET /ui/api/contact-authorizations/R7": () => ({ body: ticket({ id: "R7", canDecide: false }) }) });
    const { ContactAuthorizations } = await import("/ui/js/contact-authorizations.js") as any;
    const { pg } = await mountWith(ContactAuthorizations, {}, "http://127.0.0.1:19280/ui/fleet/authorizations?ticket=R7");
    const cards = [...pg.root.querySelectorAll(".contact-ticket")] as any[];
    expect(cards.map((c) => [c.getAttribute("data-ticket"), c.classList.contains("focus"), !!button(c, "Approve once")])).toEqual([["R7", true, false], ["R12", false, true]]);
  });
});

describe("a tool the guard doesn't cover (the leader's A3 decision): said plainly, before the mode is set", () => {
  const notCov = { state: "not-covered", backend: "codex", reason: "unsupported-version" };
  it.each([["en", "This AI tool or version isn't covered by the guard: it runs with its normal permissions; only contact approval applies."],
    ["zh-TW", "這個 AI 工具或版本不在防護範圍內：它會以原本的權限執行，只有聯絡申請需要核准。"]])("Permissions (%s): on the guard card and on the legacy room's mode card, never as ready; the switch's confirm says it too", async (lang, said) => {
    api({ "GET /ui/api/instances/classic-ops/contact-permissions": () => ({ body: roomPerm({ nativeGuard: notCov } as any) }) });
    const i18n = await import("/assets/app-i18n.js") as any;
    i18n.setLang(lang, { store: false });
    try {
      const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
      const { pg } = await mountWith(ContactPermissionsPanel, { name: "classic-ops" });
      expect([...pg.root.querySelectorAll(".contact-not-covered")].map((x: any) => [x.closest(".card").classList.contains("contact-mode") ? "mode" : "guard", text(x)]))
        .toEqual([["mode", said], ["guard", said]]);
      expect(pg.root.querySelector(".contact-guard")?.getAttribute("data-guard")).toBe("not-covered");
      fire(pg.root.querySelector(".contact-mode .btn") as any, "click"); await settle(4);
      expect((await yes()).message).toContain(said);
    } finally { i18n.setLang("en", { store: false }); }
  });
  it("a missing selected MCP tool is partial coverage: its own reason, not the not-covered warning", async () => {
    api({ "GET /ui/api/instances/classic-ops/contact-permissions": () => ({ body: roomPerm({ nativeGuard: { state: "not-covered", backend: "claude-code", reason: "missing-selected-mcp" } } as any) }) });
    const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
    const { pg } = await mountWith(ContactPermissionsPanel, { name: "classic-ops" });
    expect([pg.root.querySelector(".contact-not-covered"), text(pg.root.querySelector(".contact-guard-reason"))])
      .toEqual([null, "A selected MCP tool isn't available to the guard, so it isn't covered. Public reading and AgEnD's own tools still work."]);
  });
  it("Needs you's suggestion reads the room's coverage and says it before the switch", async () => {
    api({ "GET /ui/api/instances/classic-ops/contact-permissions": () => ({ body: roomPerm({ nativeGuard: notCov } as any) }) });
    const { ContactNeedsItem } = await import("/ui/js/contact-needs.js") as any;
    const { pg } = await mountWith(ContactNeedsItem, { item: { id: "contact-suggest:classic-ops", type: "contact", reason: "contact_restricted_suggestion", instance: "classic-ops", since: 0, contactSuggestion: { instance: "classic-ops" } } });
    expect(text(pg.root.querySelector(".contact-not-covered"))).toContain("runs with its normal permissions; only contact approval applies.");
  });
  it("ClassicBot defaults (the new-room default) say what restricted means where the guard doesn't cover the tool", () => {
    const src = readFileSync(join(process.cwd(), "src/ui/panel-settings.js"), "utf8");
    expect(src).toMatch(/s-classic-defaults-card"><h3>\$\{tn\("classicDefaultsTitle"\)\}<\/h3>[\s\S]{0,400}ca\("newRoomsRestricted"\)/);
  });
});

describe("why a request needs approval (Sentinel's A1 copy: no reset is offered)", () => {
  it("a ticket's reason code in words, with the retained-history note while it waits; a code the page doesn't know says nothing", async () => {
    api({ "GET /ui/api/contact-authorizations": () => ({ body: { items: [ticket({ reason: "earlier-non-admin" }), ticket({ id: "R13", reason: "something-else" as any, state: "declined", canDecide: false })], nextCursor: null } }) });
    const i18n = await import("/assets/app-i18n.js") as any;
    i18n.setLang("zh-TW", { store: false });
    try {
      const { ContactAuthorizations } = await import("/ui/js/contact-authorizations.js") as any;
      const { pg } = await mountWith(ContactAuthorizations, {});
      expect(text(pg.root.querySelector('[data-ticket="R12"] .contact-reason'))).toBe("classic-ops 保留的歷史含有非管理員輸入，因此這次聯絡需要核准。核准只會轉交這一筆，接收 Agent 的來源維持原狀。若要接受 classic-ops 目前的對話作為它自己的工作，請到 classic-ops 的「設定」→「權限」，按「清除保留的來源」。來源不會自動重設。");
      expect([pg.root.querySelector('[data-ticket="R13"] .contact-reason'), text(pg.root.querySelector('[data-ticket="R13"]')).includes("something-else")]).toEqual([null, false]);
    } finally { i18n.setLang("en", { store: false }); }
  });
  it("Permissions: an active origin restriction says why (unknown origin: its uncertainty wording) and that no reset is verified", async () => {
    api({ "GET /ui/api/instances/classic-ops/contact-permissions": () => ({ body: roomPerm({ originRestriction: { active: true, reason: "unknown-origin", resetSupported: false } } as any) }) });
    const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
    const { pg } = await mountWith(ContactPermissionsPanel, { name: "classic-ops" });
    expect(text(pg.root.querySelector(".contact-origin-restriction"))).toBe("This agent's retained history has an unknown origin, so this contact needs approval. Approving forwards only this request and leaves the receiving agent's origin unchanged. To accept the sending agent's current conversation as their own work, a verified managing admin can use its Permissions → Clear retained origin. It never resets on its own.");
  });
});

describe("the chat badge (message.contactTicket { id, state })", () => {
  it("a held request: 「聯絡申請 #R12」 linking to it; the delivered copy: 「已准轉交 #R12」; a bad id: nothing; every value escaped", async () => {
    const pg = page({ url: "http://127.0.0.1:19280/ui" });
    const i18n = await import("/assets/app-i18n.js") as any;
    const { contactBadgeHtml } = await import("/ui/js/contact-ticket-badge.js") as any;
    try {
      i18n.setLang("zh-TW", { store: false });
      expect(contactBadgeHtml({ contactTicket: { id: "R12", state: "pending" } })).toBe('<a class="contact-badge" data-contact-ticket="R12" href="/ui/fleet/authorizations?ticket=R12">聯絡申請 #R12</a>');
      expect(contactBadgeHtml({ contactTicket: { id: "R12", state: "delivered" } })).toBe('<a class="contact-badge ok" data-contact-ticket="R12" href="/ui/fleet/authorizations?ticket=R12">已准轉交 #R12</a>');
      i18n.setLang("en", { store: false });
      expect(contactBadgeHtml({ contactTicket: { id: "R12", state: "declined" } })).toContain(">Contact request #R12 · Declined<");
      expect([contactBadgeHtml({ contactTicket: { id: '"><img src=x>', state: "pending" } }), contactBadgeHtml({}), contactBadgeHtml({ contactTicket: { id: 5 } })]).toEqual(["", "", ""]);
    } finally { i18n.setLang("en", { store: false }); pg.restore(); }
  });
  it("a server id (R + a UUID) is read short — R + its first 8 hex digits — while the link keeps it whole", async () => {
    const pg = page({ url: "http://127.0.0.1:19280/ui" });
    try {
      const { contactBadgeHtml } = await import("/ui/js/contact-ticket-badge.js") as any;
      const id = "R1a2b3c4d-1234-4321-abcd-123456789012";
      expect(contactBadgeHtml({ contactTicket: { id, state: "delivered" } })).toBe(`<a class="contact-badge ok" data-contact-ticket="${id}" href="/ui/fleet/authorizations?ticket=${id}">Forwarded (approved) #R1a2b3c4d</a>`);
    } finally { pg.restore(); }
  });
  it("kept current: a contact-auth frame naming a request on screen reads it again (scoped) and changes its badges in place; others aren't read", async () => {
    let state: ContactTicket["state"] = "pending";
    const calls = api({ "GET /ui/api/contact-authorizations/R30": () => ({ body: ticket({ id: "R30", state }) }) });
    const { pg, frame } = await mountWith(() => null, {});
    const { contactBadgeHtml, installBadgeRefresh } = await import("/ui/js/contact-ticket-badge.js") as any;
    const off = installBadgeRefresh();
    try {
      const holder = pg.document.createElement("div"); holder.innerHTML = contactBadgeHtml({ contactTicket: { id: "R30", state: "pending" } }); pg.document.body.appendChild(holder);
      await frame("contact-auth", { instance: "web-dev", ticketId: "R99", revision: 1 });
      expect(calls).toEqual([]);
      state = "delivered";
      await frame("contact-auth", { instance: "web-dev", ticketId: "R30", revision: 2 }); await settle(4);
      expect([text(holder.querySelector("a")), (holder.querySelector("a") as any).classList.contains("ok"), calls.map((c) => c.url)]).toEqual(["Forwarded (approved) #R30", true, ["/ui/api/contact-authorizations/R30"]]);
      expect(contactBadgeHtml({ contactTicket: { id: "R30", state: "pending" } }), "a later draw keeps the fresh state").toContain("Forwarded (approved) #R30");
    } finally { off(); }
  });
  it("wired: the Fleet chat passes the hook; the shared thread draws it after the time (a Hub room passes none)", () => {
    const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    expect(src("src/ui/panel-chat.js")).toMatch(/contactBadge: \(x\) => \{ installBadgeRefresh\(\); return contactBadgeHtml\(x\); \},/);
    expect(src("src/ui/shared/chat-thread.js")).toMatch(/\$\{time\}\$\{ticks\}\$\{contact\}/);
    expect(src("src/ui/shared/chat-thread.js"), "a status line (the room's held request) too").toMatch(/<div class="msg status-line\$\{folded\}"><div class="meta">\$\{time\}\$\{contact\}<\/div>/);
    expect(src("src/ui/hub-room-thread.js")).not.toMatch(/contactBadge/);
  });
});

describe("Needs you: contact items (references only; the details from the scoped route)", () => {
  it("a request: its title from source and target; the request read from its own route, decidable there; Open goes to it", async () => {
    const calls = api({ "GET /ui/api/contact-authorizations/R12": () => ({ body: ticket() }) });
    const { ContactNeedsItem } = await import("/ui/js/contact-needs.js") as any;
    const { pg } = await mountWith(ContactNeedsItem, { item: { id: "contact:R12", type: "contact", reason: "contact_request", instance: "web-dev", since: 0, contactTicket: { id: "R12", source: "classic-ops", target: "web-dev" } } });
    expect(text(pg.root.querySelector(".n-title"))).toBe("classic-ops wants to contact web-dev");
    expect(calls.map((c) => c.url)).toEqual(["/ui/api/contact-authorizations/R12"]);
    expect([!!button(pg.root, "Approve once"), pg.root.querySelector(".n-actions a")?.getAttribute("href")]).toEqual([true, "/ui/fleet/authorizations?ticket=R12"]);
  });
  it("a request the reader can't read (403): the title only — no text from the list", async () => {
    api({ "GET /ui/api/contact-authorizations/R12": () => ({ status: 403 }) });
    const { ContactNeedsItem } = await import("/ui/js/contact-needs.js") as any;
    const { pg } = await mountWith(ContactNeedsItem, { item: { id: "contact:R12", type: "contact", reason: "contact_request", instance: "web-dev", since: 0, contactTicket: { id: "R12", source: "classic-ops", target: "web-dev" } } });
    expect([pg.root.querySelector(".contact-ticket"), button(pg.root, "Approve once")]).toEqual([null, undefined]);
  });
  const SUGGEST = { id: "contact-suggest:classic-ops", type: "contact", reason: "contact_restricted_suggestion", instance: "classic-ops", since: 0, contactSuggestion: { instance: "classic-ops" } };
  it("the suggestion: 切換這個房間 reads the room (revision, what would stop), confirms, PUTs restricted; 查看 opens its Permissions; 稍後 acknowledges it", async () => {
    const calls = api({ "GET /ui/api/instances/classic-ops/contact-permissions": () => ({ body: roomPerm() }),
      "PUT /ui/api/instances/classic-ops/contact-permissions": () => ({ body: roomPerm({ revision: 5, mode: "restricted" }) }), "POST /ui/needs/ack": () => ({ body: {} }) });
    const i18n = await import("/assets/app-i18n.js") as any;
    i18n.setLang("zh-TW", { store: false });
    try {
      const { ContactNeedsItem } = await import("/ui/js/contact-needs.js") as any;
      const { pg } = await mountWith(ContactNeedsItem, { item: SUGGEST });
      expect(text(pg.root.querySelector(".n-title"))).toBe("建議將這個房間切換為受限模式");
      expect([...pg.root.querySelectorAll(".n-actions > *")].map(text)).toEqual(["切換這個房間", "查看影響與常用轉交", "稍後"]);
      expect(pg.root.querySelector(".n-actions a")?.getAttribute("href")).toBe("/ui/fleet/agent/classic-ops?cat=permissions");
      fire(button(pg.root, "切換這個房間"), "click"); await settle(6);
      const q = await yes();
      expect(q.message).toContain("AI 工具本身的工具（2 個）：Bash, mcp__drive__write");
      expect(q.message).toContain("允許的聯絡授權無法配對");
      expect(text(pg.root.querySelector(".contact-origin-switch"))).toContain("包含管理員");
      fire(button(pg.root, "稍後"), "click"); await settle(6);
      expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([["GET", "/ui/api/instances/classic-ops/contact-permissions", undefined],   // the card's guard coverage
        ["GET", "/ui/api/instances/classic-ops/contact-permissions", undefined],                                                              // the switch: its revision
        ["PUT", "/ui/api/instances/classic-ops/contact-permissions", { revision: 4, mode: "restricted" }], ["POST", "/ui/needs/ack", { id: "contact-suggest:classic-ops" }]]);
    } finally { i18n.setLang("en", { store: false }); }
  });
  it("the suggestion for a reader who may not set the mode: no PUT (said so)", async () => {
    const calls = api({ "GET /ui/api/instances/classic-ops/contact-permissions": () => ({ body: roomPerm({ canSetMode: false } as any) }) });
    const { ContactNeedsItem } = await import("/ui/js/contact-needs.js") as any;
    const { pg } = await mountWith(ContactNeedsItem, { item: SUGGEST });
    fire(button(pg.root, "Switch this room"), "click"); await settle(6);
    expect([calls.filter((c) => c.method === "PUT").length, asked.length]).toEqual([0, 0]);
  });
  it("wired: Needs you hands contact items to it", () => {
    const src = readFileSync(join(process.cwd(), "src/ui/panel-needs.js"), "utf8");
    expect(src).toMatch(/item\.type === "contact"\s*\n\s*\/\/[^\n]*\n\s*\? html`<\$\{ContactNeedsItem\} key=\$\{item\.id\} item=\$\{item\} \/>`/);
  });
});

it("adjusting a displayed rule saves through the Permissions revision and preserves the other scoped rows", async () => {
  const original = workerPerm(), other = { ...original.grants[0], id: "g2", person: { ...ALEX, userId: "fake-other" } };
  let perm = workerPerm({ grants: [...original.grants, other] });
  const calls = api({ "GET /ui/api/instances/web-dev/contact-permissions": () => ({ body: perm }),
    "PUT /ui/api/instances/web-dev/contact-permissions": body => { perm = workerPerm({ revision: 10, grants: body.grants }); return { body: perm }; } });
  const { ContactPermissionsPanel } = await import("/ui/js/contact-permissions.js") as any;
  const { pg } = await mountWith(ContactPermissionsPanel, { name: "web-dev" });
  fire(button(pg.root, "Adjust / extend"), "click"); await settle();
  const select = pg.root.querySelector("dialog select") as any;
  select.value = "30"; fire(select, "change"); await settle();
  fire(button(pg.root, "Save rule"), "click"); await settle(6);
  const body = calls.find(c => c.method === "PUT")!.body;
  expect(body.revision).toBe(9);
  expect(body.grants[0]).toMatchObject({ id: "g1", person: ALEX, source: "classic-ops", target: "web-dev", verbs: original.grants[0].verbs, remainingUses: 3 });
  expect(new Date(body.grants[0].expiresAt).getTime() - Date.now()).toBeGreaterThan(29 * 86400000);
  expect(body.grants[1]).toMatchObject({ id: "g2", person: other.person, expiresAt: other.expiresAt });
  expect(pg.root.querySelector("dialog")).toBeNull();
});
