/**
 * Settings → Runtime & model: the reasoning-effort field beside the model (AGEND-177, #3636 PR 2). Its choices are what the
 * daemon says the selected model takes (the chat chip's list), it is applied through the chip's own /effort, and
 * "Model default" is the unset state that is never written. No CLI, no network.
 */
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleWebRequest } from "../src/web-api.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

function get(path: string, ctx: Record<string, unknown>) {
  const token = "c".repeat(48);
  const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers: { host: "127.0.0.1:19280", "x-agend-token": token }, socket: { remoteAddress: "127.0.0.1", destroy() {} } });
  let status = 0, body = "";
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const res = Object.assign(new EventEmitter(), {
    headersSent: false, destroyed: false, writableEnded: false, setHeader() {}, getHeader() { return undefined; },
    writeHead: vi.fn((c: number): void => { status = c; res.headersSent = true; }),
    end: vi.fn((t = ""): void => { body = String(t); res.writableEnded = true; finish(); }),
    write() { return true; },
  });
  handleWebRequest(req as never, res as never, new URL(path, "http://127.0.0.1:19280"), { webToken: token, logger: { info() {}, debug() {}, error() {}, warn() {} }, ...ctx } as never);
  return { finished, status: () => status, json: () => JSON.parse(body || "null") };
}

describe("GET /ui/effort-options", () => {
  const fleetConfig = { instances: { coder: { working_directory: "/w" } }, defaults: {} };
  it("asks the fleet for the agent and the model typed in the field", async () => {
    const effortOptionsFor = vi.fn(() => ({ levels: ["low", "high"], effort: null, source: "unset" }));
    const r = get("/ui/effort-options?instance=coder&model=claude-opus-4-6", { fleetConfig, effortOptionsFor });
    await r.finished;
    expect(r.status()).toBe(200);
    expect(r.json()).toEqual({ instance: "coder", levels: ["low", "high"], effort: null, source: "unset", model: "" });
    expect(effortOptionsFor).toHaveBeenCalledWith("coder", "claude-opus-4-6");
    const r2 = get("/ui/effort-options?instance=coder", { fleetConfig, effortOptionsFor });
    await r2.finished;
    expect(effortOptionsFor).toHaveBeenLastCalledWith("coder", null);
  });
  it("refuses a bad name or model, and an agent it does not have, without asking the fleet", async () => {
    const effortOptionsFor = vi.fn(() => ({ levels: [], effort: null, source: "unset" }));
    for (const [q, code] of [["", 400], ["?instance=", 400], ["?instance=..%2Fx", 400], ["?instance=coder&model=a%00b", 400], [`?instance=coder&model=${"m".repeat(300)}`, 400], ["?instance=ghost", 404], ["?instance=constructor", 404]] as const) {
      const r = get(`/ui/effort-options${q}`, { fleetConfig, effortOptionsFor });
      await r.finished;
      expect(r.status(), q).toBe(code);
    }
    expect(effortOptionsFor).not.toHaveBeenCalled();
  });
  it("a daemon without the method (older) answers 404, so a newer page just shows no field", async () => {
    const r = get("/ui/effort-options?instance=coder", { fleetConfig });
    await r.finished;
    expect(r.status()).toBe(404);
  });
});

describe("the effort field in Runtime & model", () => {
  let p: AppPage, D: any, calls: Array<{ path: string; method: string; body: any }>, options: any, nowEffort: string | null, commandAnswer: any, savedModel = "";
  const originalFetch = globalThis.fetch;
  const response = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body });
  beforeAll(async () => {
    p = page({ url: "http://127.0.0.1:19281/ui/fleet/agent/coder", storage: { agend_lang: "en" } });
    globalThis.fetch = (async (path: string, o: any = {}) => {
      const body = o.body ? JSON.parse(o.body) : null;
      calls.push({ path, method: o.method || "GET", body });
      if (path.startsWith("/ui/effort-options?")) {
        const model = new URL(path, "http://x").searchParams.get("model") || "";
        const levels = options[model] ?? options[""];
        return levels === 404 ? response({}, 404) : response({ instance: "coder", levels, effort: nowEffort, source: nowEffort ? "instance" : "unset", model: savedModel });
      }
      if (path === "/ui/command") { if (commandAnswer.ok === false) return response({ error: "nope" }, 409); nowEffort = body.args; return response({ text: "Effort set" }); }
      if (path.startsWith("/ui/models?")) return response({ models: [{ id: "opus-a", label: "opus-a" }, { id: "opus-b", label: "opus-b" }, { id: "haiku", label: "haiku" }], source: "cli-cache" });
      return response({}, 404);
    }) as any;
    D = await import("/ui/js/settings-dialogs.js");
    const i18n = await import("/assets/app-i18n.js"); i18n.setLang("en", { store: false });
  });
  afterAll(() => { p.restore(); globalThis.fetch = originalFetch; });
  beforeEach(() => {
    calls = []; nowEffort = null; commandAnswer = {};
    options = { "": ["low", "medium", "high", "max"], "opus-a": ["low", "medium", "high", "max"], "opus-b": ["low", "medium", "high"], haiku: [] };
  });
  afterEach(async () => { await p.unmount(); });

  async function mount(inst: Record<string, unknown>) {
    const out: { m?: any } = {};
    savedModel = String(inst.model ?? "");
    const ctx = { fleet: { defaults: {}, instances: { coder: inst } }, schema: buildSettingsImpactSchema(), stageAgent: vi.fn(), drafts: new Map(), channelType: () => "telegram", shortName: (n: string) => n, staged: new Map(), reload: vi.fn(), reloadLive: vi.fn(async () => {}) };
    function Page() {
      const m = D.useAgentForm({ name: "coder", inst, ctx }); out.m = m;
      return h("div", null, h(D.EffortField, { m }));
    }
    await p.mount(h(Page, null)); await settle(8);
    const $ = (sel: string) => p.root.querySelector(sel) as any;
    const labels = () => $("#ag-effort").querySelectorAll("option").map((o: any) => o.textContent.trim());
    return { $, labels, ctx, out };
  }

  it("lists Model default first, then the model's own levels; mounting writes nothing", async () => {
    const f = await mount({ backend: "claude-code", model: "opus-a", working_directory: "/w" });
    expect(f.labels()).toEqual(["Model default", "low", "medium", "high", "max"]);
    expect(f.$("#ag-effort").value).toBe("");
    expect(f.$("#ag-effort option").disabled).toBe(false);
    expect(calls.filter(c => c.method !== "GET")).toEqual([]);
    expect(f.ctx.stageAgent).not.toHaveBeenCalled();
    expect(f.$(".s-lab .impact")?.textContent).toBeTruthy();                 // takes effect now: said beside its ⓘ
  });

  it("follows the model: another model's levels replace them, one without an effort setting hides the field; nothing is written", async () => {
    const f = await mount({ backend: "claude-code", model: "opus-a", working_directory: "/w" });
    f.out.m.set("model")("opus-b"); await settle(8);
    expect(f.labels()).toEqual(["Model default", "low", "medium", "high"]);
    expect(calls.some(c => c.path.includes("model=opus-b"))).toBe(true);
    expect(f.$("#ag-effort").disabled).toBe(true);                           // an effort applies to the model that runs: save it first
    expect(p.root.textContent).toContain("Save the model change first");
    f.out.m.set("model")("haiku"); await settle(8);
    expect(f.$("#ag-effort")).toBeNull();
    f.out.m.set("model")("opus-a"); await settle(8);
    expect(f.labels()).toEqual(["Model default", "low", "medium", "high", "max"]);
    expect(f.$("#ag-effort").disabled).toBe(false);
    expect(calls.filter(c => c.method !== "GET")).toEqual([]);
  });

  it("a choice goes through the chip's /effort at once (not staged), and the field then shows it", async () => {
    const f = await mount({ backend: "claude-code", model: "opus-a", working_directory: "/w" });
    const el = f.$("#ag-effort"); el.value = "high"; fire(el, "change"); await settle(10);
    expect(calls.filter(c => c.method !== "GET")).toEqual([{ path: "/ui/command", method: "POST", body: { instance: "coder", command: "effort", args: "high" } }]);
    expect(f.ctx.stageAgent).not.toHaveBeenCalled();
    expect(f.ctx.reloadLive).toHaveBeenCalled();
    expect(f.$("#ag-effort").value).toBe("high");
    expect(f.$("#ag-effort option").disabled).toBe(true);                    // Model default cannot be picked back: /effort has no way to unset
  });

  it("a refused /effort leaves the field as it was", async () => {
    commandAnswer = { ok: false };
    const f = await mount({ backend: "claude-code", model: "opus-a", working_directory: "/w" });
    const el = f.$("#ag-effort"); el.value = "max"; fire(el, "change"); await settle(10);
    expect(f.$("#ag-effort").value).toBe("");
  });

  it("an effort in force that the selected model does not offer stays visible, not selectable", async () => {
    nowEffort = "max";
    const f = await mount({ backend: "claude-code", model: "opus-b", working_directory: "/w", effort: "max" });
    expect(f.labels()).toEqual(["Model default", "low", "medium", "high", "max (not offered by this model)"]);
    expect(f.$("#ag-effort").value).toBe("max");
  });

  it("shows nothing for a Windows agent, or from a daemon without the endpoint (an older one)", async () => {
    const win = await mount({ backend: "codex", runtime: "windows", working_directory: "C:\\w" });
    expect(win.$("#ag-effort")).toBeNull();
    expect(calls.filter(c => c.path.startsWith("/ui/effort-options"))).toEqual([]);
    await p.unmount(); options = { "": 404 };
    const old = await mount({ backend: "claude-code", model: "opus-a", working_directory: "/w" });
    expect(old.$("#ag-effort")).toBeNull();
  });
});
