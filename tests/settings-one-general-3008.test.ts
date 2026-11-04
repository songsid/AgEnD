/**
 * #3008 ② G1/G2 (the leader's strings 18 and 19, cid-alpha3-design):
 *  - Settings → an agent: on a fleet with no chat connection, ticking "General" on a second agent says, right by the
 *    checkbox, "<name> is already the General. Untick it first." — by the name the chat list shows (its display name,
 *    else the instance name); the box stays ticked and the change cannot be staged. The General itself, unticking,
 *    and a chat fleet are unchanged.
 *  - The sidebar: the row the status frame marks `general: true` is pinned first under "General", out of its other
 *    group (and of the favorites); without the mark nothing moves.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

let p: AppPage;
const realFetch = (globalThis as any).fetch;
beforeAll(() => { p = page({ url: "http://127.0.0.1:19280/settings/agents" }); (globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => null }); });
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
afterEach(async () => { await p.unmount(); });

async function editor(fleet: Record<string, any>, name: string) {
  const { AgentDialog } = await import("/ui/js/settings-dialogs.js");
  const stageAgent = vi.fn();
  const ctx = { fleet, schema: buildSettingsImpactSchema(), stageAgent, drafts: new Map(), channelType: () => "telegram",
    shortName: (n: string, inst: any) => (inst && inst.display_name) || n };
  await p.unmount();
  await p.mount(h(AgentDialog, { name, inst: fleet.instances[name], ctx, onClose: () => {} }));
  await settle(8);
  const $ = (sel: string) => p.root.querySelector(sel) as any;
  const tick = async (on: boolean) => { const box = $("#ag-general"); box.checked = on; fire(box, "change"); await settle(4); };
  return { $, tick, stageAgent };
}

describe("#3008 ② Settings: one General on a fleet with no chat connection", () => {
  it("ticking a second says which agent is the General (its display name), by the checkbox; it stays ticked", async () => {
    const e = await editor({ defaults: {}, instances: { planner: { working_directory: "/w/p", general_topic: true, display_name: "Planner Bot" }, builder: { working_directory: "/w/b" } } }, "builder");
    expect(e.$("#ag-general-one")).toBeNull();
    await e.tick(true);
    expect([e.$("#ag-general-one")?.textContent, e.$("#ag-general-one")?.getAttribute("role"), e.$("#ag-general").checked])
      .toEqual(["Planner Bot is already the General. Untick it first.", "alert", true]);
    await e.tick(false);
    expect(e.$("#ag-general-one")).toBeNull();
  });
  it("by the instance name when it has no display name", async () => {
    const e = await editor({ defaults: {}, instances: { planner: { working_directory: "/w/p", general_topic: true }, builder: { working_directory: "/w/b" } } }, "builder");
    await e.tick(true);
    expect(e.$("#ag-general-one").textContent).toBe("planner is already the General. Untick it first.");
  });
  it("the General itself, and a chat fleet's second General, are unchanged", async () => {
    const own = await editor({ defaults: {}, instances: { planner: { working_directory: "/w/p", general_topic: true } } }, "planner");
    expect([own.$("#ag-general").checked, own.$("#ag-general-one")]).toEqual([true, null]);
    const chat = await editor({ defaults: {}, channels: [{ type: "telegram", id: "telegram" }], instances: { planner: { working_directory: "/w/p", general_topic: true }, builder: { working_directory: "/w/b" } } }, "builder");
    await chat.tick(true);
    expect(chat.$("#ag-general-one")).toBeNull();
  });
});

describe("#3008 ② the sidebar pins a web-only fleet's General first", () => {
  async function nav(items: any[]) {
    const { InstanceNav } = await import("/assets/instance-nav.js");
    await p.unmount();
    await p.mount(h(InstanceNav, { route: { panel: "chat", instance: null }, items, loaded: true }));
    await settle(6);
    const groups = p.root.querySelectorAll(".v-group").map((g: any) => ({
      head: (g.querySelector(".v-group-head")?.textContent ?? "").replace(/\s+/g, " ").trim(),
      rows: g.querySelectorAll(".inst-name").map((n: any) => n.textContent),
    }));
    return groups;
  }
  const row = (name: string, extra: Record<string, unknown> = {}) => ({ name, status: "running", backend: "claude-code", tags: [], teams: [], ...extra });
  it("the marked General is first, under \"General\", and nowhere else; without the mark the list is unchanged", async () => {
    const marked = await nav([row("alpha"), row("planner", { general: true }), row("zeta")]);
    expect(marked[0]).toEqual({ head: "General", rows: ["planner"] });
    expect(marked.slice(1).flatMap((g: any) => g.rows)).toEqual(["alpha", "zeta"]);
    const plain = await nav([row("alpha"), row("planner"), row("zeta")]);
    expect(plain.some((g: any) => g.head === "General")).toBe(false);
    expect(plain.flatMap((g: any) => g.rows)).toEqual(["alpha", "planner", "zeta"]);
  });
});
