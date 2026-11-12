/** Current member client + Settings card + notice renderer, inert local API; missing marker models a held old module. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
const capability = vi.hoisted(() => ({ v3: true }));
vi.mock("/ui/js/hub-quick-pairing.js", async original => ({ ...await original<Record<string, unknown>>(), get pairingNoticesV3() { return capability.v3; } }));
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
let ui: any, clients: any, i18n: any;
const pages: AppPage[] = [], ID = "11111111-1111-4111-8111-111111111111";
const rows = [{ id: ID, label: "My Fleet", source: "code", codeId: ID, fleetId: ID, generation: 1, at: 1000, revoked: true }];
const paired = { state: "paired", binding: "binding-one", link: "online", hub: { hubId: ID, name: "Company Hub", memberOrigin: "https://member.example.test", webOrigin: "https://hub.example.test", fingerprint: { kind: "hub-key", digest: "a".repeat(64) } } };
beforeAll(async () => { const p = page(); ui = await import("/ui/js/settings-hub.js"); clients = await import("/ui/js/hub-client.js"); i18n = await import("/assets/app-i18n.js"); p.restore(); });
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } clients.setHubClient(null); capability.v3 = true; });
function client() {
  const confirm = { api: vi.fn(async (url: string) => url.startsWith("/api/hub/member/pairing")
    ? { ok: true, body: { pairing: paired, notices: url.includes("notices=3") ? rows : [] } }
    : { ok: true, body: { exposures: [] } }) };
  return { confirm, client: clients.createMemberClient({ confirm }) };
}
async function mount(c: any, props = {}) {
  const p = page({ url: "https://fleet.example.test/settings/hub" }); pages.push(p); i18n.setLang("en", { store: false });
  clients.setHubClient(c); await p.mount(h(ui.HubConnectCard, props)); await settle(20); return p;
}
describe("current member Settings explicitly leases notice v3", () => {
  it("requests the compatible query and renders the actual code provenance, then retires its lease", async () => {
    const r = client(), p = await mount(r.client);
    expect(r.confirm.api.mock.calls[0][0]).toBe("/api/hub/member/pairing?v=2&notices=3");
    expect(p.root.textContent).toContain("Approved with a join code by your Hub administrator");
    expect(p.root.textContent).not.toContain("Approved by your Hub's group policy");
    await p.unmount(); expect(r.client.pairingNotices()).toEqual([]);
  });
  it("a held renderer without the marker leaves the same client on v2", async () => {
    capability.v3 = false; const r = client(), p = await mount(r.client);
    expect(r.confirm.api.mock.calls[0][0]).toBe("/api/hub/member/pairing?v=2"); expect(p.root.textContent).not.toContain("Approved with a join code");
  });
  it("a held client without the optional method remains loadable, and U1 prefill is preserved", async () => {
    const c = { pairing: vi.fn(async () => ({ state: "unpaired" })), subscribe: () => () => {} };
    const p = await mount(c, { prefill: { address: "https://member.example.test", code: "abcdef012345" } });
    expect(c.pairing).toHaveBeenCalledOnce(); expect(p.root.querySelector("#hubAddress").value).toBe("https://member.example.test");
    expect(p.root.querySelector("#hubCode").value).toBe("abcdef012345");
  });
});
