/**
 * Settings → Shared agent settings (the page that was "Agent defaults"; its address and every `#g-…` anchor are unchanged):
 * - Two groups — what an individual agent may override, what the whole fleet shares — each with its rarer settings under
 *   Advanced; every field the old page had is still drawn, and writes the same key.
 * - A field says how many agents use its value and lists the ones that set their own, from fleet.yaml's instances.
 * - What an edit costs is shown only once a field is edited (from the schema, naming the agents it reaches and the ones it
 *   does not), disappears when the field is put back, and is added up on the Save bar. No badge is always there.
 * - The pure parts (usage, notes) and the words in both languages.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { pickSeg, segOptions, segValue } from "./helpers/settings-controls.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

const schema = buildSettingsImpactSchema();
let p: AppPage;
let raw: any;
/** What /api/fleet says about each agent (default: running). */
let status: Record<string, string> = {};
const sent: Array<{ method: string; path: string; body: any }> = [];
const realFetch = (globalThis as any).fetch;
/** Seven agents: artist sets its own model, tester its own tool set, ops its own dashboard permissions; General is one too. */
const fleet = () => ({
  defaults: { backend: "codex", model: "gpt-5.5", auto_pause_after: 30, tool_progress: "standard" },
  instances: {
    "dev-t1": { working_directory: "/w/dev" }, "reviewer-t2": { working_directory: "/w/rev" },
    "artist-t3": { working_directory: "/w/art", model: "gpt-5.5-mini" }, "tester-t4": { working_directory: "/w/test", tool_set: "minimal" },
    "ops-t5": { working_directory: "/w/ops", office_access: true }, general: { working_directory: "/w/g", general_topic: true },
  },
  channels: [{ id: "main", type: "discord", bot_token_env: "T", group_id: "1" }], web: {},
});
const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
  const method = init.method ?? "GET";
  if (method !== "GET") sent.push({ method, path, body: init.body ? JSON.parse(init.body) : null });
  const body = (() => {
    if (method !== "GET") return { ok: true };
    if (path === "/api/settings/schema") return schema;
    if (path === "/api/settings/fleet/raw") return raw;
    if (path === "/api/settings/classic") return { defaults: {}, channels: {} };
    if (path === "/api/settings/connections") return [{ id: "main", token_present: true }];
    if (path === "/api/settings/status-emojis") return { keys: [], builtins: { discord: {}, telegram: {} }, telegram_allowed: [], suggestions: [] };
    if (path === "/api/settings/pending") return [];
    if (path === "/api/fleet") return { version: "2.4.0", instances: Object.keys(raw.instances).map((name) => ({ name, status: status[name] ?? "running" })) };
    if (path.startsWith("/ui/")) return {};
    return [];
  })();
  return { ok: true, status: 200, json: async () => body };
};
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19284/settings", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  const nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(async () => {
  raw = fleet(); status = {}; sent.length = 0; (globalThis as any).confirm = () => true;
  (await import("/assets/app-i18n.js")).setLang("en");
});
afterEach(async () => { await p.unmount(); });

let opened = 0;
const open = async (section = "agent-defaults") => {
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section }, navKey: `settings:${section}|${++opened}` }));
  await settle(14);
};
const text = (el: any) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
const $ = (sel: string): any => p.root.querySelector(sel);
const field = (id: string): any => $(`#${id}`)?.closest(".field");
const type = async (id: string, value: string) => { const el = $(`#${id}`); el.value = value; fire(el, "input"); await settle(4); };
const check = async (el: any, on: boolean) => { el.checked = on; fire(el, "change"); await settle(4); };
const choose = async (id: string, value: string) => { const el = $(`#${id}`); el.value = value; fire(el, "change"); await settle(4); };
/** The pill at a field's right: "6/7 in use · artist custom". */
const pill = (id: string) => text(field(id)?.querySelector(".s-use .s-tipbtn"));
/** What hovering the pill says: the list of agents that set the field themselves. */
const pillTip = (id: string) => text(field(id)?.querySelector(".s-use .s-tipbody"));
const notes = (id: string) => (field(id)?.querySelectorAll(".s-note p") ?? []).map(text);
const bar = () => text($(".s-pending .note"));
const save = async () => {
  $(".s-pending").querySelectorAll("button").find((b: any) => b.textContent === "Save").click(); await settle(12);
};
const written = () => sent.filter((s) => s.path === "/api/settings/fleet/defaults").map((s) => s.body);

const IDS = ["g-locale", "g-be", "g-model", "g-auto", "g-tp", "g-vis", "g-tips", "g-reply-triggers", "g-reply", "g-dash", "g-ts", "g-ll", "g-am",
  "g-hang-on", "g-hang", "g-conc", "g-stag", "g-roots"];

describe("the page", () => {
  it("is Shared agent settings: a lead, then two groups, each again in Advanced", async () => {
    await open();
    expect(text($(".s-lead"))).toBe("Changes here apply to every agent that has no setting of its own — including agents you create later.");
    const cards = p.root.querySelectorAll(".s-group");
    expect(cards.map((c: any) => text(c.querySelector("h3")))).toEqual(["Shared agent settings", "System & channels", "Shared agent settings", "System & channels"]);
    expect(cards.map((c: any) => text(c.querySelector("p.note")))).toEqual(["An individual agent can override these", "One value for the whole fleet — an agent can't change it",
      "An individual agent can override these", "One value for the whole fleet — an agent can't change it"]);
    const drawer = $("details.drawer");
    expect(text(drawer.querySelector("summary"))).toBe("Advanced (10)");
    // The first two cards are the main view, the last two are in the drawer.
    expect(cards.map((c: any) => !!c.closest("details"))).toEqual([false, false, true, true]);
    expect(cards.map((c: any) => c.querySelectorAll(".field").length)).toEqual([4, 3, 7, 3]);
    expect(drawer.querySelectorAll(".field").length).toBe(10);
    expect(text($(".s-back-here") ?? $(".s-nav .active"))).toContain("Shared agent settings");
  });

  it("keeps every element id the old page had (the search and the jump links need them) and the YamlLock wrapper", async () => {
    await open();
    expect(IDS.filter((id) => !$(`#${id}`))).toEqual([]);
    expect($("#project-roots")).toBeTruthy();                       // /ui/fleet/config leads to /settings/agent-defaults#project-roots
    expect($(".s-general.s-part-fleet")).toBeTruthy();
    expect($(".s-general").closest("fieldset.s-yaml-lock")).toBeTruthy();   // the YamlLock wrapper: the fields wait while a fleet.yaml edit is unsaved
  });

  it("draws the choices as the issue says: segmented, switches, and a sentence per option for tool set and log level", async () => {
    await open();
    expect([segOptions($("#g-tp")), segOptions($("#g-vis")), segOptions($("#g-am"))]).toEqual([["off", "standard", "verbose"], ["full", "summary", "hidden"], ["mcp", "cli"]]);
    const names = (id: string) => $(`#${id}`).querySelectorAll(".s-seg-opt").map(text);
    expect([names("g-tp"), names("g-vis"), names("g-am")]).toEqual([["Off", "Standard", "Verbose"], ["Full", "Summary", "Hidden"], ["MCP (recommended)", "CLI"]]);
    for (const id of ["g-tips", "g-reply", "g-reply-triggers", "g-hang-on"]) expect([id, $(`#${id}`).type, $(`#${id}`).getAttribute("role")]).toEqual([id, "checkbox", "switch"]);
    const labels = (id: string) => $(`#${id}`).querySelectorAll("option").map((o: any) => text(o));
    expect(labels("g-ts")).toEqual(["Not set (worker; a General: general)", "Worker — talk, read, do the work", "Coordinator — worker plus fleet management",
      "Standard — a mid-sized set", "Minimal — only the basics", "Full — every tool"]);
    // The numbers of tools change with the tool profiles: no option says one.
    expect($("#g-ts").querySelectorAll("option").map(text).join(" ")).not.toMatch(/\d/);
    expect(labels("g-ll")).toEqual(["Trace — everything", "Debug — for troubleshooting", "Info — normal", "Warn — problems only", "Error — failures only"]);
    expect($("#g-ts").querySelectorAll("option").map((o: any) => o.value)).toEqual(["", "worker", "coordinator", "standard", "minimal", "full"]);
  });

  it("explains each field in an ⓘ (its words are in the page for a screen reader), and shows no permanent impact badge", async () => {
    await open();
    for (const id of IDS.filter((i) => i !== "g-hang")) {
      const head = $(`#${id}`).closest(".field")?.querySelector(".s-lab");
      expect(text(head?.querySelector(".s-i .s-tipbody")), id).toBeTruthy();
    }
    expect(text(field("g-reply-triggers").querySelector(".s-i .s-tipbody"))).toContain("Off by default");
    expect(p.root.querySelectorAll(".impact")).toHaveLength(0);
    expect($(".s-i .s-tipbtn").getAttribute("aria-label")).toMatch(/^About /);
  });

  it("opens a tip on hover or focus, closes it on leaving, and keeps it open once tapped until Escape", async () => {
    await open();
    const head = field("g-model").querySelector(".s-i");
    const [btn, body] = [head.querySelector(".s-tipbtn"), head.querySelector(".s-tipbody")];
    const shown = () => !body.hidden;
    // The mini DOM names a listener by the prop's own case (onMouseLeave → "mouseLeave"); a browser by the lower-case event.
    const leave = async () => { fire(btn, "mouseleave"); fire(btn, "mouseLeave"); await settle(2); };
    expect(shown()).toBe(false);
    fire(btn, "focus"); await settle(2);
    expect(shown()).toBe(true);
    fire(btn, "blur"); await settle(2);
    expect(shown()).toBe(false);
    fire(btn, "click"); await settle(2);                           // a tap pins it: leaving does not close it
    await leave();
    expect(shown()).toBe(true);
    fire(p.window.document, "keydown", { key: "Escape" }); await settle(2);
    expect(shown()).toBe(false);
    expect(btn.getAttribute("aria-describedby")).toBe(body.getAttribute("id"));
  });

  it("the “default” tip is on this page's marks only — the Agent dialog's marks are as they were", async () => {
    await open();
    const marks = p.root.querySelectorAll(".s-default");
    expect(marks.length).toBeGreaterThan(10);
    expect(marks.filter((m: any) => !m.getAttribute("title"))).toEqual([]);          // the field marks and the "in effect" ones too
    expect(marks[0].getAttribute("title")).toBe("Nobody set this in fleet.yaml, so the built-in value shown is in use. Editing it saves your own value.");
    await p.unmount();
    await open("agents");
    p.root.querySelectorAll("button").find((b: any) => b.textContent.trim() === "Settings").click(); await settle(8);
    const dialog = p.root.querySelector("dialog");
    const inDialog = dialog.querySelectorAll(".s-default");
    expect(inDialog.length).toBeGreaterThan(0);
    expect(inDialog.filter((m: any) => m.getAttribute("title"))).toEqual([]);
  });

  it("marks the backend as this host's and says why in a grey line — not a warning", async () => {
    await open();
    const be = field("g-be");
    expect(text(be.querySelector(".s-host"))).toBe("this host");
    expect(text(be.querySelector(".s-info"))).toContain("Only this host is checked. For a CLI on a Windows PC, choose it in that agent's own settings.");
    expect(be.querySelector(".feedback.warning, .tag.warn")).toBeNull();
  });

  it("says whether the reply guard works with the backend chosen, and follows it", async () => {
    await open();
    const line = () => text(field("g-reply").querySelector(".s-info"));
    expect(line()).toContain("Available for Claude Code, Codex, Muse and Kiro legacy/TUI in MCP mode.");
    await choose("g-be", "opencode");
    expect(line()).toBe("ⓘ Stored but inactive: opencode in mcp mode does not support reply-drop recovery.");
  });

  it("keeps the “default” mark: shown for what fleet.yaml leaves out, gone once the field is edited, back when it is put back", async () => {
    await open();
    const marked = (id: string) => !!field(id).querySelector(".s-default");
    expect([marked("g-be"), marked("g-locale"), marked("g-ll")]).toEqual([false, true, true]);
    await choose("g-ll", "warn");
    expect(marked("g-ll")).toBe(false);
    await choose("g-ll", "info");
    expect(marked("g-ll")).toBe(true);
  });
});

describe("who uses a field", () => {
  it("counts the agents that use this page's value, and names the ones that set their own", async () => {
    await open();
    expect([pill("g-be"), pill("g-model"), pill("g-ts"), pill("g-dash"), pill("g-auto")]).toEqual(["6/6 in use", "5/6 in use · artist custom", "5/6 in use · tester custom", "5/6 in use · ops custom", "6/6 in use"]);
    expect(pillTip("g-model")).toBe("Set on their own under Agents, so a change here does not reach them: artist.");
    expect(pillTip("g-be")).toBe("Every agent uses the value on this page.");
  });

  it("only the shared agent settings have a pill — the system and channel fields are the fleet's, not an agent's", async () => {
    await open();
    for (const id of ["g-locale", "g-tips", "g-roots", "g-hang-on", "g-conc", "g-stag"]) expect([id, pill(id)]).toEqual([id, null]);
  });

  it("a dashboard feature set to null (or a dashboard with no feature) is not the agent's own", async () => {
    raw = fleet();
    raw.instances["dev-t1"].dashboard = { task_board: null, appearance: undefined };
    raw.instances["reviewer-t2"].dashboard = {};
    raw.instances["writer-t6"] = { working_directory: "/w/w", dashboard: { task_board: false } };
    raw.instances["office-t7"] = { working_directory: "/w/o", office_pack_access: null };
    await open();
    expect(pill("g-dash")).toBe("6/8 in use · 2 agents custom");
    expect(pillTip("g-dash")).toContain("ops, writer");
  });

  it("with several overrides it says how many, and the hover lists them", async () => {
    raw = fleet(); raw.instances["dev-t1"].model = "x"; raw.instances["ops-t5"].model = "y";
    await open();
    expect(pill("g-model")).toBe("3/6 in use · 3 agents custom");
    expect(pillTip("g-model")).toContain("dev, artist, ops");
  });
});

describe("what an edit costs", () => {
  it("shows nothing until a field is edited — and nothing for a field that applies at once", async () => {
    await open();
    expect(p.root.querySelectorAll(".s-note")).toHaveLength(0);
    await pickSeg($("#g-tp"), "verbose");                          // tool progress is hot
    expect(p.root.querySelectorAll(".s-note")).toHaveLength(0);
    expect(bar()).toBe("Immediately");                              // …and the bar says so for a change with no words of its own
  });

  it("an agent restart names how many agents it reaches and which it does not — from the schema, not a fixed word", async () => {
    await open();
    await choose("g-model", "gpt-5.5-mini");
    expect(notes("g-model")).toEqual(["↻ After saving, 5 agent(s) restart (artist set their own — not affected)"]);
    expect(bar()).toBe("↻ 5 agent(s) restart after saving");
    expect(field("g-model").className).toContain("s-dirty");
  });

  it("puts the note away when the field is put back — and the Save bar with it", async () => {
    await open();
    const was = $("#g-model").value;
    await choose("g-model", "gpt-5.5-mini");
    expect(notes("g-model")).toHaveLength(1);
    await choose("g-model", was);
    expect(notes("g-model")).toEqual([]);
    expect($(".s-pending")).toBeNull();
    expect(field("g-model").className).not.toContain("s-dirty");
  });

  it("adds the costs of several edits on the bar, an agent reached twice counted once", async () => {
    await open();
    await choose("g-model", "gpt-5.5-mini");                       // reaches 5 (not artist)
    await choose("g-ts", "full");                                  // reaches 5 (not tester): together all 6
    expect(notes("g-ts")).toEqual(["↻ After saving, 5 agent(s) restart (tester set their own — not affected)"]);
    expect(bar()).toBe("↻ 6 agent(s) restart after saving");
  });

  it("a fleet restart (the language) says AgEnD restarts, not an agent", async () => {
    await open();
    await choose("g-locale", "zh-TW");
    expect(notes("g-locale")).toEqual(["↻ AgEnD has to restart for this to take effect"]);
    expect(bar()).toBe("↻ AgEnD restarts");
  });

  it("when every agent sets the field itself, nobody is affected — and it says so", async () => {
    raw = fleet(); for (const i of Object.values<any>(raw.instances)) i.model = "own";
    await open();
    await choose("g-model", "gpt-5.5-mini");
    expect(notes("g-model")).toEqual(["Every agent sets this on its own, so none is affected."]);
    expect(bar() ?? "").not.toContain("restart after saving");
  });

  it("with no agents yet, a new one starts from the value", async () => {
    raw = fleet(); raw.instances = {};
    await open();
    expect(pill("g-model")).toBeNull();
    await choose("g-model", "gpt-5.5-mini");
    expect(notes("g-model")).toEqual(["No agents yet — agents you create later start with this value."]);
  });

  it("every agent without its own value takes it, but only a running one restarts — the note says which", async () => {
    status = { "dev-t1": "stopped", "reviewer-t2": "paused" };
    await open();
    await choose("g-model", "gpt-5.5-mini");
    expect(notes("g-model")).toEqual(["↻ After saving, 5 agent(s) use the new value; the 3 running restart (artist set their own — not affected)"]);
    expect(bar()).toBe("↻ 5 agent(s) use the new value; the 3 running restart");
  });

  it("with no agent running, nothing restarts — and it does not say so", async () => {
    status = Object.fromEntries(Object.keys(fleet().instances).map((n) => [n, "stopped"]));
    await open();
    await choose("g-model", "gpt-5.5-mini");
    expect(notes("g-model")).toEqual(["After saving, 5 agent(s) use the new value; none is running, so none restarts (artist set their own — not affected)"]);
    expect(bar()).toBe("5 agent(s) use the new value; none is running");
    expect(`${notes("g-model")}${bar()}`).not.toMatch(/↻/);
  });

  it("the hang detector's switch and its minutes are counted apart: an agent that sets one still follows the other", async () => {
    raw = fleet();
    raw.instances["dev-t1"].hang_detector = { timeout_minutes: 5 };                // sets the minutes, inherits the switch
    raw.instances["reviewer-t2"].hang_detector = { enabled: false };                // sets the switch, inherits the minutes
    await open();
    expect(pill("g-hang-on")).toBeNull();                                           // no pill: it is the fleet's setting
    await check($("#g-hang-on"), false);                                            // the switch only: nobody who inherits it is left out
    expect(notes("g-hang-on")).toEqual(["↻ After saving, 5 agent(s) restart (reviewer set their own — not affected)"]);
    await check($("#g-hang-on"), true);
    await type("g-hang", "20");                                                     // the minutes only
    expect(notes("g-hang-on")).toEqual(["↻ After saving, 5 agent(s) restart (dev set their own — not affected)"]);
    await check($("#g-hang-on"), false);                                            // both: each agent is reached by one of them
    expect(notes("g-hang-on")).toEqual(["↻ After saving, 6 agent(s) restart"]);
    expect(bar()).toBe("↻ 6 agent(s) restart after saving");
  });

  it("an agent that sets both hang detector settings is left out of an edit to either", async () => {
    raw = fleet();
    raw.instances["dev-t1"].hang_detector = { enabled: true, timeout_minutes: 5 };
    await open();
    await check($("#g-hang-on"), false);
    expect(notes("g-hang-on")).toEqual(["↻ After saving, 5 agent(s) restart (dev set their own — not affected)"]);
    await type("g-hang", "20");
    expect(notes("g-hang-on")).toEqual(["↻ After saving, 5 agent(s) restart (dev set their own — not affected)"]);
  });

  it("project folders and a newly ticked dashboard feature say that someone must confirm; unticking says nothing", async () => {
    await open();
    $("#g-roots input[type=text]").value = "/srv"; fire($("#g-roots input[type=text]"), "input"); await settle(2);
    $("#g-roots").querySelectorAll("button").find((b: any) => b.textContent.includes("Add")).click(); await settle(4);
    expect(notes("g-roots")).toEqual(["A fleet admin has to confirm when you save"]);
    expect(bar()).toBe("A fleet admin has to confirm when you save");
    const boxes = $("#g-dash").querySelectorAll("input[type=checkbox]");
    await check(boxes[0], false);                                  // appearance was on: unticking applies at once
    expect(notes("g-dash")).toEqual([]);
    await check(boxes[3], true);                                   // office was off: ticking it is confirmed first
    expect(notes("g-dash")).toEqual(["Newly ticked items are confirmed first"]);
  });

  it("an invalid field shows its error, not a cost, and keeps Save away", async () => {
    await open();
    await type("g-conc", "25");
    expect(text(field("g-conc").querySelector(".feedback.error"))).toBeTruthy();
    expect(notes("g-conc")).toEqual([]);
    expect($(".s-pending .btn-primary").disabled).toBe(true);
    await type("g-conc", "6");
    expect(text(field("g-conc").querySelector(".feedback.warning"))).toBeTruthy();   // above 4 warns, and still saves
    expect($(".s-pending .btn-primary").disabled).toBe(false);
    await type("g-stag", "50");
    expect(text(field("g-stag").querySelector(".feedback.warning"))).toBeTruthy();
    await type("g-hang", "0");
    expect(text(field("g-hang-on").querySelector(".feedback.error"))).toBeTruthy();
    await type("g-auto", "-1");
    expect(text(field("g-auto").querySelector(".feedback.error"))).toBeTruthy();
  });
});

describe("what is written", () => {
  it("every field still writes its own key, and only the ones that changed", async () => {
    await open();
    await pickSeg($("#g-tp"), "verbose");
    await pickSeg($("#g-vis"), "hidden");
    await pickSeg($("#g-am"), "cli");
    await check($("#g-tips"), false);
    await check($("#g-reply"), false);
    await check($("#g-reply-triggers"), true);
    await choose("g-ts", "coordinator");
    await choose("g-ll", "debug");
    await choose("g-locale", "zh-TW");
    await choose("g-be", "claude-code");
    await type("g-auto", "10");
    await check($("#g-hang-on"), false);
    await type("g-hang", "20");
    await type("g-conc", "3");
    await type("g-stag", "700");
    await save();
    expect(written()).toEqual([{
      backend: "claude-code", locale: "zh-TW", auto_pause_after: 10, agent_mode: "cli", tool_set: "coordinator", tool_progress: "verbose",
      cross_instance_visibility: "hidden", tips: false, reply_triggers: true, reply_completion_guard: false, log_level: "debug",
      hang_detector: { enabled: false, timeout_minutes: 20 }, startup: { concurrency: 3, stagger_delay_ms: 700 },
    }]);
  });

  it("the dashboard permissions go whole; the two kept beside it only when they are edited, under their own keys", async () => {
    await open();
    const boxes = $("#g-dash").querySelectorAll("input[type=checkbox]");
    await check(boxes[0], false);
    await save();
    expect(written()).toEqual([{ dashboard: { appearance: false, task_board: true, web_settings: true } }]);   // office_access / office_pack_access: only when edited
  });

  it("project folders go through POST /ui/config", async () => {
    await open();
    $("#g-roots input[type=text]").value = "/srv"; fire($("#g-roots input[type=text]"), "input"); await settle(2);
    $("#g-roots").querySelectorAll("button").find((b: any) => b.textContent.includes("Add")).click(); await settle(4);
    await save();
    expect(sent.filter((s) => s.path === "/ui/config").map((s) => [s.method, s.body])).toEqual([["POST", { project_roots: ["/srv"] }]]);
  });

  it("ticking office on writes office_access under its own key", async () => {
    await open();
    await check($("#g-dash").querySelectorAll("input[type=checkbox]")[3], true);
    await save();
    expect(written()).toEqual([{ office_access: true }]);
  });

  it("a switch and a segmented choice shown on in an unset fleet read the built-in values", async () => {
    await open();
    expect([segValue($("#g-tp")), segValue($("#g-vis")), segValue($("#g-am")), $("#g-tips").checked, $("#g-reply").checked, $("#g-reply-triggers").checked, $("#g-hang-on").checked])
      .toEqual(["standard", "full", "mcp", true, true, false, true]);
  });
});

describe("the words", () => {
  it("are in zh-TW too: the name, the groups, the pills, a note and the bar", async () => {
    const { setLang } = await import("/assets/app-i18n.js");
    setLang("zh-TW");
    await open();
    expect(text($(".s-lead"))).toBe("改了會套用到所有沒有自己設定的 Agent，包括之後新建立的。");
    expect(p.root.querySelectorAll(".s-group").map((c: any) => text(c.querySelector("h3")))).toEqual(["Agent 共用設定", "系統與頻道", "Agent 共用設定", "系統與頻道"]);
    expect(text($("details.drawer summary"))).toBe("進階設定（10 項）");
    expect(pill("g-model")).toBe("5/6 套用中 · artist 自訂");
    expect($("#g-tp").querySelectorAll(".s-seg-opt").map(text)).toEqual(["關", "標準", "詳細"]);
    expect(text(field("g-be").querySelector(".s-info"))).toContain("只檢查這台主機。Windows 電腦上的 CLI，在個別 Agent 的設定裡選。");
    await choose("g-model", "gpt-5.5-mini");
    expect(notes("g-model")).toEqual(["↻ 儲存後，5 個 Agent 會重新啟動（artist 自訂，不受影響）"]);
    expect(text($(".s-pending .note"))).toBe("↻ 儲存後 5 個 Agent 會重新啟動");
    setLang("en");
  });
});
