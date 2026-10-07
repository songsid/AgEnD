/**
 * #1280 review (P2): with gemini-cli gone from the Settings backend list, an instance (or the fleet default) still
 * set to it showed a select with no matching option. A browser select then falls to its first option, so editing
 * only the description sent `backend: "claude-code"` too — the CLI and account changed without anyone choosing it.
 * The backend picker now keeps an unoffered current value selected until the user picks another.
 *
 * The page's own code runs in a vm with a minimal DOM whose <select> behaves like a browser's: its value is the
 * selected option's, else the first option's. No server, no fleet.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../src/ui/settings.html", import.meta.url), "utf8");
const slice = (from: string, to: string) => {
  const a = html.indexOf(from), b = html.indexOf(to, a);
  expect(a, from).toBeGreaterThan(-1); expect(b, to).toBeGreaterThan(a);
  return html.slice(a, b);
};

class FakeEl {
  children: Array<FakeEl | string> = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<() => void>> = {};
  parent: FakeEl | null = null;
  className = ""; style: Record<string, string> = {};
  selected = false; checked = false; disabled = false; type = "";
  private ownValue = "";
  constructor(public tag: string) {}
  /** A select's value is its selected option's, else its first option's — as in a browser. */
  get value(): string {
    if (this.tag !== "select") return this.ownValue;
    const options = this.all(e => e.tag === "option");
    return (options.find(o => o.selected) ?? options[0])?.value ?? "";
  }
  set value(v: string) {
    if (this.tag !== "select") { this.ownValue = String(v); return; }
    for (const o of this.all(e => e.tag === "option")) o.selected = o.value === String(v);
  }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); if (k === "value") this.value = String(v); if (k === "type") this.type = String(v); }
  getAttribute(k: string) { return this.attrs[k]; }
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn); }
  append(...kids: Array<FakeEl | string>) { for (const k of kids) { if (k instanceof FakeEl) k.parent = this; this.children.push(k); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  set innerHTML(_v: string) { this.children = []; }
  get textContent(): string { return this.children.map(c => typeof c === "string" ? c : c.textContent).join(""); }
  set textContent(v: string) { this.children = [String(v)]; }
  fire(type: string) { for (const fn of this.listeners[type] ?? []) fn(); }
  all(pred: (e: FakeEl) => boolean): FakeEl[] {
    const out: FakeEl[] = [];
    for (const c of this.children) if (c instanceof FakeEl) { if (pred(c)) out.push(c); out.push(...c.all(pred)); }
    return out;
  }
  querySelector(sel: string) { const cls = sel.replace(/^\./, ""); return this.all(e => e.className.split(" ").includes(cls))[0] ?? null; }
}

const BACKENDS_LINE = html.split("\n").find(l => l.includes("const BACKENDS = ["))!;
const EL_LINE = html.split("\n").find(l => l.includes("const el = (tag, attrs = {}, ...kids) =>"))!;
const PICKERS = slice("  /**\n   * The backend picker keeps", "  const impactText");
const CHANGED = slice("  function changedFields(", "  function overrideControl(");

function pageSandbox(extra: Record<string, unknown> = {}) {
  const sandbox: Record<string, unknown> = {
    document: { createElement: (tag: string) => new FakeEl(tag) },
    t: (k: string) => k, tf: (k: string, ...v: unknown[]) => `${k}:${v.join(",")}`, setTimeout, clearTimeout, ...extra,
  };
  return sandbox;
}

describe("the backend picker keeps a value it does not offer", () => {
  it("removed gemini-cli stays selected (and is labelled); an offered one is unchanged", () => {
    const sandbox = pageSandbox();
    vm.runInNewContext(`${EL_LINE}\n${BACKENDS_LINE}\nconst sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);\n${PICKERS}\n${CHANGED}\nthis.backendSelect = backendSelect; this.changedFields = changedFields; this.BACKENDS = BACKENDS;`, sandbox);
    const backendSelect = sandbox.backendSelect as (v: string) => FakeEl;
    const removed = backendSelect("gemini-cli");
    expect(removed.value).toBe("gemini-cli");
    expect(removed.all(e => e.tag === "option")[0]!.textContent).toBe("backendUnavailable:gemini-cli");
    expect(backendSelect("codex").value).toBe("codex");
    expect(backendSelect("codex").all(e => e.tag === "option").map(o => o.value)).toEqual(sandbox.BACKENDS);
  });

  it("fleet defaults: an unrelated edit leaves `backend` out of the defaults PATCH (renderGeneral's own comparison)", () => {
    const sandbox = pageSandbox();
    vm.runInNewContext(`${EL_LINE}\n${BACKENDS_LINE}\nconst sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);\n${PICKERS}\n${CHANGED}\nthis.backendSelect = backendSelect; this.changedFields = changedFields;`, sandbox);
    const { backendSelect, changedFields } = sandbox as { backendSelect: (v: string) => FakeEl; changedFields: (n: object, b: object) => object };
    const d = { backend: "gemini-cli", locale: "en" };
    const fBackend = backendSelect(d.backend || "claude-code");
    expect(changedFields({ backend: fBackend.value, locale: "zh-TW" }, { backend: d.backend || "claude-code", locale: d.locale })).toEqual({ locale: "zh-TW" });
    // renderGeneral builds both defaults pickers with backendSelect, so the above is what it sends.
    const general = slice("  function renderGeneral() {", "\n  }\n");
    expect(general).toContain('const fBackend = backendSelect(d.backend || "claude-code");');
    expect(general).toContain('const fClassicBackend = backendSelect(c.backend || d.backend || "claude-code");');
  });
});

describe("the agent editor (#1280 review): editing only the description of a gemini-cli instance", () => {
  it("stages a PATCH with the description and no backend", async () => {
    const staged: Array<{ key: string; change: any }> = [];
    const inst: Record<string, unknown> = { working_directory: "/w", channel_id: "dc", backend: "gemini-cli", description: "old desc" };
    const puts: Array<{ path: string; body: unknown }> = [];
    const sandbox = pageSandbox({
      api: async (path: string, opts: { body?: string } = {}) => {
        if (path.startsWith("/api/settings/fleet/instances/")) puts.push({ path, body: JSON.parse(opts.body ?? "{}") });
        return { ok: true, status: 200, body: {} };
      },
      state: { fleet: { defaults: {}, instances: { worker: inst }, channels: [{ id: "dc", type: "discord" }] }, schema: { order: ["now", "instance", "fleet"] } },
      channelIds: () => ["dc"], chById: () => ({ id: "dc", type: "discord" }),
      chipList: () => new FakeEl("div"), drawer: (...kids: FakeEl[]) => { const box = new FakeEl("details"); box.append(...kids.slice(1)); return box; },
      impact: () => new FakeEl("span"), impactOf: () => "instance", batchImpact: () => "instance",
      setValidation: () => true, shortName: (n: string) => n, renderAgents: () => {}, AGENT_MODAL_FIELDS: [],
      stageChange: (key: string, change: unknown) => staged.push({ key, change }),
      // Irrelevant here (it previews emojis over the API): unchanged, so it adds nothing to the PATCH.
      statusEmojiEditor: () => ({ box: new FakeEl("div"), value: () => undefined, baseline: () => undefined, refresh: () => {} }),
    });
    vm.runInNewContext([
      EL_LINE, BACKENDS_LINE, PICKERS,
      slice("  const hasOwn = ", "  function setValidation("),
      slice("  function agentEditForm(name, inst) {", "  /** Every field the agent modal shows"),
      "this.agentEditForm = agentEditForm;",
    ].join("\n"), sandbox);
    const form = (sandbox.agentEditForm as (n: string, i: unknown) => { box: FakeEl; stage(): boolean })("worker", inst);
    await new Promise(r => setTimeout(r, 0));
    const backendPicker = form.box.all(e => e.tag === "select").find(s => s.all(o => o.tag === "option").some(o => o.value === "gemini-cli"));
    expect(backendPicker?.value).toBe("gemini-cli");
    const desc = form.box.all(e => e.tag === "input" && e.value === "old desc")[0]!;
    desc.value = "new desc"; desc.fire("input");
    expect(form.stage()).toBe(true);
    await staged.at(-1)!.change.apply();
    expect(puts).toEqual([{ path: "/api/settings/fleet/instances/worker", body: { description: "new desc" } }]);
  });
});
