/**
 * #3212 PR 1: the Agent dialog's Account field (settings-dialogs.js + accounts-view.js): offered to a host agent of a
 * CLI with credential profiles, never to an agent on a paired Windows computer (that one has its own picker, #3214);
 * the choice stages `backend_options.<cli>.credential_profile`, merged with the dialog's other backend options (Codex
 * speed) and keeping the agent's existing ones; "" goes back to the fleet default (null).
 */
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

const VIEW = { clis: [
  { backend: "claude-code", profiles: true, installed: true, fleetDefault: null, agents: [], rows: [
    { scope: { kind: "host" }, backend: "claude-code", profile: null, state: "usable", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: true } },
    { scope: { kind: "host" }, backend: "claude-code", profile: "work", state: "usable", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: false } }] },
  { backend: "codex", profiles: true, installed: true, fleetDefault: null, agents: [], rows: [
    { scope: { kind: "host" }, backend: "codex", profile: null, state: "usable", signIn: true, usedBy: { agents: [], classic: [], fleetDefault: true } },
    { scope: { kind: "host" }, backend: "codex", profile: "team2", state: "usable", signIn: false, usedBy: { agents: [], classic: [], fleetDefault: false } }] },
] };
let p: AppPage, A: any;
const realFetch = (globalThis as any).fetch;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/settings/agents" });
  (globalThis as any).fetch = async (url: string) => (String(url).startsWith("/ui/accounts") ? { ok: true, status: 200, json: async () => VIEW } : { ok: false, status: 404, json: async () => null });
  A = await import("/ui/js/accounts-view.js");
});
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
afterEach(async () => { await p.unmount(); A.accountsStore.set({ loaded: false, failed: false, view: null }); });

async function editor(inst: Record<string, unknown>) {
  const { AgentDialog } = await import("/ui/js/settings-dialogs.js");
  const fleet = { defaults: {}, instances: { coder: inst } };
  const ctx = { fleet, schema: buildSettingsImpactSchema(), stageAgent: vi.fn(), drafts: new Map(), channelType: () => "telegram", shortName: (n: string) => n };
  await p.unmount();
  await p.mount(h(AgentDialog, { name: "coder", inst, ctx, onClose: () => {} }));
  await A.refreshAccounts(); await settle(10);                                       // the field's choices are read first
  const $ = (sel: string) => p.root.querySelector(sel) as any;
  const choose = async (sel: string, value: string) => { const el = $(sel); el.value = value; fire(el, "change"); await settle(4); };
  const stage = async () => { fire([...p.root.querySelectorAll("button")].find((b: any) => b.textContent.trim() === "Done") as any, "click"); await settle(4); };
  return { $, choose, stage, ctx };
}

describe("the Agent dialog's Account field (#3212)", () => {
  it("a host Claude agent: choosing an account stages just that key (the server keeps the agent's other options)", async () => {
    const e = await editor({ backend: "claude-code", working_directory: "/w", backend_options: { "claude-code": { prompt_cache_ttl: "1h" } } });
    expect(e.$("#ag-account")).not.toBeNull();
    await e.choose("#ag-account", "work");
    await e.stage();
    // Only the changed key, as the Codex speed patch does: the server merges per backend and key (settings-instance-patch.ts),
    // so the agent's prompt_cache_ttl is kept there.
    expect(e.ctx.stageAgent).toHaveBeenCalledWith("coder", expect.anything(), { backend_options: { "claude-code": { credential_profile: "work" } } });
  });
  it("a Codex agent: Speed and Account land in one backend_options patch", async () => {
    const e = await editor({ backend: "codex", working_directory: "/w" });
    await e.choose("#ag-speed", "fast");
    await e.choose("#ag-account", "team2");
    await e.stage();
    expect(e.ctx.stageAgent.mock.calls[0][2].backend_options).toEqual({ codex: { speed: "fast", credential_profile: "team2" } });
  });
  it("back to the fleet default sends null; an agent on a Windows computer gets no host Account field", async () => {
    const e = await editor({ backend: "claude-code", working_directory: "/w", backend_options: { "claude-code": { credential_profile: "work" } } });
    expect(e.$("#ag-account").value).toBe("work");
    await e.choose("#ag-account", "");
    await e.stage();
    expect(e.ctx.stageAgent.mock.calls[0][2].backend_options).toEqual({ "claude-code": { credential_profile: null } });
    const w = await editor({ backend: "claude-code", runtime: "windows", native_adapter: "exec", native_sandbox: "read-only", working_directory: "C:\\w" });
    expect(w.$("#ag-model")).not.toBeNull();
    expect(w.$("#ag-account")).toBeNull();
  });
});
