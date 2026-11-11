/**
 * a single-checkbox setting does not say its own name twice, and on a phone the agent page's
 * header shows the status as its dot only (the name keeps the room).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

let p: AppPage, D: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/ui/fleet/agent/coder" });
  (globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => null });
  D = await import("/ui/js/settings-dialogs.js");
});
afterAll(() => p.restore());
afterEach(async () => { await p.unmount(); });

const ctx = (inst: Record<string, unknown>) => ({
  fleet: { defaults: {}, instances: { coder: inst } }, classic: { defaults: {}, channels: {} }, schema: buildSettingsImpactSchema(), stageAgent: vi.fn(), drafts: new Map(),
  channelType: () => "telegram", classicRuntime: () => ({ status: "running", backend: "claude-code" }), shortName: (n: string) => n, staged: new Map(), reload: vi.fn(),
});
/** Every `.field` that holds a lone checkbox: [the field's own label (what the checkbox's aria-label says), the words beside the box]. */
const checkRows = () => [...p.root.querySelectorAll(".field")].flatMap((f: any) => {
  const box = f.querySelector(".check input[aria-label]"), words = box && box.parentNode.querySelector("span");
  return box && words ? [[box.getAttribute("aria-label"), words.textContent]] : [];
});

describe("a lone checkbox says what to do, not its own name again", () => {
  it("fleet agent: General topic, reply guard, lightweight, resume work and MCP proxy reply read 'Enable' under their title, and the box is still named for screen readers", async () => {
    const inst = { backend: "claude-code", working_directory: "/w" };
    function All() {
      const m = D.useAgentForm({ name: "coder", inst, ctx: ctx(inst) });
      return h("div", null, D.AGENT_CATEGORIES.map((cat: string) => h("section", { key: cat }, h(D.AgentFields, { m, cat }))));
    }
    await p.mount(h(All, null));
    await settle(6);
    const rows = checkRows();
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const [name, words] of rows) { expect(words).toBe("Enable"); expect(name && name.length).toBeGreaterThan(0); expect(name).not.toBe(words); }
    expect(rows.map((r) => r[0])).toEqual(expect.arrayContaining(["General topic (fleet dispatcher)", "Lightweight mode"]));
  });
  it("ClassicBot room: reply guard, native replies, collaboration mode and web sync too", async () => {
    const room = { key: "k", instanceName: "coder", name: "room" };
    function Classic() {
      const m = D.useClassicForm({ room, ctx: ctx({}) });
      return h("div", null, ["runtime", "channel"].map((cat) => h("section", { key: cat }, h(D.ClassicFields, { m, cat }))));
    }
    await p.mount(h(Classic, null));
    await settle(6);
    const rows = checkRows();
    expect(rows.map((r) => r[1])).toEqual(rows.map(() => "Enable"));
    expect(rows.map((r) => r[0])).toEqual(expect.arrayContaining(["Collaboration mode", "Web echo"]));
  });
});

describe("the agent page's status on a phone", () => {
  const css = readFileSync("src/ui/shared/app.css", "utf8");
  const src = readFileSync("src/ui/panel-details.js", "utf8");
  it("only the dot below 480px, only on the agent page; the word stays as the title and the accessible name", () => {
    expect(css).toMatch(/@media \(max-width: 479px\) \{\s*\.p-agent-page \.panel-sub \.status-text \{ display: none; \}\s*\}/);
    expect(src).toContain('class="status" role="img" title=${statusText} aria-label=${statusText}');
    expect(src).toContain('<span class="status-text">${statusText}</span>');
    // Not the Settings page's own header, nor the chat's.
    expect(css.match(/\.status-text/g)).toHaveLength(1);
  });
});
