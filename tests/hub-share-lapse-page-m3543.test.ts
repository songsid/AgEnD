/** M-3543: the Hub page's Share again of a lapsed agent. Actual Hub entry with an inert HTTP client (from the M-3294 page test). */
import { afterEach, beforeAll, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let clients: any, panels: any, words: any;
const mounted: AppPage[] = [], exposureId = "aaaaaaaa-1111-4222-8333-444444444444", fleetId = "bbbbbbbb-1111-4222-8333-444444444444";
beforeAll(async () => { const p = page(); clients = await import("/ui/js/hub-client.js"); panels = await import("/ui/js/panel-hub.js"); words = await import("/assets/app-i18n.js"); p.restore(); });
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } clients.setHubClient(null); panels.resetHubSession(); words.setLang("en", { store: false }); });
const until = async (f: () => unknown) => { for (let i = 0; i < 100 && !f(); i++) await settle(5); };
async function mount(mark = true, connected = true, policy = false, old = false, lapsed = false) {
 const calls: any[] = [], owner = { realm: "corp", objectId: fleetId };
 const shared = { id: exposureId, fleetId, owner, revision: 1, state: "published", displayName: "Notes", grants: [], sharingEpoch: 0 };
 const agents = [{ instance: "notes", displayName: "Notes", description: "Keeps notes", general: false, kind: "agent", shareable: true, exposure: { id: exposureId, revision: 1, state: "published", ...(lapsed ? { lapsed: true } : {}) } },
  { instance: "docs", displayName: "Documents", description: "Explains documents", general: false, kind: "agent", shareable: true, exposure: null },
  { instance: "general", displayName: "General", description: "", general: true, kind: "agent", shareable: true, exposure: null },
  { instance: "support", displayName: "Support", description: "A shared room", general: false, kind: "classic-room", shareable: true, exposure: null }];
 const c = clients.createHubWebClient({ fetchImpl: async (path: string, opts: any) => {
  const body = opts.body ? JSON.parse(opts.body) : undefined; calls.push({ path, method: opts.method, body });
  const data = path === "/hub/v1/session" ? { signedIn: true, admin: false, csrf: "fixture-owner", displayName: "Owner", hub: { name: "Example Hub" }, features: mark ? ["agent-sharing-v1", "sharing-pause-v1", "grant-subjects-v1", ...(policy ? ["group-policy-v1"] : [])] : [] }
   : path === "/hub/v1/me/agents" ? { fleets: [{ id: fleetId, label: "Work laptop", connected, catalogSupported: !old, catalog: old ? null : { enabled: true, requests: true, at: Date.now(), revision: "a".repeat(64), agents } }] }
   : path === "/hub/v1/me/welcome" ? { ok: true, v: 1, mode: "enabled", chat: { state: "allow" }, publish: { state: "allow" }, connect: { state: "allow", maxFleets: 8, fleets: [{ id: fleetId, label: "Work laptop", status: "active" }] } }
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
it("a lapsed shared agent says Needs re-share and offers Share again: one share request for it, nothing else", async () => {
 const { p, calls } = await mount(true, true, false, false, true);
 expect(p.root.textContent).toContain("Needs re-share");
 const again = p.root.querySelector('[data-share-again="notes"]') as any;
 expect(again).not.toBeNull(); expect(again.textContent).toBe("Share again");
 again.click(); await settle(20);
 const writes = calls.filter(x => x.path === "/hub/v1/me/agent-sharing");
 expect(writes).toHaveLength(1);
 expect(writes[0].body).toMatchObject({ fleetId, catalogRevision: "a".repeat(64), share: ["notes"], stop: [] });
});
it("a shared agent that did not lapse has no Share again", async () => {
 const { p } = await mount();
 expect(p.root.querySelector("[data-share-again]")).toBeNull();
 expect(p.root.textContent).not.toContain("Needs re-share");
});
