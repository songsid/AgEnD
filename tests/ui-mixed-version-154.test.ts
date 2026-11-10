/**
 * AGEND-154 (Prism P2-1 on #3552): a page that kept an OLDER module beside the current ones. `7198c63dd` (#3539) shipped host-install.js and runtime-cli-install.js that know nothing of the named
 * "update to latest (not audited)" exception: with the current Accounts DTO / caps they label the Antigravity button "Update to 1.5.3" and send the body they always sent — `{ backend }` / `{ cli }` —
 * which the new server used to take as the latest exception. These are the reviewer's two reproductions, mounted for real (the real modules of that commit, tests/fixtures/ui-skew-154, linked
 * to the current ones), plus the controls: the current modules say it, and the server's refusal is the real predicate.
 *
 * What a retained module can no longer do is start the latest exception: its request lacks `acceptLatestUnaudited: true`, and the server refuses that (tests/web-host-update-route-136.test.ts,
 * tests/web-host-install-gate-144.test.ts, tests/runtime-api-cli-install.test.ts and tests/runtime-cli-install-gate-148.test.ts drive the route and the real gate). The browser SKEW receipts for the same
 * combinations are in the PR.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { hostUpdateAckError } from "../src/web-host-install.js";

const UI = resolve("src/ui"), FIXTURES = resolve("tests/fixtures/ui-skew-154");
const root = mkdtempSync(join(tmpdir(), "agend-154-skew-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
/**
 * A served directory in which `olds` are the retained OLDER copies (name → fixture) and every other relative import is the current module (absolute, so the module graph is shared with the page).
 * Returns the module named `entry` from it, and a way to reach a retained module's own instance (its store).
 */
async function retained(entry: string, olds: Record<string, string>): Promise<{ mod: any; old: (name: string) => Promise<any> }> {
  const dir = join(root, `case-${++n}`); mkdirSync(dir, { recursive: true });
  const rewrite = (text: string): string => text.replace(/^(import[^\n]*?from\s+)"\.\/([^"]+)"/gm, (_m, head: string, name: string) => olds[name] || name === entry ? `${head}"./${name}"` : `${head}${JSON.stringify(pathToFileURL(join(UI, name)).href)}`);
  writeFileSync(join(dir, entry), rewrite(readFileSync(join(UI, entry), "utf8")));
  for (const [name, fixture] of Object.entries(olds)) writeFileSync(join(dir, name), rewrite(readFileSync(join(FIXTURES, fixture), "utf8")));
  const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(join(dir, name)).href);
  return { mod: await load(entry), old: load };
}
const text = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const originalFetch = globalThis.fetch;
const response = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body });

describe("the host's Accounts row: accounts-view.js beside #3539's host-install.js (7198c63dd), and beside the current one", () => {
  const hostRow = (extra: Record<string, unknown>) => ({ scope: { kind: "host" }, backend: "antigravity", profile: null, state: "usable", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: true }, ...extra });
  // The current Accounts DTO for an Antigravity at the audited release: the exception (`latest`), a button, the audited release it is NOT going to.
  const AGY = { backend: "antigravity", profiles: true, installed: true, fleetDefault: null, agents: [], rows: [hostRow({ version: "1.5.3", cliUpdate: { state: "current", installed: "1.5.3", audited: "1.5.3", button: true, via: "dashboard", latest: true } })] };
  let p: AppPage, i18n: any, posts: Array<{ url: string; body: any }>;
  const mountWith = async (olds: Record<string, string>) => {
    const { mod, old } = await retained("accounts-view.js", olds);
    const hostInstall = olds["host-install.js"] ? await old("host-install.js") : await import("/ui/js/host-install.js");
    hostInstall.hostInstallStore.set({ loaded: false, run: null, dismissed: [], starting: null });
    mod.accountsStore.set({ loaded: false, failed: false, view: null });
    await p.mount(h(mod.AccountsView, { instances: {}, stageAgent: () => {}, stageDefault: () => {} })); await settle(8);
  };
  const button = () => p.root.querySelectorAll("button").find((x: any) => /^(Update to |Updating)/.test(text(x)));
  beforeAll(() => {
    p = page({ url: "http://127.0.0.1:19281/settings/agents", storage: { agend_tour_done: "1" } });
    globalThis.fetch = (async (url: string, init: any = {}) => {
      if (init.method === "POST") {
        const body = JSON.parse(init.body); posts.push({ url, body });
        // the server's own predicate decides; the page gets its refusal as the route answers it
        const refused = url === "/ui/host-update" ? hostUpdateAckError(body.backend, body.acceptLatestUnaudited) : null;
        return refused ? response({ error: refused }, 409) : response({ install: { id: "u".repeat(32), backend: body.backend, mode: "update", fromVersion: "1.5.3", targetVersion: null, latest: true, phase: "running", startedOn: "x", startedAt: 1, endedAt: null, lines: [] } });
      }
      return response(String(url).startsWith("/ui/accounts") ? { clis: [AGY] } : url === "/ui/host-install" ? { install: null } : { login: null, targets: [] });
    }) as any;
  });
  afterAll(() => { p.restore(); globalThis.fetch = originalFetch; });
  beforeEach(async () => { posts = []; i18n = await import("/assets/app-i18n.js"); i18n.setLang("en", { store: false }); });
  afterEach(async () => { await p.unmount(); });

  it("the reviewer's reproduction: the retained module labels it 'Update to 1.5.3' (no 'not audited') and posts `{ backend }` — the server's predicate refuses that exact body, so it does not start", async () => {
    await mountWith({ "host-install.js": "host-install.7198c63dd.js" });
    expect(text(button())).toBe("Update to 1.5.3");
    expect(text(p.root)).not.toMatch(/not audited/i);
    fire(button(), "click"); await settle(8);
    expect(posts).toEqual([{ url: "/ui/host-update", body: { backend: "antigravity" } }]);
    expect(hostUpdateAckError("antigravity", posts[0]!.body.acceptLatestUnaudited)).toBe("latest_ack_required");
    expect(text(p.root)).not.toMatch(/Updating Antigravity/);                 // the refusal came back: no run is shown
  });
  it("control: the current module says 'Update to latest (not audited by AgEnD)' and posts `{ backend, acceptLatestUnaudited: true }`, which the same predicate accepts — and a run is shown", async () => {
    await mountWith({});
    expect(text(button())).toBe("Update to latest (not audited by AgEnD)");
    fire(button(), "click"); await settle(8);
    expect(posts).toEqual([{ url: "/ui/host-update", body: { backend: "antigravity", acceptLatestUnaudited: true } }]);
    expect(hostUpdateAckError("antigravity", posts[0]!.body.acceptLatestUnaudited)).toBeNull();
  });
  it("the fixture is what it says: 7198c63dd's host-install.js has no knowledge of the exception (so the first test is the module the reviewer used, not a doctored one)", () => {
    const fixture = readFileSync(join(FIXTURES, "host-install.7198c63dd.js"), "utf8");
    expect(fixture).not.toMatch(/acceptLatestUnaudited|updateLatest|not audited/i);
    expect(fixture).toMatch(/body: \{ backend \}/);
  });
});

describe("a paired computer's Runtime panel: panel-runtimes.js beside #3539's runtime-cli-install.js (7198c63dd), and beside the current one", () => {
  const idA = "12345678-1234-4321-abcd-123456789012";
  const claude = { id: "claude-code", path: "C:\\tools\\claude.exe", runnable: true, authenticated: true, version: "2.1.319", readOnlySupport: true, supports: { execution: true, resume: true, mcp: true }, models: [] };
  const caps = { version: "2.3.5-alpha", buildId: "a".repeat(64), protocolVersions: [1], capabilities: ["exec", "mcp", "panes", "credential-profiles", "remote-signin", "cli-install"] };
  const catalogRows = [{ id: "claude-code", version: "2.1.319", kind: "npm", pin: "audited" }, { id: "codex", version: "0.167.0", kind: "npm", pin: "audited" }, { id: "antigravity", version: "1.5.3", kind: "download", pin: "audited" }, { id: "opencode", version: "1.19.5", kind: "npm", pin: "audited" }];
  let p: AppPage, posts: Array<{ path: string; body: any }>, app: any, catalog: any, windowsCatalog: any, i18n: any, n2 = 0;
  const card = () => p.root.querySelector(`[data-machine-id="${idA}"]`);
  const agyButton = () => card().querySelector('.runtime-cli-install-list [data-cli="antigravity"] button');
  // The Runtime route's own decision for this body, as runtime-api.ts makes it for a computer that already has Antigravity (the one place that can see the inventory).
  const routeSays = (body: any): string | null => body.acceptLatestUnaudited === true ? null : "latest_ack_required";
  const mountWith = async (olds: Record<string, string>) => {
    const { mod } = await retained("panel-runtimes.js", olds);
    await p.mount(h(mod.RuntimesPanel, { navKey: `skew-154-${++n2}` })); await settle(14);
  };
  beforeAll(async () => {
    p = page({ url: "http://localhost/settings/runtimes", storage: { agend_lang: "en" } });
    globalThis.fetch = (async (path: string, options: any = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (options.method === "POST") { posts.push({ path, body }); const refused = routeSays(body); return refused ? response({ error: refused }, 409) : response({ job: { cli: "antigravity", state: "installing", startedAt: 1 } }, 202); }
      if (path === "/ui/runtimes") return response({ enabled: true, machines: [{ id: idA, name: "Desktop", status: "online", platform: "win32", lastSeenAt: Date.now(), inventoryUpdatedAt: Date.now(), runtimeInfo: caps, inventory: { home: "C:\\D", clis: [{ ...claude, id: "antigravity", version: "1.3.5" }] } }] });
      if (path.endsWith("/remote-setup")) return response({ capable: true, online: true, switches: { accounts: { on: false }, install: { on: true } }, job: null, catalog: catalogRows });
      if (path === "/api/settings/runtimes") return response({ switches: { windows_cli: { on: false }, remote_runtime: { on: true } }, max_agents_per_machine: { value: 4, min: 1, max: 16, default: 4 }, local_origin: "http://127.0.0.1:19280" });
      return response({});
    }) as any;
    i18n = await import("/assets/app-i18n.js"); i18n.setLang("en", { store: false });
    catalog = await import("/ui/js/runtime-catalog.js"); app = await import("/assets/app-store.js"); windowsCatalog = await import("/ui/js/windows-cli-catalog.js");
  });
  afterAll(() => { p.restore(); globalThis.fetch = originalFetch; });
  beforeEach(() => { posts = []; (globalThis as any).confirm = () => true; app.appStore.set({ windowsCli: false }); windowsCatalog.forgetWindowsCliCatalog(); catalog.forgetRuntimeCatalog(); });
  afterEach(async () => { await p.unmount(); catalog.forgetRuntimeCatalog(); vi.restoreAllMocks(); });

  it("the reviewer's reproduction: an older Antigravity on the computer — the retained module says 'Update to 1.5.3', its dialog describes the pinned download, and it posts `{ cli }` — which the route refuses (409), so no `cli.update` is sent", async () => {
    const asked: string[] = []; (globalThis as any).confirm = (m: string) => { asked.push(m); return true; };
    await mountWith({ "runtime-cli-install.js": "runtime-cli-install.7198c63dd.js" });
    expect(text(agyButton())).toBe("Update to 1.5.3");
    expect(text(card())).not.toMatch(/not audited/i);
    fire(agyButton(), "click"); await settle(14);
    expect(asked.join(" ")).not.toMatch(/LATEST|NOT audited/);                 // what the person was shown is the pinned wording
    expect(posts).toEqual([{ path: `/ui/runtimes/machines/${idA}/cli-install`, body: { cli: "antigravity" } }]);
    expect(routeSays(posts[0]!.body)).toBe("latest_ack_required");
  });
  it("control: the current module says 'Update to latest (not audited by AgEnD)', asks in words that say LATEST and NOT audited, and posts `{ cli, acceptLatestUnaudited: true }`", async () => {
    const asked: string[] = []; (globalThis as any).confirm = (m: string) => { asked.push(m); return true; };
    await mountWith({});
    expect(text(agyButton())).toBe("Update to latest (not audited by AgEnD)");
    fire(agyButton(), "click"); await settle(14);
    expect(asked.join(" ")).toMatch(/LATEST/); expect(asked.join(" ")).toMatch(/NOT audited/);
    expect(posts).toEqual([{ path: `/ui/runtimes/machines/${idA}/cli-install`, body: { cli: "antigravity", acceptLatestUnaudited: true } }]);
    expect(routeSays(posts[0]!.body)).toBeNull();
  });
  it("the fixture is what it says: 7198c63dd's runtime-cli-install.js has no knowledge of the exception", () => {
    const fixture = readFileSync(join(FIXTURES, "runtime-cli-install.7198c63dd.js"), "utf8");
    expect(fixture).not.toMatch(/acceptLatestUnaudited|updateLatest|runtimeUpdateLatest|not audited/i);
    expect(fixture).toMatch(/body: \{ cli: cli\.id \}/);
  });
});
