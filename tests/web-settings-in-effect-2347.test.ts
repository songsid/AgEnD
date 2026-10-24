/**
 * #2347 §10: every field shows the value actually in effect and where it comes from.
 * - Agent defaults: a default nobody set in fleet.yaml carries a "default" mark (gone once it is edited, absent when set).
 * - An agent's dialog: an inherited field says what it inherits ("Inherited: 30 min · change in Agent defaults"),
 *   marked "default" when Agent defaults do not set it either; the link goes to that field in Agent defaults.
 * - A ClassicBot room: inherits from ClassicBot defaults when they set it (the link goes there), else from Agent defaults.
 * - The model pickers' empty choice names the model it inherits.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

const schema = buildSettingsImpactSchema();
let p: AppPage;
const realFetch = (globalThis as any).fetch;
const RAW = {
  defaults: { backend: "codex", model: "gpt-5.5", auto_pause_after: 30, tool_progress: "standard" },
  instances: { "web-dev": { working_directory: "/w/web" } },
  channels: [{ id: "main", type: "discord", bot_token_env: "T", group_id: "1" }], web: {},
};
const CLASSIC = { defaults: { tool_progress: "verbose" }, channels: { c1: { name: "ops", instanceName: "ops-t1", channelId: "1", adapterId: "discord" } } };
const sent: Array<{ method: string; path: string; body: any }> = [];
const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
  const method = init.method ?? "GET";
  if (method !== "GET") sent.push({ method, path, body: init.body ? JSON.parse(init.body) : null });
  const body = (() => {
    if (method !== "GET") return { ok: true };
    if (path === "/api/settings/schema") return schema;
    if (path === "/api/settings/fleet/raw") return RAW;
    if (path === "/api/settings/classic") return CLASSIC;
    if (path === "/api/settings/connections") return [{ id: "main", token_present: true }];
    if (path === "/api/settings/status-emojis") return { keys: [], builtins: { discord: {}, telegram: {} }, telegram_allowed: [], suggestions: [] };
    if (path === "/api/settings/pending") return [];
    if (path === "/api/fleet") return { version: "2.4.0", instances: [{ name: "web-dev", status: "running" }] };
    if (path.startsWith("/ui/")) return {};
    return [];
  })();
  return { ok: true, status: 200, json: async () => body };
};
let nav: any, req: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19283/settings", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  nav = await import("/assets/app-nav.js");
  // @ts-expect-error — a JS module of the app, with no types
  req = await import("../src/ui/settings-request.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(() => { (globalThis as any).confirm = () => true; });
afterEach(async () => { await p.unmount(); });

const open = async (section: string, key = section) => {
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section }, navKey: `settings:${section}|${key}` }));
  await settle(14);
};
const text = (el: any) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
/** The "Inherited: …" line of the field holding `id`. */
const inheritedOf = (id: string) => text(p.root.querySelector(`#${id}`)?.closest(".field")?.querySelector(".s-inherited"));
const marked = (id: string) => !!p.root.querySelector(`#${id}`)?.closest(".field, .check")?.querySelector(".s-default");

describe("#2347 §10: Agent defaults mark what nobody set", () => {
  it("unset keys carry \"default\"; keys fleet.yaml sets do not", async () => {
    await open("agent-defaults");
    expect(Object.fromEntries(["g-be", "g-model", "g-auto", "g-tp", "g-locale", "g-vis", "g-reply", "g-ts", "g-ll", "g-am", "g-hang", "g-conc", "g-stag"].map((id) => [id, marked(id)])))
      .toEqual({ "g-be": false, "g-model": false, "g-auto": false, "g-tp": false,
        "g-locale": true, "g-vis": true, "g-reply": true, "g-ts": true, "g-ll": true, "g-am": true, "g-hang": true, "g-conc": true, "g-stag": true });
  });
  it("Project folders left empty says new agents may work in any folder; listing one removes that line", async () => {
    await open("agent-defaults", "roots");
    const line = () => text(p.root.querySelector("#g-roots .s-effect"));
    const before = line();
    const input: any = p.root.querySelector("#g-roots input[type=text]");
    input.value = "/srv"; fire(input, "input"); await settle(2);
    p.root.querySelector("#g-roots").querySelectorAll("button").find((b: any) => b.textContent.includes("Add")).click(); await settle(4);
    expect([before, line()]).toEqual(["In effect: any folder default", null]);
  });
  it("review: startup concurrency left unset is automatic (2–10 by free memory and cores), not 10 — an empty field says so", async () => {
    await open("agent-defaults", "conc");
    const conc: any = p.root.querySelector("#g-conc");
    expect([conc.value, text(conc.closest(".field").querySelector(".s-effect"))])
      .toEqual(["", "In effect: automatic, 2–10 by free memory and CPU cores default"]);
  });
  it("review: saving another startup setting leaves concurrency automatic (the merge replaces startup whole: it is left out)", async () => {
    sent.length = 0;
    await open("agent-defaults", "stagger");
    const stag: any = p.root.querySelector("#g-stag");
    stag.value = "800"; fire(stag, "input"); await settle(4);
    p.root.querySelector(".s-pending").querySelectorAll("button").find((b: any) => b.textContent === "Save").click(); await settle(12);
    expect(sent.filter((x) => x.path === "/api/settings/fleet/defaults").map((x) => x.body)).toEqual([{ startup: { stagger_delay_ms: 800 } }]);
  });
  it("an edited default is no longer \"default\" (it is what the bar will save)", async () => {
    await open("agent-defaults", "edit");
    const input: any = p.root.querySelector("#g-hang");
    input.value = "15"; fire(input, "input"); await settle(4);
    expect([marked("g-hang"), marked("g-conc")]).toEqual([false, true]);
  });
});

describe("#2347 §10: an agent's inherited fields say what they inherit, and from where", () => {
  it("each inherited field: its value, \"default\" when Agent defaults do not set it either, and a link to it there", async () => {
    req.requestAgentSettings("web-dev");
    await open("agents", "web-dev");
    const dlg = p.root.querySelector("dialog");
    expect([inheritedOf("ag-be"), inheritedOf("ag-auto"), inheritedOf("ag-hang"), inheritedOf("ag-tool_progress"), inheritedOf("ag-log_level")])
      .toEqual(["Inherited: Codex · change in Agent defaults", "Inherited: 30 min · change in Agent defaults", "Inherited: 10 min default · change in Agent defaults",
        "Inherited: standard · change in Agent defaults", "Inherited: info default · change in Agent defaults"]);
    const links = ["ag-auto", "ag-hang", "ag-log_level"].map((id) => p.root.querySelector(`#${id}`).closest(".field").querySelector(".s-inherited a").getAttribute("href"));
    expect(links).toEqual(["/settings/agent-defaults#g-auto", "/settings/agent-defaults#g-hang", "/settings/agent-defaults#g-ll"]);
    // The model's empty choice names the model it inherits.
    expect(text(dlg.querySelectorAll("#ag-model option")[0])).toBe("inherit (gpt-5.5)");
  });
  it("an override (Inherit unticked) has no inherited line", async () => {
    req.requestAgentSettings("web-dev");
    await open("agents", "web-dev-2");
    const tick: any = p.root.querySelector("#ag-auto").closest(".override").querySelector(".inherit-row input");
    tick.checked = false; fire(tick, "change"); await settle(4);
    expect(inheritedOf("ag-auto")).toBeNull();
  });
  it("the link goes to that field in Agent defaults — in the Advanced drawer, which opens for it", async () => {
    req.requestAgentSettings("web-dev");
    await open("agents", "web-dev-3");
    p.root.querySelector("#ag-hang").closest(".field").querySelector(".s-inherited a").click(); await settle(4);
    const path = p.window.location.pathname;
    await p.unmount();
    (globalThis as any).location = p.window.location;
    await open("agent-defaults", "from-link");
    await settle(6);
    const drawer = p.root.querySelector("#g-hang").closest("details");
    expect([path, drawer.open, p.document.activeElement?.id]).toEqual(["/settings/agent-defaults", true, "g-hang"]);
    nav.navigate("/settings");
  });
});

describe("#2347 §10: a ClassicBot room inherits from ClassicBot defaults first", () => {
  it("set in ClassicBot defaults: from there; else from Agent defaults; else \"default\"", async () => {
    req.requestAgentSettings("ops-t1", "classic");
    await open("chat", "ops");
    const link = (id: string) => p.root.querySelector(`#${id}`).closest(".field").querySelector(".s-inherited a").getAttribute("href");
    expect([inheritedOf("cl-tp"), link("cl-tp"), inheritedOf("cl-auto"), link("cl-auto"), inheritedOf("cl-be")])
      .toEqual(["Inherited: verbose · change in ClassicBot defaults", "/settings/chat#g-ctp", "Inherited: 30 min · change in Agent defaults", "/settings/agent-defaults#g-auto",
        "Inherited: Codex · change in Agent defaults"]);
    expect(text(p.root.querySelectorAll("#cl-model option")[0])).toBe("inherit (gpt-5.5)");
    // Every inherited line, including built-in reply guard on and reply-trigger off.
    expect(p.root.querySelector("dialog").querySelectorAll(".s-inherited").map(text)).toEqual(["Inherited: Codex · change in Agent defaults",
      "Inherited: 30 min · change in Agent defaults", "Inherited: verbose · change in ClassicBot defaults", "Inherited: on default · change in Agent defaults", "Inherited: off default · change in Agent defaults"]);
  });
  it("ClassicBot defaults' own inherited fields say what they take from Agent defaults", async () => {
    await open("chat", "classic-defaults");
    expect([inheritedOf("g-cbe"), text(p.root.querySelector("#g-creply").closest(".field").querySelector(".s-inherited"))])
      .toEqual(["Inherited: Codex · change in Agent defaults", "Inherited: on default · change in Agent defaults"]);
  });
});

describe("#2347 §10: Advanced's read-only list", () => {
  it("review: the preview port is the host's at every web port — 0 stays ephemeral, past 65535 there is none", async () => {
    const { webReadOnlyDefault } = await import("/ui/js/panel-settings.js");
    const { previewSettings } = await import("../src/web-preview.js");
    const ports = [0, 1024, 19280, 65534, 65535];
    expect(ports.map((hp) => webReadOnlyDefault("web.preview_port", { health_port: hp }))).toEqual(ports.map((hp) => previewSettings({}, hp).port));
  });
  it("review: the upload limits are the ones uploadLimits applies (a file never above the whole message; out of range is the default)", async () => {
    const { uploadMbInEffect } = await import("/ui/js/panel-settings.js");
    const { uploadLimits } = await import("../src/web-upload.js");
    const MB = 1024 * 1024;
    const cases = [{}, { upload_max_total_mb: 10 }, { upload_max_file_mb: 60, upload_max_total_mb: 10 }, { upload_max_file_mb: 999 }, { upload_max_file_mb: 2.5 },
      { upload_max_total_mb: 0 }, { upload_max_file_mb: 80, upload_max_total_mb: 500 }, { upload_max_file_mb: "20" }];
    expect(cases.map((w) => uploadMbInEffect(w))).toEqual(cases.map((w) => { const l = uploadLimits(w as never); return { file: l.maxFileBytes / MB, total: l.maxTotalBytes / MB }; }));
  });
  it("every key it lists has the value the host uses when fleet.yaml leaves it out", async () => {
    const { WEB_READ_ONLY, webReadOnlyDefault } = await import("/ui/js/panel-settings.js");
    expect(WEB_READ_ONLY.filter((k: string) => webReadOnlyDefault(k, {}) === undefined)).toEqual([]);
    expect([webReadOnlyDefault("web.preview_port", {}), webReadOnlyDefault("web.preview_port", { health_port: 8000 })]).toEqual([19281, 8001]);
  });
  it("the defaults the page names are the host's own (uploads, sessions, the terminal, previews)", async () => {
    const { webReadOnlyDefault } = await import("/ui/js/panel-settings.js");
    const { UPLOAD_LIMITS } = await import("../src/web-upload.js");
    const { DEFAULT_SESSION_POLICY } = await import("../src/web-session.js");
    const { DEFAULT_WEB_TERMINAL_TTL_MINUTES } = await import("../src/login-controller.js");
    const { previewSettings } = await import("../src/web-preview.js");
    const MB = 1024 * 1024, HOUR = 3600_000;
    expect([webReadOnlyDefault("web.upload_max_file_mb", {}), webReadOnlyDefault("web.upload_max_total_mb", {}), webReadOnlyDefault("web.preview_port", { health_port: 19280 }),
      DEFAULT_SESSION_POLICY.local.absoluteMs / HOUR, DEFAULT_SESSION_POLICY.local.idleMs / HOUR, DEFAULT_WEB_TERMINAL_TTL_MINUTES])
      .toEqual([UPLOAD_LIMITS.maxFileBytes / MB, UPLOAD_LIMITS.maxTotalBytes / MB, previewSettings({}, 19280).port, 48, 48, 10]);   // 48 / 48 / 10: panel-settings' in-effect lines
  });
});
