import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

// Claude accounts ("credential profiles") on a paired Windows computer, in the dashboard: the Runtime card, the new-agent form and
// the change-runtime dialog. AgEnD only shows and sends a NAME; these tests also pin that no path or account detail is ever rendered.
const idA = "12345678-1234-4321-abcd-123456789012", idB = "22345678-1234-4321-abcd-123456789012", idC = "32345678-1234-4321-abcd-123456789012";
const originalFetch = globalThis.fetch;
const claude = { id: "claude-code", path: "C:\\tools\\claude.exe", runnable: true, authenticated: true, version: "2.1.316", readOnlySupport: true, supports: { execution: true, resume: true, mcp: true }, models: [] };
const caps = (extra: string[] = []) => ({ version: "2.3.5-alpha", buildId: "a".repeat(64), protocolVersions: [1], capabilities: ["exec", "mcp", "panes", ...extra] });
const machine = (id: string, name: string, over: any = {}) => ({ id, name, status: "online", platform: "win32", lastSeenAt: Date.now(), inventoryUpdatedAt: Date.now(), runtimeInfo: caps(["credential-profiles"]),
  inventory: { home: `C:\\${name}`, clis: [claude], credentialProfiles: { profiles: [{ name: "work", loggedIn: true }, { name: "home", loggedIn: true }, { name: "old", loggedIn: false }, { name: "fresh", loggedIn: null }], default: "work" } }, ...over });
let machines: any[], posts: Array<{ path: string; body: any }>, runtimeDescribe: any;
const response = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body });
let p: AppPage, Panel: any, Create: any, Dialog: any, catalog: any, app: any, windowsCatalog: any, models: any, accounts: any, i18n: any;
const button = (label: string) => p.root.querySelectorAll("button").find((node: any) => node.textContent.trim() === label);
const choose = async (id: string) => { const input = p.root.querySelectorAll(".agent-runtime-picker input").find((node: any) => node.value === `machine:${id}`); input.checked = true; fire(input, "change"); await settle(5); };
const select = async (selector: string, value: string) => { const node = p.root.querySelector(selector); node.value = value; fire(node, "change"); await settle(3); };

beforeAll(async () => {
  p = page({ url: "http://localhost/settings/runtimes", storage: { agend_lang: "en" } });
  globalThis.fetch = (async (path: string, options: any = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (options.method === "POST") posts.push({ path, body });
    if (path === "/ui/runtimes") return response({ enabled: true, machines });
    if (path === "/ui/instances/agent-1/runtime") return options.method === "POST" ? response({ ok: true }) : response(runtimeDescribe);
    if (path === "/ui/backends") return response({ backends: [{ name: "claude-code", installed: true }], defaultBackend: "claude-code" });
    if (path.startsWith("/ui/models?")) return response({ models: [], source: "cli-cache" });
    if (path === "/api/settings/runtimes") return response({ switches: { windows_cli: { on: false }, remote_runtime: { on: true } }, max_agents_per_machine: { value: 4, min: 1, max: 16, default: 4 }, local_origin: "http://127.0.0.1:19280" });
    if (path === "/ui/instances") return response({ name: "remote-agent" });
    return response({});
  }) as any;
  i18n = await import("/assets/app-i18n.js"); i18n.setLang("en", { store: false });
  catalog = await import("/ui/js/runtime-catalog.js"); models = await import("/ui/js/settings-catalog.js"); app = await import("/assets/app-store.js"); windowsCatalog = await import("/ui/js/windows-cli-catalog.js");
  Panel = (await import("/ui/js/panel-runtimes.js")).RuntimesPanel; Create = (await import("/ui/js/panel-fleet.js")).CreateInstanceDialog;
  Dialog = (await import("/ui/js/agent-runtime-settings.js")).AgentRuntimeChangeDialog; accounts = await import("/ui/js/credential-profile-select.js");
});
beforeEach(() => {
  posts = []; machines = [machine(idA, "Desktop"), machine(idB, "Old Laptop", { runtimeInfo: caps(), inventory: { home: "C:\\Old", clis: [claude] } }), machine(idC, "Empty", { inventory: { home: "C:\\Empty", clis: [claude], credentialProfiles: { profiles: [] } } })];
  runtimeDescribe = { revision: "a".repeat(64), runtime: "windows", machineId: idA, backend: "claude-code", directory: "C:\\Work", model: "", adapter: "exec", sandbox: "read-only", general: false, credentialProfile: "home" };
  app.appStore.set({ windowsCli: false }); windowsCatalog.forgetWindowsCliCatalog(); catalog.forgetRuntimeCatalog(); models.forgetCatalogs();
});
afterEach(async () => { await p.unmount(); catalog.forgetRuntimeCatalog(); vi.restoreAllMocks(); });
afterAll(() => { p.restore(); globalThis.fetch = originalFetch; });

describe("Settings → Runtime: the computer card", () => {
  it("lists each reported Claude account with its sign-in state and the default, and says nothing else about it", async () => {
    await p.mount(h(Panel, { navKey: "profiles-card" })); await settle(12);
    const card = p.root.querySelector(`[data-machine-id="${idA}"]`), rows = card.querySelectorAll(".runtime-profile-list li");
    expect(rows.map((row: any) => row.getAttribute("data-profile"))).toEqual(["work", "home", "old", "fresh"]);
    expect(rows.map((row: any) => row.querySelector(".runtime-cli-auth").textContent.trim())).toEqual(["Signed in", "Signed in", "Not signed in", "Not checked"]);
    expect(rows[0].querySelector(".runtime-profile-default").textContent).toBe("Default"); expect(rows[1].querySelector(".runtime-profile-default")).toBeNull();
    expect(card.querySelector(".runtime-profiles-how").textContent).toContain("agend-runtime login claude-code NAME");
    expect(card.textContent).not.toMatch(/[A-Za-z]:\\credential|@|token/i);
  });
  it("tells a Runtime that predates Claude accounts (or an empty one) what to do instead of listing nothing", async () => {
    await p.mount(h(Panel, { navKey: "profiles-old" })); await settle(12);
    const old = p.root.querySelector(`[data-machine-id="${idB}"]`); expect(old.querySelector(".runtime-profile-list")).toBeNull();
    expect(old.querySelector(".runtime-profiles-old").textContent).toContain("Update the Runtime on that computer");
    const empty = p.root.querySelector(`[data-machine-id="${idC}"]`); expect(empty.querySelector(".runtime-profile-list")).toBeNull(); expect(empty.textContent).toContain("No Claude accounts reported yet.");
  });
  it("ignores a malformed report instead of rendering it", async () => {
    machines = [machine(idA, "Desktop", { inventory: { home: "C:\\D", clis: [claude], credentialProfiles: { profiles: [{ name: "work", loggedIn: true, path: "C:\\secret" }, null, { loggedIn: true }] } } })];
    await p.mount(h(Panel, { navKey: "profiles-malformed" })); await settle(12);
    expect(p.root.querySelectorAll(".runtime-profile-list li")).toHaveLength(1); expect(p.root.textContent).not.toContain("secret");
  });
});

describe("names that are also Object properties", () => {
  const names = ["constructor", "toString", "hasOwnProperty"];
  it("the computer card lists them as ordinary accounts, in the reported order", async () => {
    machines = [machine(idA, "Desktop", { inventory: { home: "C:\\D", clis: [claude], credentialProfiles: { profiles: names.map((name, index) => ({ name, loggedIn: index === 0 ? true : index === 1 ? false : null })), default: "constructor" } } })];
    await p.mount(h(Panel, { navKey: "profiles-awkward" })); await settle(12);
    const rows = p.root.querySelectorAll(".runtime-profile-list li");
    expect(rows.map((row: any) => row.getAttribute("data-profile"))).toEqual(names);
    expect(rows.map((row: any) => row.querySelector(".runtime-cli-auth").textContent.trim())).toEqual(["Signed in", "Not signed in", "Not checked"]);
    expect(rows[0].querySelector(".runtime-profile-default").textContent).toBe("Default"); expect(rows[1].querySelector(".runtime-profile-default")).toBeNull();
  });
  it("the new-agent form offers and sends them by name; an unreported one is not mistaken for a reported one", async () => {
    machines = [machine(idA, "Desktop", { inventory: { home: "C:\\D", clis: [claude], credentialProfiles: { profiles: names.map(name => ({ name, loggedIn: true })) } } })];
    await p.mount(h(Create, { onClose() {} })); await settle(8); await choose(idA);
    expect(p.root.querySelectorAll("#native-create-claude-account option").map((node: any) => node.value)).toEqual(["", ...names]);
    await select("#native-create-claude-account", "hasOwnProperty"); button("Next").click(); await settle(8);
    const name = p.root.querySelectorAll(".agent-runtime-fields input")[1]; name.value = "Awkward"; fire(name, "input"); await settle();
    button("Create").click(); await settle(8);
    expect(posts.find(row => row.path === "/ui/instances")?.body).toMatchObject({ credentialProfile: "hasOwnProperty" });
    expect(accounts.credentialProfileView({ runtimeInfo: caps(["credential-profiles"]), inventory: { credentialProfiles: { profiles: [{ name: "work", loggedIn: true }] } } }).profiles.some((row: any) => row.name === "constructor")).toBe(false);
  });
});

describe("new remote agent: Claude account", () => {
  const open = async (id: string) => { await p.mount(h(Create, { onClose() {} })); await settle(8); await choose(id); };
  it("offers the computer's accounts for Claude Code, disables a signed-out one and sends only the chosen name", async () => {
    await open(idA);
    const field = "#native-create-claude-account", options = (): Array<{ value: string; disabled: boolean; text: string }> => p.root.querySelectorAll(`${field} option`).map((node: any) => ({ value: node.value, disabled: !!node.disabled, text: node.textContent }));
    expect(options().map(o => o.value)).toEqual(["", "work", "home", "old", "fresh"]);
    expect(options().find(o => o.value === "old")).toMatchObject({ disabled: true }); expect(options().find(o => o.value === "old")!.text).toContain("not signed in");
    expect(options().find(o => o.value === "work")!.text).toContain("default");
    await select(field, "home"); button("Next").click(); await settle(8);
    const name = p.root.querySelectorAll(".agent-runtime-fields input")[1]; name.value = "Home helper"; fire(name, "input"); await settle();
    button("Create").click(); await settle(8);
    expect(posts.find(row => row.path === "/ui/instances")?.body).toMatchObject({ runtime: "windows", machineId: idA, backend: "claude-code", credentialProfile: "home" });
  });
  it("omits the field when no account is chosen, and when the CLI is not Claude Code", async () => {
    await open(idA); button("Next").click(); await settle(8);
    const name = p.root.querySelectorAll(".agent-runtime-fields input")[1]; name.value = "Plain"; fire(name, "input"); await settle();
    button("Create").click(); await settle(8);
    expect(posts.find(row => row.path === "/ui/instances")!.body).not.toHaveProperty("credentialProfile");
  });
  it("locks the choice, with the update note, for a Runtime that cannot honour it", async () => {
    await open(idB);
    const select = p.root.querySelector("#native-create-claude-account"); expect(select.disabled).toBe(true);
    expect(p.root.querySelector(".claude-account-old").textContent).toContain("Update the Runtime on that computer");
  });
  it("explains how to create the first account when a computer has none", async () => {
    await open(idC); expect(p.root.querySelector(".claude-account-empty").textContent).toContain("agend-runtime login claude-code NAME");
  });
});

describe("change runtime dialog: Claude account", () => {
  const configure = async () => { await p.mount(h(Dialog, { name: "agent-1", inst: { backend: "claude-code", runtime: "windows", machine_id: idA }, onClose: vi.fn(), onChanged: vi.fn() })); await settle(8); button("Next").click(); await settle(6); };
  it("preselects the agent's current account, says a change starts a new conversation and posts the name", async () => {
    await configure();
    const field = "#runtime-change-claude-account"; expect(p.root.querySelector(field).value).toBe("home");
    expect(p.root.querySelector(".claude-account-change").textContent).toBe("Changing the account starts a new conversation.");
    await select(field, "work");
    const fresh = p.root.querySelector('.agent-runtime-change input[type="checkbox"]'); fresh.checked = true; fire(fresh, "change"); await settle(3);
    button("Save runtime change").click(); await settle(4);
    expect(posts.find(row => row.path === "/ui/instances/agent-1/runtime")!.body).toMatchObject({ runtime: "windows", machineId: idA, backend: "claude-code", credentialProfile: "work", startNewConversation: true });
  });
  it("omits the account when the computer's own sign-in is chosen", async () => {
    await configure(); await select("#runtime-change-claude-account", "");
    const fresh = p.root.querySelector('.agent-runtime-change input[type="checkbox"]'); fresh.checked = true; fire(fresh, "change"); await settle(3);
    button("Save runtime change").click(); await settle(4);
    expect(posts.find(row => row.path === "/ui/instances/agent-1/runtime")!.body).not.toHaveProperty("credentialProfile");
  });
  it("shows a current account the computer no longer reports instead of silently dropping it", async () => {
    runtimeDescribe = { ...runtimeDescribe, credentialProfile: "gone" }; await configure();
    expect(p.root.querySelector("#runtime-change-claude-account").value).toBe("gone"); expect(p.root.querySelector("#runtime-change-claude-account").textContent).toContain("not reported");
  });
});

describe("words", () => {
  it("every Claude-account string exists in English and zh-TW with the same placeholders", async () => {
    const read = (lang: string) => { i18n.setLang(lang, { store: false }); return lang; };
    const keys = ["label", "none", "default", "signedOut", "unchecked", "notReported", "old", "empty", "hint", "changeNote"];
    const machineKeys = ["profilesTitle", "profileDefault", "profilesNone", "profilesHow", "profilesOld", "profilesList", "profileSignedIn", "profileSignedOut", "profileUnchecked", "capability_credentialProfiles"];
    const words: Record<string, Record<string, string>> = {};
    for (const lang of ["en", "zh-TW"]) { read(lang); words[lang] = {}; for (const key of keys) words[lang][`claudeAccount.${key}`] = i18n.t(`claudeAccount.${key}`, "X"); for (const key of machineKeys) words[lang][`machines.${key}`] = i18n.t(`machines.${key}`, "X"); }
    i18n.setLang("en", { store: false });
    for (const key of Object.keys(words.en)) { expect(words.en[key], key).not.toBe(key); expect(words["zh-TW"][key], key).not.toBe(key); expect(words["zh-TW"][key], key).not.toBe(words.en[key]); }
    expect(words["zh-TW"]["claudeAccount.label"]).toBe("Claude 帳號");
    expect(accounts.credentialProfileState(true)).toBe("signedIn"); expect(accounts.credentialProfileState(false)).toBe("signedOut"); expect(accounts.credentialProfileState(null)).toBe("unchecked");
  });
});
