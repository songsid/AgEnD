/** Actual Hub entry with two owned Fleets and an inert HTTP client; no browser or directory account. */
import { afterEach, beforeAll, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let clients: any, panels: any, words: any;
const mounted: AppPage[] = [], exposureId = "aaaaaaaa-1111-4222-8333-444444444444", fleetId = "bbbbbbbb-1111-4222-8333-444444444444";
beforeAll(async () => { const p = page(); clients = await import("/ui/js/hub-client.js"); panels = await import("/ui/js/panel-hub.js"); words = await import("/assets/app-i18n.js"); p.restore(); });
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } clients.setHubClient(null); panels.resetHubSession(); words.setLang("en", { store: false }); });
const until = async (f: () => unknown) => { for (let i = 0; i < 100 && !f(); i++) await settle(5); };
async function mount(mark = true, connected = true) {
 const calls: any[] = [], owner = { realm: "corp", objectId: fleetId };
 const shared = { id: exposureId, fleetId, owner, revision: 1, state: "published", displayName: "Notes", grants: [], sharingEpoch: 0 };
 const agents = [{ instance: "notes", displayName: "Notes", description: "Keeps notes", general: false, kind: "agent", shareable: true, exposure: { id: exposureId, revision: 1, state: "published" } },
  { instance: "docs", displayName: "Documents", description: "Explains documents", general: false, kind: "agent", shareable: true, exposure: null },
  { instance: "general", displayName: "General", description: "", general: true, kind: "agent", shareable: true, exposure: null },
  { instance: "support", displayName: "Support", description: "A shared room", general: false, kind: "classic-room", shareable: true, exposure: null }];
 const c = clients.createHubWebClient({ fetchImpl: async (path: string, opts: any) => {
  const body = opts.body ? JSON.parse(opts.body) : undefined; calls.push({ path, method: opts.method, body });
  const data = path === "/hub/v1/session" ? { signedIn: true, admin: false, csrf: "fixture-owner", displayName: "Owner", hub: { name: "Example Hub" }, features: mark ? ["agent-sharing-v1", "sharing-pause-v1", "grant-subjects-v1"] : [] }
   : path === "/hub/v1/me/agents" ? { fleets: [{ id: fleetId, label: "Work laptop", connected, catalogSupported: true, catalog: { enabled: true, requests: true, at: Date.now(), revision: "a".repeat(64), agents } }] }
   : path === "/hub/v1/exposures" ? { mine: [shared, { ...shared, id: "eeeeeeee-1111-4222-8333-444444444444", fleetId: null, kind: "personal", personalAgentId: "ffffffff-1111-4222-8333-444444444444", displayName: "Personal notes" }], askable: [] }
   : path === "/hub/v1/me/agent-sharing" ? { id: body.idempotencyKey, fleetId, state: "queued", result: null, expiresAt: Date.now() + 600_000 }
   : { pairings: [] };
  return { ok: true, status: 200, headers: new Headers(), json: async () => data };
 } }); clients.setHubClient(c); panels.resetHubSession();
 const p = page({ url: "http://127.0.0.1/ui/hub/exposures", storage: { agend_lang: "en", agend_tour_done: "1" } }); mounted.push(p);
 await p.mount(h(panels.HubPanel, { route: { panel: "hub", tab: "exposures" }, navKey: `sharing-${mark}-${connected}` }));
 await until(() => p.root.querySelector(mark ? "[data-my-agents] input" : ".hub-shared"));
 return { p, calls, c };
}
it("lists current-owner rows grouped by Fleet; Select all skips General and includes Classic with its memory disclosure", async () => {
 const { p, calls } = await mount();
 expect(p.root.textContent).toContain("Work laptop");
 expect(p.root.querySelectorAll("[data-share-agent]")).toHaveLength(4);
 expect(p.root.textContent).toContain("On my own computer");
 expect(p.root.querySelector('a[href="/ui/hub/exposures?agent=eeeeeeee-1111-4222-8333-444444444444"]')).not.toBeNull();
 (p.root.querySelector("[data-share-all]") as any).click(); await settle(10);
 expect((p.root.querySelector('[data-share-agent="general"]') as any).checked).toBe(false);
 expect((p.root.querySelector('[data-share-agent="support"]') as any).checked).toBe(true);
 expect(p.root.textContent).toContain("one agent with one memory");
 expect(calls.filter(x => x.path === "/hub/v1/me/agent-sharing")).toHaveLength(0);
 const apply = Array.from(p.root.querySelectorAll("button")).find((x: any) => x.textContent === "Share 2 agents") as any;
 expect(apply).toBeTruthy(); apply.click(); await settle(20);
 const writes = calls.filter(x => x.path === "/hub/v1/me/agent-sharing"); expect(writes).toHaveLength(1);
 expect(writes[0].body).toMatchObject({ fleetId, catalogRevision: "a".repeat(64), share: ["docs", "support"], stop: [] });
 expect(p.root.textContent).toContain("Sharing…");
});
it("confirms stops once and offers Pause instead without a Fleet mutation", async () => {
 const { p, calls } = await mount();
 const input = p.root.querySelector('[data-share-agent="notes"]') as any; input.checked = false; fire(input, "change"); await settle(10);
 (Array.from(p.root.querySelectorAll("button")).find((x: any) => x.textContent === "Stop sharing 1 agent") as any).click(); await settle(10);
 expect(p.root.textContent).toContain("Their lists of who may ask are cleared");
 (Array.from(p.document.querySelectorAll("button")).find((x: any) => x.textContent === "Pause instead") as any).click(); await settle(20);
 expect(calls.filter(x => x.path === "/hub/v1/me/agent-sharing")).toHaveLength(0);
 expect(calls.filter(x => x.path.endsWith("/sharing"))).toHaveLength(1);
});
it("keeps offline shares ticked and offers their independent Hub-side pause", async () => {
 const { p } = await mount(true, false);
 const input = p.root.querySelector('[data-share-agent="notes"]') as any;
 expect(input.checked).toBe(true); expect(input.disabled).toBe(true);
 expect(p.root.textContent).toContain("This Fleet is offline"); expect(p.root.textContent).toContain("Pause sharing");
});
it("keeps the legacy shared list with an older Hub and makes no owner-inventory call", async () => {
 const { p, calls } = await mount(false);
 expect(p.root.querySelector("[data-my-agents]")).toBeNull();
 expect(p.root.querySelector(".hub-shared")).not.toBeNull();
 expect(calls.some(x => x.path === "/hub/v1/me/agents")).toBe(false);
});
it("session-scopes every new owner mutation and read, so queued work cannot use the next person's cookie", async () => {
 const { c, calls } = await mount(); await c.signOut(); const before = calls.length;
 for (const out of await Promise.all([c.ownAgents("fixture-owner"), c.refreshOwnAgents("fixture-owner", fleetId), c.requestAgentSharing("fixture-owner", {}), c.ownerGrant("fixture-owner", {}), c.usePreviousAgentAccess("fixture-owner", exposureId, {})])) expect(out.code).toBe("unauthenticated");
 expect(calls).toHaveLength(before);
});
it("reuses exact-login access on a Hub without subject search and stops a multi-target write when the session ends", async () => {
 const { p, c, calls } = await mount(); const module = await import("/ui/js/hub-grant-picker.js");
 let release!: () => void, started!: () => void; const entered = new Promise<void>(r => { started = r; }); const gate = new Promise<void>(r => { release = r; });
 await p.mount(h(module.HubGrantPicker, { x: { id: exposureId, revision: 1, displayName: "Notes" }, targets: [{ id: exposureId, revision: 1, displayName: "Notes" }, { id: fleetId, revision: 2, displayName: "Documents" }], client: c, legacy: true, act: (f: any) => f(), onClose: () => {}, grant: async (input: any) => { const out = await c.ownerGrant("fixture-owner", input); started(); await gate; return out; } }));
 const input = p.root.querySelector("[data-grant-login]") as any; expect(input).not.toBeNull(); input.value = "reader"; fire(input, "input"); await settle(5);
 fire(p.root.querySelector("[data-grant-picker]")!, "submit"); await entered; await c.signOut(); release(); await settle(10);
 expect(calls.filter(x => x.path === "/hub/v1/grants")).toHaveLength(1);
 expect(calls.find(x => x.path === "/hub/v1/grants").body).toEqual({ exposureId, exposureRevision: 1, days: 7, login: "reader" });
});
