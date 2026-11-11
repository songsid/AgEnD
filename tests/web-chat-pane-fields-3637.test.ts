import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
let p: AppPage, fields: any, native: any;
beforeAll(async () => {
  p = page();
  (globalThis as any).fetch = vi.fn(async (url: string) => ({ ok: url.includes("status-emojis"), status: url.includes("status-emojis") ? 200 : 404,
    json: async () => url.endsWith("/status-emojis") ? { keys: ["received", "failed"], builtins: { discord: {}, telegram: {} } } : { entries: [], problems: [] } }));
  fields = await import("/ui/js/settings-dialogs.js"); native = await import("/ui/js/native-instance-settings.js");
});
afterEach(async () => p.unmount());
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
describe("two full Settings panes keep label and form ownership", () => {
  it.each(["fleet", "classic", "native"])("namespaces every %s control and changes only the intended form", async kind => {
    const forms: any[] = [];
    function Form({ n }: { n: number }) {
      const name = `agent-${n}`, inst = { backend: "claude-code", working_directory: "/rig", ...(kind === "native" ? { runtime: "windows" } : {}) };
      const ctx = { fleet: { defaults: {}, instances: { [name]: inst } }, schema: buildSettingsImpactSchema(), drafts: new Map(), staged: new Map(),
        channelType: () => "telegram", classicRuntime: () => ({ execution: "idle" }), stageAgent: vi.fn(), shortName: (s: string) => s, reload: vi.fn() };
      const m = kind === "classic" ? fields.useClassicForm({ room: { instanceName: name, key: name }, ctx })
        : kind === "native" ? native.useNativeForm({ name, inst, ctx }) : fields.useAgentForm({ name, inst, ctx });
      forms[n] = m;
      const Component = kind === "classic" ? fields.ClassicFields : kind === "native" ? native.NativeFields : fields.AgentFields;
      const cats = kind === "classic" ? fields.CLASSIC_CATEGORIES : kind === "native" ? native.NATIVE_CATEGORIES : fields.AGENT_CATEGORIES;
      return h("section", { "data-form": n }, cats.map((cat: string) => h(Component, { key: cat, m, cat, idPrefix: `pane-${n}-` })));
    }
    await p.mount(h("div", null, h(Form, { n: 0 }), h(Form, { n: 1 }))); await settle(5);
    const ids = [...p.root.querySelectorAll("[id]")].map((el: any) => el.id);
    expect(ids.length).toBeGreaterThan(3);
    expect(new Set(ids).size, ids.filter((id, n) => ids.indexOf(id) !== n).join(", ")).toBe(ids.length);
    for (const label of p.root.querySelectorAll("label[for]")) {
      const id = label.getAttribute("for");
      expect(id).toMatch(/^pane-[01]-/);
      expect(label.closest("[data-form]")?.querySelector(`[id="${id}"]`)).not.toBeNull();
    }
    const id = kind === "classic" ? "cl-ctx" : kind === "native" ? "ni-desc" : "ag-desc";
    const input = p.root.querySelector(`#pane-0-${id}`) as any;
    expect(input).not.toBeNull();
    input.value = kind === "classic" ? "9" : "Only this pane"; fire(input, "input"); await settle(3);
    expect(forms[0].pending()).toEqual(kind === "classic" ? { context_lines: 9 } : { description: "Only this pane" });
    expect(forms[1].pending()).toEqual({});
  });
});
