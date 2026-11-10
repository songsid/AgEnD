/**
 * AGEND-161 (PR 1): an agent's "Details & settings" page and the categorised agent form behind it.
 * - the categories of each kind of agent (fleet / Windows native / ClassicBot room), the address that names one, and which
 *   category a change belongs to (the dot on the nav);
 * - every field of the old agent dialog is still there, in a category, with its id — and has an ⓘ;
 * - the patch is what the dialog always wrote: an untouched form writes nothing (so `fleet.yaml` is unchanged), an edit of a
 *   moved field writes exactly that key, and the three keys the page adds (board cards, resume work, MCP proxy reply) are
 *   written only when changed from what is in effect.
 */
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
// @ts-expect-error — a JS module of the app, with no types
import { agentForm, agentPatch, boardCardsOf, proxyReplyOf, resumeWorkOf } from "../src/ui/settings-model.js";

let p: AppPage, D: any, G: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/ui/fleet/agent/coder" });
  (globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => null });
  D = await import("/ui/js/settings-dialogs.js");
  G = await import("/ui/js/agent-details-settings.js");
});
afterAll(() => p.restore());
afterEach(async () => { await p.unmount(); });

const ctxFor = (inst: Record<string, unknown>, defaults: Record<string, unknown> = {}) => ({
  fleet: { defaults, instances: { coder: inst } }, schema: buildSettingsImpactSchema(), stageAgent: vi.fn(), drafts: new Map(),
  channelType: () => "telegram", shortName: (n: string) => n, staged: new Map(), reload: vi.fn(),
});
/** Every category of the agent form on one page, as the dialog stacks them (the form's own hook, no dialog around it). */
async function form(inst: Record<string, unknown>, defaults: Record<string, unknown> = {}) {
  const out: { m?: any } = {};
  const ctx = ctxFor(inst, defaults);
  function All() {
    const m = D.useAgentForm({ name: "coder", inst, ctx });
    out.m = m;
    return h("div", null, D.AGENT_CATEGORIES.map((cat: string) => h("section", { key: cat, "data-cat": cat }, h(D.AgentFields, { m, cat, onDelete: cat === "adv" ? () => {} : undefined }))));
  }
  await p.unmount();
  await p.mount(h(All, null));
  await settle(6);
  const $ = (sel: string) => p.root.querySelector(sel) as any;
  const edit = async (sel: string, value: string) => { const el = $(sel); el.value = value; fire(el, "input"); fire(el, "change"); await settle(3); };
  const check = async (sel: string, on: boolean) => { const el = $(sel); el.checked = on; fire(el, "change"); await settle(3); };
  return { $, edit, check, ctx, patch: () => out.m.pending(), ready: () => out.m.ready };
}

describe("the categories", () => {
  it("a fleet agent has Overview + five; a Windows native agent has no channel category; a ClassicBot room has Runtime and Channels only", () => {
    expect(G.categoriesOf("fleet")).toEqual(["overview", "basic", "runtime", "work", "channel", "adv"]);
    expect(G.categoriesOf("native")).toEqual(["overview", "basic", "runtime", "work", "adv"]);
    expect(G.categoriesOf("classic")).toEqual(["overview", "runtime", "channel"]);
  });
  it("which kind a page is: the room's read says classic, a Windows runtime is native, anything else is a fleet agent", () => {
    expect(G.agentKind({ kind: "classic" }, { runtime: "wsl" })).toBe("classic");
    expect(G.agentKind({}, { runtime: "windows" })).toBe("native");
    expect(G.agentKind(null, { runtime: "wsl" })).toBe("fleet");
    expect(G.agentKind(null, null)).toBe("fleet");
  });
  it("the address names one (?cat=); none is the list on a phone and Overview on a wide screen; a category this kind lacks goes to its first", () => {
    expect(G.categoryFromSearch("fleet", "?cat=runtime")).toBe("runtime");
    expect(G.categoryFromSearch("fleet", "")).toBe("");
    expect(G.categoryFromSearch("fleet", "?cat=nonsense")).toBe("");
    expect(G.categoryFromSearch("classic", "?cat=basic")).toBe("runtime");      // the sidebar's ⚙ always names Basic info
    expect(G.categoryFromSearch("native", "?cat=channel")).toBe("basic");
    expect(G.categoryPath("web dev", "basic")).toBe("/ui/fleet/agent/web%20dev?cat=basic");
    expect(G.categoryPath("web-dev", "")).toBe("/ui/fleet/agent/web-dev");
  });
  it("each key of a patch belongs to one category (the nav's dot)", () => {
    expect([...G.dirtyCategories("fleet", { description: "x", model: "m", auto_pause_after: 3, status_emojis: { failed: "x" }, board_cards_at_once: 2 })].sort())
      .toEqual(["adv", "basic", "channel", "runtime", "work"]);
    expect([...G.dirtyCategories("fleet", {})]).toEqual([]);
    expect([...G.dirtyCategories("classic", { backend: "codex", web_echo: true })].sort()).toEqual(["channel", "runtime"]);
    expect([...G.dirtyCategories("native", { native_sandbox: "workspace-write", systemPrompt: "x" })].sort()).toEqual(["adv", "work"]);
  });
});

describe("every field of the old agent dialog is in a category, with its ⓘ", () => {
  const WHERE: Record<string, string[]> = {
    basic: ["#ag-dn", "#ag-desc"],
    runtime: ["#ag-model", "#ag-fo"],
    work: ["#ag-wd", "#ag-auto", "#ag-hang", "#ag-agent_mode", "#ag-tool_set"],
    channel: ["#ag-ch", "#ag-general", "#ag-tool_progress", "#ag-cross_instance_visibility"],
    adv: ["#ag-sys", "#ag-log_level", "#ag-resume", "#ag-mcp-proxy", "#ag-cards", "#ag-dash-appearance", "#ag-dash-task_board", "#ag-dash-web_settings", "#ag-dash-office", "#ag-dash-office_packs"],
  };
  it("by category", async () => {
    const f = await form({ backend: "claude-code", working_directory: "/w" });
    for (const [cat, ids] of Object.entries(WHERE)) for (const id of ids) expect(f.$(`[data-cat="${cat}"] ${id}`), `${id} is not in ${cat}`).not.toBeNull();
    // The Codex-only Speed is in Runtime & model (and not there for another CLI).
    expect(f.$("#ag-speed")).toBeNull();
    const c = await form({ backend: "codex", working_directory: "/w" });
    expect(c.$('[data-cat="runtime"] #ag-speed')).not.toBeNull();
  });
  it("each category's settings carry an ⓘ (the shared InfoTip) and the Status emojis say what they are", async () => {
    const f = await form({ backend: "claude-code", working_directory: "/w" });
    for (const cat of ["basic", "runtime", "work", "channel", "adv"]) expect(p.root.querySelectorAll(`[data-cat="${cat}"] .s-tipbtn`).length, cat).toBeGreaterThan(0);
    expect(p.root.querySelectorAll(".s-tipbtn").length).toBeGreaterThanOrEqual(20);
    expect(f.$('[data-cat="channel"]')?.textContent).toContain("What this is");
    expect(f.$('[data-cat="adv"]')?.textContent).toContain("existing field");              // System prompt: the existing field, unchanged
  });
  it("only the page offers Delete (the dialog passes no onDelete)", async () => {
    const f = await form({ backend: "claude-code", working_directory: "/w" });
    expect(p.root.querySelector(".btn-danger")).not.toBeNull();
    expect(f.$(".ap-danger")).not.toBeNull();
  });
});

describe("the patch is what the dialog always wrote", () => {
  it("an untouched form writes nothing — fleet.yaml is unchanged — whether or not the agent sets the three new keys", async () => {
    expect((await form({ backend: "claude-code", working_directory: "/w" })).patch()).toEqual({});
    expect((await form({ backend: "claude-code", working_directory: "/w", board_cards_at_once: 3, resume_interrupted_work: false, mcp_proxy_reply: true })).patch()).toEqual({});
    expect((await form({ backend: "claude-code", working_directory: "/w" }, { resume_interrupted_work: false, mcp_proxy_reply: true })).patch()).toEqual({});
  });
  it("an edit of a moved field writes exactly that key (Basic info, Workspace & running, Channels, Advanced)", async () => {
    const f = await form({ backend: "claude-code", working_directory: "/w" });
    await f.edit("#ag-desc", "reviews the UI");
    expect(f.patch()).toEqual({ description: "reviews the UI" });
    await f.edit("#ag-wd", "/w2");
    await f.edit("#ag-sys", "file:prompts/dev.md");
    expect(f.patch()).toEqual({ description: "reviews the UI", working_directory: "/w2", systemPrompt: "file:prompts/dev.md" });
    await f.check("#ag-general", true);
    expect(f.patch().general_topic).toBe(true);
  });
  it("an override still follows 'Inherit from defaults': unticking it and typing writes the value, ticking it again writes null", async () => {
    const f = await form({ backend: "claude-code", working_directory: "/w", auto_pause_after: 30 });
    expect(f.$("#ag-auto").value).toBe("30");
    const inherit = f.$('.field:has(#ag-auto) .inherit-row input') ?? [...p.root.querySelectorAll(".inherit-row input")].find((i: any) => i.closest(".field")?.querySelector("#ag-auto"));
    inherit.checked = true; fire(inherit, "change"); await settle(3);
    expect(f.patch()).toEqual({ auto_pause_after: null });
  });
  it("the three new keys are written only when changed from what is in effect", async () => {
    const f = await form({ backend: "claude-code", working_directory: "/w" });
    expect(f.$("#ag-resume").checked).toBe(true);                      // in effect: on
    expect(f.$("#ag-mcp-proxy").checked).toBe(false);                  // in effect: off
    expect(f.$("#ag-cards").value).toBe("1");
    await f.check("#ag-resume", false);
    await f.check("#ag-mcp-proxy", true);
    await f.edit("#ag-cards", "3");
    expect(f.patch()).toEqual({ resume_interrupted_work: false, mcp_proxy_reply: true, board_cards_at_once: 3 });
    await f.check("#ag-resume", true);                                  // put back: nothing to write
    expect(f.patch()).toEqual({ mcp_proxy_reply: true, board_cards_at_once: 3 });
  });
  it("what is in effect follows the fleet's defaults, then the built-in value", () => {
    expect([boardCardsOf({}), boardCardsOf({ board_cards_at_once: 4 }), boardCardsOf({ board_cards_at_once: 0 })]).toEqual([1, 4, 1]);
    expect([resumeWorkOf({}, {}), resumeWorkOf({}, { resume_interrupted_work: false }), resumeWorkOf({ resume_interrupted_work: true }, { resume_interrupted_work: false })]).toEqual([true, false, true]);
    expect([proxyReplyOf({}, {}), proxyReplyOf({}, { mcp_proxy_reply: true }), proxyReplyOf({ mcp_proxy_reply: false }, { mcp_proxy_reply: true })]).toEqual([false, true, false]);
  });
  it("a whole number of at least 1 for the board cards: anything else is invalid and Save waits", async () => {
    const f = await form({ backend: "claude-code", working_directory: "/w" });
    await f.edit("#ag-cards", "0");
    expect(f.ready()).toBe(false);
    expect(p.root.textContent).toContain("whole number of at least 1");
    await f.edit("#ag-cards", "1.5");
    expect(f.ready()).toBe(false);
    await f.edit("#ag-cards", "2");
    expect(f.ready()).toBe(true);
    expect(f.patch()).toEqual({ board_cards_at_once: 2 });
  });
  it("agentPatch given a form without the three keys (an older caller) writes none of them", () => {
    const inst = { backend: "claude-code", working_directory: "/w" };
    const f: any = agentForm(inst, {}, "coder");
    delete f.board_cards_at_once; delete f.resume_interrupted_work; delete f.mcp_proxy_reply;
    expect(agentPatch(f, inst, {}, null, null)).toEqual({});
  });
});
