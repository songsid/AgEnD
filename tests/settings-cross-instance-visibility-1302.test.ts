/**
 * #1302: the Settings page exposes `cross_instance_visibility` as a fleet default and as a per-instance override.
 * Nothing is written for a user who never touched it (the #1298 lesson): an unrelated edit leaves the key out of the
 * PATCH / PUT, even when fleet.yaml holds a value the picker cannot show. What the page sends goes through the real
 * settings API into a scratch fleet.yaml and comes back on the next load.
 *
 * The page's own code runs in a vm with a minimal DOM whose <select> behaves like a browser's (its value is the
 * selected option's, else the first option's). No server process, no fleet.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { crossInstanceVisibility } from "../src/cross-instance-notice.js";

const html = readFileSync(new URL("../src/ui/settings.html", import.meta.url), "utf8");
const slice = (from: string, to: string) => {
  const a = html.indexOf(from), b = html.indexOf(to, a);
  expect(a, from).toBeGreaterThan(-1); expect(b, to).toBeGreaterThan(a);
  return html.slice(a, b);
};
const line = (marker: string) => { const l = html.split("\n").find(x => x.includes(marker)); expect(l, marker).toBeTruthy(); return l!; };

class FakeEl {
  children: Array<FakeEl | string> = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<() => void>> = {};
  parent: FakeEl | null = null;
  className = ""; style: Record<string, string> = {};
  selected = false; checked = false; disabled = false; type = ""; open = false; hidden = false;
  onclick: (() => unknown) | null = null; onchange: (() => unknown) | null = null;
  classList = { toggle: () => {}, add: () => {}, remove: () => {} };
  private ownValue = "";
  constructor(public tag: string) {}
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
  fire(type: string) { for (const fn of this.listeners[type] ?? []) fn(); if (type === "change") this.onchange?.(); }
  all(pred: (e: FakeEl) => boolean): FakeEl[] {
    const out: FakeEl[] = [];
    for (const c of this.children) if (c instanceof FakeEl) { if (pred(c)) out.push(c); out.push(...c.all(pred)); }
    return out;
  }
  querySelector(sel: string) { const cls = sel.replace(/^\./, ""); return this.all(e => e.className.split(" ").includes(cls))[0] ?? null; }
}

/** The visibility picker: the select whose options are exactly the three modes. */
const pickerIn = (box: FakeEl) => {
  const found = box.all(e => e.tag === "select" && e.all(o => o.tag === "option").map(o => o.value).join() === "full,summary,hidden");
  expect(found).toHaveLength(1);
  return found[0]!;
};
/** The "inherit default" checkbox in the same row as the picker. */
const inheritToggleOf = (picker: FakeEl) => picker.parent!.all(e => e.tag === "input" && e.attrs.type === "checkbox")[0]!;

const PAGE_HELPERS = () => [
  line("const el = (tag, attrs = {}, ...kids) =>"),
  line("const BACKENDS = ["),
  line("function select(value, options) {"),
  // #1294: the backend pickers are built by backendSelect, a page-level helper next to select().
  slice("  /**\n   * The backend picker keeps", "  const impactText"),
  slice("  const hasOwn = ", "  function setValidation("),
  slice("  function setValidation(", "  function confirmAccessChange("),
];

function sandbox(extra: Record<string, unknown>) {
  const staged: Array<{ key: string; change: { apply(): Promise<unknown> } }> = [];
  const sent: Array<{ path: string; method: string; body: unknown }> = [];
  const box: Record<string, unknown> = {
    document: { createElement: (tag: string) => new FakeEl(tag) },
    t: (k: string) => k, tf: (k: string, ...v: unknown[]) => `${k}:${v.join(",")}`, esc: (s: string) => s,
    setTimeout, clearTimeout, structuredClone, confirm: () => true,
    api: async (path: string, opts: { method?: string; body?: string } = {}) => {
      if (opts.method) sent.push({ path, method: opts.method, body: JSON.parse(opts.body ?? "{}") });
      return { ok: true, status: 200, body: {} };
    },
    channelIds: () => ["tg"], chById: () => ({ id: "tg", type: "telegram" }), chLabel: () => "tg",
    chipList: () => new FakeEl("div"),
    drawer: (...kids: FakeEl[]) => { const d = new FakeEl("details"); d.append(...kids.slice(1)); return d; },
    impact: () => new FakeEl("span"), impactOf: () => "now", batchImpact: () => "now",
    shortName: (n: string) => n, renderAgents: () => {}, AGENT_MODAL_FIELDS: [],
    stageChange: (key: string, change: { apply(): Promise<unknown> }) => staged.push({ key, change }),
    statusEmojiEditor: () => ({ box: new FakeEl("div"), value: () => undefined, baseline: () => undefined, refresh: () => {} }),
    ...extra,
  };
  return { box, staged, sent };
}

async function agentForm(inst: Record<string, unknown>, defaults: Record<string, unknown> = {}) {
  const { box, staged, sent } = sandbox({ state: { fleet: { defaults, instances: { worker: inst }, channels: [{ id: "tg", type: "telegram" }] } } });
  vm.runInNewContext([...PAGE_HELPERS(), slice("  function agentEditForm(name, inst) {", "  /** Every field the agent modal shows"), "this.agentEditForm = agentEditForm;"].join("\n"), box);
  const form = (box.agentEditForm as (n: string, i: unknown) => { box: FakeEl; stage(): boolean })("worker", inst);
  await new Promise(r => setTimeout(r, 0));
  const patch = async () => {
    expect(form.stage()).toBe(true);
    await staged.at(-1)!.change.apply();
    return sent.at(-1)!;
  };
  return { form, picker: pickerIn(form.box), patch };
}

async function general(visibilityDefaults: Record<string, unknown>) {
  // The language picker has no "auto" option, so with `locale` unset it falls to its first option and a save writes
  // `locale: en` (a separate, older issue). A set locale keeps these tests about this one key.
  const defaults = { locale: "en", ...visibilityDefaults };
  const host = new FakeEl("div");
  const { box, staged, sent } = sandbox({
    $: (id: string) => (id === "general" ? host : new FakeEl("div")),
    state: { fleet: { defaults, instances: {}, channels: [] }, classic: { defaults: {} }, pending: new Map() },
    channels: () => [],
  });
  vm.runInNewContext([...PAGE_HELPERS(), slice("  function renderGeneral() {", "\n  // ── What's New ──"), "this.renderGeneral = renderGeneral;"].join("\n"), box);
  (box.renderGeneral as () => void)();
  const save = host.all(e => e.tag === "button" && e.className === "primary")[0]!;
  const review = async () => {
    staged.length = 0;
    await save.onclick!();
    const defaultsChange = staged.find(s => s.key === "defaults:fleet");
    if (!defaultsChange) return null;
    await defaultsChange.change.apply();
    return sent.at(-1)!;
  };
  const selects = host.all(e => e.tag === "select" && e.all(o => o.tag === "option").map(o => o.value).join() === "full,summary,hidden");
  expect(selects).toHaveLength(1);
  return { picker: selects[0]!, host, review };
}

const editDescription = (form: { box: FakeEl }, from: string) => {
  const desc = form.box.all(e => e.tag === "input" && e.value === from)[0]!;
  desc.value = "new desc"; desc.fire("input");
};

describe("the agent editor", () => {
  it("unset: shows the fleet default as inherited, and an unrelated edit sends nothing for it", async () => {
    const { form, picker, patch } = await agentForm({ working_directory: "/w", description: "old" }, { cross_instance_visibility: "summary" });
    expect(picker.value).toBe("summary");
    expect(picker.disabled).toBe(true);
    editDescription(form, "old");
    expect(await patch()).toEqual({ path: "/api/settings/fleet/instances/worker", method: "PATCH", body: { description: "new desc" } });
  });

  it("a value the picker cannot show (a typo in fleet.yaml) is not rewritten by an unrelated edit", async () => {
    const { form, picker, patch } = await agentForm({ working_directory: "/w", description: "old", cross_instance_visibility: "verbose" });
    expect(picker.value).toBe("full");                          // what the fleet does with it: unknown reads as unset
    editDescription(form, "old");
    expect((await patch()).body).toEqual({ description: "new desc" });
  });

  it("override, change and back to inherit", async () => {
    const set = await agentForm({ working_directory: "/w" });
    inheritToggleOf(set.picker).checked = false; inheritToggleOf(set.picker).fire("change");
    set.picker.value = "hidden"; set.picker.fire("change");
    expect((await set.patch()).body).toEqual({ cross_instance_visibility: "hidden" });

    const change = await agentForm({ working_directory: "/w", cross_instance_visibility: "hidden" });
    expect(change.picker.value).toBe("hidden");
    expect(change.picker.disabled).toBe(false);
    change.picker.value = "summary"; change.picker.fire("change");
    expect((await change.patch()).body).toEqual({ cross_instance_visibility: "summary" });

    const inherit = await agentForm({ working_directory: "/w", cross_instance_visibility: "hidden" });
    inheritToggleOf(inherit.picker).checked = true; inheritToggleOf(inherit.picker).fire("change");
    expect((await inherit.patch()).body).toEqual({ cross_instance_visibility: null });
  });
});

describe("the fleet defaults", () => {
  it("unset: shows full, and saving other defaults sends nothing for it", async () => {
    const g = await general({ tool_progress: "off" });
    expect(g.picker.value).toBe("full");
    const toolProgress = g.host.all(e => e.tag === "select" && e.all(o => o.tag === "option").some(o => o.value === "verbose"))[0]!;
    toolProgress.value = "verbose";
    expect((await g.review())!.body).toEqual({ tool_progress: "verbose" });
  });

  it("untouched: nothing staged at all; a value the picker cannot show is left alone", async () => {
    expect(await (await general({})).review()).toBeNull();
    expect(await (await general({ cross_instance_visibility: "loud" })).review()).toBeNull();
    expect(await (await general({ cross_instance_visibility: "hidden" })).review()).toBeNull();
  });

  it("changed: one PUT with the new mode", async () => {
    const g = await general({ cross_instance_visibility: "hidden" });
    expect(g.picker.value).toBe("hidden");
    g.picker.value = "summary";
    expect(await g.review()).toEqual({ path: "/api/settings/fleet/defaults", method: "PUT", body: { cross_instance_visibility: "summary" } });
  });
});

describe("round trip through the settings API and fleet.yaml", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function request(fm: FleetManager, path: string, method = "GET", body?: unknown): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = new EventEmitter() as EventEmitter & { method: string; destroy(): void };
      req.method = method; req.destroy = () => undefined;
      let status = 0;
      const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(payload: string) { resolve({ status, body: JSON.parse(payload) }); } };
      try {
        expect(handleSettingsRequest(req as never, res as never, new URL(`http://localhost${path}`), fm as never)).toBe(true);
        if (body !== undefined) queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
      } catch (err) { reject(err); }
    });
  }

  it("what the page sends is saved, validated, read back raw, and survives a reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1302-settings-")); dirs.push(dir);
    const path = join(dir, "fleet.yaml");
    writeFileSync(path, `# header\ndefaults:\n  tool_progress: off\ninstances:\n  worker:\n    working_directory: ${dir}\n    topic_id: 5\n  other:\n    working_directory: ${dir}\n    topic_id: 6\n`);
    const fm = new FleetManager(dir);
    try {
      fm.loadConfig(path);
      expect((await request(fm, "/api/settings/fleet/defaults", "PUT", { cross_instance_visibility: "summary" })).status).toBe(200);
      expect((await request(fm, "/api/settings/fleet/instances/worker", "PATCH", { cross_instance_visibility: "hidden" })).status).toBe(200);
      expect((await request(fm, "/api/settings/fleet/instances/worker", "PATCH", { cross_instance_visibility: "loud" })).status).toBe(400);

      const raw = (await request(fm, "/api/settings/fleet/raw")).body;
      expect(raw.defaults.cross_instance_visibility).toBe("summary");
      expect(raw.instances.worker.cross_instance_visibility).toBe("hidden");
      expect(raw.instances.other).not.toHaveProperty("cross_instance_visibility");

      const reloaded = new FleetManager(dir);
      reloaded.loadConfig(path);
      expect(crossInstanceVisibility(reloaded.fleetConfig, "worker")).toBe("hidden");
      expect(crossInstanceVisibility(reloaded.fleetConfig, "other")).toBe("summary");
      expect(readFileSync(path, "utf8")).toContain("# header");

      // Back to inherit: null removes the override, it is not stored as null.
      expect((await request(fm, "/api/settings/fleet/instances/worker", "PATCH", { cross_instance_visibility: null })).status).toBe(200);
      expect(readFileSync(path, "utf8").match(/cross_instance_visibility/g)).toHaveLength(1);
      expect(crossInstanceVisibility(fm.fleetConfig, "worker")).toBe("summary");
      for (const f of [fm, reloaded]) { f.stormWindow.shutdown(); f.spawnGate.shutdown(); f.memoryPressure.stop(); }
    } catch (err) {
      fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); fm.memoryPressure.stop();
      throw err;
    }
  });
});
