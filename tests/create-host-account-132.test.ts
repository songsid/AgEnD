/**
 * AGEND-132: New agent on this host (WSL / Linux) chooses an account, as one on a paired Windows computer does.
 * - server: POST /ui/instances checks the account (exists on this host, CLI supports named accounts, signed in) before
 *   anything is created, and creates the agent with backend_options.<cli>.credential_profile; never falls back to the default;
 * - dashboard: the field shows for a host CLI with named accounts and hides otherwise, clears when the CLI changes, sends credentialProfile;
 *   the paired-computer field and the Agent dialog's field are unchanged.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { resolveCreateAccount } from "../src/create-host-account.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const TOKEN = "t".repeat(48);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A data dir with claude-code profiles: `work` signed in, `off` signed out (folder with no login), `fresh` unknown-by-nothing. */
function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), "agend-create-acct-")); dirs.push(dir);
  const root = join(dir, "credential-profiles", "claude-code");
  mkdirSync(join(root, "work"), { recursive: true }); mkdirSync(join(root, "off"), { recursive: true });
  writeFileSync(join(root, "work", ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "00000000-0000-4000-8000-000000000001" } }));
  writeFileSync(join(root, "work", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "c".repeat(32), refreshToken: "c".repeat(32), expiresAt: Date.now() + 86400000 } }));
  return dir;
}

describe("resolveCreateAccount", () => {
  it("no account: the request is left as it was (the agent follows the fleet default)", () => {
    const dir = dataDir();
    expect(resolveCreateAccount(dir, { topic_name: "a" }, "claude-code")).toEqual({ ok: true });
    expect(resolveCreateAccount(dir, { topic_name: "a", credentialProfile: "" }, undefined)).toEqual({ ok: true });
    expect(resolveCreateAccount(dir, { backend_options: { codex: { speed: "fast" } } }, undefined)).toEqual({ ok: true, backendOptions: { codex: { speed: "fast" } } });
  });
  it("a signed-in account of this host becomes the agent's own credential_profile, next to its other options", () => {
    const dir = dataDir();
    expect(resolveCreateAccount(dir, { credentialProfile: "work" }, "claude-code")).toEqual({ ok: true, backendOptions: { "claude-code": { credential_profile: "work" } } });
    expect(resolveCreateAccount(dir, { backend: "claude-code", credentialProfile: "work", backend_options: { "claude-code": { prompt_cache_ttl: "1h" }, codex: { speed: "fast" } } }, undefined))
      .toEqual({ ok: true, backendOptions: { "claude-code": { prompt_cache_ttl: "1h", credential_profile: "work" }, codex: { speed: "fast" } } });
  });
  it("is refused, with a reason, when it does not exist, is signed out, is badly named or the CLI has no named accounts", () => {
    const dir = dataDir();
    expect(resolveCreateAccount(dir, { credentialProfile: "ghost" }, "claude-code")).toMatchObject({ ok: false, status: 400, code: "credential_profile_not_found", profile: "ghost" });
    expect(resolveCreateAccount(dir, { credentialProfile: "off" }, "claude-code")).toMatchObject({ ok: false, status: 409, code: "credential_profile_signed_out", profile: "off" });
    expect((resolveCreateAccount(dir, { credentialProfile: "off" }, "claude-code") as any).loginCommand).toContain("off");
    expect(resolveCreateAccount(dir, { credentialProfile: "../x" }, "claude-code")).toMatchObject({ ok: false, status: 400, code: "credential_profile_invalid" });
    expect(resolveCreateAccount(dir, { credentialProfile: 5 }, "claude-code")).toMatchObject({ ok: false, status: 400, code: "credential_profile_invalid" });
    expect(resolveCreateAccount(dir, { backend: "opencode", credentialProfile: "work" }, "claude-code")).toMatchObject({ ok: false, status: 400, code: "credential_profile_unsupported" });
    // a profile of another CLI's name is not this CLI's: codex has no "work" folder here
    expect(resolveCreateAccount(dir, { backend: "codex", credentialProfile: "work" }, "claude-code")).toMatchObject({ ok: false, code: "credential_profile_not_found", backend: "codex" });
  });
  it("the same checks cover backend_options sent directly, and two different names conflict", () => {
    const dir = dataDir();
    expect(resolveCreateAccount(dir, { backend_options: { "claude-code": { credential_profile: "ghost" } } }, "claude-code")).toMatchObject({ ok: false, code: "credential_profile_not_found" });
    expect(resolveCreateAccount(dir, { credentialProfile: "work", backend_options: { "claude-code": { credential_profile: "off" } } }, "claude-code")).toMatchObject({ ok: false, code: "credential_profile_conflict" });
    expect(resolveCreateAccount(dir, { backend_options: { "claude-code": { credential_profile: "work" } } }, "claude-code")).toMatchObject({ ok: true });
  });
});

class CaptureRes extends ServerResponse {
  status = 0; body = "";
  constructor(req: IncomingMessage) { super(req); }
  writeHead(status: number): this { this.status = status; return this; }
  end(chunk?: unknown): this { if (chunk) this.body += String(chunk); this.emit("capture:end"); return this; }
}
async function create(dir: string, body: Record<string, unknown>, handleCreate: (args: any, respond: (r: unknown, e?: string) => void) => Promise<void>) {
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  req.method = "POST"; req.url = "/ui/instances"; req.headers = { "x-agend-token": TOKEN };
  const res = new CaptureRes(req);
  const ctx = { webToken: TOKEN, dataDir: dir, sseClients: new Set(), fleetConfig: { channel: { group_id: 1 }, defaults: { backend: "claude-code" }, instances: {}, teams: {} },
    instanceIpcClients: new Map(), adapter: null, daemons: new Map(), eventLog: null, logger: { info() {}, debug() {}, error() {} }, getUiStatus: () => ({}), emitSseEvent: () => {},
    lifecycle: { handleCreate } } as unknown as WebApiContext;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no response")), 5000);
    res.once("capture:end", () => { clearTimeout(timer); resolve(); });
    handleWebRequest(req, res, new URL("http://localhost/ui/instances"), ctx);
  });
  return { status: res.status, body: JSON.parse(res.body) };
}

describe("POST /ui/instances with an account", () => {
  const ok = async (args: any, respond: (r: unknown, e?: string) => void) => { seen.push(args); respond({ success: true, name: "n" }); };
  let seen: any[];
  beforeEach(() => { seen = []; });
  it("creates the agent with the account in its backend_options, and no credentialProfile left over", async () => {
    const r = await create(dataDir(), { topic_name: "n", backend: "claude-code", credentialProfile: "work" }, ok);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].backend_options).toEqual({ "claude-code": { credential_profile: "work" } });
    expect(seen[0]).not.toHaveProperty("credentialProfile");
  });
  it("a missing, signed-out or unsupported account creates nothing and says why", async () => {
    const dir = dataDir();
    const missing = await create(dir, { topic_name: "n", credentialProfile: "ghost" }, ok);
    expect([missing.status, missing.body.code]).toEqual([400, "credential_profile_not_found"]);
    expect(missing.body.error).toContain("ghost");
    const off = await create(dir, { topic_name: "n", credentialProfile: "off" }, ok);
    expect([off.status, off.body.code, off.body.profile]).toEqual([409, "credential_profile_signed_out", "off"]);
    const none = await create(dir, { topic_name: "n", backend: "opencode", credentialProfile: "work" }, ok);
    expect([none.status, none.body.code]).toEqual([400, "credential_profile_unsupported"]);
    expect(seen).toHaveLength(0);
  });
  it("without an account the create is as before", async () => {
    const r = await create(dataDir(), { topic_name: "n" }, ok);
    expect(r.status).toBe(200);
    expect(seen[0]).not.toHaveProperty("backend_options");
  });
});

// ── the dashboard ──
const claudeCli = { id: "claude-code", path: "C:\\tools\\claude.exe", runnable: true, authenticated: true, version: "2.1.316", readOnlySupport: true, supports: { execution: true, resume: true, mcp: true }, models: [] };
const row = (backend: string, profile: string | null, state = "usable") => ({ scope: { kind: "host" }, backend, profile, state, signIn: true, usedBy: { agents: [], classic: [], fleetDefault: false } });
const VIEW = { clis: [
  { backend: "claude-code", profiles: true, installed: true, fleetDefault: null, agents: [], rows: [row("claude-code", null), row("claude-code", "work"), row("claude-code", "off", "not_signed_in"),
    { ...row("claude-code", "pc"), scope: { kind: "machine", id: "m1", name: "Desktop", online: true } }] },
  { backend: "codex", profiles: true, installed: true, fleetDefault: "team", agents: [], rows: [row("codex", null), row("codex", "team")] },
  { backend: "opencode", profiles: false, installed: true, fleetDefault: null, agents: [], rows: [row("opencode", null)] },
] };
const idA = "12345678-1234-4321-abcd-123456789012";
const machine = { id: idA, name: "Desktop", status: "online", platform: "win32", lastSeenAt: Date.now(), inventoryUpdatedAt: Date.now(),
  runtimeInfo: { version: "2.3.5-alpha", buildId: "a".repeat(64), protocolVersions: [1], capabilities: ["exec", "mcp", "panes", "credential-profiles"] },
  inventory: { home: "C:\\D", clis: [claudeCli], credentialProfiles: { profiles: [{ name: "pc", loggedIn: true }], default: "pc" } } };

describe("New agent → WSL / Linux: the Account field", () => {
  const originalFetch = globalThis.fetch;
  let p: AppPage, Create: any, catalog: any, windowsCatalog: any, app: any, accounts: any, i18n: any, posts: any[], models: any;
  const response = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const button = (label: string) => p.root.querySelectorAll("button").find((n: any) => n.textContent.trim() === label);
  const chooseRuntime = async (value: string) => { const input = p.root.querySelectorAll(".agent-runtime-picker input").find((n: any) => n.value === value); input.checked = true; fire(input, "change"); await settle(5); };
  const open = async (lang = "en") => { i18n.setLang(lang, { store: false }); await p.mount(h(Create, { onClose() {} })); await settle(10); await chooseRuntime("wsl"); await accounts.refreshAccounts(); await settle(6); };
  const pickCli = async (id: string) => {
    fire(p.root.querySelector(".agent-create-cli .cli-picker-trigger"), "click"); await settle(3);
    const item = p.root.querySelectorAll('[role="menuitemradio"]').find((n: any) => n.textContent.includes(id)); fire(item, "click"); await settle(5);
  };
  const field = () => p.root.querySelector("#create-host-account") as any;
  beforeAll(async () => {
    p = page({ url: "http://localhost/ui", storage: { agend_lang: "en" } });
    globalThis.fetch = (async (path: string, options: any = {}) => {
      if (options.method === "POST") posts.push({ path, body: JSON.parse(options.body) });
      if (path === "/ui/runtimes") return response({ enabled: true, machines: [machine] });
      if (path.startsWith("/ui/accounts")) return response(VIEW);
      if (path === "/ui/backends") return response({ backends: ["claude-code", "codex", "opencode"].map(name => ({ name, installed: true, state: "usable" })), defaultBackend: "claude-code" });
      if (path.startsWith("/ui/models?")) return response({ models: [], source: "cli-cache" });
      if (path === "/ui/instances") return response({ name: "wsl-agent" });
      return response({});
    }) as any;
    i18n = await import("/assets/app-i18n.js");
    catalog = await import("/ui/js/runtime-catalog.js"); app = await import("/assets/app-store.js"); windowsCatalog = await import("/ui/js/windows-cli-catalog.js");
    models = await import("/ui/js/settings-catalog.js"); accounts = await import("/ui/js/accounts-view.js");
    Create = (await import("/ui/js/panel-fleet.js")).CreateInstanceDialog;
  });
  beforeEach(() => { posts = []; app.appStore.set({ windowsCli: false }); windowsCatalog.forgetWindowsCliCatalog(); catalog.forgetRuntimeCatalog(); models.forgetCatalogs?.(); accounts.accountsStore.set({ loaded: false, failed: false, view: null }); });
  afterEach(async () => { await p.unmount(); catalog.forgetRuntimeCatalog(); });
  afterAll(() => { p.restore(); globalThis.fetch = originalFetch; });

  it("shows for a CLI with named accounts: only this host's accounts, a signed-out one disabled, the empty choice is the fleet default", async () => {
    await open();
    const f = field(); expect(f).not.toBeNull();
    expect([...f.querySelectorAll("option")].map((o: any) => o.value)).toEqual(["", "work", "off"]);   // the paired computer's "pc" is not here
    expect([...f.querySelectorAll("option")].map((o: any) => o.disabled)).toEqual([false, false, true]);
    expect(f.querySelector("option").textContent).toBe("Fleet default (default connection)");
    expect(p.root.textContent).toContain("The new agent connects with this account from its first start.");
  });
  it("is in the same step as the CLI, under it, and sends the chosen account on Create", async () => {
    await open();
    const cli = p.root.querySelector(".agent-create-cli"); expect(cli.contains(field())).toBe(true);
    field().value = "work"; fire(field(), "change"); await settle(3);
    button("Next")!.click(); await settle(5);
    expect(p.root.querySelector("#create-host-account")).toBeNull();                                  // step 2 has no second copy
    const topic = p.root.querySelectorAll(".agent-runtime-fields input")[1]; topic.value = "acct-agent"; fire(topic, "input"); await settle(3);
    button("Create")!.click(); await settle(8);
    expect(posts.find(r => r.path === "/ui/instances")?.body).toMatchObject({ topic_name: "acct-agent", backend: "claude-code", credentialProfile: "work" });
  });
  it("sends nothing about an account when none is chosen", async () => {
    await open();
    button("Next")!.click(); await settle(5);
    const topic = p.root.querySelectorAll(".agent-runtime-fields input")[1]; topic.value = "plain"; fire(topic, "input"); await settle(3);
    button("Create")!.click(); await settle(8);
    expect(posts.find(r => r.path === "/ui/instances")!.body).not.toHaveProperty("credentialProfile");
  });
  it("is cleared and re-offered when the CLI changes, and hidden for a CLI without named accounts", async () => {
    await open();
    field().value = "work"; fire(field(), "change"); await settle(3);
    await pickCli("Codex");
    expect(field()).not.toBeNull(); expect(field().value).toBe("");                                   // another CLI: the old choice is gone
    expect([...field().querySelectorAll("option")].map((o: any) => o.value)).toEqual(["", "team"]);
    expect(field().querySelector("option").textContent).toBe("Fleet default (team)");
    await pickCli("OpenCode");
    expect(field()).toBeNull();
    await pickCli("Claude Code");
    expect(field().value).toBe("");
  });
  it("zh-TW words", async () => {
    await open("zh-TW");
    expect(field().previousElementSibling?.textContent ?? field().parentElement.querySelector("label").textContent).toBe("帳號");
    expect(field().querySelector("option").textContent).toBe("Fleet 預設（預設連接）");
    expect(p.root.textContent).toContain("新 Agent 從第一次啟動就會使用這個帳號");
  });
  it("a paired Windows computer keeps its own Claude account field, and no host field", async () => {
    app.appStore.set({ windowsCli: true });
    i18n.setLang("en", { store: false }); await p.mount(h(Create, { onClose() {} })); await settle(10);
    const input = p.root.querySelectorAll(".agent-runtime-picker input").find((n: any) => n.value === `machine:${idA}`); input.checked = true; fire(input, "change"); await settle(6);
    expect(p.root.querySelector("#native-create-claude-account")).not.toBeNull();
    expect(field()).toBeNull();
  });
});
