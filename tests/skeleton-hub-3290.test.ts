import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let p: AppPage | undefined, client: any, panel: any, router: any;
const ROOM = "11111111-2222-4333-8444-555555555555", AGENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const signed = { signedIn: true, displayName: "Alex", login: "alex", admin: true, csrf: "c".repeat(64), hub: { name: "Team Hub" } };
const room = { id: ROOM, exposureId: AGENT, grantId: "g", state: "active", exposureName: "Guide", ownerName: "Olivia", exposureState: "published", features: [] };
type Reply = [number, any];
function held() { let release!: (r: Reply) => void; const promise = new Promise<Reply>(r => { release = r; }); return { promise, release }; }
const until = async (fn: () => unknown) => { for (let i = 0; i < 100 && !fn(); i++) await settle(3); expect(fn()).toBeTruthy(); };
beforeAll(async () => {
  const initial = page();
  client = await import("/ui/js/hub-client.js"); panel = await import("/ui/js/panel-hub.js"); router = await import("/assets/app-nav.js");
  initial.restore();
});
afterEach(async () => { if (p) { await p.unmount(); p.restore(); p = undefined; } client.setHubClient(null); panel.resetHubSession(); vi.unstubAllGlobals(); });
function api(overrides: Record<string, () => Reply | Promise<Reply>>) {
  const routes: Record<string, () => Reply | Promise<Reply>> = {
    "/hub/v1/session": () => [200, signed], "/hub/v1/rooms": () => [200, { rooms: [room] }],
    "/hub/v1/exposures": () => [200, { mine: [{ id: AGENT, displayName: "Guide", state: "published", grants: [], revision: 1 }], askable: [] }],
    "/hub/v1/pairings": () => [200, { pairings: [] }],
    [`/hub/v1/rooms/${ROOM}/messages`]: () => [200, { entries: [], room }],
    [`/hub/v1/exposures/${AGENT}/activity`]: () => [200, { activity: [] }],
    "/hub/v1/admin/overview": () => [200, { fleets: [], pairings: [] }], ...overrides,
  };
  client.setHubClient(client.createHubWebClient({ fetchImpl: async (url: string) => {
    const [status, json] = await (routes[url.split("?")[0]!] || (() => [404, { code: "not-found" }] as Reply))();
    return { ok: status >= 200 && status < 300, status, json: async () => json, headers: { get: () => null } };
  } }));
  panel.resetHubSession();
}
async function mount(tab = "ask", query = "", sessionRow = false) {
  p = page({ url: `https://hub.test/ui/hub${query}`, storage: { agend_tour_done: "1" } });
  p.document.body.setAttribute("data-hub", "hub"); router.startRouter(p.window);
  await p.mount(h("div", {}, sessionRow ? h(panel.HubSessionMenu, {}) : null, h(panel.HubPanel, { route: { tab }, navKey: tab })));
}

describe("#3290 Hub initial reads", () => {
  it("keeps the session unknown until its read settles, rather than presenting signed out", async () => {
    const pending = held(); api({ "/hub/v1/session": () => pending.promise }); await mount("ask", "", true);
    expect(p!.root.querySelector(".hub-session .skeleton")).not.toBeNull();
    expect(p!.root.querySelector(".p-hub .skeleton")).not.toBeNull();
    expect(p!.root.textContent).not.toContain("Not signed in");
    pending.release([401, {}]); await until(() => p!.root.querySelector("#hubLogin"));
    expect(p!.root.querySelector(".p-hub .skeleton")).toBeNull();
  });

  it("shows a pending room list instead of a completed choose/empty result", async () => {
    const pending = held(); api({ "/hub/v1/rooms": () => pending.promise }); await mount();
    await until(() => p!.root.querySelector(".hub-home .skeleton"));
    expect(p!.root.querySelector(".hub-home .empty")).toBeNull();
    pending.release([200, { rooms: [] }]); await until(() => p!.root.querySelector(".hub-home .empty"));
    expect(p!.root.querySelector(".hub-home .skeleton")).toBeNull();
  });

  it("keeps room lookup and history pending separately, then ends the empty history skeleton", async () => {
    const rooms = held(), history = held(); api({ "/hub/v1/rooms": () => rooms.promise, [`/hub/v1/rooms/${ROOM}/messages`]: () => history.promise });
    await mount("ask", `?room=${ROOM}`); await until(() => p!.root.querySelector(".hub-room-loading .skeleton"));
    rooms.release([200, { rooms: [room] }]); await until(() => p!.root.querySelector("#msgIn"));
    expect(p!.root.querySelector(".hub-scroller .skeleton")).not.toBeNull();
    expect(p!.root.querySelector(".hub-room-empty")).toBeNull();
    expect(p!.root.querySelector("#msgIn")).not.toBeNull();
    history.release([200, { entries: [], room }]); await until(() => p!.root.querySelector(".hub-room-empty"));
    expect(p!.root.querySelector(".hub-scroller .skeleton")).toBeNull();
  });

  it("a failed first history read ends with Retry and can reach a known empty room", async () => {
    let fail = true; api({ [`/hub/v1/rooms/${ROOM}/messages`]: () => fail ? [503, { code: "unreachable" }] : [200, { entries: [], room }] });
    await mount("ask", `?room=${ROOM}`); await until(() => p!.root.querySelector(".hub-scroller .error-state"));
    expect(p!.root.querySelector(".hub-scroller .skeleton")).toBeNull();
    expect(p!.root.querySelector(".hub-room-empty")).toBeNull();
    fail = false; fire(p!.root.querySelector(".hub-scroller .error-state button")!, "click");
    await until(() => p!.root.querySelector(".hub-room-empty"));
  });

  it("shows owner lists and recent activity only after their own reads, not a false empty", async () => {
    const catalog = held(), pairings = held(); api({ "/hub/v1/exposures": () => catalog.promise, "/hub/v1/pairings": () => pairings.promise });
    await mount("exposures"); await until(() => p!.root.querySelector(".hub-owner .sk-rows"));
    expect(p!.root.querySelector(".hub-empty")).toBeNull();
    catalog.release([200, { mine: [{ id: AGENT, displayName: "Guide", state: "published", grants: [] }] }]); pairings.release([200, { pairings: [] }]);
    await until(() => p!.root.querySelector(".hub-shared")); expect(p!.root.querySelector(".hub-owner .skeleton")).toBeNull();
    await p!.unmount(); p!.restore(); p = undefined;
    const activity = held(); api({ [`/hub/v1/exposures/${AGENT}/activity`]: () => activity.promise });
    await mount("exposures", `?agent=${AGENT}`); await until(() => p!.root.querySelector(".hub-owner .sk-rows"));
    expect(p!.root.textContent).not.toContain("No questions yet");
    activity.release([200, { activity: [] }]); await until(() => !p!.root.querySelector(".hub-owner .skeleton"));
  });

  it("retains recent activity during a refresh and after a refresh failure", async () => {
    const refresh = held(); let reads = 0;
    api({ [`/hub/v1/exposures/${AGENT}/activity`]: () => ++reads === 1 ? [200, { activity: [{ askerName: "Sam", askedAt: 1, stage: "answered" }] }] : refresh.promise });
    await mount("exposures", `?agent=${AGENT}`); await until(() => p!.root.textContent.includes("Sam"));
    fire([...p!.root.querySelectorAll("button")].find(b => b.textContent === "Refresh")!, "click"); await settle();
    expect(p!.root.querySelector(".hub-owner .skeleton")).toBeNull(); expect(p!.root.textContent).toContain("Sam");
    refresh.release([503, { code: "unreachable" }]); await until(() => p!.root.querySelector(".hub-owner .error-state"));
    expect(p!.root.textContent).toContain("Sam");
  });

  it("does not call unknown admin fleets zero, and a failure has a working Retry", async () => {
    const overview = held(); let first = true;
    api({ "/hub/v1/admin/overview": () => first ? overview.promise : [200, { fleets: [], pairings: [] }] }); await mount("admin");
    await until(() => p!.root.querySelector(".hub-admin .skeleton"));
    expect(p!.root.textContent).not.toContain("Paired fleets (0)");
    overview.release([503, { code: "unreachable" }]); await until(() => p!.root.querySelector(".hub-admin .error-state"));
    expect(p!.root.querySelector(".hub-admin .skeleton")).toBeNull();
    first = false; fire(p!.root.querySelector(".hub-admin .error-state button")!, "click");
    await until(() => p!.root.querySelector(".hub-steps"));
  });

  it("the New chat picker is pending until catalog data arrives, and a cancelled dialog stays closed", async () => {
    const catalog = held(); api({ "/hub/v1/exposures": () => catalog.promise }); await mount();
    await until(() => p!.root.querySelector(".hub-new")); fire(p!.root.querySelector(".hub-new")!, "click");
    await until(() => p!.root.querySelector("dialog .skeleton")); expect(p!.root.querySelector("dialog .empty")).toBeNull();
    fire(p!.root.querySelector("dialog .dlg-x")!, "click"); await settle();
    catalog.release([200, { askable: [] }]); await settle();
    expect(p!.root.querySelector("dialog")).toBeNull();
  });
});

describe("#3290 Hub-related fleet Settings", () => {
  it("pairing read failures end the skeleton and Retry can show the connect form", async () => {
    p = page(); const first = held(); let fail = false;
    client.setHubClient({ pairing: () => fail ? Promise.resolve({ state: "unpaired" }) : first.promise.then(() => { throw new Error("offline"); }), subscribe: () => () => {} });
    const { HubConnectCard } = await import("/ui/js/settings-hub.js");
    await p.mount(h(HubConnectCard, {})); expect(p.root.querySelector(".s-hub-connect .skeleton")).not.toBeNull();
    first.release([503, {}]); await until(() => p!.root.querySelector(".s-hub-connect .error-state"));
    expect(p.root.querySelector(".s-hub-connect .skeleton")).toBeNull();
    fail = true; fire(p.root.querySelector(".error-state button")!, "click"); await until(() => p!.root.querySelector("#hubAddress"));
  });

  it("exposure inventory has its own pending and failed states, never a false no-agents result", async () => {
    p = page(); let bad = true; const pending = held();
    client.setHubClient({ pairing: async () => ({ state: "paired", link: "online", hub: { name: "Hub", memberOrigin: "https://hub.test", fingerprint: { digest: "a".repeat(64) } } }),
      subscribe: () => () => {}, exposures: () => bad ? pending.promise.then(() => { throw new Error("offline"); }) : Promise.resolve([]) });
    const { HubConnectCard } = await import("/ui/js/settings-hub.js"); await p.mount(h(HubConnectCard, {}));
    await until(() => p!.root.querySelector(".hub-exposures .skeleton"));
    expect(p.root.textContent).not.toContain("No agents");
    pending.release([503, {}]); await until(() => p!.root.querySelector(".hub-exposures .error-state"));
    expect(p.root.querySelector(".hub-exposures .skeleton")).toBeNull();
    bad = false; fire(p.root.querySelector(".hub-exposures .error-state button")!, "click");
    await until(() => !p!.root.querySelector(".hub-exposures .error-state"));
  });

  it.each([
    ["membership", "HubMembershipSettings", ".hub-membership-settings", "settings-hub-membership.js"],
    ["retention", "HubRetentionSettings", ".hub-retention", "settings-hub-retention.js"],
    ["certificate", "HubBrowserCertificateSettings", ".hub-browser-certificate", "settings-hub-browser-certificate.js"],
  ])("%s first read has a skeleton and a failed read ends it", async (_name, component, selector, module) => {
    p = page(); const pending = held();
    vi.stubGlobal("fetch", vi.fn(async () => { await pending.promise; return { ok: false, status: 503, json: async () => ({}) }; }));
    const loaders: Record<string, () => Promise<any>> = {
      "settings-hub-membership.js": () => import("/ui/js/settings-hub-membership.js"),
      "settings-hub-retention.js": () => import("/ui/js/settings-hub-retention.js"),
      "settings-hub-browser-certificate.js": () => import("/ui/js/settings-hub-browser-certificate.js"),
    };
    const mod = await loaders[module!]!(); await p.mount(h(mod[component!], {}));
    expect(p.root.querySelector(`${selector} .skeleton`)).not.toBeNull();
    expect(p.root.querySelector(`${selector} input[role="switch"]`)).toBeNull();
    pending.release([503, {}]); await until(() => !p!.root.querySelector(`${selector} .skeleton`));
    expect(p.root.querySelector(`${selector} [role="status"]`)).not.toBeNull();
  });
});
