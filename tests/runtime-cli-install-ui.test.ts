import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

// #3190 Part 3b: Settings → Runtime, a paired computer's "Install a CLI". The page sends a CLI id and shows what that computer's owner allowed; it cannot change the switch.
const idA = "12345678-1234-4321-abcd-123456789012", idB = "22345678-1234-4321-abcd-123456789012";
const originalFetch = globalThis.fetch;
const claude = { id: "claude-code", path: "C:\\tools\\claude.exe", runnable: true, authenticated: true, version: "2.1.319", readOnlySupport: true, supports: { execution: true, resume: true, mcp: true }, models: [] };
const caps = (extra: string[]) => ({ version: "2.3.5-alpha", buildId: "a".repeat(64), protocolVersions: [1], capabilities: ["exec", "mcp", "panes", ...extra] });
const machine = (id: string, name: string, over: any = {}) => ({ id, name, status: "online", platform: "win32", lastSeenAt: Date.now(), inventoryUpdatedAt: Date.now(), runtimeInfo: caps(["credential-profiles", "remote-signin", "cli-install"]),
  inventory: { home: `C:\\${name}`, clis: [claude] }, ...over });
const keys: Array<string | undefined> = [];
let machines: any[], setup: any, posts: Array<{ path: string; body: any }>, installAnswer: { status: number; body: any };
// Ridge #3321 S06: a remote-setup read the test holds or fails (null: answered at once with `setup`).
let setupAnswer: null | (() => Promise<any>) = null;
const response = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body });
const catalogRows = [{ id: "claude-code", version: "2.1.319", kind: "npm", pin: "audited" }, { id: "codex", version: "0.167.0", kind: "npm", pin: "audited" }, { id: "antigravity", version: "1.5.3", kind: "download", pin: "audited" }, { id: "opencode", version: "1.19.5", kind: "npm", pin: "audited" }];
let p: AppPage, Panel: any, app: any, windowsCatalog: any, catalog: any, i18n: any;
const card = (id = idA) => p.root.querySelector(`[data-machine-id="${id}"]`);
const rowOf = (cli: string) => card().querySelector(`.runtime-cli-install-list [data-cli="${cli}"]`);
const installButton = (cli: string) => rowOf(cli).querySelector("button");

beforeAll(async () => {
  p = page({ url: "http://localhost/settings/runtimes", storage: { agend_lang: "en" } });
  globalThis.fetch = (async (path: string, options: any = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (options.method === "POST") { posts.push({ path, body }); keys.push(options.headers?.["Idempotency-Key"]); }
    if (path === "/ui/runtimes") return response({ enabled: true, machines });
    if (path.endsWith("/remote-setup")) return setupAnswer ? setupAnswer() : response(setup);
    if (path.endsWith("/cli-install")) return response(installAnswer.body, installAnswer.status);
    if (path === "/api/settings/runtimes") return response({ switches: { windows_cli: { on: false }, remote_runtime: { on: true } }, max_agents_per_machine: { value: 4, min: 1, max: 16, default: 4 }, local_origin: "http://127.0.0.1:19280" });
    return response({});
  }) as any;
  i18n = await import("/assets/app-i18n.js"); i18n.setLang("en", { store: false });
  catalog = await import("/ui/js/runtime-catalog.js"); app = await import("/assets/app-store.js"); windowsCatalog = await import("/ui/js/windows-cli-catalog.js");
  Panel = (await import("/ui/js/panel-runtimes.js")).RuntimesPanel;
});
beforeEach(() => {
  posts = []; keys.length = 0; (globalThis as any).confirm = () => true; setupAnswer = null;
  machines = [machine(idA, "Desktop"), machine(idB, "Old Laptop", { runtimeInfo: caps(["credential-profiles"]) })];
  setup = { capable: true, online: true, switches: { accounts: { on: false }, install: { on: true } }, job: null, catalog: catalogRows };
  installAnswer = { status: 202, body: { job: { cli: "codex", state: "installing", startedAt: 1 } } };
  app.appStore.set({ windowsCli: false }); windowsCatalog.forgetWindowsCliCatalog(); catalog.forgetRuntimeCatalog();
});
afterEach(async () => { await p.unmount(); catalog.forgetRuntimeCatalog(); vi.restoreAllMocks(); });
afterAll(() => { p.restore(); globalThis.fetch = originalFetch; });

describe("F1: what the CLI printed is compared by its version number", () => {
  const withVersion = async (cliId: string, version: string | undefined, navKey: string) => {
    machines = [machine(idA, "Desktop", { inventory: { home: "C:\\D", clis: [{ ...claude, id: cliId, version }] } })];
    await p.mount(h(Panel, { navKey })); await settle(14);
  };
  it.each([["codex", "codex-cli 0.167.0", "0.167.0"], ["claude-code", "2.1.319 (Claude Code)", "2.1.319"]])("%s printing %j is installed at %s: it says so and has no install button", async (cli, printed, number) => {
    await withVersion(cli, printed, `f1-${cli}`);
    expect(rowOf(cli).textContent).toContain(`Installed ${number}`); expect(rowOf(cli).textContent).toContain("up to date"); expect(rowOf(cli).textContent).not.toContain("not the version");
    expect(installButton(cli)).toBeNull();
  });
  it("an older version is behind the audited one: AgEnD says which it has audited and offers Update to it (AGEND-136)", async () => {
    await withVersion("codex", "codex-cli 0.161.0", "f1-other");
    expect(rowOf("codex").textContent).toContain("Installed 0.161.0. AgEnD has audited 0.167.0: Update installs exactly that");
    expect(installButton("codex").textContent).toBe("Update to 0.167.0");
  });
  it.each(["codex-cli 0.168.0", "10.165.0", "codex-cli 20.165.0"])("%j is newer than the audited version: 'not verified by AgEnD yet', and no button (AGEND-136)", async printed => {
    await withVersion("codex", printed, `f1-newer-${printed}`);
    expect(rowOf("codex").textContent).toContain("not verified by AgEnD yet");
    expect(installButton("codex")).toBeNull();
  });
  it.each(["codex-cli 0.167.0.1", "codex-cli 0.166", "unknown", ""])("%j is not a version at all: shown as another version, and offered the pinned one", async printed => {
    await withVersion("codex", printed, `f1-bad-${printed}`);
    expect(rowOf("codex").textContent).toContain("not the version AgEnD installs");
    expect(installButton("codex")).not.toBeNull();
  });
  it("a prerelease of an older version is behind; the number decides", async () => {
    await withVersion("codex", "codex-cli 0.165.0-alpha.1", "f1-pre");
    expect(rowOf("codex").textContent).toContain("Update installs exactly that");
    expect(installButton("codex").textContent).toBe("Update to 0.167.0");
  });
  it("a missing version is shown as `?`, not as installed", async () => {
    await withVersion("codex", undefined, "f1-none");
    expect(rowOf("codex").textContent).toContain("Installed ? (not the version AgEnD installs)");
  });
  it("versionNumber takes the first x.y.z, not one that is glued to other digits or dots", async () => {
    const { versionNumber } = await import("/ui/js/runtime-cli-install.js");
    expect(versionNumber("codex-cli 0.167.0")).toBe("0.167.0"); expect(versionNumber("2.1.319 (Claude Code)")).toBe("2.1.319");
    expect(versionNumber("v1.2.3-rc.1 extra 4.5.6")).toBe("1.2.3-rc.1");
    for (const bad of ["10.165.0.1", "1.2", "", "abc", 7, undefined, null]) expect(versionNumber(bad as string), String(bad)).toBeNull();
  });
});

describe("AGEND-152 / AGEND-153: Update is offered where the registry's runtime.update says so — pinned to the audited release, or the one named exception", () => {
  // The panel is mounted for real, as the reviewer did: the computer has an OLDER copy of the CLI installed, and the catalog has the audited pin.
  const olderCopy = async (cliId: string, version: string, navKey: string) => {
    machines = [machine(idA, "Desktop", { inventory: { home: "C:\\D", clis: [{ ...claude, id: cliId, version }] } })];
    await p.mount(h(Panel, { navKey })); await settle(14);
  };
  it("AGEND-153 OpenCode 1.18.34 installed (audited 1.19.5): 'Update to 1.19.5' — the pinned install over the older copy, sending only the CLI id", async () => {
    await olderCopy("opencode", "1.18.34", "r4-opencode");
    expect(rowOf("opencode").textContent).toContain("Installed 1.18.34");
    expect(rowOf("opencode").textContent).toContain("1.19.5");
    expect(installButton("opencode").textContent).toBe("Update to 1.19.5");
    fire(installButton("opencode"), "click"); await settle(14);
    expect(posts).toEqual([{ path: `/ui/runtimes/machines/${idA}/cli-install`, body: { cli: "opencode" } }]);
  });
  it("AGEND-153 OpenCode already at the audited release: up to date, no button", async () => {
    await olderCopy("opencode", "1.19.5", "r4-opencode-current");
    expect(rowOf("opencode").textContent).toContain("up to date"); expect(installButton("opencode")).toBeNull();
  });
  it("AGEND-153 OpenCode newer than the audited release: not verified by AgEnD yet, no button", async () => {
    await olderCopy("opencode", "1.19.6", "r4-opencode-newer");
    expect(rowOf("opencode").textContent).toContain("not verified by AgEnD yet"); expect(installButton("opencode")).toBeNull();
  });
  it("an installed CLI whose version cannot be read is offered the pinned install (nothing to compare), not an Update", async () => {
    await olderCopy("opencode", "unknown", "r4-opencode-unknown");
    expect(installButton("opencode").textContent).toBe("Install pinned 1.19.5");
  });
  it.each([["1.3.5", "below"], ["1.5.3", "at"], ["1.5.9", "above"]])("AGEND-153 Antigravity %s (%s the audited release): the named exception — 'Update to latest (not audited by AgEnD)', with the warning in its line", async (version, _where) => {
    await olderCopy("antigravity", version, `r4-agy-${version}`);
    expect(installButton("antigravity").textContent).toBe("Update to latest (not audited by AgEnD)");
    expect(rowOf("antigravity").textContent).toContain(`Installed ${version}`);
    expect(rowOf("antigravity").textContent).toContain("NOT audited");
    expect(rowOf("antigravity").textContent).toContain("1.5.3");
  });
  it("AGEND-153 Antigravity: the click asks in words that say 'latest' and 'not audited', then sends only the CLI id", async () => {
    const asked: string[] = [];
    (globalThis as any).confirm = (message: string) => { asked.push(message); return true; };
    await olderCopy("antigravity", "1.5.3", "r4-agy-click");
    fire(installButton("antigravity"), "click"); await settle(14);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("LATEST"); expect(asked[0]).toContain("NOT audited"); expect(asked[0]).toContain("the vendor's update program is not run");
    // AGEND-154 (Prism P2-1 on #3552): the id and the one explicit sentence that this is the latest exception (the server refuses the request without it) — no version, no address, no command.
    expect(posts).toEqual([{ path: `/ui/runtimes/machines/${idA}/cli-install`, body: { cli: "antigravity", acceptLatestUnaudited: true } }]);
    expect(JSON.stringify(posts)).not.toMatch(/1\.5|http|\.exe/);
  });
  it("AGEND-154: Antigravity NOT installed yet is the pinned install — the body is the CLI's id alone, no acknowledgement of the latest exception", async () => {
    await p.mount(h(Panel, { navKey: "r4-agy-install" })); await settle(14);
    expect(installButton("antigravity").textContent).toBe("Install 1.5.3");
    fire(installButton("antigravity"), "click"); await settle(14);
    expect(posts).toEqual([{ path: `/ui/runtimes/machines/${idA}/cli-install`, body: { cli: "antigravity" } }]);
  });
  it("AGEND-153 Antigravity waits for the owner's switch like any update", async () => {
    setup = { ...setup, switches: { accounts: { on: false }, install: { on: false } } };
    await olderCopy("antigravity", "1.5.3", "r4-agy-off");
    expect(installButton("antigravity").disabled).toBe(true);
  });
  it("control: Codex 0.161.0 installed (audited 0.167.0) still has the pinned Update", async () => {
    await olderCopy("codex", "codex-cli 0.161.0", "r4-codex");
    expect(installButton("codex").textContent).toBe("Update to 0.167.0");
  });
  it("an install-only CLI that is not installed still has Install — Antigravity is installed from the PINNED audited download, never from 'latest'", async () => {
    await p.mount(h(Panel, { navKey: "r4-install" })); await settle(14);
    expect(installButton("antigravity").textContent).toBe("Install 1.5.3");
    expect(installButton("opencode").textContent).toBe("Install 1.19.5");
  });
  it("the named exception is in zh-TW too: 更新到最新版（未經盤點）", async () => {
    i18n.setLang("zh-TW", { store: false });
    try {
      await olderCopy("antigravity", "1.3.5", "r4-agy-zh");
      expect(installButton("antigravity").textContent).toBe("更新到最新版（未經盤點）");
      expect(rowOf("antigravity").textContent).toContain("尚未稽核");
    } finally { i18n.setLang("en", { store: false }); }
  });
});


describe("Settings → Runtime: install a CLI on a paired computer", () => {
  it("lists Claude Code and Codex with their state; one at the audited version has no button, one that is not installed has Install", async () => {
    await p.mount(h(Panel, { navKey: "install-list" })); await settle(14);
    expect(rowOf("claude-code").textContent).toContain("Installed 2.1.319 — up to date"); expect(installButton("claude-code")).toBeNull();
    expect(rowOf("codex").textContent).toContain("Not installed"); expect(installButton("codex").textContent).toBe("Install 0.167.0");
    expect(installButton("codex").disabled).toBe(false);
    expect(card().querySelector(".runtime-cli-install-off")).toBeNull();
  });
  it("a CLI that is already the audited version has no install button", async () => {
    machines = [machine(idA, "Desktop", { inventory: { home: "C:\\D", clis: [{ ...claude, version: "2.1.319" }] } })];
    await p.mount(h(Panel, { navKey: "install-current" })); await settle(14);
    expect(rowOf("claude-code").textContent).toContain("Installed 2.1.319"); expect(installButton("claude-code")).toBeNull();
  });
  it("while the computer's owner has not turned it on: the buttons are off and the command to run on that computer is shown", async () => {
    setup = { ...setup, switches: { accounts: { on: false }, install: { on: false } } };
    await p.mount(h(Panel, { navKey: "install-off" })); await settle(14);
    expect(installButton("codex").disabled).toBe(true);
    expect(card().querySelector(".runtime-cli-install-off").textContent).toContain("has not turned this on");
    expect(card().querySelector(".runtime-cli-install pre code").textContent).toBe("agend-runtime remote-setup install on --for 2h");
  });
  it("sends only the CLI id after the person confirms, and follows the install to its end", async () => {
    await p.mount(h(Panel, { navKey: "install-run" })); await settle(14);
    fire(installButton("codex"), "click"); await settle(14);
    expect(posts).toEqual([{ path: `/ui/runtimes/machines/${idA}/cli-install`, body: { cli: "codex" } }]);
    setup = { ...setup, job: { cli: "codex", state: "installing", startedAt: 1 } }; await settle(4);
  });
  it("AGEND-136: Update on a computer behind the audited version sends only the CLI id (the pinned install over the older copy), through the usual confirmation", async () => {
    machines = [machine(idA, "Desktop", { inventory: { home: "C:\\D", clis: [{ ...claude, version: "2.1.316 (Claude Code)" }] } })];
    await p.mount(h(Panel, { navKey: "update-run" })); await settle(14);
    expect(installButton("claude-code").textContent).toBe("Update to 2.1.319");
    fire(installButton("claude-code"), "click"); await settle(14);
    expect(posts).toEqual([{ path: `/ui/runtimes/machines/${idA}/cli-install`, body: { cli: "claude-code" } }]);
    expect(JSON.stringify(posts)).not.toMatch(/2\.1\.3|update/);
  });
  it("AGEND-136: the Update button on a computer waits for the owner's switch like Install", async () => {
    machines = [machine(idA, "Desktop", { inventory: { home: "C:\\D", clis: [{ ...claude, version: "2.1.316" }] } })];
    setup = { ...setup, switches: { accounts: { on: false }, install: { on: false } } };
    await p.mount(h(Panel, { navKey: "update-off" })); await settle(14);
    expect(installButton("claude-code").textContent).toBe("Update to 2.1.319"); expect(installButton("claude-code").disabled).toBe(true);
  });
  it("AGEND-136: in zh-TW the update words exist", async () => {
    i18n.setLang("zh-TW", { store: false });
    machines = [machine(idA, "Desktop", { inventory: { home: "C:\\D", clis: [{ ...claude, version: "2.1.316" }] } })];
    await p.mount(h(Panel, { navKey: "update-zh" })); await settle(14);
    expect(installButton("claude-code").textContent).toBe("更新到 2.1.319"); expect(rowOf("claude-code").textContent).toContain("稽核過");
    i18n.setLang("en", { store: false });
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
  // AGEND-148 (Prism R3 on #3539, P2-1): the install goes through the Settings gate's confirmed write, like any change that acts on a computer.
  it("AGEND-148: the install is a confirmed write (an Idempotency-Key, the CLI's id and nothing else); a gate that held it and was turned down is told in words, never as an install", async () => {
    installAnswer = { status: 403, body: { error: "install_confirmation_required" } };
    await p.mount(h(Panel, { navKey: "install-gate" })); await settle(14);
    fire(installButton("codex"), "click"); await settle(14);
    expect(posts).toEqual([{ path: `/ui/runtimes/machines/${idA}/cli-install`, body: { cli: "codex" } }]);
    expect(keys).toHaveLength(1); expect(typeof keys[0]).toBe("string"); expect(keys[0]!.length).toBeGreaterThan(8);
    expect(card().querySelector(".runtime-error").textContent).toContain("Could not start the install: The install must be confirmed first.");
  });
  it("an older Runtime is told to update, and an offline computer that it is offline", async () => {
    setup = { capable: false, online: true, switches: null, job: null, catalog: catalogRows };
    machines = [machine(idA, "Desktop"), machine(idB, "Sleeping", { status: "offline" })];
    await p.mount(h(Panel, { navKey: "install-old" })); await settle(14);
    expect(card().querySelector(".runtime-cli-install").textContent).toContain("Update the Runtime on that computer to install CLIs from here.");
    expect(card(idB).querySelector(".runtime-cli-install").textContent).toContain("That computer is offline.");
    expect(card().querySelector(".runtime-cli-install-list")).toBeNull();
  });
  it("is not offered for a computer whose Runtime does not report cli-install", async () => {
    await p.mount(h(Panel, { navKey: "install-none" })); await settle(14);
    expect(card(idB).querySelector(".runtime-cli-install")).toBeNull();
  });
  it("shows the official commands for the CLIs it does not install, to be run by the computer's owner", async () => {
    await p.mount(h(Panel, { navKey: "install-others" })); await settle(14);
    const others = card().querySelector(".runtime-cli-install-others").textContent;
    expect(others).toContain("irm https://x.ai/cli/install.ps1 | iex"); expect(others).toContain("irm https://dev.meta.ai/install.ps1 | iex"); expect(others).toContain("needs an administrator");
    expect(others).not.toContain("Antigravity");       // AGEND-135: it is installed from the list above (a pinned download), not by the vendor's script
  });
  it("AGEND-133: OpenCode is listed and installed like the others (its pin comes from the computer's catalog)", async () => {
    await p.mount(h(Panel, { navKey: "install-opencode" })); await settle(14);
    expect(rowOf("opencode").textContent).toContain("Not installed");
    expect(installButton("opencode").textContent).toBe("Install 1.19.5");
    expect(installButton("opencode").disabled).toBe(false);
    expect(card().querySelector(".runtime-cli-install-others").textContent).not.toContain("OpenCode");
  });
  it("AGEND-133: every CLI it does not install says WHY, not just the command (both languages)", async () => {
    await p.mount(h(Panel, { navKey: "install-why" })); await settle(14);
    const why = (id: string) => card().querySelector(`.runtime-cli-install-why[data-why="${id}"]`)?.textContent ?? "";
    expect(why("grok")).toContain("not signed by its publisher");
    expect(why("muse")).toContain("installs itself");
    expect(why("kiro")).toContain("needs an administrator");
    expect(why("muse")).toContain("installs itself, and updates itself");
    expect(card().querySelector('.runtime-cli-install-why[data-why="muse"]').parentElement.textContent).toContain("irm https://dev.meta.ai/install.ps1 | iex");
    await p.unmount(); i18n.setLang("zh-TW", { store: false });
    await p.mount(h(Panel, { navKey: "install-why-zh" })); await settle(14);
    for (const id of ["grok", "muse", "kiro"]) expect(why(id), id).toMatch(/為什麼不能從這裡安裝/);
    i18n.setLang("en", { store: false });
  });
  // AGEND-135 (#3521): Antigravity is a one-click install from a pinned, verified download — listed with the others, and it says what the download is checked against.
  it("\"Not yet verified by AgEnD\" follows the registry's `pin`, not the install kind or a vendor: an integrity pin has it, an audited pin does not", async () => {
    setup = { ...setup, catalog: [{ id: "claude-code", version: "2.1.316", kind: "download", pin: "audited" }, { id: "codex", version: "0.165.0", kind: "npm", pin: "integrity" }, { id: "opencode", version: "1.19.5", kind: "npm", pin: "audited" }] };
    await p.mount(h(Panel, { navKey: "install-pin" })); await settle(14);
    expect(rowOf("claude-code").textContent).not.toContain("Not yet verified by AgEnD");       // a download that is audited
    expect(rowOf("codex").textContent).toContain("Not yet verified by AgEnD");                    // an npm package pinned for integrity only
    expect(rowOf("codex").textContent).not.toContain("Google");                                   // the words name no vendor
    expect(rowOf("opencode").textContent).not.toContain("Not yet verified by AgEnD");
  });
  it("AGEND-135: Antigravity is listed with its pinned version, asks with the download wording, and sends only its id", async () => {
    const asked: string[] = [];
    (globalThis as any).confirm = (message: string) => { asked.push(message); return true; };
    await p.mount(h(Panel, { navKey: "install-antigravity" })); await settle(14);
    expect(rowOf("antigravity").textContent).toContain("Not installed");
    expect(installButton("antigravity").textContent).toBe("Install 1.5.3");
    // AGEND-148: the pinned 1.5.3 is on the maintainer-confirmed audited ledger (the registry says `pin: "audited"`), so the page no longer calls it unverified; an integrity-only pin still does
    // (the test above).
    expect(rowOf("antigravity").textContent).not.toContain("Not yet verified by AgEnD");
    expect(rowOf("claude-code").textContent).not.toContain("Not yet verified by AgEnD");
    expect(rowOf("opencode").textContent).not.toContain("Not yet verified by AgEnD");
    expect(installButton("antigravity").disabled).toBe(false);
    installAnswer = { status: 202, body: { job: { cli: "antigravity", state: "installing", startedAt: 1 } } };
    fire(installButton("antigravity"), "click"); await settle(14);
    expect(posts).toEqual([{ path: `/ui/runtimes/machines/${idA}/cli-install`, body: { cli: "antigravity" } }]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("downloads that exact version from the vendor's own address");
    expect(asked[0]).toContain("the vendor's install script is not run");
    expect(asked[0]).toContain("checks its size, its checksum and the publisher's Windows signature");
    expect(asked[0]).not.toContain("npm registry");
  });
  it("AGEND-135: a refused download is shown with the Runtime's reason", async () => {
    setup = { ...setup, job: { cli: "antigravity", state: "installing", startedAt: 1 } };
    await p.mount(h(Panel, { navKey: "install-agy-refused" })); await settle(14);
    setup = { ...setup, job: { cli: "antigravity", state: "failed", startedAt: 1, error: "The downloaded file is not the one this AgEnD version expects (its checksum differs), so nothing was installed" } };
    await vi.waitFor(async () => { await settle(30); expect(card().textContent).toContain("The install did not finish: The downloaded file is not the one this AgEnD version expects (its checksum differs)"); }, { timeout: 8000 });
  });
  it("is in zh-TW too", async () => {
    i18n.setLang("zh-TW", { store: false });
    await p.mount(h(Panel, { navKey: "install-zh" })); await settle(14);
    expect(card().querySelector(".runtime-cli-install h4").textContent).toBe("安裝 CLI"); expect(installButton("codex").textContent).toBe("安裝 0.167.0"); expect(rowOf("antigravity").textContent).not.toContain("尚未經 AgEnD 驗證");
    i18n.setLang("en", { store: false });
  });
});

describe("Ridge #3321 S06 / S09: the install card before its read, after a failed read, and its commands", () => {
  it("S06: while the computer's setting is being read — the shared loading state, no buttons and no empty version slots", async () => {
    let release!: () => void;
    setupAnswer = () => new Promise((done) => { release = () => done(response(setup)); });
    await p.mount(h(Panel, { navKey: "s06-held" })); await settle(14);
    const box = card().querySelector(".runtime-cli-install");
    // (the Other CLIs' Copy buttons, in their closed drawer, are not install controls)
    const controls = [...box.querySelectorAll("button")].filter((b: any) => !b.closest(".runtime-cli-install-others"));
    expect([!!box.querySelector(".skeleton, [aria-busy=true]"), controls.length, !!box.querySelector(".runtime-cli-install-list")]).toEqual([true, 0, false]);
    // The loading state says what it waits for (the Skeleton's accessible label).
    expect([...box.querySelectorAll("[aria-label]")].map((n: any) => n.getAttribute("aria-label"))).toContain("Reading this computer's install setting…");
    release(); await settle(14);
    expect([!!card().querySelector(".runtime-cli-install-list"), !!installButton("codex")]).toEqual([true, true]);
  });
  it("S06: a first read that fails says so with Retry (no form); Retry reads it again", async () => {
    let fails = true;
    setupAnswer = async () => (fails ? response({ error: "unavailable" }, 503) : response(setup));
    await p.mount(h(Panel, { navKey: "s06-failed" })); await settle(14);
    const box = card().querySelector(".runtime-cli-install");
    expect([box.textContent.includes("Could not read this computer's setting."), !!box.querySelector(".runtime-cli-install-list")]).toEqual([true, false]);
    const retry = [...box.querySelectorAll("button")].find((b: any) => /retry|try again/i.test(b.textContent)) as any;
    expect(retry, "Retry").toBeDefined();
    fails = false; fire(retry, "click"); await settle(14);
    expect(!!card().querySelector(".runtime-cli-install-list")).toBe(true);
    // #3328 F1b: the failed read's message is gone once a read succeeds.
    const box2 = card().querySelector(".runtime-cli-install");
    expect([box2.querySelectorAll("[role=alert], .runtime-error").length, box2.textContent.includes("Could not read this computer's setting.")]).toEqual([0, false]);
  });
  it("S09: the owner's switch command and the other CLIs' commands are labelled cards with Copy", async () => {
    setup = { ...setup, switches: { accounts: { on: false }, install: { on: false } } };
    const written: string[] = [];
    Object.defineProperty((globalThis as any).navigator, "clipboard", { configurable: true, value: { writeText: async (s: string) => { written.push(s); } } });
    await p.mount(h(Panel, { navKey: "s09" })); await settle(14);
    const cards = [...card().querySelectorAll(".runtime-cli-install .runtime-command-card")] as any[];
    expect(cards.length).toBeGreaterThan(1);
    const first = cards[0];
    expect(first.querySelector(".runtime-command-label").textContent).toBe("Command for that computer");
    fire(first.querySelector("button"), "click"); await settle(6);
    expect([written, first.querySelector("button").textContent]).toEqual([[first.querySelector("code").textContent], "Copied"]);
  });
});
