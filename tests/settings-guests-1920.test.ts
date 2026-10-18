/**
 * #1920 phase 3 (P3b-2): Settings → Web → Guests, as rendered (the panel in the mini DOM, a fake fetch for the server).
 * - The switches and an open connection's agents are staged as ONE PUT /api/settings/fleet/web { guests } with only what
 *   changed (off / chat on = the default: null); the server judges what waits for a confirmation.
 * - Every guest account is listed (who, platform, what it reaches, sessions, devices, last seen); Narrow stages a list
 *   (Remove narrowing lifts it); Sign out asks, then signs that account out at once (POST …/revoke) and reloads.
 * - Over the public link nothing can be changed.
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
    if (method === "POST" && path === "/api/settings/guests/revoke") return { ok: true, count: 1, durable: true };
    if (method !== "GET") return { ok: true };
    if (path === "/api/settings/guests") return overview;
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

const OVERVIEW = {
  enabled: true, chat: true, instances: ["alpha", "beta", "gamma"],
  connections: [{ id: "dc", type: "discord", mode: "open", named: ["alpha"] }, { id: "tg", type: "telegram", mode: "allowlist", named: [] }],
  guests: [
    { adapterId: "dc", userId: "111", name: "Alice", platform: "discord", scope: ["alpha"], sessions: 2, lastSeen: 1_790_000_000_000, devices: 1, narrow: null },
    { adapterId: "tg", userId: "222", name: "Bob", platform: "telegram", scope: ["beta"], sessions: 0, lastSeen: null, devices: 0, narrow: ["beta"] },
  ],
};
async function open(guests: Record<string, unknown> = { enabled: true, open_instances: { dc: ["alpha"] }, narrow: { "tg:222": ["beta"] } }) {
  fleet = { defaults: { locale: "en" }, instances: { alpha: {}, beta: {}, gamma: {} }, channels: [], web: { guests } };
  overview = structuredClone(OVERVIEW);
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.unmount();
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "web" }, navKey: "settings:web" }));
  await settle(12);
  const $ = (sel: string) => p.root.querySelector(sel) as any;
  const click = async (el: any) => { fire(el, "click"); await settle(); };
  const check = async (el: any, on: boolean) => { el.checked = on; fire(el, "change"); await settle(); };
  const button = (label: string, root: any = p.root) => root.querySelectorAll("button").find((b: any) => b.textContent.trim() === label);
  const review = async () => { await click($("#guestsReview")); };
  const apply = async () => { const region = p.root.querySelector("[role=region]"); if (region) await click(button("Apply changes", region)); };
  const writes = () => sent.filter((s) => s.method !== "GET" && s.path === "/api/settings/fleet/web");
  const row = (account: string) => $(`.guest-row[data-account="${account}"]`);
  const name = (container: any, n: string) => [...container.querySelectorAll("label")].find((l: any) => l.textContent.trim() === n)?.querySelector("input");
  return { $, click, check, button, review, apply, writes, row, name };
}

describe("Settings → Web → Guests, as rendered", () => {
  it("lists the switches, the open connection's agents and every guest account", async () => {
    const w = await open();
    expect([w.$("#guestsEnabled").checked, w.$("#guestsChat").checked]).toEqual([true, true]);
    expect(w.$("#guestsOpen-dc"), "an open connection's agents").not.toBeNull();
    expect(w.$("#guestsOpen-tg"), "an allowlist connection has none to name").toBeNull();
    expect([w.name(w.$("#guestsOpen-dc"), "alpha").checked, w.name(w.$("#guestsOpen-dc"), "beta").checked]).toEqual([true, false]);
    expect(w.row("dc:111").textContent).toContain("Alice");
    expect(w.row("dc:111").textContent).toContain("Agents: 1 · Sessions: 2 · Remembered browsers: 1 · Last active");
    expect(w.row("tg:222").textContent).toContain("Not signed in now");
    expect(w.row("tg:222").textContent).toContain("Narrowed to: beta");
    expect(w.button("Sign out", w.row("tg:222")), "no session or device: nothing to sign out").toBeUndefined();
  });
  it("one PUT with only what changed: chat off, an agent named, a narrowing lifted — through Review and Apply", async () => {
    const w = await open();
    await w.check(w.$("#guestsChat"), false);
    await w.check(w.name(w.$("#guestsOpen-dc"), "beta"), true);
    await w.click(w.button("Remove narrowing", w.row("tg:222")));
    await w.review(); await w.apply();
    expect(w.writes().map((s) => s.body)).toEqual([{ guests: { chat: false, open_instances: { dc: ["alpha", "beta"] }, narrow: { "tg:222": null } } }]);
  });
  it("Narrow… stages the ticked list for that account; turning sign-in off is null (the default)", async () => {
    const w = await open();
    await w.click(w.button("Narrow", w.row("dc:111")));
    const edit = w.$("#guestNarrow-dc\\:111") ?? w.row("dc:111").querySelector(".guest-names");
    expect(w.name(edit, "alpha").checked, "starts from what it reaches now").toBe(true);
    await w.check(w.name(edit, "alpha"), false);
    await w.check(w.$("#guestsEnabled"), false);
    await w.review(); await w.apply();
    expect(w.writes().map((s) => s.body)).toEqual([{ guests: { enabled: null, narrow: { "dc:111": [] } } }]);
  });
  it("chat back on is null (the default); the last named agent unticked removes the entry", async () => {
    const w = await open({ enabled: true, chat: false, open_instances: { dc: ["alpha"] } });
    await w.check(w.$("#guestsChat"), true);
    await w.check(w.name(w.$("#guestsOpen-dc"), "alpha"), false);
    await w.review(); await w.apply();
    expect(w.writes().map((s) => s.body)).toEqual([{ guests: { chat: null, open_instances: { dc: null } } }]);
  });
  it("a change undone before Review again is no longer staged: Apply writes nothing", async () => {
    const w = await open();
    await w.check(w.$("#guestsChat"), false);
    await w.review();
    await w.check(w.$("#guestsChat"), true);
    await w.review(); await w.apply();
    expect(w.writes()).toEqual([]);
  });
  it("nothing changed: nothing is written", async () => {
    const w = await open();
    await w.review(); await w.apply();
    expect(w.writes()).toEqual([]);
  });
  it("Sign out asks (No: nothing), then signs that account out at once and reloads the list", async () => {
    const w = await open();
    const asked: string[] = [];
    (globalThis as any).confirm = (m: string) => { asked.push(m); return false; };
    await w.click(w.button("Sign out", w.row("dc:111")));
    expect(asked.join("\n")).toContain("Alice's guest sessions end now");
    expect(sent.filter((s) => s.path === "/api/settings/guests/revoke"), "No: nothing").toEqual([]);
    const before = sent.filter((s) => s.path === "/api/settings/guests").length;
    (globalThis as any).confirm = (m: string) => { asked.push(m); return true; };
    await w.click(w.button("Sign out", w.row("dc:111"))); await settle(6);
    expect(sent.filter((s) => s.path === "/api/settings/guests/revoke").map((s) => s.body)).toEqual([{ adapterId: "dc", userId: "111" }]);
    expect(sent.filter((s) => s.path === "/api/settings/guests").length, "reloaded").toBe(before + 1);
  });
  it("over the public link the card cannot be changed", async () => {
    p.document.body.setAttribute("data-public-link", "1");
    const w = await open();
    expect(w.$(".s-guest-fields").disabled).toBe(true);
    expect(w.$("#guestsReview").disabled).toBe(true);
  });
});
