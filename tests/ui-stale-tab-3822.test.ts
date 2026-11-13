/**
 * #3822 (SKEW): a tab left open across an AgEnD update keeps the modules it already loaded; a module it loads later is the
 * new version, and when that one imports a name the tab's older copy lacks, the browser refuses to link it. The alpha.3
 * rehearsal: an alpha.2 tab opened an agent's Basic info and the Settings module would not link
 * ("… './credential-profile-select.js' does not provide an export named 'accountCli'"): a skeleton for ever.
 * - What a real ESM linker throws for that (Node, in a child process, on two scratch modules) is what the page tells apart.
 * - The agent page (useAgentSettings + AgentSettingsPanels) whose Settings module will not link: the reload prompt in
 *   place, never the skeleton; Reload reloads the tab. A failure that is not that (the network): the Retry, a new attempt.
 * - The app's Outlet: a panel that will not link asks for a reload instead of a Retry that would load the same old copy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const LINK = "The requested module './credential-profile-select.js' does not provide an export named 'accountCli'";
const pages: AppPage[] = [], dirs: string[] = [];
// The Settings module the agent page loads lazily: every attempt fails with `failure` (a throwing factory caches nothing,
// so each attempt runs it again). One mock for the file; no module reset (one Preact for the harness and the app).
let failure: Error = new SyntaxError(LINK), loads = 0;
vi.doMock("/ui/js/panel-settings.js", () => { loads++; throw failure; });
afterEach(async () => {
  for (const p of pages.splice(0)) { await p.unmount(); p.restore(); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete (globalThis as any).fetch;
});
function open(url = "http://127.0.0.1:19281/ui/fleet/agent/coder?cat=basic") {
  const p = page({ url, storage: { agend_tour_done: "1" } }); pages.push(p);
  (globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => null });
  return p;
}

describe("#3822 what a tab older than the server meets", () => {
  it("a real ESM linker: a new module importing a name its (older) dependency lacks is a SyntaxError; the page calls that stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-skew-3822-")); dirs.push(dir);
    writeFileSync(join(dir, "credential-profile-select.js"), "export const profileOptions = 1;\n");          // the tab's older copy
    writeFileSync(join(dir, "agent-runtime-settings.js"), "import { accountCli } from './credential-profile-select.js';\nexport const x = accountCli;\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    const out = execFileSync(process.execPath, ["--input-type=module", "-e",
      `import(${JSON.stringify(pathToFileURL(join(dir, "agent-runtime-settings.js")).href)}).then(() => console.log("linked"), (e) => console.log(e.constructor.name + "|" + e.message))`], { encoding: "utf8" }).trim();
    const [name, message] = out.split("|");
    expect(name).toBe("SyntaxError");
    expect(message).toMatch(/does not provide an export named 'accountCli'/);
    open();
    const S = await import("/assets/stale-tab.js");
    expect(S.isStaleModuleError(new SyntaxError(message!))).toBe(true);
    expect(S.isStaleModuleError(new Error("a loader's wrapper", { cause: new SyntaxError(message!) }))).toBe(true);   // as vitest's mock loader wraps it below
    expect(S.isStaleModuleError(new Error("x", { cause: new TypeError("offline") }))).toBe(false);
    expect(S.isStaleModuleError(new TypeError("Failed to fetch dynamically imported module"))).toBe(false);   // the network: Retry fits
    expect(S.isStaleModuleError(new Error("x"))).toBe(false);
  });
});

describe("#3822 the agent page's settings, in a tab older than the server", () => {
  async function agentPage(fail: Error, lang = "en") {
    const p = open();
    failure = fail;
    const i18n = await import("/assets/app-i18n.js"); i18n.setLang(lang, { store: false });
    const G = await import("/ui/js/agent-details-settings.js");
    const lease = { current: () => true, hold: () => {}, fetch: (u: string) => (globalThis as any).fetch(u) };
    function Page() {
      const sess = G.useAgentSettings({ name: "coder", lease, enabled: true, navKey: "k" });
      return h("div", { id: "basic" }, h(G.AgentSettingsPanels, { name: "coder", kind: "fleet", cat: "basic", sess, onDirty: () => {} }));
    }
    await p.mount(h(Page, null)); await settle(10);
    return { p, loads: () => loads };
  }
  it.each(["en", "zh-TW"])("%s: a Settings module that will not link shows the reload prompt in place, never a skeleton; Reload reloads", async lang => {
    const { p } = await agentPage(new SyntaxError(LINK), lang);
    const prompt = p.root.querySelector("[data-stale-tab]") as any;
    expect(prompt).not.toBeNull();
    expect(p.root.querySelector(".skeleton")).toBeNull();
    expect(prompt.textContent).toContain(lang === "en" ? "This tab is older than AgEnD now." : "這個分頁比 AgEnD 舊。");
    expect(prompt.textContent).not.toMatch(/staleTab\./);
    const reload = vi.fn(); Object.defineProperty(globalThis.location, "reload", { value: reload, configurable: true });
    fire(prompt.querySelector("button"), "click");
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("a failure that is not a stale tab (the network): the Retry, which really loads again", async () => {
    const { p, loads } = await agentPage(new TypeError("Failed to fetch dynamically imported module"));
    expect(p.root.querySelector("[data-stale-tab]")).toBeNull();
    expect(p.root.querySelector(".skeleton")).toBeNull();
    const retry = p.root.querySelector(".error-state button") as any;
    expect(retry).not.toBeNull();
    const before = loads();
    fire(retry, "click"); await settle(10);
    expect(loads()).toBe(before + 1);                                                    // the failed attempt was not kept
  });
});

describe("#3822 the app's Outlet", () => {
  async function outlet(failure: Error) {
    const p = open("http://127.0.0.1:19281/ui/x");
    const S = await import("/assets/app-shell.js");
    let calls = 0;
    const panels = new Map([["x", { load: () => { calls++; return Promise.reject(failure); } }]]);
    await p.mount(h(S.Outlet, { route: { panel: "x" }, seq: 0, panels })); await settle(8);
    return { p, calls: () => calls };
  }
  it("a panel that will not link asks for a reload (a Retry would load the same old copy)", async () => {
    const { p } = await outlet(new SyntaxError(LINK));
    expect(p.root.querySelector("[data-stale-tab]")).not.toBeNull();
    expect(p.root.querySelector(".skeleton")).toBeNull();
  });
  it("any other failed load keeps the Retry", async () => {
    const { p, calls } = await outlet(new TypeError("Failed to fetch dynamically imported module"));
    expect(p.root.querySelector("[data-stale-tab]")).toBeNull();
    const retry = p.root.querySelector(".error-state button") as any;
    expect(retry).not.toBeNull();
    fire(retry, "click"); await settle(8);
    expect(calls()).toBe(2);
  });
});
