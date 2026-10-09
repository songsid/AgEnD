/**
 * #1310: Settings → Defaults locale picker must have an "Auto (follow system)" option that maps to *unset*. Without
 * it the select falls to its first option (en) and any unrelated defaults save writes locale: en, pinning the UI
 * language and disabling timezone auto-detect.
 *
 * #1408 step 3: the picker is the General section's, rendered in the mini DOM with a fake fetch for the server; the
 * save path is the panel's (the PUT it stages and Apply sends). The server side is the real settings API, as before.
 */
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";

interface Sent { method: string; path: string; body: any }
const schema = buildSettingsImpactSchema();
let p: AppPage;
let fleetDefaults: Record<string, unknown>;
let sent: Sent[] = [];

const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
  const method = init.method ?? "GET";
  sent.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
  const body = (() => {
    if (method !== "GET") return method === "POST" ? { id: "job-1", status: "done", targets: [] } : { ok: true };
    if (path === "/api/settings/schema") return schema;
    if (path === "/api/settings/fleet/raw") return { defaults: fleetDefaults, instances: {}, channels: [] };
    if (path === "/api/settings/classic") return { channels: {}, defaults: {} };
    if (path === "/api/settings/status-emojis") return { keys: [], builtins: { discord: {}, telegram: {} }, telegram_allowed: [], suggestions: [] };
    if (path === "/api/fleet") return { version: "2.1.12", instances: [] };
    return [];
  })();
  return { ok: true, status: 200, json: async () => body };
};

const realFetch = (globalThis as any).fetch;
beforeAll(() => {
  p = page({ url: "http://127.0.0.1:19280/settings" });
  (globalThis as any).fetch = fakeFetch;
});
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(() => {
  fleetDefaults = {}; sent = [];
  (globalThis as any).confirm = () => true;
  p.window.confirm = () => true;
});
afterEach(async () => {
  await p.unmount();
  const { resetOperation } = await import("/ui/js/settings-apply.js");
  const { resetConfirmations } = await import("/ui/js/settings-confirm.js");
  resetOperation(); resetConfirmations();
});

/** General, freshly read, with the defaults the test names. */
async function general(defaults: Record<string, unknown>) {
  fleetDefaults = defaults;
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.unmount();
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "general" }, navKey: "settings:general" }));
  await settle(12);
  const picker = p.root.querySelector("#g-locale")!;
  /** Review, then Apply: what the panel sends for the defaults (null when nothing differs). */
  const review = async () => {
    sent = [];
    fire(p.root.querySelectorAll("button").find((b: any) => b.textContent.trim() === "Review changes")!, "click");
    await settle();
    const region = p.root.querySelector("[role=region]");
    if (!region) return null;
    fire(region.querySelectorAll("button").find((b: any) => b.textContent.trim() === "Apply changes")!, "click");
    await settle();
    return sent.find(s => s.path === "/api/settings/fleet/defaults") ?? null;
  };
  const logLevel = () => p.root.querySelector("#g-ll")!;
  return { picker, review, logLevel };
}
const pick = async (el: any, value: string) => { el.value = value; fire(el, "change"); await settle(); };

describe("localeSelect picker (#1310)", () => {
  it("locale unset: picker shows Auto as the selected option", async () => {
    const { picker } = await general({});
    expect(picker.value).toBe("");
    const opts = picker.querySelectorAll("option");
    expect(opts[0]!.value).toBe("");       // Auto first
    expect(opts[0]!.textContent).toBe("Auto (follow system)");
    expect(opts.map((o: any) => o.value)).toEqual(["", "en", "zh-TW"]);
  });

  it("locale unset + unrelated edit (log_level): PUT body has NO locale key", async () => {
    const { logLevel, review } = await general({});
    await pick(logLevel(), "warn");
    const sentDefaults = await review();
    expect(sentDefaults).not.toBeNull();
    expect(Object.keys(sentDefaults!.body)).not.toContain("locale");
  });

  it("choose Auto (set → Auto): locale is sent as null so the server clears it", async () => {
    const { picker, review } = await general({ locale: "en" });
    expect(picker.value).toBe("en");
    await pick(picker, "");
    expect((await review())!.body).toMatchObject({ locale: null });
  });

  it("choose zh-TW: locale is set to zh-TW", async () => {
    const { picker, review } = await general({});
    await pick(picker, "zh-TW");
    expect((await review())!.body).toMatchObject({ locale: "zh-TW" });
  });

  it("existing explicit en + unrelated edit: locale is not in the PATCH (preserved)", async () => {
    const { picker, logLevel, review } = await general({ locale: "en" });
    expect(picker.value).toBe("en");
    await pick(logLevel(), "warn");
    const sentDefaults = await review();
    expect(Object.keys(sentDefaults!.body)).not.toContain("locale");
    expect(sentDefaults!.body).toMatchObject({ log_level: "warn" });
  });

  it("unknown locale in fleet.yaml is kept selected (and labelled) until the user changes it", async () => {
    const { picker } = await general({ locale: "fr" });
    expect(picker.value).toBe("fr");
    const kept = picker.querySelectorAll("option").find((o: any) => o.value === "fr");
    expect(kept).toBeTruthy();
    expect(kept.textContent).toBe("fr");
  });
});

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
