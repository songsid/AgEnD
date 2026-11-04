/** Real SettingsPanel render; all requests are answered in memory, with no server or Agent actions. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const originalFetch = globalThis.fetch;
const machineA = "machine-a", machineB = "machine-b", machineC = "machine-c";
const instances = {
  "linux-running": { backend: "codex", tags: ["work"] },
  "shared-linux": { runtime: "wsl", backend: "codex", tags: ["work"] },
  "shared-local": { runtime: "windows", backend: "codex", tags: ["work"] },
  "shared-remote-a": { runtime: "windows", machine_id: machineA, backend: "codex", tags: ["work"] },
  "shared-remote-b": { runtime: "windows", machineId: machineB, backend: "codex", tags: ["work"] },
  "offline-remote": { runtime: "windows", machine_id: machineC, backend: "codex", tags: ["work"] },
  "shared-unknown": { runtime: "future-runtime", backend: "codex", tags: ["work"] },
  "missing-status": { runtime: "wsl", backend: "codex", tags: ["work"] },
};
const live = [
  { name: "linux-running", status: "running" },
  { name: "shared-linux", status: "stopped" },
  { name: "shared-local", status: "running" },
  { name: "shared-remote-a", status: "running", machine_id: machineA, machine_name: "Desktop A", machine_status: "online" },
  { name: "shared-remote-b", status: "running", machine_id: machineB, machine_name: "Laptop B", machine_status: "online" },
  { name: "offline-remote", status: "paused", machine_id: machineC, machine_name: "Offline C", machine_status: "offline" },
  { name: "shared-unknown", status: "future-status" },
];
const requests: Array<{ path: string; method: string }> = [];
let p: AppPage, Panel: any, app: any, apply: any, nav: any;

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/settings/agents", storage: { agend_lang: "en", agend_tour_done: "1" } });
  globalThis.fetch = (async (path: string, init: any = {}) => {
    requests.push({ path, method: init.method || "GET" });
    let body: any = {}, status = 200;
    if (path === "/api/settings/schema") body = { provider_secrets: false, impacts: {}, order: ["now", "instance", "fleet"] };
    else if (path === "/api/settings/fleet/raw") body = { defaults: { backend: "codex" }, instances: structuredClone(instances), teams: { Review: { members: ["shared-remote-a"] } }, channels: [] };
    else if (path === "/api/fleet") body = { version: "2.3.5-alpha", instances: structuredClone(live) };
    else if (path === "/api/settings/classic") body = { defaults: {}, channels: {} };
    else if (["/api/settings/connections", "/api/profiles", "/api/settings/pending"].includes(path)) body = [];
    else if (path === "/ui/backend-login") body = { targets: [], login: null };
    else status = 404;
    return { ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) };
  }) as any;
  ({ SettingsPanel: Panel } = await import("/ui/js/panel-settings.js"));
  app = await import("/assets/app-store.js");
  apply = await import("/ui/js/settings-apply.js");
  nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
  const { setLang } = await import("/assets/app-i18n.js");
  setLang("en", { store: false });
});
beforeEach(async () => {
  await p.unmount();
  apply.resetOperation();
  app.appStore.set({ pendingChanges: [], windowsCli: false });
  requests.length = 0;
  await p.mount(h(Panel, { route: { panel: "settings", section: "agents" }, navKey: "settings:agents|1|en" }));
  await settle(8);
});
afterEach(async () => { await p.unmount(); });
afterAll(() => { p.restore(); globalThis.fetch = originalFetch; });

const names = () => p.root.querySelectorAll(".s-agent-row").map((row: any) => row.querySelector(".s-name").textContent).sort();
const control = (index: number) => p.root.querySelectorAll(".s-agent-filter-controls select")[index];
const writes = () => requests.filter((request) => request.method !== "GET");
async function pick(index: number, value: string) { const select = control(index); select.value = value; fire(select, "change"); await settle(4); }
async function search(value: string) { const input = p.root.querySelector(".s-toolbar input"); input.value = value; fire(input, "input"); await settle(4); }

describe("Agent list view filters", () => {
  it("intersects the existing search with Runtime and status, preserving team grouping and accurate result counts", async () => {
    expect(names()).toHaveLength(8); // positive control: the real panel loaded every fixture Agent
    await search("shared");
    expect(names()).toEqual(["shared-linux", "shared-local", "shared-remote-a", "shared-remote-b", "shared-unknown"]);
    await pick(0, "windows-remote");
    await pick(1, "running");
    expect(names()).toEqual(["shared-remote-a", "shared-remote-b"]);
    expect(p.root.querySelector(".s-agent-filter-count").textContent).toBe("Showing 2 of 8 Agents");
    expect(p.root.querySelectorAll(".s-agents-list .s-group-head").map((head: any) => head.textContent)).toEqual([expect.stringContaining("Review"), expect.stringContaining("work")]);
    await pick(0, `machine:${machineA}`);
    expect(names()).toEqual(["shared-remote-a"]);
    expect(p.root.querySelector(".s-agent-row .s-agent-runtime").textContent).toContain("Desktop A");
    expect(writes()).toEqual([]);
    expect(p.root.querySelector(".s-pending")).toBeNull();
  });

  it("shows an empty intersection and clears search and both filters without creating a draft", async () => {
    await search("shared"); await pick(0, "windows-remote"); await pick(1, "stopped");
    expect(names()).toEqual([]);
    expect(p.root.querySelector(".empty-title").textContent).toBe('No agents match "shared".');
    expect(p.root.querySelector(".s-agent-filter-count").textContent).toBe("Showing 0 of 8 Agents");
    await search("");
    expect(names()).toEqual([]);
    expect(p.root.querySelector(".empty-title").textContent).toBe("No matching Agents");
    expect([control(0).value, control(1).value]).toEqual(["windows-remote", "stopped"]);
    p.root.querySelector(".s-agent-filter-clear").click(); await settle(4);
    expect(names()).toEqual(Object.keys(instances).sort());
    expect([control(0).value, control(1).value, p.root.querySelector(".s-toolbar input").value]).toEqual(["", "", ""]);
    expect(p.root.querySelector(".s-agent-filter-count").textContent).toBe("Showing 8 of 8 Agents");
    expect(p.root.querySelector(".s-agent-filter-clear").disabled).toBe(true);
    expect(p.root.querySelector(".s-pending")).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("keeps unknown Runtimes outside WSL/local Windows while retaining the absent-runtime WSL default", async () => {
    await pick(0, "wsl");
    expect(names()).toEqual(["linux-running", "missing-status", "shared-linux"]);
    await pick(0, "windows-local");
    expect(names()).toEqual(["shared-local"]);
    await pick(0, "unknown");
    expect(names()).toEqual(["shared-unknown"]);
    expect(p.root.querySelector(".s-agent-row .s-agent-runtime").textContent).toBe("Unknown Runtime");
    expect(writes()).toEqual([]);
  });

  it("distinguishes unreadable or future statuses from the genuinely stopped Agent", async () => {
    await pick(1, "unknown");
    expect(names()).toEqual(["missing-status", "shared-unknown"]);
    expect(p.root.querySelectorAll(".s-agent-status").map((row: any) => row.textContent)).toEqual(["Unknown status", "Unknown status"]);
    expect(p.root.querySelectorAll(".s-agent-row .s-actions button").map((button: any) => button.textContent))
      .not.toContain("Start");
    await pick(1, "stopped");
    expect(names()).toEqual(["shared-linux"]);
    expect(p.root.querySelector(".s-agent-status").textContent).toBe("Stopped");
    expect(p.root.querySelectorAll(".s-agent-row .s-actions button").map((button: any) => button.textContent))
      .toContain("Start");
    expect(writes()).toEqual([]);
  });

  it("uses each actual remote machine and its reported offline flag without changing the paused process state", async () => {
    await pick(0, `machine:${machineB}`); // legacy camelCase config id still maps to the real live machine
    expect(names()).toEqual(["shared-remote-b"]);
    expect(p.root.querySelector(".s-agent-row .s-agent-runtime").textContent).toContain("Laptop B");
    await pick(0, "windows-remote"); await pick(1, "runtime-offline");
    expect(names()).toEqual(["offline-remote"]);
    expect(p.root.querySelector(".s-agent-status").textContent).toContain("Paused");
    expect(p.root.querySelector(".s-agent-runtime-state").textContent).toBe("Runtime offline");
    await pick(1, "paused");
    expect(names()).toEqual(["offline-remote"]); // offline is a machine fact, not a replacement Agent status
    await pick(1, "running");
    expect(names()).toEqual(["shared-remote-a", "shared-remote-b"]);
    expect(writes()).toEqual([]);
  });
});
