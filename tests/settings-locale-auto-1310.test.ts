/**
 * #1310: Settings → Defaults locale picker must have an "Auto (follow system)"
 * option that maps to *unset*. Without it the select falls to its first option
 * (en) and any unrelated defaults save writes locale: en, pinning the UI
 * language and disabling timezone auto-detect.
 *
 * The page's own code runs in a vm with a minimal DOM whose <select> behaves
 * like a browser's (its value is the selected option's, else the first option's).
 * The real Settings API save path exercises handleSettingsRequest directly.
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";

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

/** The locale picker: the select whose options include the "" (auto) value. */
const localePicker = (host: FakeEl) => {
  const found = host.all(e => e.tag === "select" && e.all(o => o.tag === "option").some(o => o.value === ""));
  expect(found, "locale picker (has auto option)").toHaveLength(1);
  return found[0]!;
};

const PAGE_HELPERS = () => [
  line("const el = (tag, attrs = {}, ...kids) =>"),
  line("const BACKENDS = ["),
  line("function select(value, options) {"),
  // #1294 + #1310: backend and locale pickers are page-level helpers next to select().
  slice("  /**\n   * The backend picker keeps", "  const impactText"),
  slice("  const hasOwn = ", "  function setValidation("),
  slice("  function setValidation(", "  function confirmAccessChange("),
];

function makeSandbox(extra: Record<string, unknown>) {
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
    channelIds: () => [], chById: () => null, chLabel: () => "",
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

async function general(defaults: Record<string, unknown>) {
  const host = new FakeEl("div");
  const { box, staged, sent } = makeSandbox({
    $: (id: string) => (id === "general" ? host : new FakeEl("div")),
    state: { fleet: { defaults, instances: {}, channels: [] }, classic: { defaults: {} } },
    channels: () => [],
  });
  vm.runInNewContext(
    [...PAGE_HELPERS(), slice("  function renderGeneral() {", "\n  // ── What's New ──"), "this.renderGeneral = renderGeneral;"].join("\n"),
    box,
  );
  (box.renderGeneral as () => void)();
  const save = host.all(e => e.tag === "button" && e.className === "primary")[0]!;
  const picker = localePicker(host);
  const review = async () => {
    staged.length = 0;
    await save.onclick!();
    const defaultsChange = staged.find(s => s.key === "defaults:fleet");
    if (!defaultsChange) return null;
    await defaultsChange.change.apply();
    return sent.at(-1)!;
  };
  return { picker, host, review };
}

// ── Settings API helpers ──────────────────────────────────────────────────────

function apiRequest(ctx: SettingsApiContext, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as EventEmitter & { method: string; headers: Record<string, string>; destroy(): void };
    req.method = "PUT";
    req.headers = {};
    req.destroy = () => undefined;
    let status = 0;
    const res = {
      writeHead(code: number) { status = code; },
      end(payload: string) { resolve({ status, body: JSON.parse(payload) as Record<string, unknown> }); },
    };
    try {
      expect(handleSettingsRequest(req as never, res as never, new URL("http://localhost/api/settings/fleet/defaults"), ctx)).toBe(true);
      queueMicrotask(() => {
        req.emit("data", Buffer.from(JSON.stringify(body)));
        req.emit("end");
      });
    } catch (err) { reject(err); }
  });
}

function makeApiCtx(initialDefaults: Record<string, unknown> = {}): { ctx: SettingsApiContext; defaults: Record<string, unknown> } {
  const defaults: Record<string, unknown> = { ...initialDefaults };
  const ctx = {
    fleetConfig: { defaults, instances: {} },
    getRawFleetConfig: () => ({}),
    saveFleetConfig: () => {},
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  } as unknown as SettingsApiContext;
  return { ctx, defaults };
}

// ── Page-code unit tests ──────────────────────────────────────────────────────

describe("localeSelect picker (#1310)", () => {
  it("locale unset: picker shows Auto as the selected option", async () => {
    const { picker } = await general({});
    expect(picker.value).toBe("");
    const opts = picker.all(o => o.tag === "option");
    expect(opts[0]!.value).toBe("");       // Auto first
    expect(opts[0]!.selected).toBe(true);  // and selected
  });

  it("locale unset + unrelated edit (log_level): PUT body has NO locale key", async () => {
    const { host, review } = await general({});
    const logLevel = host.all(e => e.tag === "select" && e.all(o => o.tag === "option").some(o => o.value === "warn"))[0]!;
    logLevel.value = "warn";
    const sent = await review();
    expect(sent).not.toBeNull();
    expect(Object.keys(sent!.body as object)).not.toContain("locale");
  });

  it("choose Auto (set → Auto): locale is sent as null so the server clears it", async () => {
    const { picker, review } = await general({ locale: "en" });
    expect(picker.value).toBe("en");
    picker.value = "";
    expect((await review())!.body).toMatchObject({ locale: null });
  });

  it("choose zh-TW: locale is set to zh-TW", async () => {
    const { picker, review } = await general({});
    picker.value = "zh-TW";
    expect((await review())!.body).toMatchObject({ locale: "zh-TW" });
  });

  it("existing explicit en + unrelated edit: locale is not in the PATCH (preserved)", async () => {
    const { host, picker, review } = await general({ locale: "en" });
    expect(picker.value).toBe("en");
    const logLevel = host.all(e => e.tag === "select" && e.all(o => o.tag === "option").some(o => o.value === "warn"))[0]!;
    logLevel.value = "warn";
    const sent = await review();
    expect(Object.keys(sent!.body as object)).not.toContain("locale");
    expect(sent!.body).toMatchObject({ log_level: "warn" });
  });

  it("unknown locale in fleet.yaml is kept selected until the user changes it", async () => {
    const { picker } = await general({ locale: "fr" });
    expect(picker.value).toBe("fr");
  });
});

// ── Real Settings API path ────────────────────────────────────────────────────

describe("Settings PUT /defaults locale → real API path (#1310)", () => {
  it("locale unset, unrelated edit: server does not set locale", async () => {
    const { ctx } = makeApiCtx({ log_level: "info" });
    const r = await apiRequest(ctx, { log_level: "warn" });
    expect(r.status).toBe(200);
    expect(ctx.fleetConfig!.defaults.locale).toBeUndefined();
  });

  it("locale:null clears an existing locale from defaults", async () => {
    const { ctx } = makeApiCtx({ locale: "en" });
    const r = await apiRequest(ctx, { locale: null });
    expect(r.status).toBe(200);
    expect(ctx.fleetConfig!.defaults.locale).toBeUndefined();
  });

  it("locale:zh-TW sets the locale", async () => {
    const { ctx } = makeApiCtx({});
    const r = await apiRequest(ctx, { locale: "zh-TW" });
    expect(r.status).toBe(200);
    expect(ctx.fleetConfig!.defaults.locale).toBe("zh-TW");
  });
});
