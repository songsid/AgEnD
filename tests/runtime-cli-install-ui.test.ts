import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

// #3190 Part 3b: Settings → Runtime, a paired computer's "Install a CLI". The page sends a CLI id and shows what that computer's owner allowed; it cannot change the switch.
const idA = "12345678-1234-4321-abcd-123456789012", idB = "22345678-1234-4321-abcd-123456789012";
const originalFetch = globalThis.fetch;
const claude = { id: "claude-code", path: "C:\\tools\\claude.exe", runnable: true, authenticated: true, version: "2.1.318", readOnlySupport: true, supports: { execution: true, resume: true, mcp: true }, models: [] };
const caps = (extra: string[]) => ({ version: "2.3.5-alpha", buildId: "a".repeat(64), protocolVersions: [1], capabilities: ["exec", "mcp", "panes", ...extra] });
const machine = (id: string, name: string, over: any = {}) => ({ id, name, status: "online", platform: "win32", lastSeenAt: Date.now(), inventoryUpdatedAt: Date.now(), runtimeInfo: caps(["credential-profiles", "remote-signin", "cli-install"]),
  inventory: { home: `C:\\${name}`, clis: [claude] }, ...over });
let machines: any[], setup: any, posts: Array<{ path: string; body: any }>, installAnswer: { status: number; body: any };
const response = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body });
const catalogRows = [{ id: "claude-code", version: "2.1.316" }, { id: "codex", version: "0.165.0" }];
let p: AppPage, Panel: any, app: any, windowsCatalog: any, catalog: any, i18n: any;
const card = (id = idA) => p.root.querySelector(`[data-machine-id="${id}"]`);
const rowOf = (cli: string) => card().querySelector(`.runtime-install-list [data-cli="${cli}"]`);
const installButton = (cli: string) => rowOf(cli).querySelector("button");

beforeAll(async () => {
  p = page({ url: "http://localhost/settings/runtimes", storage: { agend_lang: "en" } });
  globalThis.fetch = (async (path: string, options: any = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (options.method === "POST") posts.push({ path, body });
    if (path === "/ui/runtimes") return response({ enabled: true, machines });
    if (path.endsWith("/remote-setup")) return response(setup);
    if (path.endsWith("/cli-install")) return response(installAnswer.body, installAnswer.status);
    if (path === "/api/settings/runtimes") return response({ switches: { windows_cli: { on: false }, remote_runtime: { on: true } }, max_agents_per_machine: { value: 4, min: 1, max: 16, default: 4 }, local_origin: "http://127.0.0.1:19280" });
    return response({});
  }) as any;
  i18n = await import("/assets/app-i18n.js"); i18n.setLang("en", { store: false });
  catalog = await import("/ui/js/runtime-catalog.js"); app = await import("/assets/app-store.js"); windowsCatalog = await import("/ui/js/windows-cli-catalog.js");
  Panel = (await import("/ui/js/panel-runtimes.js")).RuntimesPanel;
});
beforeEach(() => {
  posts = []; (globalThis as any).confirm = () => true;
  machines = [machine(idA, "Desktop"), machine(idB, "Old Laptop", { runtimeInfo: caps(["credential-profiles"]) })];
  setup = { capable: true, online: true, switches: { accounts: { on: false }, install: { on: true } }, job: null, catalog: catalogRows };
  installAnswer = { status: 202, body: { job: { cli: "codex", state: "installing", startedAt: 1 } } };
  app.appStore.set({ windowsCli: false }); windowsCatalog.forgetWindowsCliCatalog(); catalog.forgetRuntimeCatalog();
});
afterEach(async () => { await p.unmount(); catalog.forgetRuntimeCatalog(); vi.restoreAllMocks(); });
afterAll(() => { p.restore(); globalThis.fetch = originalFetch; });

describe("Settings → Runtime: install a CLI on a paired computer", () => {
  it("lists Claude Code and Codex with their state; a CLI at another version is offered the audited one", async () => {
    await p.mount(h(Panel, { navKey: "install-list" })); await settle(14);
    expect(rowOf("claude-code").textContent).toContain("Installed 2.1.318 (not the version AgEnD installs)");
    expect(installButton("claude-code").textContent).toBe("Install pinned 2.1.316");
    expect(rowOf("codex").textContent).toContain("Not installed"); expect(installButton("codex").textContent).toBe("Install 0.165.0");
    expect(installButton("codex").disabled).toBe(false);
    expect(card().querySelector(".runtime-install-off")).toBeNull();
  });
  it("a CLI that is already the audited version has no install button", async () => {
    machines = [machine(idA, "Desktop", { inventory: { home: "C:\\D", clis: [{ ...claude, version: "2.1.316" }] } })];
    await p.mount(h(Panel, { navKey: "install-current" })); await settle(14);
    expect(rowOf("claude-code").textContent).toContain("Installed 2.1.316"); expect(installButton("claude-code")).toBeNull();
  });
  it("while the computer's owner has not turned it on: the buttons are off and the command to run on that computer is shown", async () => {
    setup = { ...setup, switches: { accounts: { on: false }, install: { on: false } } };
    await p.mount(h(Panel, { navKey: "install-off" })); await settle(14);
    expect(installButton("codex").disabled).toBe(true);
    expect(card().querySelector(".runtime-install-off").textContent).toContain("has not turned this on");
    expect(card().querySelector(".runtime-install pre code").textContent).toBe("agend-runtime remote-setup install on --for 2h");
  });
  it("sends only the CLI id after the person confirms, and follows the install to its end", async () => {
    await p.mount(h(Panel, { navKey: "install-run" })); await settle(14);
    fire(installButton("codex"), "click"); await settle(14);
    expect(posts).toEqual([{ path: `/ui/runtimes/machines/${idA}/cli-install`, body: { cli: "codex" } }]);
    setup = { ...setup, job: { cli: "codex", state: "installing", startedAt: 1 } }; await settle(4);
  });
  it("shows the end of a finished install, and the sentence the computer gave for a failed one", async () => {
    setup = { ...setup, job: { cli: "codex", state: "installing", startedAt: 1 } };
    await p.mount(h(Panel, { navKey: "install-end" })); await settle(14);
    expect(card().textContent).toContain("Installing…");
    setup = { ...setup, job: { cli: "codex", state: "failed", startedAt: 1, error: "A downloaded package is not the one this AgEnD version expects, so nothing was installed" } };
    await vi.waitFor(async () => { await settle(30); expect(card().textContent).toContain("The install did not finish: A downloaded package is not the one this AgEnD version expects"); }, { timeout: 8000 });
  });
  it("a refusal from the server is shown and nothing else changes", async () => {
    installAnswer = { status: 400, body: { error: "The owner of that computer has not turned this on." } };
    await p.mount(h(Panel, { navKey: "install-refused" })); await settle(14);
    fire(installButton("codex"), "click"); await settle(14);
    expect(card().querySelector(".runtime-error").textContent).toContain("Could not start the install: The owner of that computer has not turned this on.");
  });
  it("an older Runtime is told to update, and an offline computer that it is offline", async () => {
    setup = { capable: false, online: true, switches: null, job: null, catalog: catalogRows };
    machines = [machine(idA, "Desktop"), machine(idB, "Sleeping", { status: "offline" })];
    await p.mount(h(Panel, { navKey: "install-old" })); await settle(14);
    expect(card().querySelector(".runtime-install").textContent).toContain("Update the Runtime on that computer to install CLIs from here.");
    expect(card(idB).querySelector(".runtime-install").textContent).toContain("That computer is offline.");
    expect(card().querySelector(".runtime-install-list")).toBeNull();
  });
  it("is not offered for a computer whose Runtime does not report cli-install", async () => {
    await p.mount(h(Panel, { navKey: "install-none" })); await settle(14);
    expect(card(idB).querySelector(".runtime-install")).toBeNull();
  });
  it("shows the official commands for the CLIs it does not install, to be run by the computer's owner", async () => {
    await p.mount(h(Panel, { navKey: "install-others" })); await settle(14);
    const others = card().querySelector(".runtime-install-others").textContent;
    expect(others).toContain("irm https://x.ai/cli/install.ps1 | iex"); expect(others).toContain("irm https://antigravity.google/cli/install.ps1 | iex"); expect(others).toContain("needs an administrator");
  });
  it("is in zh-TW too", async () => {
    i18n.setLang("zh-TW", { store: false });
    await p.mount(h(Panel, { navKey: "install-zh" })); await settle(14);
    expect(card().querySelector(".runtime-install h4").textContent).toBe("安裝 CLI"); expect(installButton("codex").textContent).toBe("安裝 0.165.0");
    i18n.setLang("en", { store: false });
  });
});
