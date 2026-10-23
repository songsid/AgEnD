/**
 * #1939 S2a: Settings → Web → Web authority, as rendered (the panel in the mini DOM, a fake fetch for the server).
 * - The switch, "Only this computer can authorize" and the hours are staged as ONE PUT /api/settings/fleet/web
 *   { verified_authority } with only what changed (off / not only-this-computer / 48 h = the key removed: null); the
 *   server judges what waits for a confirmation.
 * - The sessions authorized now are listed (device, account, until when).
 * - A host in web.allowed_hosts that isn't loopback warns while "Only this computer" is off; a switch that counts as off
 *   (its state could not be saved) says so.
 * - Revoke web authority asks, then revokes at once (POST …/revoke) and reloads.
 * - Over the public link the card is not offered.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

const schema = buildSettingsImpactSchema();
let p: AppPage, fleet: any, overview: any;
let sent: Array<{ method: string; path: string; body: any }> = [];
const realFetch = (globalThis as any).fetch;
const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
  const method = init.method ?? "GET";
  sent.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
  const body = (() => {
    if (method === "POST" && path === "/api/settings/apply") return { id: "job-1", status: "done", targets: [] };
    if (method === "POST" && path === "/api/settings/web-authority/revoke") return { ok: true, epoch: 4, durable: true };
    if (method !== "GET") return { ok: true };
    if (path === "/api/settings/web-authority") return overview;
    if (path === "/api/settings/guests") return { enabled: false, chat: true, instances: [], connections: [], guests: [] };
    if (path === "/api/settings/schema") return schema;
    if (path === "/api/settings/fleet/raw") return fleet;
    if (path === "/api/settings/classic") return { channels: {}, defaults: {} };
    if (path === "/api/settings/connections") return [];
    if (path === "/api/fleet") return { version: "2.3.0", instances: [] };
    return [];
  })();
  return { ok: true, status: 200, json: async () => body };
};
beforeAll(() => { p = page({ url: "http://127.0.0.1:19280/settings/web" }); (globalThis as any).fetch = fakeFetch; });
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(() => { sent = []; p.window.confirm = () => true; (globalThis as any).confirm = () => true; });
afterEach(async () => {
  await p.unmount();
  p.document.body.removeAttribute("data-public-link");
  const { resetOperation } = await import("/ui/js/settings-apply.js");
  const { resetConfirmations } = await import("/ui/js/settings-confirm.js");
  resetOperation(); resetConfirmations();
});

function overviewFor(configured: Record<string, any>, extra: Record<string, unknown> = {}) {
  return { state: { enabled: configured.enabled !== false, loopbackOnly: configured.loopback_only === true, epoch: 1 }, configured,
    hours: { min: 1, max: 48, default: 48 }, lanHosts: [], authorized: [], ...extra };
}
async function open(configured: Record<string, any> = {}, extra: Record<string, unknown> = {}) {
  fleet = { defaults: { locale: "en" }, instances: {}, channels: [], web: { verified_authority: configured } };
  overview = overviewFor(configured, extra);
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.unmount();
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "web" }, navKey: "settings:web" }));
  await settle(12);
  const $ = (sel: string) => p.root.querySelector(sel) as any;
  const click = async (el: any) => { fire(el, "click"); await settle(); };
  const check = async (el: any, on: boolean) => { el.checked = on; fire(el, "change"); await settle(); };
  const type = async (el: any, v: string) => { el.value = v; fire(el, "input"); await settle(); };
  const button = (label: string, root: any = p.root) => root.querySelectorAll("button").find((b: any) => b.textContent.trim() === label);
  const review = async () => { await settle(2); };          // #2347: an edit is staged as it is made
  const apply = async () => { const region = p.root.querySelector("[role=region]"); if (region) await click(button("Save", region)); };
  const writes = () => sent.filter((s) => s.method !== "GET" && s.path === "/api/settings/fleet/web");
  return { $, click, check, type, button, review, apply, writes };
}

describe("Settings → Web → Web authority, as rendered", () => {
  it("shows what is in force: the switch on by default (§0.1), only-this-computer off, the hours; no session authorized yet", async () => {
    const w = await open();
    expect([w.$("#vaEnabled").checked, w.$("#vaLoopbackOnly").checked, w.$("#vaHours").value]).toEqual([true, false, ""]);
    // #2347 §10: the hours left empty say what is in effect, in plain text with a "default" mark (no grey placeholder).
    const effect = w.$("#vaHours").parentNode.querySelector(".s-effect");
    expect([effect?.textContent.replace(/\s+/g, " ").trim(), w.$("#vaHours").getAttribute("placeholder")]).toEqual(["In effect: 48 h default", null]);
    await w.type(w.$("#vaHours"), "12");
    expect(w.$("#vaHours").parentNode.querySelector(".s-effect")).toBeNull();
    await w.type(w.$("#vaHours"), "");
    expect(w.$("#vaSessionsNone").textContent).toBe("No session is authorized now.");
    expect(w.$("#vaEnforce"), "§0: no step-up list").toBeNull();
    expect(w.$("#vaLanWarning")).toBeNull();
    expect(w.$("#vaStuckOff")).toBeNull();
  });
  it("lists the sessions authorized now: the device, the account, until when", async () => {
    const w = await open({ enabled: true }, { authorized: [{ handle: "a1b2c3d4e5f60718", label: "Firefox on Mac", account: "owner:admin", authorizedAt: Date.UTC(2026, 9, 18, 9, 0), until: Date.UTC(2026, 9, 20, 9, 0) }] });
    const row = w.$('#vaSessions li[data-handle="a1b2c3d4e5f60718"]');
    expect(row.textContent).toContain("Firefox on Mac");
    expect(row.textContent).toContain("owner:admin");
    expect(row.textContent).toMatch(/Authorized .+ · until .+/);
  });
  it("one PUT with only what changed: off, only-this-computer, 12 h — staged as edited, then Save", async () => {
    const w = await open();
    await w.check(w.$("#vaEnabled"), false);
    await w.check(w.$("#vaLoopbackOnly"), true);
    await w.type(w.$("#vaHours"), "12");
    await w.review(); await w.apply();
    expect(w.writes().map((s) => s.body)).toEqual([{ verified_authority: { enabled: false, loopback_only: true, max_session_hours: 12 } }]);
  });
  it("back to each default is null: on, not only-this-computer, the hours cleared", async () => {
    const w = await open({ enabled: false, loopback_only: true, max_session_hours: 6 });
    await w.check(w.$("#vaEnabled"), true);
    await w.check(w.$("#vaLoopbackOnly"), false);
    await w.type(w.$("#vaHours"), "");
    await w.review(); await w.apply();
    expect(w.writes().map((s) => s.body)).toEqual([{ verified_authority: { enabled: null, loopback_only: null, max_session_hours: null } }]);
  });
  // §0.3: the temporary public link's option — always shown (any fleet can open one), off by default, its risk said.
  it("the quick-link row: always shown, off by default, its risk said; on is staged as quick_link: true, back off as null", async () => {
    const w = await open();
    expect([!!w.$("#vaQuickLink"), w.$("#vaQuickLink").checked, w.$("#vaNamedLink"), w.$(".s-web-authority").textContent.includes("Cloudflare's quick-tunnel service")]).toEqual([true, false, null, true]);
    await w.check(w.$("#vaQuickLink"), true);
    await w.review(); await w.apply();
    const on = await open({ quick_link: true });
    expect(on.$("#vaQuickLink").checked).toBe(true);
    await on.check(on.$("#vaQuickLink"), false);
    await on.review(); await on.apply();
    expect(on.writes().map((x: any) => x.body)).toEqual([{ verified_authority: { quick_link: true } }, { verified_authority: { quick_link: null } }]);
  });
  it("a session authorized over the temporary public link is marked so", async () => {
    const w = await open({ quick_link: true }, { authorized: [{ handle: "a1b2c3d4e5f60718", label: "Safari on iPhone", account: "owner:admin", authorizedAt: Date.UTC(2026, 9, 18, 9, 0), until: Date.UTC(2026, 9, 18, 13, 0), quick: true }] });
    expect(w.$('#vaSessions li[data-handle="a1b2c3d4e5f60718"] .s-va-quick')?.textContent).toBe("over the temporary public link");
  });
  it("hours out of 1–48 are refused on the page", async () => {
    const w = await open();
    await w.type(w.$("#vaHours"), "72");
    const save = (p.root.querySelector("[role=region]")?.querySelectorAll("button") ?? []).find((b: any) => b.textContent.trim() === "Save");
    expect([save?.disabled, !!p.root.querySelector(".s-pending .s-fix")]).toEqual([true, true]);     // #2347: Save waits
    expect(w.$(".s-web-authority .feedback.error").textContent).toBe("Must be a number from 1 to 48");
  });
  it("warns about hosts that reach the dashboard from elsewhere while only-this-computer is off; not once it is on", async () => {
    const w = await open({}, { lanHosts: ["agend.example.com"] });
    expect(w.$("#vaLanWarning").textContent).toContain("agend.example.com");
    await w.check(w.$("#vaLoopbackOnly"), true);
    expect(w.$("#vaLanWarning")).toBeNull();
  });
  it("says when the switch counts as off although fleet.yaml has it on (its state could not be saved)", async () => {
    const w = await open({ enabled: true }, { state: { enabled: false, loopbackOnly: false, epoch: 3 } });
    expect(w.$("#vaStuckOff").textContent).toContain("could not be saved");
  });
  it("nothing changed: nothing is written", async () => {
    const w = await open({ enabled: true });
    await w.review(); await w.apply();
    expect(w.writes()).toEqual([]);
  });
  it("Revoke asks (No: nothing), then revokes at once and reloads", async () => {
    const w = await open({ enabled: true });
    const asked: string[] = [];
    (globalThis as any).confirm = (m: string) => { asked.push(m); return false; };
    await w.click(w.$("#vaRevoke"));
    expect(asked.join("\n")).toContain("every session's authorization ends");
    expect(sent.filter((s) => s.path === "/api/settings/web-authority/revoke")).toEqual([]);
    const before = sent.filter((s) => s.path === "/api/settings/web-authority").length;
    (globalThis as any).confirm = () => true;
    await w.click(w.$("#vaRevoke")); await settle(6);
    expect(sent.filter((s) => s.path === "/api/settings/web-authority/revoke").map((s) => s.method)).toEqual(["POST"]);
    expect(sent.filter((s) => s.path === "/api/settings/web-authority").length, "reloaded").toBe(before + 1);
  });
  it("an answer that isn't the overview (an older server) says it could not be loaded, and Retry asks again", async () => {
    const w = await open();
    const { SettingsPanel } = await import("/ui/js/panel-settings.js");
    const good = overviewFor({});
    for (const bad of [[], { ...good, state: undefined }, { ...good, hours: undefined }, { ...good, lanHosts: undefined }, { ...good, authorized: undefined }]) {
      overview = bad;
      await p.unmount();
      await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "web" }, navKey: "settings:web" }));
      await settle(12);
      expect(w.$(".s-web-authority").textContent, JSON.stringify(Object.keys(bad))).toContain("Web authority could not be loaded.");
    }
    overview = overviewFor({ enabled: true });
    await w.click(w.$(".s-web-authority button")); await settle(6);                       // its one button: Retry
    expect(w.$("#vaEnabled").checked).toBe(true);
  });
  it("showing it makes this browser's own line read again (a revoke or the switch there changes what it says)", async () => {
    const { AuthorizeChip, resetWebAuthorization } = await import("/assets/web-authorize.js");
    resetWebAuthorization();
    const reads = () => sent.filter((s) => s.path === "/ui/authorization").length;
    const line = async () => { await p.unmount(); await p.mount(h(AuthorizeChip, {})); await settle(8); };
    await line(); await line();
    expect(reads(), "one read per page load").toBe(1);
    await open({ enabled: true });
    await line();
    expect(reads(), "read again after Settings → Web").toBe(2);
  });
  const away = async (configured: Record<string, any>) => {
    const { SettingsPanel } = await import("/ui/js/panel-settings.js");
    await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "device" }, navKey: "settings:device" })); await settle(8);
    overview = overviewFor(configured); fleet.web.verified_authority = configured;       // another admin's change meanwhile
    await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "web" }, navKey: "settings:web|2" })); await settle(12);
  };
  it("#2367 review: a card never edited follows the overview when shown again — nothing staged, nothing written", async () => {
    const w = await open({ max_session_hours: 12 });
    await away({ max_session_hours: 6 });
    await w.apply();
    expect([w.$("#vaHours").value, !!p.root.querySelector("[role=region]"), w.writes()]).toEqual(["6", false, []]);
  });
  it("#2367 review control: an edited field comes back over the fresh overview, and Save sends only it", async () => {
    const w = await open({ max_session_hours: 12 });
    await w.check(w.$("#vaLoopbackOnly"), true);
    await away({ max_session_hours: 6 });
    const back = [w.$("#vaHours").value, w.$("#vaLoopbackOnly").checked];
    await w.apply();
    expect([back, w.writes().map((s) => s.body)]).toEqual([["6", true], [{ verified_authority: { loopback_only: true } }]]);
  });
  it("over the public link the card is not offered", async () => {
    p.document.body.setAttribute("data-public-link", "1");
    const w = await open();
    expect(w.$(".s-web-authority")).toBeNull();
    expect(sent.filter((s) => s.path === "/api/settings/web-authority")).toEqual([]);
  });
});
