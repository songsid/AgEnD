/**
 * AGEND-163: the Export and Load template dialogs on an agent's Basic info — a file loads into the form (not into fleet.yaml),
 * what it fills and skips is shown first, and the filled form's patch is what the Save bar stages.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { buildAgentExport, parseAgentExport } from "../src/agent-export.js";
import { fake } from "./helpers/fake-secrets-163.js";

let p: AppPage, D: any;
const calls: Array<{ url: string; body: any }> = [];
const fleet = { instances: {} as Record<string, any> };
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/ui/fleet/agent/coder" });
  // The two routes, answered by the same functions the server uses.
  (globalThis as any).fetch = async (url: string, opts: any) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    const out = url.endsWith("/parse") ? parseAgentExport(body.text) : buildAgentExport(body.instance, fleet.instances[body.instance], body.include);
    return { ok: true, status: 200, json: async () => out };
  };
  D = await import("/ui/js/settings-dialogs.js");
});
afterAll(() => p.restore());
afterEach(async () => { calls.length = 0; await p.unmount(); });

async function basic(inst: Record<string, unknown>) {
  fleet.instances.coder = inst;
  const out: { m?: any } = {};
  const ctx = { fleet: { defaults: {}, instances: { coder: inst } }, schema: buildSettingsImpactSchema(), stageAgent: vi.fn(), drafts: new Map(),
    channelType: () => "telegram", shortName: (n: string) => n, staged: new Map(), reload: vi.fn() };
  function Basic() {
    const m = D.useAgentForm({ name: "coder", inst, ctx });
    out.m = m;
    return h("section", null, h(D.AgentFields, { m, cat: "basic" }));
  }
  await p.mount(h(Basic, null));
  await settle(6);
  const $ = (sel: string) => p.root.querySelector(sel) as any;
  const $$ = (sel: string) => [...p.root.querySelectorAll(sel)] as any[];
  const click = async (sel: string) => { fire($(sel), "click"); await settle(6); };
  const toggle = async (sel: string) => { fire($(sel), "change"); await settle(6); };
  const type = async (sel: string, value: string) => { const el = $(sel); el.value = value; fire(el, "input"); await settle(6); };
  return { $, $$, click, toggle, type, patch: () => out.m.pending(), form: () => out.m.f };
}
const inst = { backend: "claude-code", working_directory: "/w" };
const FILE = `agend_export: 1
kind: agent
role: reviewer
agent:
  description: Reviews UI changes
  tags: [review, ui]
  systemPrompt: |
    # Role

    Be exact.
  model: claude-sonnet-5-5
  tool_set: coordinator
  working_directory: /elsewhere/place
  channel_id: discord
  skipPermissions: true
behavior:
  hang_detector: { timeout_minutes: 15 }
  tool_progress: verbose
library:
  skills: [{ ref: ui-review, version: 1 }]
  mcp: []
`;

describe("Load template", () => {
  it("the Basic info has the two buttons beside Agent instructions", async () => {
    const f = await basic(inst);
    expect(f.$("[data-template-load]")).toBeTruthy();
    expect(f.$("[data-template-export]")).toBeTruthy();
    expect(f.$("[data-load-text]")).toBeFalsy();
  });
  it("checks first: N filled, M skipped with the reasons — and changes nothing yet", async () => {
    const f = await basic(inst);
    await f.click("[data-template-load]");
    await f.type("[data-load-text]", FILE);
    expect(f.$("[data-load-fill]").disabled).toBe(true);
    await f.click("[data-load-check]");
    expect(calls).toEqual([{ url: "/ui/agent-export/parse", body: { text: FILE } }]);
    expect(f.$$("[data-fill]").map((e) => e.getAttribute("data-fill"))).toEqual(["description", "tags", "systemPrompt", "model", "tool_set", "hang_detector", "tool_progress"]);
    expect(f.$$("[data-skip]").map((e) => e.getAttribute("data-skip"))).toEqual(["agent.working_directory", "agent.channel_id", "agent.skipPermissions"]);
    expect(f.$("[data-load-library]")).toBeTruthy();
    expect(f.patch()).toEqual({});
  });
  it("Fill the form writes the values into the form: the patch is what Save stages (the excluded ones never appear)", async () => {
    const f = await basic(inst);
    await f.click("[data-template-load]");
    await f.type("[data-load-text]", FILE);
    await f.click("[data-load-check]");
    expect(f.$("[data-load-fill]").disabled).toBe(false);
    await f.click("[data-load-fill]");
    expect(f.$("[data-load-text]")).toBeFalsy();     // the dialog is closed
    expect(f.patch()).toEqual({
      description: "Reviews UI changes", systemPrompt: "# Role\n\nBe exact.\n", tags: ["review", "ui"], model: "claude-sonnet-5-5", tool_set: "coordinator",
      hang_detector: { timeout_minutes: 15 }, tool_progress: "verbose",
    });
    expect(f.$("#ag-sys").value).toBe("# Role\n\nBe exact.\n");
  });
  it("a file: reference in the Agent instructions is listed as skipped, and the form's text is left alone", async () => {
    const f = await basic({ ...inst, systemPrompt: "mine" });
    await f.click("[data-template-load]");
    await f.type("[data-load-text]", "agend_export: 1\nagent:\n  systemPrompt: file:~/.ssh/id_rsa\n  description: d\n");
    await f.click("[data-load-check]");
    expect(f.$$("[data-fill]").map((e) => e.getAttribute("data-fill"))).toEqual(["description"]);
    expect(f.$$("[data-skip]").map((e) => e.getAttribute("data-skip"))).toEqual(["agent.systemPrompt"]);
    await f.click("[data-load-fill]");
    expect(f.$("#ag-sys").value).toBe("mine");
  });
  it("a file that is not an export says why and fills nothing", async () => {
    const f = await basic(inst);
    await f.click("[data-template-load]");
    await f.type("[data-load-text]", "description: hi");
    await f.click("[data-load-check]");
    expect(f.$("[data-load-error]")).toBeTruthy();
    expect(f.$("[data-load-fill]").disabled).toBe(true);
    await f.type("[data-load-text]", "description: hi\n");   // editing the text clears the old answer
    expect(f.$("[data-load-error]")).toBeFalsy();
  });
});

describe("Export", () => {
  const saved = { ...inst, description: "Reviews", systemPrompt: "# Role", model: "claude-sonnet-5-5", channel_id: "discord" };
  it("previews the file for the chosen groups and enables Copy and Download", async () => {
    const f = await basic(saved);
    await f.click("[data-template-export]");
    expect(calls[0]).toEqual({ url: "/ui/agent-export/build", body: { instance: "coder", include: ["identity", "systemPrompt", "runtime", "behavior"] } });
    const text: string = f.$("[data-export-preview]").value;
    expect(text).toContain("agend_export: 1");
    expect(text).toContain("model: claude-sonnet-5-5");
    expect(text).not.toContain("discord");
    expect(f.$("[data-export-download]").disabled).toBe(false);
    await f.toggle('[data-export-group="runtime"]');
    expect(calls.at(-1)!.body.include).toEqual(["identity", "systemPrompt", "behavior"]);
    expect(f.$("[data-export-preview]").value).not.toContain("model:");
  });
  it("a suspected secret blocks Copy and Download and names the field and line", async () => {
    const f = await basic({ ...saved, systemPrompt: `ok\nuse ${fake.anthropicKey()}` });
    await f.click("[data-template-export]");
    expect(f.$("[data-export-secret]").textContent).toContain("systemPrompt");
    expect(f.$("[data-export-download]").disabled).toBe(true);
    expect(f.$("[data-export-copy]").disabled).toBe(true);
    expect(f.$("[data-export-preview]").value).not.toContain(fake.anthropicKey().slice(0, 12));
    await f.toggle('[data-export-group="systemPrompt"]');       // turn the group off: nothing secret left
    expect(f.$("[data-export-secret]")).toBeFalsy();
    expect(f.$("[data-export-download]").disabled).toBe(false);
  });
});

describe("Export: what was left out is said beside the preview (AGEND-171)", () => {
  it("a file: Agent instructions with only that group chosen shows the note and offers nothing to copy; a text over the limit too", async () => {
    const f = await basic({ ...inst, systemPrompt: "file:prompts/dev.md" });
    await f.click("[data-template-export]");
    await f.toggle('[data-export-group="identity"]');
    await f.toggle('[data-export-group="runtime"]');
    await f.toggle('[data-export-group="behavior"]');            // Agent instructions is on by default
    expect(f.$('[data-export-omitted="fileRef"]')).toBeTruthy();
    expect(f.$("[data-export-download]").disabled).toBe(true);
    const g = await basic({ ...inst, description: "d", systemPrompt: "x".repeat(24001) });
    await g.click("[data-template-export]");
    expect(g.$('[data-export-omitted="tooLong"]')).toBeTruthy();
    expect(g.$("[data-export-download]").disabled).toBe(false);          // the rest of the file is still fine
    expect(g.$("[data-export-preview]").value).not.toContain("systemPrompt");
  });
});

describe("Load template in Chinese: the Agent instructions length is a translated string (AGEND-163 review)", () => {
  it("reads 字元, not a literal 'chars'", async () => {
    const i18n = await import("/assets/app-i18n.js");
    i18n.setLang("zh-TW");
    try {
      const f = await basic(inst);
      await f.click("[data-template-load]");
      await f.type("[data-load-text]", "agend_export: 1\nagent:\n  systemPrompt: '# Role'\n");
      await f.click("[data-load-check]");
      const row = f.$('[data-fill="systemPrompt"]').textContent;
      expect(row).toContain("字元");
      expect(row).not.toContain("chars");
    } finally { i18n.setLang("en"); }
  });
});

describe("applyFill", () => {
  it("a setting a file names stops following the default; the others keep following it", async () => {
    const f = await basic(inst);
    expect(f.form().inherit.tool_progress).toBe(true);
    await f.click("[data-template-load]");
    await f.type("[data-load-text]", "agend_export: 1\nbehavior:\n  tool_progress: verbose\n");
    await f.click("[data-load-check]");
    await f.click("[data-load-fill]");
    expect(f.form().inherit.tool_progress).toBe(false);
    expect(f.form().inherit.log_level).toBe(true);
    expect(f.patch()).toEqual({ tool_progress: "verbose" });
  });
});
