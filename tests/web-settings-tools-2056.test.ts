/**
 * #2056 A: General (and a coordinator or full profile) changes Settings → Web appearance for the user through the page's
 * own stores and checks — no second implementation, no bypass of custom CSS's safe rules. A worker keeps only its own
 * theme. Real stores on a scratch home (FleetManager, no fleet start).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agend-2056-home-"));
process.env.AGEND_HOME = home;                         // before the fleet's modules load (pino's daemon.log)

const { FleetManager } = await import("../src/fleet-manager.js");
const { OPERATOR } = await import("../src/web-prefs.js");
const { TOOL_PROFILES, resolveToolSet } = await import("../src/tool-permissions.js");
const { outboundHandlers } = await import("../src/outbound-handlers.js");
const { checkOwnerCss } = await import("../src/web-owner-css.js");
const { DEFAULT_PLACEMENTS } = await import("../src/web-identity-palette.js");

let fm: any, dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agend-2056-fleet-"));
  writeFileSync(join(dir, "fleet.yaml"), `web:\n  experimental:\n    canvas_worker: true\ninstances:\n  general:\n    working_directory: ${dir}\n    general_topic: true\n  alpha:\n    working_directory: ${dir}\n  beta:\n    working_directory: ${dir}\n`);
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  fm.loadConfig(join(dir, "fleet.yaml"));
  fm.getInstanceStatus = () => "running";
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
const set = (change: unknown, person?: string) => fm.webSettings.change(person, change);
const host = () => fm.webPrefs.read(OPERATOR).values as Record<string, unknown>;

describe("who may: General, coordinators and full profiles — never a worker or the lean profiles", () => {
  it("the profiles", () => {
    for (const p of ["general", "coordinator", "full"] as const) expect(["get_web_settings", "set_web_settings"].every((t) => TOOL_PROFILES[p].includes(t)), p).toBe(true);
    for (const p of ["worker", "standard", "minimal"] as const) expect(TOOL_PROFILES[p].some((t) => t === "get_web_settings" || t === "set_web_settings"), p).toBe(false);
    expect(resolveToolSet(fm.fleetConfig.instances.general, "general")).toBe("general");
    expect(resolveToolSet(fm.fleetConfig.instances.alpha, "alpha")).toBe("worker");
  });
});

describe("get_web_settings: the page in plain words", () => {
  it("defaults: a sentence per setting, the values, the people, and what only the person can do", () => {
    const r = fm.webSettings.read();
    expect(r.ok).toBe(true);
    expect(r.summary[0]).toBe("Agents' themes, widgets: shown.");
    expect(r.summary[1]).toBe(`Identity colours: shown on ${DEFAULT_PLACEMENTS.join(", ")} (the default).`);
    expect(r.summary.join("\n")).toContain("Custom CSS (the host operator): off");
    expect(r.host).toMatchObject({ themes_shown: true, card_size: "m", colour_places: [...DEFAULT_PLACEMENTS], colour_places_default: true, colours_off: false, sidebar_widget: null });
    expect(r.people[0]).toEqual({ person: OPERATOR, name: null });
    expect(r.agents.map((a: { name: string }) => a.name)).toEqual(["general", "alpha", "beta"]);
    expect(r.page_only.join(" ")).toContain("card upload limits");
  });
  it("a person who has signed in is named among the people, and their own custom CSS is theirs, not the operator's", () => {
    const alice = "person:discord-main:111111111111111111";
    fm.webPrefs.setPlatformName(alice, "Alice");
    expect(fm.webSettings.read().people).toContainEqual({ person: alice, name: "Alice" });
    expect(set({ what: "custom_css", action: "save", text: "body { outline: 1px solid #123456 }" }, alice)).toMatchObject({ ok: true, on_trial: true });
    expect([fm.ownerCss.state(alice).pending !== null, fm.ownerCss.state(OPERATOR).pending]).toEqual([true, null]);
    expect(set({ what: "custom_css", action: "revert" }, alice)).toMatchObject({ ok: true });
  });
  it("an unknown person is refused, never invented", () => {
    expect(fm.webSettings.read("person:discord:999")).toEqual({ ok: false, error: "unknown_person", detail: "name one of get_web_settings' people" });
    expect(set({ what: "restore_defaults" }, "person:discord:999")).toMatchObject({ ok: false, error: "unknown_person" });
  });
});

describe("set_web_settings: as the page changes it", () => {
  it("host settings: stored as the page stores them (its default as unset), announced; the page's check refuses a bad value", () => {
    const status = vi.spyOn(fm, "emitSseEvent");
    expect(set({ what: "host", set: { themes_shown: false, card_size: "l", colours_off: true, colour_places: ["ring"] } })).toMatchObject({ ok: true });
    expect(host()).toMatchObject({ "fx.show": false, "card.size": "l", "color.off": true, "color.show": ["ring"] });
    expect(fm.webSettings.read().summary.slice(0, 2)).toEqual(["Agents' themes, widgets: hidden (every chat looks the same).", "Identity colours: turned off on this host."]);
    expect(status).toHaveBeenCalledWith("status", expect.anything());
    expect(set({ what: "host", set: { themes_shown: true, card_size: "m", colours_off: false, colour_places: [...DEFAULT_PLACEMENTS].reverse() } })).toMatchObject({ ok: true });
    expect(["fx.show", "card.size", "color.off", "color.show"].map((k) => Object.hasOwn(host(), k))).toEqual([false, false, false, false]);
    // The same check as POST /ui/prefs: the page's own error.
    const pageError = fm.webPrefs.parsePatch({ "card.size": "xl" });
    expect(set({ what: "host", set: { card_size: "xl" } })).toEqual({ ok: false, error: "prefs", detail: pageError.error });
    expect(set({ what: "host", set: { lasers: true } })).toMatchObject({ ok: false, error: "host" });
    status.mockRestore();
  });
  it("the sidebar widget: the same widget checker as the page (and as agents' widgets)", () => {
    const widget = { spec: { v: 1, title: "Fleet", items: [{ type: "stat", label: "Working", bind: "fleet.working" }] }, data: {} };
    expect(set({ what: "host", set: { sidebar_widget: widget } })).toMatchObject({ ok: true });
    expect((host()["widget.sidebar"] as { spec: { title: string } }).spec.title).toBe("Fleet");
    const bad = { spec: { v: 1, title: "x", items: [{ type: "html", label: "<b>" }] }, data: {} };
    const r = set({ what: "host", set: { sidebar_widget: bad } });
    expect(r).toEqual({ ok: false, error: "prefs", detail: fm.webPrefs.parsePatch({ "widget.sidebar": bad }).error });
    expect(set({ what: "host", set: { sidebar_widget: null } })).toMatchObject({ ok: true });
    expect(Object.hasOwn(host(), "widget.sidebar")).toBe(false);
  });
  it("an agent's colour: the Colour dialog's write (checked first), read back as the dialog reads it; reset with null", () => {
    expect(set({ what: "agent_colour", instance: "alpha", colour: "preset:teal", places: ["name"] })).toMatchObject({ ok: true, instance: "alpha", color: "preset:teal", show: ["name"] });
    expect(fm.webSettings.read().summary.join("\n")).toContain("alpha (preset:teal, on name)");
    expect(set({ what: "agent_colour", instance: "alpha", colour: "#zz0000" })).toMatchObject({ ok: false });
    expect(fm.webSettings.read().agents.find((a: { name: string }) => a.name === "alpha")).toMatchObject({ color: "preset:teal" });   // nothing written
    expect(set({ what: "agent_colour", instance: "alpha", colour: null, places: null })).toMatchObject({ ok: true, color: null, show: null });
    expect(set({ what: "agent_colour", instance: "nobody", colour: "preset:teal" })).toEqual({ ok: false, error: "unknown_instance" });
  });
  it("#2196 page colours: one agent's (page / chat / agent: its own) kept with the host's prefs, another's untouched; read back", () => {
    expect(set({ what: "page_colours", instance: "alpha", choice: "chat" })).toEqual({ ok: true, instance: "alpha", choice: "chat" });
    expect(set({ what: "page_colours", instance: "beta", choice: "page" })).toMatchObject({ ok: true });
    expect(host()["theme.pageByInstance"]).toEqual({ alpha: "chat", beta: "page" });
    expect(fm.webSettings.read().host.page_colours).toEqual({ alpha: "chat", beta: "page" });
    expect(fm.webSettings.read().summary.join("\n")).toContain("Page colours a person chose: alpha only its chat, beta on the whole page.");
    expect(set({ what: "page_colours", instance: "alpha", choice: "agent" })).toMatchObject({ ok: true });
    expect(host()["theme.pageByInstance"]).toEqual({ beta: "page" });
    expect([set({ what: "page_colours", instance: "nobody", choice: "page" }), set({ what: "page_colours", instance: "beta", choice: "on" })])
      .toEqual([{ ok: false, error: "unknown_instance" }, { ok: false, error: "page_colours", detail: "choice: agent (its own), page (the whole page) or chat (only its chat)" }]);
    expect(set({ what: "page_colours", instance: "beta", choice: "agent" })).toMatchObject({ ok: true });
    expect(Object.hasOwn(host(), "theme.pageByInstance")).toBe(false);                       // the last one gone: unset
  });
  it("#2198: General's save waits for the person's page; with a ~40 s chat round trip after the page showed it, keep succeeds (put back in force)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-19T10:00:00Z"));
      const r = set({ what: "custom_css", action: "save", text: "body { outline: 4px solid #ff00ff }" });
      expect(r).toMatchObject({ ok: true, on_trial: true, trial: expect.stringMatching(/^[a-f0-9]{32}$/) });
      expect(String(r.note)).toMatch(/waits until they open the dashboard/);
      expect(String(r.note)).toMatch(/20 s after it is on their screen/);
      const pending = fm.ownerCss.state(OPERATOR).pending;
      expect(pending).toMatchObject({ waiting: true });
      vi.setSystemTime(new Date("2026-10-19T10:03:00Z"));                // they open the dashboard 3 minutes later
      expect(fm.ownerCss.shown(OPERATOR, pending.id)).toMatchObject({ ok: true, started: true });
      vi.setSystemTime(new Date("2026-10-19T10:03:40Z"));                // "keep it" reaches General 40 s later
      expect(fm.ownerCss.state(OPERATOR).pending, "the dead-man switch reverted it at 20 s").toBeNull();
      expect(set({ what: "custom_css", action: "keep" }), "keep names its trial").toMatchObject({ ok: false, error: "trial" });
      const kept = set({ what: "custom_css", action: "keep", trial: r.trial });
      expect(kept).toMatchObject({ ok: true, active: pending.sha });
      expect(String(kept.note)).toMatch(/in force again/);
      expect(fm.ownerCss.state(OPERATOR)).toMatchObject({ active: pending.sha, pending: null });
      const none = set({ what: "custom_css", action: "keep", trial: r.trial });
      expect(none).toMatchObject({ ok: false, error: "not_on_trial" });
      expect(JSON.stringify(none)).toMatch(/use/);
      set({ what: "custom_css", action: "off" });
    } finally { vi.useRealTimers(); }
  });
  it("custom CSS: the same safe rules (no bypass); a tool saves on trial, keeps or reverts it, uses an earlier version, turns it off", () => {
    const remote = "body { background: url(https://example.com/x.png) }";
    expect(checkOwnerCss(remote, new Set()).ok).toBe(false);
    expect(set({ what: "custom_css", action: "save", text: remote })).toMatchObject({ ok: false });
    expect(fm.ownerCss.state(OPERATOR).active).toBeNull();
    expect(set({ what: "custom_css", action: "save", text: "body { outline: 2px solid #ff0000 }" })).toMatchObject({ ok: true, on_trial: true });
    const trial = fm.ownerCss.state(OPERATOR).pending;
    expect(trial).not.toBeNull();
    // The user's decision (2026-10-18): General keeps it too — the page's Keep, the store's own check.
    expect(set({ what: "custom_css", action: "revert" })).toMatchObject({ ok: true, active: null });
    expect(fm.ownerCss.state(OPERATOR).pending).toBeNull();
    // #2198: reverted on purpose, it is not kept back (only one that expired by itself is); the answer points at use.
    expect(set({ what: "custom_css", action: "keep", trial: trial.id }), "nothing on trial").toMatchObject({ ok: false, error: "not_on_trial" });
    const saved1 = set({ what: "custom_css", action: "save", text: "body { outline: 1px solid #0000ff }" });
    const first = fm.ownerCss.state(OPERATOR).pending.sha;
    expect(set({ what: "custom_css", action: "keep", trial: saved1.trial })).toMatchObject({ ok: true, active: first });
    expect(fm.ownerCss.state(OPERATOR)).toMatchObject({ active: first, pending: null });
    const saved2 = set({ what: "custom_css", action: "save", text: "body { outline: 3px solid #00ff00 }" });
    expect(fm.webSettings.read().custom_css.trial, "get_web_settings names the trial on now").toBe(saved2.trial);
    // #2198 follow-up: a newer trial on now (theirs, from the page) is not kept in place of the one General saved.
    expect(set({ what: "custom_css", action: "keep", trial: saved1.trial })).toMatchObject({ ok: false, error: "trial_mismatch" });
    expect(fm.ownerCss.state(OPERATOR).pending?.id).toBe(saved2.trial);
    set({ what: "custom_css", action: "keep", trial: saved2.trial });
    expect(fm.webSettings.read().custom_css.trial).toBeNull();
    // An earlier version: only one the person's store holds (each passed the safe rules when saved).
    expect(set({ what: "custom_css", action: "use", version: first })).toMatchObject({ ok: true, active: first });
    expect(set({ what: "custom_css", action: "use", version: "f".repeat(32) })).toMatchObject({ ok: false, error: "no_such_version" });
    expect(set({ what: "custom_css", action: "use", version: "not a sha" })).toMatchObject({ ok: false, error: "sha" });
    expect(fm.ownerCss.state(OPERATOR).active).toBe(first);
    expect(set({ what: "custom_css", action: "off" })).toMatchObject({ ok: true, active: null });
    expect(set({ what: "custom_css", action: "lasers" })).toMatchObject({ ok: false, error: "custom_css" });
    expect(fm.webSettings.read().page_only.join(" "), "keep and use are no longer the person's alone").not.toMatch(/keep|earlier/i);
  });
  it("the skills General loads say the same: keep and use are its own, after the user says so (Prism #2081)", () => {
    for (const skill of ["web-appearance", "web-dashboard"]) {
      const text = readFileSync(join("src", "general-knowledge", "skills", skill, "SKILL.md"), "utf8");
      expect(text, skill).not.toContain("custom_css_person_only");
      expect(text, skill).not.toMatch(/keeping a (?:custom )?CSS trial,? or switch(?:ing)? to an earlier/i);
    }
    // #2198: keep also puts back the version that just went back (as use of it); revert and use as before.
    const appearance = readFileSync("src/general-knowledge/skills/web-appearance/SKILL.md", "utf8");
    expect(appearance).toContain("`keep` (with `trial`: the id `save` returned — a different trial on now, say one they saved on their page since, is refused with `trial_mismatch`, never kept instead; or, kept after that 20 s ran out, it is put back in force as `use` of it), `revert` (the trial), `use` (with `version`");
    expect(appearance).toContain("waits until they open the dashboard");
    expect(readFileSync("src/general-knowledge/skills/web-dashboard/SKILL.md", "utf8")).toContain("keep or revert\nthe trial, switch to an earlier saved version");
  });
  // #2799: the fleet.yaml above still says canvas_worker: true (an old one loads); the effects, effect slots and mods
  // these changes reached were removed with them.
  it("#2799: an effect, an effect slot or a mod change is refused, whatever the config says", () => {
    for (const change of [{ what: "effect_slot", slot: "sidebar", id: "f".repeat(32) }, { what: "effect", action: "remove", instance: "alpha" },
      { what: "mod", action: "review", instance: "alpha" }]) {
      expect(set(change), change.what).toMatchObject({ ok: false, error: "experimental_feature_disabled", detail: "Canvas Worker effects were removed; ambient effects are still available" });
    }
    const r = fm.webSettings.read();
    expect(["mods", "effect_slots"].some((k) => Object.hasOwn(r, k)), "no mods or effect slots in the read").toBe(false);
    expect(r.agents.some((a: Record<string, unknown>) => Object.hasOwn(a, "effects"))).toBe(false);
  });
  it("Restore defaults: the host settings the page resets, and the person's custom CSS off", () => {
    set({ what: "host", set: { themes_shown: false, card_size: "s", colours_off: true } });
    set({ what: "custom_css", action: "save", text: "body { outline: 1px solid #00ff00 }" });
    fm.ownerCss.keep(OPERATOR, fm.ownerCss.state(OPERATOR).pending.id);                    // the person's click on the page
    expect(set({ what: "restore_defaults" })).toMatchObject({ ok: true, custom_css: "off" });
    expect(["fx.show", "card.size", "color.off", "color.show", "widget.sidebar", "card.sizeByInstance"].some((k) => Object.hasOwn(host(), k))).toBe(false);
    expect(fm.ownerCss.state(OPERATOR).active).toBeNull();
  });
});

describe("the tool handlers (the dispatch every sink uses)", () => {
  const call = (tool: string, args: unknown) => new Promise<{ result: any; error: any }>((resolve) =>
    outboundHandlers.get(tool)!(fm, args as Record<string, unknown>, (result: unknown, error?: unknown) => resolve({ result, error }), { instanceName: "general" } as never));
  it("get_web_settings answers; set_web_settings validates the change's shape first (the schema) and answers the store's verdict", async () => {
    expect((await call("get_web_settings", {})).result.summary.length).toBeGreaterThan(5);
    expect((await call("set_web_settings", { change: { what: "host", set: { colour_places: ["glow"] } } })).error).toMatch(/colour_places/);
    expect((await call("set_web_settings", { change: { what: "warp" } })).error).toBeTruthy();
    expect((await call("set_web_settings", { change: { what: "host", set: { card_size: "l" } } })).result).toMatchObject({ ok: true });
    expect(host()["card.size"]).toBe("l");
    expect((await call("set_web_settings", { change: { what: "restore_defaults" } })).result).toMatchObject({ ok: true });
  });
  it("#2799: a call naming a removed change (a resumed session) gets the tool's refusal, as before — not a schema error", async () => {
    for (const change of [{ what: "effect_slot", slot: "page", id: null }, { what: "effect", action: "apply", instance: "alpha", id: "e".repeat(32) }, { what: "mod", action: "install", stage: "x" }]) {
      const r = await call("set_web_settings", { change });
      expect([r.result, r.error], change.what).toEqual([{ ok: false, error: "experimental_feature_disabled", detail: "Canvas Worker effects were removed; ambient effects are still available" }, undefined]);
    }
    expect((await call("set_web_settings", { person: "nobody", change: { what: "mod" } })).result, "the person is still checked first").toMatchObject({ ok: false, error: "unknown_person" });
  });
});
