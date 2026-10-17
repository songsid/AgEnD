/**
 * #2056 A: General (and a coordinator or full profile) changes Settings → Web appearance for the user through the page's
 * own stores and checks — no second implementation, no bypass of custom CSS's safe rules. A worker keeps only its own
 * theme. Real stores on a scratch home (FleetManager, no fleet start).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(dir, "fleet.yaml"), `instances:\n  general:\n    working_directory: ${dir}\n    general_topic: true\n  alpha:\n    working_directory: ${dir}\n  beta:\n    working_directory: ${dir}\n`);
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
    expect(r.summary[0]).toBe("Agents' themes, effects and widgets: shown.");
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
    expect(fm.webSettings.read().summary.slice(0, 2)).toEqual(["Agents' themes, effects and widgets: hidden (every chat looks the same).", "Identity colours: turned off on this host."]);
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
  it("custom CSS: the same safe rules (no bypass); a tool puts it on trial, reverts or turns it off — keeping is the person's", () => {
    const remote = "body { background: url(https://example.com/x.png) }";
    expect(checkOwnerCss(remote, new Set()).ok).toBe(false);
    expect(set({ what: "custom_css", action: "save", text: remote })).toMatchObject({ ok: false });
    expect(fm.ownerCss.state(OPERATOR).active).toBeNull();
    expect(set({ what: "custom_css", action: "save", text: "body { outline: 2px solid #ff0000 }" })).toMatchObject({ ok: true, on_trial: true });
    const trial = fm.ownerCss.state(OPERATOR).pending;
    expect(trial).not.toBeNull();
    // Keeping it, or choosing an earlier version (which applies at once), is the person's own click — never a tool's.
    for (const action of ["keep", "use"]) expect(set({ what: "custom_css", action, version: trial.sha })).toMatchObject({ ok: false, error: "custom_css_person_only" });
    expect(fm.ownerCss.state(OPERATOR).pending).not.toBeNull();
    expect(set({ what: "custom_css", action: "revert" })).toMatchObject({ ok: true, active: null });
    expect(fm.ownerCss.state(OPERATOR).pending).toBeNull();
    // The person kept one on the page: a tool may turn it off.
    set({ what: "custom_css", action: "save", text: "body { outline: 1px solid #0000ff }" });
    expect(fm.ownerCss.keep(OPERATOR, fm.ownerCss.state(OPERATOR).pending.id)).toMatchObject({ ok: true });
    expect(set({ what: "custom_css", action: "off" })).toMatchObject({ ok: true, active: null });
    expect(set({ what: "custom_css", action: "lasers" })).toMatchObject({ ok: false, error: "custom_css" });
  });
  it("an effect slot: the page's owner-selection check (an unknown effect is refused); an effect on a chat: the effect service's", () => {
    expect(set({ what: "effect_slot", slot: "sidebar", id: "f".repeat(32) })).toMatchObject({ ok: false });
    expect(set({ what: "effect_slot", slot: "nope", id: null })).toMatchObject({ ok: false, error: "effect_slot" });
    expect(set({ what: "effect", action: "apply", instance: "alpha", id: "f".repeat(32) })).toMatchObject({ ok: false });
    expect(set({ what: "effect", action: "remove", instance: "alpha" })).toMatchObject({ ok: true, removed: [] });
  });
  it("mods: an agent's proposal reviewed (the plan) and installed with the parts asked for — the store's own commit", async () => {
    const { createHash } = await import("node:crypto");
    const { checkModBundle } = await import("../src/web-mod-bundle.js");
    const { agendVersion } = await import("../src/agent-whats-new.js");
    const file = (t: string) => ({ sha256: createHash("sha256").update(t).digest("hex"), b64: Buffer.from(t).toString("base64") });
    const doc = { format: "agend-mod", v: 1, manifest: { name: "tagline", version: "1.0.0", title: "Tagline", author: "alpha", contents: { identity: "identity.json" } },
      files: { "identity.json": file(JSON.stringify({ tagline: "Reviews fast" })) } };
    const text = JSON.stringify(doc);
    const checked = checkModBundle(text, { agendVersion: agendVersion(), limits: fm.themeStore.limits(), effects: null });
    if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
    expect(fm.mods.propose("alpha", text, checked.mod)).toMatchObject({ ok: true });
    expect(fm.webSettings.read().summary.join("\n")).toContain("proposed by agents: alpha");
    const review = set({ what: "mod", action: "review", instance: "alpha" });
    expect(review).toMatchObject({ ok: true, stage: expect.any(String), plan_hash: expect.any(String) });
    expect(set({ what: "mod", action: "install", stage: review.stage, plan_hash: "0".repeat(64), include: { identity: true }, target: "alpha" }), "a plan that moved").toMatchObject({ ok: false });
    const status = vi.spyOn(fm, "emitSseEvent");
    const installed = set({ what: "mod", action: "install", stage: review.stage, plan_hash: review.plan_hash, include: { identity: true }, target: "alpha" });
    expect(status, "every page re-reads, as after the page's install").toHaveBeenCalledWith("status", expect.anything());
    status.mockRestore();
    expect(installed).toMatchObject({ ok: true, applied: expect.arrayContaining(["identity"]) });
    expect(fm.webSettings.read().mods.installed.map((m: { name: string }) => m.name)).toEqual(["tagline"]);
    expect(set({ what: "mod", action: "uninstall", id: installed.id })).toMatchObject({ ok: true });
  });
  it("mods: a proposal that is not there is the store's refusal; an unknown action is named", () => {
    expect(set({ what: "mod", action: "review", instance: "alpha" })).toMatchObject({ ok: false });
    expect(set({ what: "mod", action: "lasers" })).toMatchObject({ ok: false, error: "mod" });
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
});
