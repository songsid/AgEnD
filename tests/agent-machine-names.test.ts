/** The Agent list names a remote computer as the Runtime page does, and says so (with a short id) when it cannot. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const originalFetch = globalThis.fetch;
const idLive = "a5166881-fa8f-421c-be35-e8b09d5f72a8", idCatalog = "b1111111-2222-4333-8444-555555555555",
  idGone = "c2222222-3333-4444-8555-666666666666", idRevoked = "d3333333-4444-4555-8666-777777777777";
const instances = {
  "named-live": { runtime: "windows", machine_id: idLive, backend: "codex" },
  "named-catalog": { runtime: "windows", machine_id: idCatalog, backend: "codex" },
  "gone": { runtime: "windows", machine_id: idGone, backend: "codex" },
  "revoked": { runtime: "windows", machine_id: idRevoked, backend: "codex" },
};
const live = [
  { name: "named-live", status: "running", machine_id: idLive, machine_name: "junsionloh3", machine_status: "online" },
  { name: "named-catalog", status: "running", machine_id: idCatalog, machine_status: "online" },
  { name: "gone", status: "running", machine_id: idGone, machine_status: "offline" },
  { name: "revoked", status: "running", machine_id: idRevoked, machine_name: "Old PC", machine_status: "revoked" },
];
const machines = [
  { id: idLive, name: "junsionloh3", status: "online" },
  { id: idCatalog, name: "Desktop A", status: "online" },
  { id: idRevoked, name: "Old PC", status: "revoked" },
];
let fleetInstances: Record<string, any> = instances, listReads = 0;
let p: AppPage, Panel: any, app: any, apply: any, nav: any, catalog: any, catalogAnswer: () => { ok: boolean; status: number; body: any };

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/settings/agents", storage: { agend_lang: "en", agend_tour_done: "1" } });
  globalThis.fetch = (async (path: string) => {
    let body: any = {}, status = 200;
    if (path === "/api/settings/schema") body = { provider_secrets: false, impacts: {}, order: ["now", "instance", "fleet"] };
    else if (path === "/api/settings/fleet/raw") body = { defaults: { backend: "codex" }, instances: structuredClone(fleetInstances), teams: {}, channels: [] };
    else if (path === "/api/fleet") body = { version: "2.3.5-alpha", instances: structuredClone(live) };
    else if (path === "/api/settings/classic") body = { defaults: {}, channels: {} };
    else if (["/api/settings/connections", "/api/profiles", "/api/settings/pending"].includes(path)) body = [];
    else if (path === "/ui/backend-login") body = { targets: [], login: null };
    else if (path === "/ui/runtimes") { listReads++; const answer = catalogAnswer(); return { ok: answer.ok, status: answer.status, json: async () => answer.body }; }
    else status = 404;
    return { ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) };
  }) as any;
  ({ SettingsPanel: Panel } = await import("/ui/js/panel-settings.js"));
  app = await import("/assets/app-store.js");
  apply = await import("/ui/js/settings-apply.js");
  nav = await import("/assets/app-nav.js");
  catalog = await import("/ui/js/runtime-catalog.js");
  nav.startRouter(p.window);
  const { setLang } = await import("/assets/app-i18n.js");
  setLang("en", { store: false });
});
beforeEach(async () => {
  await p.unmount();
  apply.resetOperation();
  catalog.forgetRuntimeCatalog();
  fleetInstances = instances; listReads = 0;
  catalogAnswer = () => ({ ok: true, status: 200, body: { enabled: true, machines } });
  app.appStore.set({ pendingChanges: [], windowsCli: false });
});
afterEach(async () => { await p.unmount(); catalog.forgetRuntimeCatalog(); vi.useRealTimers(); });
afterAll(() => { p.restore(); globalThis.fetch = originalFetch; });

const mount = async () => { await p.mount(h(Panel, { route: { panel: "settings", section: "agents" }, navKey: "settings:agents|1|en" })); await settle(12); };
const tag = (name: string) => p.root.querySelectorAll(".s-agent-row").find((row: any) => row.querySelector(".s-name").textContent === name).querySelector(".s-agent-runtime .tag");
const options = () => p.root.querySelectorAll(".s-agent-filter-controls select")[0].querySelectorAll("option").map((option: any) => option.textContent);

describe("a remote computer in the Agent list", () => {
  it("shows the computer's name, from the live row or else from the computer list, never its id", async () => {
    await mount();
    expect(tag("named-live").textContent).toBe("junsionloh3 · Windows remote");
    expect(tag("named-live").getAttribute("title")).toBe("junsionloh3");
    expect(tag("named-catalog").textContent).toBe("Desktop A · Windows remote");
    expect(options()).toContain("junsionloh3 · Windows remote");
    expect(options()).toContain("Desktop A · Windows remote");
    expect(p.root.querySelector(".s-agents-list").textContent).not.toContain(idLive);
    expect(p.root.querySelector(".s-agents-list").textContent).not.toContain(idCatalog);
  });

  it("says a computer that is in no list is unknown, with the start of its id and where to change it", async () => {
    await mount();
    expect(tag("gone").textContent).toBe("Unknown computer · c2222222");
    expect(tag("gone").className).toContain("warn");
    expect(tag("gone").getAttribute("title")).toContain("change its Runtime");
    expect(tag("gone").getAttribute("title")).toContain(idGone);
    expect(options()).toContain("Unknown computer · c2222222");
    expect(p.root.querySelector(".s-agents-list").textContent).not.toContain(idGone);
  });

  it("still names an Agent's revoked computer, though the Runtime page no longer lists it", async () => {
    await mount();
    expect(tag("revoked").textContent).toBe("Old PC · revoked");
    expect(tag("revoked").className).toContain("warn");
    expect(tag("revoked").getAttribute("title")).toContain("change its Runtime");
    expect(options()).toContain("Old PC · revoked");
  });

  it("calls a revoked computer with no name a revoked computer, with the start of its id", async () => {
    catalogAnswer = () => ({ ok: true, status: 200, body: { enabled: true, machines: [{ id: idRevoked, status: "revoked" }] } });
    await p.mount(h(Panel, { route: { panel: "settings", section: "agents" }, navKey: "settings:agents|1|en" }));
    await settle(12);
    const row = p.root.querySelectorAll(".s-agent-row").find((item: any) => item.querySelector(".s-name").textContent === "revoked");
    expect(row.querySelector(".s-agent-runtime .tag").textContent).toBe("Old PC · revoked"); // the live row still carries the name
    const { machineLabel } = await import("/ui/js/settings-agent-filters.js");
    expect(machineLabel(idRevoked, "", "revoked").label).toBe("Revoked computer · d3333333");
  });

  it("does not call every computer unknown when remote Runtimes are off and the list answers empty", async () => {
    catalogAnswer = () => ({ ok: true, status: 200, body: { enabled: false, machines: [] } });
    await mount();
    for (const name of ["named-live", "gone"]) expect(tag(name).className).not.toContain("warn");
    expect(tag("gone").textContent).toBe("Windows remote");
    expect(tag("named-live").textContent).toBe("junsionloh3 · Windows remote"); // the live row still names it
    expect(options()).not.toContain("Unknown computer · c2222222");
  });

  it("reads the computer list only while a remote Agent is listed, and stops when the page goes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    fleetInstances = { local: { runtime: "windows", backend: "codex" } };
    await mount(); await vi.advanceTimersByTimeAsync(16000);
    expect(listReads).toBe(0); // no remote Agent: nothing asks for computers
    await p.unmount();
    fleetInstances = instances; catalog.forgetRuntimeCatalog();
    await mount(); const first = listReads;
    expect(first).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(11000);
    expect(listReads).toBeGreaterThan(first); // polled while the page is up
    await p.unmount();
    const stopped = listReads;
    await vi.advanceTimersByTimeAsync(16000);
    expect(listReads).toBe(stopped);
  });

  it("does not claim a computer is gone while the computer list cannot be read", async () => {
    catalogAnswer = () => ({ ok: false, status: 403, body: { error: "forbidden" } });
    await mount();
    expect(tag("gone").textContent).toBe("Windows remote");
    expect(tag("gone").className).not.toContain("warn");
    expect(tag("named-live").textContent).toBe("junsionloh3 · Windows remote");
  });
});

describe("a remote computer elsewhere in the app", () => {
  it("is named by its name in the sidebar and chat header, and by the start of its id when it has none", async () => {
    const { machineName } = await import("/assets/machine-name.js");
    expect(machineName(idLive, "junsionloh3")).toBe("junsionloh3");
    expect(machineName(idLive, undefined)).toBe("Computer a5166881");
    expect(machineName(idLive, "")).not.toContain(idLive);
  });
});
