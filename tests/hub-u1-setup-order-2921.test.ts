/** M-2921 (spec 1.1): 「設定 Hub」 comes after the connection card, and folds to one line once this Fleet has a connection. */
import { afterEach, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";

const mounted: AppPage[] = [];
const until = async (test: () => unknown) => { for (let i = 0; i < 150 && !test(); i++) await settle(3); };
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
afterEach(async () => { for (const pg of mounted.splice(0)) { await pg.unmount(); pg.restore(); } });
const paired = { state: "paired", binding: "b".repeat(64), hub: { hubId: "11111111-2222-4333-8444-555555555555", name: null, memberOrigin: "https://member.example.test", webOrigin: "https://hub.example.test", fingerprint: { kind: "hub-key", digest: "f".repeat(64) } }, link: "online" };

async function section(pairing: unknown) {
  const pg = page({ url: "http://127.0.0.1:19280/settings/hub", storage: { agend_tour_done: "1" } }); mounted.push(pg);
  pg.document.body.dataset.hubSetup = "1";
  (globalThis as any).fetch = async (path: string) => response(path.split("?")[0] === "/api/settings/hub/membership"
    ? { ok: true, enabled: true, connectionCardV1: true, pairing } : { ok: true, operation: null, display: null });
  (await import("/assets/app-i18n.js")).setLang("en", { store: false });
  const { HubSection } = await import("/ui/js/settings-hub-section.js");
  await pg.mount(h(HubSection, { hubHost: false, overPublicLink: false }));
  await until(() => { const c = pg.root.querySelector("#hub-connection"); return c && c.getAttribute("data-state") !== "unknown" && pg.root.querySelector("#hub-setup"); });
  await settle(10);
  return pg;
}
const order = (pg: AppPage) => [...pg.root.querySelectorAll("#hub-connection, #hub-setup")].map((el: any) => el.id);

describe("M-2921: the Hub setup card's place", () => {
  it("not connected: the connection card first, then 設定 Hub, open", async () => {
    const pg = await section({ state: "unpaired" });
    expect(order(pg)).toEqual(["hub-connection", "hub-setup"]);
    expect(pg.root.querySelector(".hub-setup-folded")).toBeNull();
  });
  it("connected: 設定 Hub folds into one closed line under the connection card", async () => {
    const pg = await section(paired);
    expect(order(pg)).toEqual(["hub-connection", "hub-setup"]);
    const folded = pg.root.querySelector(".hub-setup-folded");
    expect(folded?.open).toBeFalsy(); expect(folded?.querySelector("summary")?.textContent).toBe("Set up a Hub");
    expect(folded?.querySelector("#hub-setup")).toBeTruthy();
  });
});
