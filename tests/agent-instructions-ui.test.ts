/**
 * Agent instructions on an agent's Basic info: the editor of `systemPrompt` (what Settings used to call "System prompt"; same key,
 * same patch, same place in what the AI is told) — the Edit / Preview switch, the counter (characters and bytes, the 24,000 limit,
 * the Codex AGENTS.md note), `file:` references, and that Advanced no longer has it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { systemPromptParts } from "../src/prompt-file-ref.js";
// @ts-expect-error — a JS module of the app, with no types
import { agentForm, agentPatch } from "../src/ui/settings-model.js";
// @ts-expect-error — a JS module of the app, with no types
import { instructionsSize, INSTRUCTIONS_MAX_CHARS, CODEX_NOTE_BYTES, promptParts } from "../src/ui/agent-instructions-field.js";

let p: AppPage, D: any, G: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/ui/fleet/agent/coder" });
  (globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => null });
  D = await import("/ui/js/settings-dialogs.js");
  G = await import("/ui/js/agent-details-settings.js");
});
afterAll(() => p.restore());
afterEach(async () => { await p.unmount(); });

async function form(inst: Record<string, unknown>, cats: string[] = ["basic"]) {
  const out: { m?: any } = {};
  const ctx = { fleet: { defaults: {}, instances: { coder: inst } }, schema: buildSettingsImpactSchema(), stageAgent: vi.fn(), drafts: new Map(),
    channelType: () => "telegram", shortName: (n: string) => n, staged: new Map(), reload: vi.fn() };
  function Page() {
    const m = D.useAgentForm({ name: "coder", inst, ctx });
    out.m = m;
    return h("div", null, cats.map((cat) => h("section", { key: cat, "data-cat": cat }, h(D.AgentFields, { m, cat }))));
  }
  await p.unmount();
  await p.mount(h(Page, null));
  await settle(6);
  const $ = (sel: string) => p.root.querySelector(sel) as any;
  const edit = async (sel: string, value: string) => { const el = $(sel); el.value = value; fire(el, "input"); fire(el, "change"); await settle(3); };
  const click = async (sel: string) => { fire($(sel), "click"); await settle(3); };
  return { $, edit, click, patch: () => out.m.pending(), ready: () => out.m.ready };
}
const inst = { backend: "claude-code", working_directory: "/w" };

describe("the patch: systemPrompt's own key, as it always was", () => {
  it("an untouched form writes nothing, with or without a prompt already saved (text, several lines, or a file: reference)", async () => {
    expect((await form(inst)).patch()).toEqual({});
    expect((await form({ ...inst, systemPrompt: "# Role\nreview" })).patch()).toEqual({});
    expect((await form({ ...inst, systemPrompt: "file:prompts/dev.md, file:rules.md" })).patch()).toEqual({});
    expect((await form({ ...inst, systemPrompt: "x".repeat(INSTRUCTIONS_MAX_CHARS + 500) })).patch()).toEqual({});
  });
  it("typing writes exactly {systemPrompt} — no other key is added", async () => {
    const f = await form({ ...inst, description: "d" });
    await f.edit("#ag-sys", "# Role\n\nBe exact.");
    expect(f.patch()).toEqual({ systemPrompt: "# Role\n\nBe exact." });
    await f.edit("#ag-sys", "file:prompts/dev.md");
    expect(f.patch()).toEqual({ systemPrompt: "file:prompts/dev.md" });
    const g = await form({ ...inst, systemPrompt: "old text" });
    await g.edit("#ag-sys", "old text");
    expect(g.patch()).toEqual({});
  });
  it("the patch is what agentPatch always gave: the model's own function, not the field's", () => {
    const i = { ...inst, systemPrompt: "old" };
    const f = agentForm(i, {}, "coder");
    expect(agentPatch(f, i, {}, null, null)).toEqual({});
    f.systemPrompt = "new";
    expect(agentPatch(f, i, {}, null, null)).toEqual({ systemPrompt: "new" });
  });
  it("is Basic info's: the nav dot of that category; a Windows native agent keeps its own (Advanced)", () => {
    expect([...G.dirtyCategories("fleet", { systemPrompt: "x" })]).toEqual(["basic"]);
    expect([...G.dirtyCategories("native", { systemPrompt: "x" })]).toEqual(["adv"]);
  });
});

describe("where it lives", () => {
  it("is in Basic info only: titled Agent instructions, with its ⓘ saying it was the System prompt; Advanced no longer has it", async () => {
    const f = await form(inst, ["basic", "adv"]);
    expect(f.$('[data-cat="basic"] #ag-sys')).not.toBeNull();
    expect(f.$('[data-cat="adv"] #ag-sys')).toBeNull();
    expect(f.$('[data-cat="basic"]').textContent).toContain("Agent instructions");
    expect(f.$('[data-cat="basic"]').textContent).toContain("Formerly");
    expect(f.$('[data-cat="adv"]').textContent).not.toContain("System prompt");
    expect(p.root.querySelectorAll('[data-cat="basic"] .s-tipbtn').length).toBe(4);   // name, tags, description, agent instructions
  });
  it("a Windows agent in this form keeps the old field in Advanced, unchanged", async () => {
    const f = await form({ ...inst, runtime: "windows", native_agent_id: "12345678-1234-4321-abcd-123456789012" }, ["basic", "adv"]);
    expect(f.$('[data-cat="basic"] #ag-sys')).toBeNull();
    expect(f.$('[data-cat="adv"] #ag-sys')).not.toBeNull();
  });
});

describe("the field", () => {
  it("a counter in characters and bytes, and the Codex note", async () => {
    const f = await form(inst);
    expect(f.$("[data-instructions-size]").textContent).toContain("0 / 24,000 characters");
    expect(f.$("[data-instructions-codex]").textContent).toContain("32 KiB");
    await f.edit("#ag-sys", "héllo 你好");
    expect(f.$("[data-instructions-size]").textContent).toContain("8 / 24,000 characters");
    expect(f.$("[data-instructions-size]").textContent).toContain("13 bytes");
  });
  it("counts characters as the server does (UTF-16 length) and bytes as UTF-8", () => {
    expect(instructionsSize("abc")).toEqual({ chars: 3, bytes: 3 });
    expect(instructionsSize("你好")).toEqual({ chars: 2, bytes: 6 });
  });
  it("over 24,000 characters while editing: an error under the field and Save waits; at 24,000 it is fine", async () => {
    const f = await form(inst);
    await f.edit("#ag-sys", "x".repeat(INSTRUCTIONS_MAX_CHARS));
    expect(f.ready()).toBe(true);
    await f.edit("#ag-sys", "x".repeat(INSTRUCTIONS_MAX_CHARS + 1));
    expect(f.ready()).toBe(false);
    expect(f.$("[data-instructions-size]").textContent).toContain("24,001 characters");
    expect(f.$("[data-instructions-size]").getAttribute("role")).toBe("alert");
  });
  it("a prompt that was already longer than that and is left alone does not stop an unrelated Save", async () => {
    const long = "x".repeat(INSTRUCTIONS_MAX_CHARS + 500);
    const f = await form({ ...inst, systemPrompt: long, description: "d" });
    expect(f.ready()).toBe(true);
    expect(f.$("[data-instructions-size]").getAttribute("role")).toBeNull();
    await f.edit("#ag-desc", "e");
    expect(f.ready()).toBe(true);
    expect(f.patch()).toEqual({ description: "e" });
    await f.edit("#ag-sys", long + "y");
    expect(f.ready()).toBe(false);
  });
  it("past about 16 KiB the Codex note warns that the end may be cut", async () => {
    const f = await form(inst);
    await f.edit("#ag-sys", "x".repeat(CODEX_NOTE_BYTES + 1));
    expect(f.$("[data-instructions-codex]").textContent).toContain("may cut off");
    expect(f.$("[data-instructions-codex]").className).toContain("warning");
  });
});

describe("Preview", () => {
  it("shows the text through the chat's Markdown renderer (HTML in it stays text); Edit brings the draft back", async () => {
    const f = await form(inst);
    await f.edit("#ag-sys", "# Title\n\n- one\n- two\n\n<script>alert(1)</script>");
    await f.click('[data-instructions-mode="preview"]');
    expect(f.$("#ag-sys")).toBeNull();
    const html = f.$("[data-instructions-preview]").innerHTML as string;
    expect(html).toMatch(/<h1|<strong|Title/);
    expect(html).toContain("<li>");
    expect(html).not.toContain("<script>");
    await f.click('[data-instructions-mode="edit"]');
    expect(f.$("#ag-sys").value).toBe("# Title\n\n- one\n- two\n\n<script>alert(1)</script>");
    expect(f.patch()).toEqual({ systemPrompt: "# Title\n\n- one\n- two\n\n<script>alert(1)</script>" });   // switching only previews: nothing was staged by it
  });
  it("of nothing says so", async () => {
    const f = await form(inst);
    await f.click('[data-instructions-mode="preview"]');
    expect(f.$('[data-cat="basic"]').textContent).toContain("Nothing to preview");
  });
  it("a file: reference is shown as the file it names, not read and not drawn as text; inline parts between files are still Markdown", async () => {
    const f = await form({ ...inst, systemPrompt: "file:prompts/dev.md, **be brief**, file:~/rules.md" });
    await f.click('[data-instructions-mode="preview"]');
    const files = [...p.root.querySelectorAll("[data-instructions-file]")].map((e: any) => e.querySelector("code").textContent);
    expect(files).toEqual(["prompts/dev.md", "~/rules.md"]);
    expect(f.$("[data-instructions-preview]").innerHTML).toContain("<strong>");
    expect(f.$("[data-instructions-codex]").textContent).toContain("A file's text is added when the agent starts");
    expect(f.patch()).toEqual({});
  });
  it("commas alone do not make parts: a prompt with no file: is one text", async () => {
    const f = await form({ ...inst, systemPrompt: "You are Kuro, a careful reviewer, and you are brief." });
    await f.click('[data-instructions-mode="preview"]');
    expect(p.root.querySelectorAll("[data-instructions-file]").length).toBe(0);
    expect(f.$("[data-instructions-preview]").textContent).toContain("You are Kuro, a careful reviewer, and you are brief.");
  });
});

describe("the page reads a systemPrompt's parts as the daemon does", () => {
  const SAMPLES = ["", "plain", "a, b, c", "file:a.md", "file:a.md, file:b.md", "text, file:a.md, more text", "  file:a.md  ,  x ", "no file here, only commas", "file:", ",file:a.md,"];
  it.each(SAMPLES)("%j", (value) => { expect(promptParts(value)).toEqual(systemPromptParts(value)); });
});
