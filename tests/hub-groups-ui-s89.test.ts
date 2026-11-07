/**
 * #3298 S-89: the Hub's signed-in welcome, Administration → Group permissions and their discovery entries, on a fake Hub client
 * shaped by the agreed contract (M-2624; admin-dto.ts #3356). The pages only present the server's answers: the group comes from the
 * server's resolve, the effect from its preview, Save sends that preview's digest (one click, no dialog), Resume one exact row.
 * Gating: nothing of this shows unless the session says "group-policy-v1" AND this tab's client has the calls.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const g = globalThis as any;
let client: any, welcome: any, editor: any, panel: any, section: any;
const mounted: AppPage[] = [];
const until = async (fn: () => unknown, n = 200) => { for (let i = 0; i < n && !fn(); i++) await settle(5); };
const ID1 = "0f1e2d3c-4b5a-4968-8776-655443322110", ID2 = "1f1e2d3c-4b5a-4968-8776-655443322111";
const DN1 = "CN=Hub-Members,OU=Groups,DC=example,DC=test", DN2 = "CN=Hub-Owners,OU=Groups,DC=example,DC=test";
const POLICY = { realm: "corp", generation: "gen-1", revision: 4, state: "enabled", groups: [{ group: { realm: "corp", objectId: ID1 }, dn: DN1, allow: ["ask_agents"], maxFleets: 0 }], denies: [] };

beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19290/ui/hub", storage: { agend_tour_done: "1", agend_lang: "en" } });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  await import("/assets/app-store.js");
  client = await import("/ui/js/hub-client.js");
  welcome = await import("/ui/js/hub-welcome.js");
  editor = await import("/ui/js/hub-group-policy.js");
  panel = await import("/ui/js/panel-hub.js");
  section = await import("/ui/js/settings-hub-section.js");
  pg.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); panel.resetHubSession(); });
afterAll(() => { client.setHubClient(null); });

function fake(over: Record<string, any> = {}) {
  const calls: Array<[string, ...any[]]> = [];
  const rec = (name: string, answer: (...a: any[]) => any) => vi.fn(async (...a: any[]) => { calls.push([name, ...a]); return answer(...a); });
  return { calls, c: {
    stub: false, web: true, groupPolicyV1: true, onSignedOut: () => () => {},
    session: rec("session", () => ({ ok: true, signedIn: true, displayName: "Ada Admin", login: "ada", admin: true, csrf: "x", features: ["group-policy-v1"] })),
    rooms: rec("rooms", () => ({ ok: true, rooms: [] })), catalog: rec("catalog", () => ({ ok: true, askable: [] })),
    adminOverview: rec("adminOverview", () => ({ ok: true, fleets: [], pairings: [] })),
    welcome: rec("welcome", () => ({ ok: true, v: 1, mode: "enabled", chat: { state: "deny", reason: "no-group" }, publish: { state: "deny", reason: "no-group" }, connect: { state: "deny", reason: "no-group", maxFleets: 0, fleets: [] } })),
    groupPolicy: rec("groupPolicy", () => ({ ok: true, groupPolicyV1: true, supported: true, binding: "ready", policy: POLICY, paused: [] })),
    resolveGroup: rec("resolveGroup", () => ({ ok: true, realm: "corp", objectId: ID2, dn: DN2 })),
    previewGroupPolicy: rec("previewGroupPolicy", () => ({ ok: true, previewDigest: "d".repeat(64), expiresAt: Date.now() + 60_000, policyRevision: 4, authorizationVersion: 9,
      impact: { losingActions: [], losingPublication: [], grandfathered: [], suspendedOnSave: [], adminLosesChat: false } })),
    saveGroupPolicy: rec("saveGroupPolicy", () => ({ ok: true, policyRevision: 5, state: "enabled" })),
    resumeGroupResource: rec("resumeGroupResource", () => ({ ok: true, state: "active" })),
    ...over,
  } };
}
async function mountWith(c: any, node: any, url = "http://127.0.0.1:19290/ui/hub") {
  client.setHubClient(c);
  const pg = page({ url, storage: { agend_tour_done: "1", agend_lang: "en" } }); mounted.push(pg);
  await pg.mount(node); await settle(20);
  return pg;
}
const text = (el: any) => (el?.textContent || "").replace(/\s+/g, " ").trim();

describe("the welcome: shaped by what the person may do now", () => {
  it("no actions: both entries stay visible but unavailable, with 'Contact your Hub admin'", async () => {
    const f = fake(); const pg = await mountWith(f.c, h(welcome.HubWelcome, { name: "Bo" }));
    expect(text(pg.root.querySelector('[data-welcome="no-actions"]'))).toBe("Your account can sign in, but no actions are allowed yet. Contact your Hub admin.");
    for (const e of ["chat", "connect"]) expect(pg.root.querySelector(`[data-entry="${e}"]`).getAttribute("aria-disabled"), e).toBe("true");
    expect(pg.root.querySelector('[data-entry="chat"] .btn')).toBe(null);
  });
  it("ask only: Chat opens; Connect says fleet connection isn't included", async () => {
    const onChats = vi.fn();
    const f = fake({ welcome: async () => ({ ok: true, v: 1, mode: "enabled", chat: { state: "allow", reason: "group" }, publish: { state: "deny", reason: "no-group" }, connect: { state: "deny", reason: "no-group", maxFleets: 0, fleets: [] } }),
      catalog: async () => ({ ok: true, askable: [{}, {}] }) });
    const pg = await mountWith(f.c, h(welcome.HubWelcome, { name: "Bo", onChats }));
    fire(pg.root.querySelector('[data-entry="chat"] .btn'), "click"); expect(onChats).toHaveBeenCalledTimes(1);
    expect(pg.root.querySelector('[data-welcome="nothing-shared"]')).toBe(null);
    expect(text(pg.root.querySelector('[data-entry="connect"]'))).toContain("Connecting a fleet is not included in your access.");
  });
  it("full, nothing shared yet: 'No agents have been shared with you yet', never a list of private agents; fleets 0 of 2", async () => {
    const f = fake({ welcome: async () => ({ ok: true, v: 1, mode: "enabled", chat: { state: "allow" }, publish: { state: "allow" }, connect: { state: "allow", maxFleets: 2, fleets: [] } }) });
    const pg = await mountWith(f.c, h(welcome.HubWelcome, { name: "Bo" }));
    expect(text(pg.root.querySelector('[data-welcome="nothing-shared"]'))).toBe("No agents have been shared with you yet. An agent's owner has to give you access.");
    expect(text(pg.root.querySelector('[data-welcome="fleets"]'))).toBe("Your fleets: 0 of 2");
    expect(text(pg.root.querySelector('[data-entry="connect"]'))).not.toMatch(/automatic|instantly/i);          // no quick-pairing promise before S-90
  });
  it("at the fleet limit: manage guidance instead of connecting more", async () => {
    const f = fake({ welcome: async () => ({ ok: true, v: 1, mode: "enabled", chat: { state: "allow" }, publish: { state: "allow" }, connect: { state: "allow", maxFleets: 1, fleets: [{ id: "f1", label: "Desk", status: "active" }] } }) });
    const pg = await mountWith(f.c, h(welcome.HubWelcome, { name: "Bo" }));
    expect(pg.root.querySelector('[data-welcome="limit"]')).not.toBe(null);
  });
  it("the directory didn't answer: 'can't be checked right now' with Retry — never a cached yes", async () => {
    let n = 0;
    const f = fake({ welcome: async () => { n++; return { ok: true, v: 1, mode: "enabled", chat: { state: "unknown" }, publish: { state: "unknown" }, connect: { state: "unknown", maxFleets: 0, fleets: [] } }; } });
    const pg = await mountWith(f.c, h(welcome.HubWelcome, { name: "Bo" }));
    expect(pg.root.querySelector('[data-entry="chat"]').getAttribute("aria-disabled")).toBe("true");
    fire(pg.root.querySelector('[data-welcome="unknown"] .btn'), "click"); await settle(20);
    expect(n).toBe(2);
  });
  it("legacy (group permissions never enabled): today's behaviour — chat by grants, connect through the admin's pairing", async () => {
    const f = fake({ welcome: async () => ({ ok: true, v: 1, mode: "legacy", chat: { state: "allow" }, publish: { state: "allow" }, connect: { state: "deny", maxFleets: 0, fleets: [] } }) });
    const pg = await mountWith(f.c, h(welcome.HubWelcome, { name: "Bo" }));
    expect(pg.root.querySelector('[data-entry="chat"] .btn')).not.toBe(null);
    expect(text(pg.root.querySelector('[data-entry="connect"]'))).toContain("Your Hub admin pairs fleets for you.");
  });
});

describe("Administration → Group permissions", () => {
  it("add a group: the server resolves it; the server's preview is shown; Save sends that preview's digest, once, with no dialog", async () => {
    const f = fake(); const pg = await mountWith(f.c, h(editor.HubGroupPolicyPage, {}));
    await until(() => pg.root.querySelector(".hub-step-form input"));
    const input = pg.root.querySelector(".hub-step-form input"); input.value = DN2; fire(input, "input"); await settle(4);
    fire(pg.root.querySelector(".hub-step-form"), "submit"); await settle(20);
    expect(f.calls.filter(c => c[0] === "resolveGroup")).toEqual([["resolveGroup", DN2]]);
    const row = pg.root.querySelector(`[data-group="${ID2}"]`);
    expect(text(row)).toContain(DN2);
    // A new group starts with chat only and one fleet (#3298 decision 2).
    expect([...row.querySelectorAll("input[type=checkbox]")].map((b: any) => b.checked)).toEqual([true, false, false]);
    await until(() => pg.root.querySelector(".hub-groups-preview .btn-primary"), 400);
    const sent = f.calls.filter(c => c[0] === "previewGroupPolicy").at(-1)![1];
    expect(sent.groups.map((x: any) => [x.group.objectId, x.dn, x.allow, x.maxFleets])).toEqual([[ID1, DN1, ["ask_agents"], 0], [ID2, DN2, ["ask_agents"], 1]]);
    expect(sent.revision).toBe(4);
    expect(text(pg.root.querySelector(".hub-groups-preview"))).toContain("No one loses anything they can do now.");
    fire(pg.root.querySelector(".hub-groups-preview .btn-primary"), "click"); await settle(20);
    const saves = f.calls.filter(c => c[0] === "saveGroupPolicy");
    expect(saves).toHaveLength(1); expect(saves[0]![1]).toEqual(sent); expect(saves[0]![2]).toBe("d".repeat(64));
    expect(pg.document.querySelector("dialog, [role=dialog]")).toBe(null);
  });
  it("the preview's effects are listed, the admin losing chat included", async () => {
    const f = fake({ previewGroupPolicy: async () => ({ ok: true, previewDigest: "e".repeat(64), expiresAt: 1, policyRevision: 4, authorizationVersion: 1, impact: {
      losingActions: [{ personId: { realm: "corp", objectId: ID1 }, name: "Bo Wu", login: "bo" }], losingPublication: [{ personId: { realm: "corp", objectId: ID2 }, name: "Cy", login: null }],
      grandfathered: [{ kind: "exposure", id: "x1", revision: 2, label: "Sales", owner: { name: "Cy" } }], suspendedOnSave: [], adminLosesChat: true } }) });
    const pg = await mountWith(f.c, h(editor.HubGroupPolicyPage, {}));
    await until(() => pg.root.querySelector(`[data-group="${ID1}"] input[type=checkbox]`));
    const box = pg.root.querySelectorAll(`[data-group="${ID1}"] input[type=checkbox]`)[1]; box.checked = true;
    fire(box, "change"); await until(() => pg.root.querySelector(".hub-groups-preview .btn-primary"), 400);
    const p = text(pg.root.querySelector(".hub-groups-preview"));
    for (const words of ["Bo Wu", "bo", "Cy", "Sales", "you won't be able to chat either"]) expect(p, words).toContain(words);
  });
  it("a group the directory doesn't have: said in words, nothing added", async () => {
    const f = fake({ resolveGroup: async () => ({ ok: true, reason: "not-found" }) });
    const pg = await mountWith(f.c, h(editor.HubGroupPolicyPage, {}));
    await until(() => pg.root.querySelector(".hub-step-form input"));
    const input = pg.root.querySelector(".hub-step-form input"); input.value = "CN=Nope,DC=example,DC=test"; fire(input, "input"); await settle(4);
    fire(pg.root.querySelector(".hub-step-form"), "submit"); await settle(20);
    expect(text(pg.root.querySelector(".hub-groups-list [role=alert]"))).toBe("No such group in the directory.");
    expect(pg.root.querySelectorAll(".hub-group-row")).toHaveLength(1);
  });
  it("a directory that can't do group permissions (non-AD): read-only, said plainly, nothing to add or save", async () => {
    const f = fake({ groupPolicy: async () => ({ ok: true, groupPolicyV1: true, supported: false, binding: "ready", policy: { ...POLICY, state: "never-enabled", groups: [] }, paused: [] }) });
    const pg = await mountWith(f.c, h(editor.HubGroupPolicyPage, {}));
    expect(pg.root.querySelector('[data-reason="unsupported"]')).not.toBe(null);
    expect(pg.root.querySelector(".hub-step-form")).toBe(null); expect(pg.root.querySelector(".hub-groups-state .btn")).toBe(null);
  });
  it("repair required: said, and never shown as an empty editable policy", async () => {
    const f = fake({ groupPolicy: async () => ({ ok: true, groupPolicyV1: true, supported: true, binding: "repair-required", policy: null, paused: [] }) });
    const pg = await mountWith(f.c, h(editor.HubGroupPolicyPage, {}));
    expect(pg.root.querySelector('[data-reason="repair"]')).not.toBe(null);
    expect(pg.root.querySelector(".hub-groups-list")).toBe(null); expect(pg.root.querySelector(".hub-step-form")).toBe(null);
  });
  it("before the Hub's enforcement is installed (no preview yet): no Save, said so", async () => {
    const f = fake({ previewGroupPolicy: async () => ({ ok: false, status: 404, code: "not-found" }) });
    const pg = await mountWith(f.c, h(editor.HubGroupPolicyPage, {}));
    await until(() => pg.root.querySelector(".hub-groups-state .btn"));
    fire(pg.root.querySelector(".hub-groups-state .btn"), "click"); await until(() => !pg.root.querySelector(".hub-groups-preview [aria-busy]") && pg.root.querySelector(".hub-groups-preview"), 400);
    await settle(80);
    expect(text(pg.root.querySelector(".hub-groups-preview"))).toContain("becomes available once the Hub's enforcement is installed");
    expect(pg.root.querySelector(".hub-groups-preview .btn-primary")).toBe(null);
  });
  it("a preview the server no longer holds: Save is refused and the effect is checked again", async () => {
    const f = fake({ saveGroupPolicy: async () => ({ ok: false, status: 409, code: "stale-preview" }) });
    const pg = await mountWith(f.c, h(editor.HubGroupPolicyPage, {}));
    await until(() => pg.root.querySelector(".hub-groups-state .btn"));
    fire(pg.root.querySelector(".hub-groups-state .btn"), "click"); await until(() => pg.root.querySelector(".hub-groups-preview .btn-primary"), 400);
    const before = f.calls.filter(c => c[0] === "previewGroupPolicy").length;
    fire(pg.root.querySelector(".hub-groups-preview .btn-primary"), "click");
    await until(() => f.calls.filter(c => c[0] === "previewGroupPolicy").length > before, 400);
    expect(f.calls.filter(c => c[0] === "previewGroupPolicy").length).toBeGreaterThan(before);
    expect(text(pg.root.querySelector(".hub-groups [role=alert]"))).toBe("Something changed since this was checked. Check again.");
  });
  it("Resume sends one exact paused row: its resource, the policy revision shown and its lifecycle revision", async () => {
    const row = { resource: { kind: "fleet", id: "fleet-7", revision: 3 }, lifecycleRevision: 2, label: "Desk", owner: { name: "Bo" } };
    const f = fake({ groupPolicy: async () => ({ ok: true, groupPolicyV1: true, supported: true, binding: "ready", policy: { ...POLICY, state: "suspended" }, paused: [row] }) });
    const pg = await mountWith(f.c, h(editor.HubGroupPolicyPage, {}));
    fire(pg.root.querySelector('[data-paused="fleet-7"] .btn'), "click"); await settle(20);
    expect(f.calls.filter(c => c[0] === "resumeGroupResource")).toEqual([["resumeGroupResource", row.resource, 4, 2]]);
  });
});

describe("discovery and gating", () => {
  it("Administration shows the Group permissions entry only with the session's mark and a client that has the calls", async () => {
    for (const [mark, clientHas, shown] of [[true, true, true], [false, true, false], [true, false, false]] as const) {
      const base = fake();
      const c = { ...base.c, ...(clientHas ? {} : { groupPolicyV1: undefined }),
        session: async () => ({ ok: true, signedIn: true, displayName: "Ada", login: "ada", admin: true, csrf: "x", ...(mark ? { features: ["group-policy-v1"] } : {}) }) };
      const pg = await mountWith(c, h(panel.HubPanel, { route: { panel: "hub", tab: "admin" } }), "http://127.0.0.1:19290/ui/hub/admin");
      await until(() => pg.root.querySelector(".hub-admin"), 200);
      await settle(40);
      expect(!!pg.root.querySelector('[data-entry="group-permissions"]'), `${mark}/${clientHas}`).toBe(shown);
      await pg.unmount(); mounted.splice(mounted.indexOf(pg), 1); pg.restore(); client.setHubClient(null); panel.resetHubSession();
    }
  });
  it("the editor's address on a Hub without group permissions says so (the fleet's Settings link may arrive before the Hub is updated)", async () => {
    const base = fake();
    const c = { ...base.c, session: async () => ({ ok: true, signedIn: true, displayName: "Ada", login: "ada", admin: true, csrf: "x" }) };
    const pg = await mountWith(c, h(panel.HubPanel, { route: { panel: "hub", tab: "admin" } }), "http://127.0.0.1:19290/ui/hub/admin?view=groups");
    await until(() => pg.root.querySelector('[data-groups="unavailable"]'), 200);
    expect(text(pg.root.querySelector('[data-groups="unavailable"]'))).toBe("Group permissions aren't available on this Hub yet. Update the Hub, then try again.");
    expect(base.calls.some(x => x[0] === "groupPolicy")).toBe(false);
  });
  it("the signed-in landing is the welcome when marked; the chat list otherwise", async () => {
    const f = fake();
    const pg = await mountWith(f.c, h(panel.HubPanel, { route: { panel: "hub", tab: "ask" } }));
    await until(() => pg.root.querySelector(".hub-welcome-page"), 300);
    expect(pg.root.querySelector(".hub-home").className).toContain("has-welcome");
    expect(f.calls.some(c => c[0] === "welcome")).toBe(true);
  });
  it("fleet Settings → Hub: a Group permissions row on a Hub host, linking to its own configured HTTPS web origin only", async () => {
    expect(section.hubGroupsHref("https://hub.example.test")).toBe("https://hub.example.test/ui/hub/admin?view=groups");
    expect(section.hubGroupsHref("https://hub.example.test:8443/")).toBe("https://hub.example.test:8443/ui/hub/admin?view=groups");
    for (const bad of ["http://hub.example.test", "https://hub.example.test/x", "javascript:alert(1)", "", undefined, "https://u:p@hub.example.test"]) expect(section.hubGroupsHref(bad), String(bad)).toBe(null);
    // Leader, #3372 N2: hidden until this fleet's own Hub offers group permissions (the server's page mark).
    const unmarked = await mountWith(fake().c, h(section.HubSection, { hubHost: true, hubOrigin: "https://hub.example.test" }), "http://127.0.0.1:19280/settings/hub");
    expect(unmarked.root.querySelector("#hub-group-permissions")).toBe(null);
    await unmarked.unmount(); mounted.splice(mounted.indexOf(unmarked), 1); unmarked.restore();
    client.setHubClient(fake().c);
    const pg = page({ url: "http://127.0.0.1:19280/settings/hub", storage: { agend_tour_done: "1", agend_lang: "en" } }); mounted.push(pg);
    pg.document.body.setAttribute("data-hub-groups", "1");
    await pg.mount(h(section.HubSection, { hubHost: true, hubOrigin: "https://hub.example.test" })); await settle(20);
    const link = pg.root.querySelector("#hub-group-permissions a");
    expect(link.getAttribute("href")).toBe("https://hub.example.test/ui/hub/admin?view=groups");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
  it("a fleet that isn't the Hub host gets no Group permissions row", async () => {
    const member = await mountWith(fake().c, h(section.HubSection, { hubHost: false, hubOrigin: "https://hub.example.test" }), "http://127.0.0.1:19280/settings/hub");
    member.document.body.setAttribute("data-hub-groups", "1");
    expect(member.root.querySelector("#hub-group-permissions")).toBe(null);
  });
});
