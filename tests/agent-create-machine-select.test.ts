/**
 * New agent → "Choose a runtime" → Connected computers.
 *  - an online computer that reported a task-capable CLI can be chosen;
 *  - an offline, awaiting-approval, not-yet-inventoried or CLI-less computer cannot, and its row says why and what to do next;
 *  - the list is requested again when the dialog opens, can be refreshed by hand, and follows a computer coming online.
 * Checked in English and zh-TW.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage, Create: any, Change: any, catalog: any, windowsCatalog: any, app: any, i18n: any, picker: any;
const originalFetch = globalThis.fetch;
const ids = ["1", "2", "3", "4", "5", "6"].map(n => `${n}2345678-1234-4321-abcd-123456789012`);
const [online, offline, pending, noInventory, noCli, revoked] = ids;
const cli = () => ({ id: "codex", path: "C:\\tools\\codex.exe", runnable: true, authenticated: true, readOnlySupport: true, supports: { execution: true, resume: true, mcp: true }, models: [] });
const machine = (id: string, name: string, status: string, inventory: any = { home: "C:\\Users", clis: [cli()] }) =>
  ({ id, name, status, platform: "win32", lastSeenAt: Date.now(), ...(inventory ? { inventory, inventoryUpdatedAt: Date.now() } : {}) });
let machines: any[], listReads: number, listAnswer: "ok" | "fail" | "hang", runtimeSource: any;
const response = (body: any, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const radio = (id: string) => p.root.querySelectorAll(".agent-runtime-picker input").find((item: any) => item.value === `machine:${id}`);
const row = (id: string) => radio(id).closest("label");
const button = (text: string) => p.root.querySelectorAll("button").find((item: any) => item.textContent.trim() === text);
const hint = "Connect and approve a computer in Settings → Runtime to use its CLIs.";
const status = (id: string) => row(id).querySelector(".runtime-machine-status");
const poll = async () => { vi.advanceTimersByTime(5000); await settle(8); };
const mount = async () => { await p.mount(h(Create, { onClose() {} })); await settle(8); };

beforeAll(async () => {
  p = page({ url: "http://localhost/ui", storage: { agend_lang: "en" } });
  globalThis.fetch = (async (path: string) => {
    if (path === "/ui/runtimes") {
      listReads++;
      if (listAnswer === "hang") return new Promise(() => {});
      return listAnswer === "fail" ? response({ error: "unavailable" }, 503) : response({ enabled: true, machines });
    }
    if (path === "/ui/instances/agent-1/runtime") return response(runtimeSource);
    if (path === "/ui/windows-cli/probe") return response({ home: "C:\\Test", clis: [cli()] });
    if (path === "/ui/backends") return response({ backends: [{ name: "claude-code", installed: true }], defaultBackend: "claude-code" });
    return response({});
  }) as any;
  i18n = await import("/assets/app-i18n.js"); i18n.setLang("en", { store: false });
  catalog = await import("/ui/js/runtime-catalog.js"); app = await import("/assets/app-store.js");
  windowsCatalog = await import("/ui/js/windows-cli-catalog.js");
  Create = (await import("/ui/js/panel-fleet.js")).CreateInstanceDialog;
  picker = await import("/ui/js/agent-runtime.js");
  Change = (await import("/ui/js/agent-runtime-settings.js")).AgentRuntimeChangeDialog;
});
beforeEach(() => {
  listReads = 0; listAnswer = "ok"; i18n.setLang("en", { store: false }); app.appStore.set({ windowsCli: true });
  machines = [machine(online, "Desktop", "online"), machine(offline, "Laptop", "offline"), machine(pending, "Studio", "pending"),
    machine(noInventory, "Fresh", "online", null), machine(noCli, "Bare", "online", { home: "C:\\Users", clis: [{ ...cli(), path: "" }] }), machine(revoked, "Gone", "revoked")];
  catalog.forgetRuntimeCatalog(); windowsCatalog.forgetWindowsCliCatalog();
});
afterEach(async () => { vi.useRealTimers(); await p.unmount(); catalog.forgetRuntimeCatalog(); });
afterAll(() => { p.restore(); globalThis.fetch = originalFetch; });

describe("machineBlockReason", () => {
  it("is empty only for an online computer with a usable CLI", () => {
    expect(machines.map(item => picker.machineBlockReason(item))).toEqual(["", "machineOffline", "machinePending", "machineNoInventory", "machineNoCli", "machineOffline"]);
    expect(picker.machineBlockReason(machine(online, "Signed out", "online", { home: "C:\\Users", clis: [{ ...cli(), runnable: false }] }))).toBe("machineNotReady");
    // detect-only and runnable CLIs together: the runnable one is enough, as it is for "Next"
    expect(picker.machineBlockReason(machine(online, "Mixed", "online", { home: "C:\\Users", clis: [{ ...cli(), runnable: false }, { ...cli(), id: "claude-code" }] }))).toBe("");
  });
});

describe("new agent: connected computers", () => {
  it("lets an online computer be chosen", async () => {
    await mount();
    expect(radio(online).disabled).toBe(false);
    expect(row(online).classList.contains("blocked")).toBe(false);
    expect(row(online).querySelector(".runtime-machine-reason")).toBeNull();
    radio(online).checked = true; fire(radio(online), "change"); await settle(5);
    expect(row(online).classList.contains("selected")).toBe(true);
    expect(button("Next").disabled).toBe(false);
  });

  it("blocks the others and tells the user why and what to do, never greying a row silently", async () => {
    await mount();
    const expected: Array<[string, string]> = [
      [offline, "Offline: run connect-agend.bat on that computer."],
      [pending, "Awaiting approval: choose Approve computer in Settings → Runtime."],
      [noInventory, "CLIs not detected yet: choose Refresh CLI inventory for it in Settings → Runtime."],
      [noCli, "No task-capable CLI reported: install one, then choose Refresh CLI inventory in Settings → Runtime."],
    ];
    for (const [id, reason] of expected) {
      expect(radio(id).disabled).toBe(true);
      expect(row(id).classList.contains("blocked")).toBe(true);
      const note = row(id).querySelector(".runtime-machine-reason");
      expect(note.textContent).toBe(reason);
      expect(radio(id).getAttribute("aria-describedby")).toBe(note.id);
    }
    expect(radio(revoked)).toBeUndefined();
  });

  it("says the same in zh-TW", async () => {
    i18n.setLang("zh-TW", { store: false });
    await mount();
    expect(row(offline).querySelector(".runtime-machine-reason").textContent).toBe("離線：請在那台電腦執行 connect-agend.bat。");
    expect(row(pending).querySelector(".runtime-machine-reason").textContent).toBe("等待核准：請到設定 → Runtime 按「核准電腦」。");
    expect(row(noInventory).querySelector(".runtime-machine-reason").textContent).toBe("尚未偵測 CLI：到設定 → Runtime 按該電腦的「更新 CLI 清單」。");
    expect(row(noCli).querySelector(".runtime-machine-reason").textContent).toBe("沒有可派工的 CLI：請先安裝，再到設定 → Runtime 按「更新 CLI 清單」。");
    expect(row(offline).textContent).toContain("離線");
    expect(row(online).querySelector(".runtime-machine-reason")).toBeNull();
  });

  it("requests the list when the dialog opens, refreshes on demand, and follows a computer coming online", async () => {
    machines = [machine(offline, "Laptop", "offline")];
    await mount();
    const opened = listReads;
    expect(opened).toBeGreaterThan(0);
    expect(radio(offline).disabled).toBe(true);
    machines = [machine(offline, "Laptop", "online"), machine(online, "Desktop", "online")];
    button("Refresh computers").click(); await settle(8);
    expect(listReads).toBeGreaterThan(opened);
    expect(radio(offline).disabled).toBe(false);
    expect(radio(online)).toBeDefined();
    expect(row(offline).querySelector(".runtime-machine-reason")).toBeNull();
  });

  it("points to Settings → Runtime when no computer is connected, and still offers refresh", async () => {
    machines = [];
    await mount();
    expect(p.root.textContent).toContain(hint);
    expect(button("Refresh computers")).toBeDefined();
  });

  it("a list holding only revoked computers counts as empty", async () => {
    machines = [machine(revoked, "Gone", "revoked")];
    await mount();
    expect(radio(revoked)).toBeUndefined();
    expect(p.root.textContent).toContain(hint);
  });

  it("never claims the list is empty while loading or when loading failed", async () => {
    listAnswer = "hang";
    await mount();
    expect(p.root.textContent).not.toContain(hint);
    await p.unmount(); catalog.forgetRuntimeCatalog();
    listAnswer = "fail";
    await mount();
    expect(p.root.textContent).toContain("Could not update connected computers");
    expect(p.root.textContent).not.toContain(hint);
    expect(button("Refresh computers")).toBeDefined();
  });

  it("only a click disables the refresh button; the background poll does not", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await mount();
    await poll();
    expect(button("Refresh computers").disabled).toBe(false);
    listAnswer = "hang";
    button("Refresh computers").click(); await settle(4);
    expect(button("Refresh computers").disabled).toBe(true);
  });

  it("colours the status by meaning and keeps it as text", async () => {
    await mount();
    expect(status(online).classList.contains("is-online")).toBe(true);
    expect(status(offline).classList.contains("is-offline")).toBe(true);
    expect(status(pending).classList.contains("is-pending")).toBe(true);
    expect(status(online).classList.contains("is-offline")).toBe(false);
    expect([online, offline, pending].map(id => status(id).textContent)).toEqual(["Online", "Offline", "Awaiting approval"]);
    i18n.setLang("zh-TW", { store: false }); await p.unmount(); await mount();
    expect([online, offline, pending].map(id => status(id).textContent)).toEqual(["在線", "離線", "等待核准"]);
  });

  it("follows the 5 s poll: a computer that comes online becomes selectable without pressing anything", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    machines = [machine(offline, "Laptop", "offline")];
    await mount();
    expect(radio(offline).disabled).toBe(true);
    machines = [machine(offline, "Laptop", "online")];
    await poll();
    expect(radio(offline).disabled).toBe(false);
    expect(status(offline).textContent).toBe("Online");
  });

  it("a chosen computer that goes offline stays checked but disabled, says why, and blocks Next", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await mount();
    radio(online).checked = true; fire(radio(online), "change"); await settle(5);
    expect(button("Next").disabled).toBe(false);
    machines = [machine(online, "Desktop", "offline")];
    await poll();
    expect(radio(online).checked).toBe(true);
    expect(radio(online).disabled).toBe(true);
    expect(row(online).querySelector(".runtime-machine-reason").textContent).toContain("connect-agend.bat");
    expect(button("Next").disabled).toBe(true);
  });

  it("an online computer whose CLIs are all detect-only is blocked with its own reason", async () => {
    machines = [machine(online, "Desktop", "online", { home: "C:\\Users", clis: [{ ...cli(), runnable: false }] })];
    await mount();
    expect(radio(online).disabled).toBe(true);
    expect(row(online).querySelector(".runtime-machine-reason").textContent).toContain("No CLI is signed in and ready");
  });
});

describe("change an agent's runtime: connected computers", () => {
  const changeDialog = async () => { await p.mount(h(Change, { name: "agent-1", inst: { working_directory: "C:\\x", backend: "codex", machine_id: offline }, onClose() {}, onChanged() {} })); await settle(10); };
  beforeEach(() => { runtimeSource = { revision: "a".repeat(64), runtime: "windows", machineId: offline, directory: "C:\\x", backend: "codex", model: "", adapter: "exec", sandbox: "read-only", general: false }; });
  const next = () => button("Next");

  it("when the current computer is offline it stays the target, disabled with the reason, and there is no way to continue", async () => {
    await changeDialog();
    expect(radio(offline).checked).toBe(true);
    expect(radio(offline).disabled).toBe(true);
    expect(row(offline).querySelector(".runtime-machine-reason").textContent).toContain("connect-agend.bat");
    expect(next().disabled).toBe(true);
  });

  it("an online computer can be picked and continues", async () => {
    await changeDialog();
    radio(online).checked = true; fire(radio(online), "change"); await settle(8);
    expect(radio(online).checked).toBe(true);
    expect(next().disabled).toBe(false);
  });

  it("shows the same reasons and status colours as the create dialog", async () => {
    await changeDialog();
    expect(row(pending).querySelector(".runtime-machine-reason").textContent).toContain("Approve computer");
    expect(status(online).classList.contains("is-online")).toBe(true);
    expect(status(offline).classList.contains("is-offline")).toBe(true);
  });
});
