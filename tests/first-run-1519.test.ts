/**
 * #1519 P7 (docs/design/ux-onboarding-walkthrough.md §5.1): the first run of a web-only fleet, and the wizard that
 * never overwrites an agent.
 * - The status frame says how many chat connections the fleet has; 0 shows the first-run card in Chat and in Settings'
 *   Agents and Connections; "Use the web only" hides it in this browser; "Connect a chat app" opens the setup wizard.
 * - A fleet with no agent: Chat offers New instance (the sidebar's opener, now a +).
 * - The wizard: a new agent's name must be free (409); "an agent you already have" binds that agent to the new
 *   connection and changes nothing else about it.
 * No server, no fleet: the quickstart route on a scratch config, the app's modules on a mini DOM with a fake fetch.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  execFileSync: vi.fn(() => { throw Error("no binary discovery in this test"); }),
}));
import { agentConflict, draftQuickstart, handleQuickstartRequest, planQuickstart, validateWizardInput, withExistingAgent, type WizardPlanInput } from "../src/quickstart-api.js";
import { FleetManager } from "../src/fleet-manager.js";
import type { FleetConfig } from "../src/types.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const CH = { id: "telegram", type: "telegram", mode: "topic", bot_token_env: "AGEND_TELEGRAM_TOKEN", group_id: "-100", access: { mode: "locked", allowed_users: [] } };
const cfgOf = (instances: Record<string, unknown>, channels: unknown[] = []) => ({ defaults: { backend: "codex" }, instances, channels }) as unknown as FleetConfig;
const NEW = { platform: "discord", backend: "claude-code", working_directory: "/w/new", instance_name: "alpha", token_env: "AGEND_DISCORD_TOKEN" } as WizardPlanInput;

describe("the wizard never overwrites an agent", () => {
  const cfg = cfgOf({ alpha: { working_directory: "/w/a", backend: "kiro-cli", description: "A", model: "m1", channel_id: "telegram" } }, [CH]);

  it("a new agent's name must be free; an existing agent must exist; a connection alone has no agent part", () => {
    expect(agentConflict(NEW, cfg) ?? "").toMatch(/already exists/);
    expect(agentConflict({ ...NEW, instance_name: "beta" }, cfg)).toBeNull();
    expect(agentConflict({ ...NEW, existing_agent: true }, cfg)).toBeNull();
    expect(agentConflict({ ...NEW, instance_name: "beta", existing_agent: true }, cfg) ?? "").toMatch(/no agent called "beta"/);
    expect(agentConflict({ ...NEW, instance_name: "__proto__", existing_agent: true }, cfg) ?? "", "an inherited key is not an agent").toMatch(/no agent/);
    expect(agentConflict({ ...NEW, connection_only: true }, cfg)).toBeNull();
  });

  it("an existing agent keeps everything; only its connection becomes the new one — and the plan shows its own directory and backend", () => {
    const body = { platform: "discord", instance_name: "alpha", existing_agent: true, token_env: "AGEND_DISCORD_TOKEN" } as WizardPlanInput;
    expect(validateWizardInput(body), "no backend or directory is asked for").toBeNull();
    const plan = planQuickstart(withExistingAgent(body, cfg), { backends: [], has_fleet: true, channels: [{ id: "telegram", type: "telegram", token_env: "AGEND_TELEGRAM_TOKEN" }] } as never);
    expect(plan.instance).toEqual({ name: "alpha", working_directory: "/w/a", backend: "kiro-cli", channel_id: "discord", existing: true });
    expect(plan.warnings.join(" "), "its backend is not checked against this host").not.toMatch(/not found on this host/);
    const draft = draftQuickstart(cfg, body, plan);
    expect(draft.instances.alpha).toEqual({ working_directory: "/w/a", backend: "kiro-cli", description: "A", model: "m1", channel_id: "discord" });
    expect(withExistingAgent({ ...body, existing_agent: undefined, working_directory: "/w/x", backend: "codex" }, cfg), "a new agent's input as it is")
      .toMatchObject({ working_directory: "/w/x", backend: "codex" });
  });

  it("existing_agent must be a boolean; a new agent still needs its backend and directory", () => {
    expect(validateWizardInput({ ...NEW, existing_agent: "yes" as never }) ?? "").toMatch(/existing_agent must be a boolean/);
    expect(validateWizardInput({ ...NEW, instance_name: "beta", working_directory: "" }) ?? "").toMatch(/working_directory/);
  });
});

describe("the quickstart route", () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  function call(method: string, path: string, cfg: FleetConfig, body?: unknown) {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-test-firstrun-")); roots.push(dataDir);
    return new Promise<{ status: number; body: any }>((resolve) => {
      const req: any = Object.assign(new EventEmitter(), { method, url: path, headers: {}, destroy: vi.fn() });
      const res: any = { headersSent: false, setHeader: vi.fn(), writeHead(s: number) { this.status = s; this.headersSent = true; }, end(t: string) { resolve({ status: this.status, body: JSON.parse(t) }); } };
      const ctx: any = { fleetConfig: cfg, dataDir, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
      expect(handleQuickstartRequest(req, res, new URL(path, "http://localhost"), ctx)).toBe(true);
      if (body !== undefined) queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
    });
  }
  const cfg = () => cfgOf({ alpha: { working_directory: "/w/a", backend: "kiro-cli" } });

  it("the environment lists the agents (the wizard offers them)", async () => {
    const r = await call("GET", "/api/settings/quickstart/environment", cfg());
    expect(r.body.agents).toEqual([{ name: "alpha", working_directory: "/w/a", backend: "kiro-cli" }]);
  });
  it("plan: a new agent named like an existing one is a 409; as the existing agent it plans with that agent's own values", async () => {
    const taken = await call("POST", "/api/settings/quickstart/plan", cfg(), { ...NEW, token_env: undefined });
    expect([taken.status, taken.body.error]).toEqual([409, expect.stringMatching(/already exists/)]);
    const ok = await call("POST", "/api/settings/quickstart/plan", cfg(), { platform: "discord", instance_name: "alpha", existing_agent: true });
    expect([ok.status, ok.body.instance]).toEqual([200, { name: "alpha", working_directory: "/w/a", backend: "kiro-cli", channel_id: "discord", existing: true }]);
  });
});

describe("the status frame counts the connections", () => {
  it.each([
    ["web only", { channels: [] }, 0],
    ["two connections", { channels: [CH, { ...CH, id: "discord", type: "discord" }] }, 2],
    ["a legacy `channel:`", { channel: CH }, 1],
  ])("%s", (_n, shape, count) => {
    const dir = mkdtempSync(join(tmpdir(), "agend-test-firstrun-fm-"));
    try {
      const fm = new FleetManager(dir) as any;
      clearInterval(fm.sessionPruneTimer);
      fm.fleetConfig = { defaults: {}, instances: {}, ...shape };
      expect((fm.getUiStatusSync() as { connections: number }).connections).toBe(count);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── The app ──

type Req = { method: string; url: string; body: any };
let reqs: Req[] = [];
let env: Record<string, unknown> = {};
const FLEET = { defaults: { backend: "claude-code" }, channels: [], instances: { alpha: { working_directory: "/w/a" } } };
async function fetchFake(url: string, init: any = {}) {
  const r: Req = { method: init.method || "GET", url, body: init.body ? JSON.parse(init.body) : null };
  reqs.push(r);
  const m = r.method;
  const body: unknown =
    m === "GET" && url === "/api/settings/schema" ? { impacts: {}, order: ["now", "instance", "fleet"] }
    : m === "GET" && url === "/api/settings/fleet/raw" ? structuredClone(FLEET)
    : m === "GET" && url === "/api/settings/classic" ? { defaults: {}, channels: {} }
    : m === "GET" && url === "/api/settings/connections" ? []
    : m === "GET" && url === "/api/fleet" ? { version: "2.2.0", instances: [{ name: "alpha", status: "running" }] }
    : m === "GET" && (url === "/api/profiles" || url === "/api/settings/pending") ? []
    : url === "/api/settings/quickstart/environment" ? env
    : url === "/api/settings/quickstart/probe" && r.body?.action === "verify" ? { identity: { valid: true, username: "bot" } }
    : url === "/api/settings/quickstart/plan" ? { channel: { id: "telegram", type: "telegram" }, channel_id: "telegram", token_env: "AGEND_TELEGRAM_TOKEN", warnings: [],
      instance: { name: r.body.instance_name, working_directory: r.body.working_directory ?? "/w/a", backend: r.body.backend ?? "claude-code", channel_id: "telegram", ...(r.body.existing_agent ? { existing: true } : {}) } }
    : url.startsWith("/ui/history") ? { messages: [] }
    : m !== "GET" ? { ok: true } : {};
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

let p: AppPage;
let app: any, nav: any, shell: any, chat: any, S: any, first: any;
const listeners = new Map<string, Set<(d: unknown) => void>>();
const stream = { on(n: string, f: (d: unknown) => void) { if (!listeners.has(n)) listeners.set(n, new Set()); listeners.get(n)!.add(f); return () => listeners.get(n)!.delete(f); } };
const status = (connections: unknown, instances = [{ name: "alpha", status: "running", state: "idle", execution_state: "idle" }]) =>
  app.applyStatus({ uptime: 1, instances, ...(connections === undefined ? {} : { connections }) });
const btn = (scope: any, text: string) => scope?.querySelectorAll("button").find((b: any) => b.textContent.includes(text)) ?? null;
const card = () => p.root.querySelector(".first-run");
/** What a test compares: the card's title, or null — never the node (a failure stays a plain AssertionError). */
const cardTitle = () => card()?.querySelector("h3")?.textContent?.trim() ?? null;
const dialogTitle = () => p.root.querySelector("dialog")?.querySelector("h2")?.textContent ?? null;
const mountChat = () => p.mount(h(chat.ChatPanel, { route: { panel: "chat" }, navKey: "chat:|1|en" }));
const mountSettings = (section: string) => p.mount(h(S.SettingsPanel, { route: { panel: "settings", section }, navKey: `settings:${section}|${++navSeq}|en` }));
let navSeq = 0;

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  shell = await import("/assets/app-shell.js");
  chat = await import("/ui/js/panel-chat.js");
  S = await import("/ui/js/panel-settings.js");
  first = await import("/ui/js/first-run.js");
  chat.boot({ stream, boot: null, deps: { fetch: fetchFake } });
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  reqs = [];
  p.storage.delete(first.DISMISS_KEY);
  first.resetFirstRun();
  env = { backends: ["claude-code"], channels: [], has_fleet: true, agents: [{ name: "alpha", working_directory: "/w/a", backend: "claude-code" }] };
});

describe("the first-run card", () => {
  it("only on a known web-only fleet: 0 connections shows it; 1, or a frame that does not say, does not", async () => {
    for (const [n, shown] of [[0, true], [1, false], [undefined, false]] as const) {
      status(n); await mountChat();
      expect([n, cardTitle()]).toEqual([n, shown ? "Connect a chat app" : null]);
      await p.unmount();
    }
    expect(app.appStore.get().connections, "a frame without the count is unknown, not 0").toBeNull();
  });

  it("Use the web only hides it here and in Settings, and stays hidden after a reload (stored)", async () => {
    status(0); await mountChat();
    btn(card(), "Use the web only").click(); await settle(2);
    expect(cardTitle()).toBeNull();
    expect(p.storage.get(first.DISMISS_KEY)).toBe("1");
    first.resetFirstRun();                                   // a reload: only the stored answer is left
    await mountSettings("bots"); await settle(6);
    expect(cardTitle()).toBeNull();
    p.storage.delete(first.DISMISS_KEY);                     // control: without it, the same page shows the card
    await mountSettings("agents"); await settle(6);
    expect(cardTitle()).toBe("Connect a chat app");
  });

  it("with no storage (it throws) the card still shows, and Use the web only still hides it on this page", async () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("SecurityError"); } });
    try {
      status(0); await mountChat();
      expect(cardTitle()).toBe("Connect a chat app");
      btn(card(), "Use the web only").click(); await settle(2);
      expect(cardTitle()).toBeNull();
    } finally { Object.defineProperty(globalThis, "localStorage", real); }
  });

  it("Connect a chat app (from Chat) goes to Settings › Connections, which opens the setup wizard once", async () => {
    status(0); await mountChat();
    btn(card(), "Connect a chat app").click(); await settle(2);
    expect(p.window.location.pathname).toBe("/settings/bots");
    await mountSettings("bots"); await settle(8);
    expect(dialogTitle()).toBe("Set up AgEnD");
    await mountSettings("bots"); await settle(8);
    expect(dialogTitle(), "asked once: coming back does not open it again").toBeNull();
  });

  it("in Settings it heads Agents and Connections (not General), and opens the wizard in place", async () => {
    status(0);
    await mountSettings("general"); await settle(6);
    expect(cardTitle()).toBeNull();
    await mountSettings("agents"); await settle(6);
    expect(cardTitle()).toBe("Connect a chat app");
    btn(card(), "Connect a chat app").click(); await settle(8);
    expect(dialogTitle()).toBe("Set up AgEnD");
  });
});

describe("Chat with no agent", () => {
  it("says so, and New instance opens what the sidebar's + opens", async () => {
    const opened = vi.fn();
    shell.setNewInstanceOpener(opened);
    status(2, []); await mountChat();
    expect(p.root.querySelector(".empty-title")?.textContent ?? null).toBe("No instances yet");
    btn(p.root, "New instance").click();
    expect(opened).toHaveBeenCalledOnce();
    status(2); await mountChat();
    expect(p.root.querySelector(".empty-title")?.textContent ?? null, "with agents: pick one").not.toBe("No instances yet");
  });
});

describe("the wizard's first step", () => {
  const d = () => p.root.querySelector("dialog");
  const openWizard = async () => { status(1); await mountSettings("agents"); await settle(6); btn(p.root.querySelector(".panel-actions"), "Setup wizard").click(); await settle(6); };
  /** From step 1 to the plan: the plan request's body. */
  const toPlan = async () => {
    btn(d(), "Next").click(); await settle(2);
    btn(d(), "Next").click(); await settle(2);
    const t = d().querySelector("#wz-token"); t.value = "fake-wizard-token"; fire(t, "input"); await settle(2);
    btn(d(), "Verify").click(); await settle(6);
    btn(d(), "Next").click(); await settle(6);
    return reqs.filter(r => r.url === "/api/settings/quickstart/plan").map(r => r.body);
  };

  it("with agents: an agent you already have by default — the plan names it, existing, with no backend or directory", async () => {
    await openWizard();
    expect(btn(d(), "An agent you already have")?.getAttribute("aria-pressed") ?? null).toBe("true");
    expect(d().querySelector("#wz-agent")?.value ?? null).toBe("alpha");
    expect(d().querySelector("#wz-wd")?.id ?? null, "no directory to ask").toBeNull();
    const [plan] = await toPlan();
    expect(plan).toEqual({ platform: "telegram", instance_name: "alpha", existing_agent: true });
  });

  it("A new agent: asks backend, directory and a free name (agent-1 is taken → agent-2)", async () => {
    env = { ...env, agents: [{ name: "agent-1", working_directory: "/w/1", backend: "codex" }] };
    await openWizard();
    btn(d(), "A new agent").click(); await settle(2);
    expect([d().querySelector("#wz-name")?.value ?? null, d().querySelector("label[for=wz-name]")?.textContent ?? null]).toEqual(["agent-2", "New agent name"]);
    btn(d(), "Next").click(); await settle(2);
    expect(d().querySelector(".feedback.error")?.textContent ?? null).toBe("Enter an absolute working directory.");
    const wd = d().querySelector("#wz-wd"); wd.value = "/w/new"; fire(wd, "input"); await settle(2);
    const [plan] = await toPlan();
    expect(plan).toEqual({ platform: "telegram", backend: "claude-code", working_directory: "/w/new", instance_name: "agent-2" });
  });

  it("no agents: no choice, the first agent as before", async () => {
    env = { ...env, agents: [] };
    await openWizard();
    expect([btn(d(), "An agent you already have")?.textContent ?? null, d().querySelector("#wz-name")?.value ?? null]).toEqual([null, "agent-1"]);
  });
});
