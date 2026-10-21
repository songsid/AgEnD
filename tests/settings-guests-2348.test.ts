/**
 * #2348 (on #1920 phase 3): Settings → Guests, as rendered (the panel in the mini DOM, a fake fetch for the server).
 * - Every edit is staged at once (no Review button): ONE PUT /api/settings/fleet/web { guests } with only what changed —
 *   switches (off / chat on = the default: null) and grants (a grant whole, a removed one null). Undone, it unstages.
 * - Before grants exist, "Start from today's guests" stages each guest's current reach as a grant.
 * - Add a person from the people seen in chat: their agents pre-ticked by where they wrote. Remove / Keep access.
 * - Send sign-in code (an action, outside Save): only for saved access; its outcome shows on the row (sent, or why a DM
 *   failed). Sign out asks, then signs that account out at once. Over the public link the card is not offered.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

const schema = buildSettingsImpactSchema();
let p: AppPage, fleet: any, overview: any, sendCodeAnswer: any = { ok: true, outcome: "sent", expiresAt: Date.now() + 600_000 };
let sent: Array<{ method: string; path: string; body: any }> = [];
/** #2367 review: what PUT /api/settings/fleet/web answers (default: ok). */
let webAnswer: { status: number; body: unknown } | null = null;
/** #2367 review: a PUT /api/settings/fleet/web held until this opens (null: answered at once). */
let webHold: Promise<void> | null = null;
const realFetch = (globalThis as any).fetch;
const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
  const method = init.method ?? "GET";
  sent.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
  if (method === "PUT" && path === "/api/settings/fleet/web" && webHold) { const held = webHold; webHold = null; await held; }
  if (method === "PUT" && path === "/api/settings/fleet/web" && webAnswer) {
    const a = webAnswer;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
  }
  const body = (() => {
    if (method === "POST" && path === "/api/settings/apply") return { id: "job-1", status: "done", targets: [] };
    if (method === "POST" && path === "/api/settings/guests/revoke") return { ok: true, count: 1, durable: true };
    if (method === "POST" && path === "/api/settings/guests/send-code") return sendCodeAnswer;
    if (path === "/api/settings/guests/people") return { people: PEOPLE };
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
beforeEach(() => { sent = []; webAnswer = null; webHold = null; p.window.confirm = () => true; (globalThis as any).confirm = () => true; });
afterEach(async () => {
  await p.unmount();
  p.document.body.removeAttribute("data-public-link");
  const { resetOperation } = await import("/ui/js/settings-apply.js");
  const { resetConfirmations } = await import("/ui/js/settings-confirm.js");
  resetOperation(); resetConfirmations();
});

const OVERVIEW = {
  enabled: true, chat: true, explicit: true, instances: ["alpha", "beta", "gamma"],
  connections: [{ id: "dc", type: "discord", mode: "pairing", named: [] }],
  guests: [
    { adapterId: "dc", userId: "111", name: "Alice", platform: "discord", scope: ["alpha"], reach: ["alpha"], sessions: 2, lastSeen: 1_790_000_000_000, devices: 1, narrow: null, grant: { name: "Alice", instances: ["alpha"] } },
    { adapterId: "tg", userId: "222", name: "Bob", platform: "telegram", scope: ["beta"], reach: ["beta"], sessions: 0, lastSeen: null, devices: 0, narrow: null, grant: { name: "Bob", instances: ["beta"] } },
  ],
};
const PEOPLE = [
  { adapterId: "dc", userId: "111", platform: "discord", username: "alice", name: "Alice", lastSeen: "2026-10-21T10:00:00Z", instances: ["alpha"] },
  { adapterId: "dc", userId: "333", platform: "discord", username: "sam.o", name: "Sam Ortiz", lastSeen: "2026-10-21T17:00:00Z", instances: ["beta", "gamma"] },
  { adapterId: "tg", userId: "444", platform: "telegram", username: "sarak", name: "Sara K.", lastSeen: "2026-10-18T09:00:00Z", instances: ["alpha"] },
];
const GRANTS = { "dc:111": { name: "Alice", instances: ["alpha"] }, "tg:222": { name: "Bob", instances: ["beta"] } };
async function open(guests: Record<string, unknown> = { enabled: true, grants: structuredClone(GRANTS) }, over: Record<string, unknown> = {}) {
  fleet = { defaults: { locale: "en" }, instances: { alpha: {}, beta: {}, gamma: {} }, channels: [], web: { guests } };
  overview = { ...structuredClone(OVERVIEW), ...over };
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.unmount();
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "web" }, navKey: "settings:web" }));
  await settle(12);
  const $ = (sel: string) => p.root.querySelector(sel) as any;
  const click = async (el: any) => { fire(el, "click"); await settle(); };
  const check = async (el: any, on: boolean) => { el.checked = on; fire(el, "change"); await settle(); };
  const button = (label: string, root: any = p.root) => root.querySelectorAll("button").find((b: any) => b.textContent.trim() === label);
  const apply = async () => { const region = p.root.querySelector("[role=region]"); if (region) await click(button("Save", region)); };
  const writes = () => sent.filter((s) => s.method !== "GET" && s.path === "/api/settings/fleet/web");
  const row = (account: string) => $(`.guest-row[data-account="${account}"]`);
  const name = (container: any, n: string) => [...container.querySelectorAll("label")].find((l: any) => l.textContent.trim().startsWith(n))?.querySelector("input");
  const type = async (el: any, text: string) => { el.value = text; fire(el, "input"); await settle(); };
  return { $, click, check, button, apply, writes, row, name, type };
}

describe("Settings → Guests, as rendered (#2348)", () => {
  it("lists the switches and everyone with access: their agents, and whether they are signed in", async () => {
    const w = await open();
    expect([w.$("#guestsEnabled").checked, w.$("#guestsChat").checked, w.$("#guestsReview")]).toEqual([true, true, null]);
    expect(w.row("dc:111").textContent).toContain("Alice");
    expect([...w.row("dc:111").querySelectorAll(".g-chip")].map((c: any) => c.textContent)).toEqual(["alpha"]);
    expect(w.row("dc:111").textContent).toContain("Signed in · 1 device(s)");
    expect(w.row("tg:222").textContent).toContain("Not signed in");
    expect(w.button("Sign out", w.row("tg:222")), "no session or device: nothing to sign out").toBeUndefined();
    expect(w.$(".s-dirty"), "nothing edited yet").toBeNull();
  });
  it("an edit is staged at once — no Review step — and Apply writes only what changed: a grant whole", async () => {
    const w = await open();
    await w.click(w.button("Edit agents", w.row("dc:111")));
    await w.check(w.name(w.row("dc:111"), "beta"), true);
    expect(w.row("dc:111").classList.contains("s-dirty"), "the straight-bar marker").toBe(true);
    await w.check(w.$("#guestsChat"), false);
    await w.apply();
    expect(w.writes().map((s) => s.body)).toEqual([{ guests: { chat: false, grants: { "dc:111": { name: "Alice", instances: ["alpha", "beta"] } } } }]);
  });
  it("undone, it is no longer staged: Apply writes nothing", async () => {
    const w = await open();
    await w.check(w.$("#guestsChat"), false);
    await w.check(w.$("#guestsChat"), true);
    await w.apply();
    expect(w.writes()).toEqual([]);
  });
  it("Remove access stages null; Keep access undoes it", async () => {
    const w = await open();
    await w.click(w.button("Remove access", w.row("tg:222")));
    expect(w.row("tg:222").textContent).toContain("Access ends when you save.");
    await w.click(w.button("Keep access", w.row("tg:222")));
    await w.click(w.button("Remove access", w.row("tg:222")));
    await w.apply();
    expect(w.writes().map((s) => s.body)).toEqual([{ guests: { grants: { "tg:222": null } } }]);
  });
  it("Add a person: search the people seen in chat (not those with access); Choose pre-ticks where they wrote", async () => {
    const w = await open();
    const cands = () => [...p.root.querySelectorAll(".g-cand")].map((c: any) => c.getAttribute("data-account"));
    expect(cands(), "Alice already has access").toEqual(["dc:333", "tg:444"]);
    await w.type(w.$("#grantsSearch"), "sam");
    expect(cands()).toEqual(["dc:333"]);
    await w.click(w.button("Choose", p.root.querySelector('.g-cand[data-account="dc:333"]')));
    expect(w.row("dc:333").textContent).toContain("New — granted when you save");
    expect([w.name(w.row("dc:333"), "beta").checked, w.name(w.row("dc:333"), "gamma").checked, w.name(w.row("dc:333"), "alpha").checked]).toEqual([true, true, false]);
    await w.apply();
    expect(w.writes().map((s) => s.body)).toEqual([{ guests: { grants: { "dc:333": { name: "Sam Ortiz", instances: ["beta", "gamma"] } } } }]);
  });
  it("a grant with no agent says so on the row", async () => {
    const w = await open();
    await w.click(w.button("Edit agents", w.row("dc:111")));
    await w.check(w.name(w.row("dc:111"), "alpha"), false);
    expect(w.row("dc:111").querySelector(".g-error").textContent).toBe("Tick at least one agent, or remove this person.");
  });
  it("before grants exist: the legacy note, and Start from today's guests stages each guest's reach", async () => {
    const w = await open({ enabled: true }, { explicit: false });
    expect(w.$(".g-legacy").textContent).toContain("Saving grants switches to explicit access");
    await w.click(w.$("#grantsConvert"));
    await w.apply();
    expect(w.writes().map((s) => s.body)).toEqual([{ guests: { grants: { "dc:111": { name: "Alice", instances: ["alpha"] }, "tg:222": { name: "Bob", instances: ["beta"] } } } }]);
  });
  it("#2365 review: leaving the section with unsaved changes and coming back keeps them (the real panel's navigation)", async () => {
    const w = await open();
    await w.check(w.$("#guestsChat"), false);
    await w.click(w.button("Edit agents", w.row("dc:111")));
    await w.check(w.name(w.row("dc:111"), "beta"), true);
    const { SettingsPanel } = await import("/ui/js/panel-settings.js");
    await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "device" }, navKey: "settings:device" })); await settle(8);
    expect(w.$("#guestsChat"), "another section").toBeNull();
    await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "web" }, navKey: "settings:web" })); await settle(8);
    expect(w.$("#guestsChat").checked, "the draft, not the saved state").toBe(false);
    expect(w.row("dc:111").classList.contains("s-dirty")).toBe(true);
    await w.apply();
    expect(w.writes().map((s) => s.body)).toEqual([{ guests: { chat: false, grants: { "dc:111": { name: "Alice", instances: ["alpha", "beta"] } } } }]);
  });
  it("#2367 review: an edit made while a Save runs outlives it (still shown, still unsaved); the next Save sends only it", async () => {
    let release!: () => void;
    webHold = new Promise<void>((r) => { release = r; });
    const w = await open();
    await w.check(w.$("#guestsChat"), false);
    await w.apply(); await settle(4);
    await w.click(w.button("Edit agents", w.row("dc:111")));
    await w.check(w.name(w.row("dc:111"), "beta"), true);
    fleet = { ...fleet, web: { guests: { ...fleet.web.guests, chat: false } } };            // what that Save wrote
    release();
    const { appStore } = await import("/assets/app-store.js");
    for (let i = 0; i < 50 && (appStore.get() as any).settingsOp?.phase !== "done"; i++) await settle(4);
    await settle(12);
    const after = [w.row("dc:111").classList.contains("s-dirty"), !!p.root.querySelector(".s-pending")];
    await w.apply(); await settle(12);
    expect([after, w.writes().map((x) => x.body)]).toEqual([[true, true],
      [{ guests: { chat: false } }, { guests: { grants: { "dc:111": { name: "Alice", instances: ["alpha", "beta"] } } } }]]);
  });
  it("#2367 review: the real Save tells the section how it went — failed (the section says why) and waiting", async () => {
    const { appStore } = await import("/assets/app-store.js");
    webAnswer = { status: 400, body: { error: "grant names someone not seen in chat" } };
    let w = await open();
    await w.check(w.$("#guestsChat"), false);
    await w.apply(); await settle(12);
    // …and the edit it failed to save is still there, unsaved (the section was shown again by the reload).
    const failed = [(appStore.get() as any).settingsOp?.steps?.[0]?.stageKey, p.root.querySelector(".g-error")?.textContent ?? "",
      w.$("#guestsChat").checked, !!p.root.querySelector(".s-pending")];
    const { resetOperation } = await import("/ui/js/settings-apply.js");
    resetOperation();
    webAnswer = { status: 202, body: { ok: true, result: "pending_confirmation", pending_change: { id: "e".repeat(32), state: "pending", section: "access",
      requested_at: 1, requested_by: "Chrome", expires_at: 2, remaining_ms: 290_000, source: "web_session", summary: ["guests"], confirmation: { kind: "chat" }, can_withdraw: true, outcome: null } } };
    w = await open();
    await w.check(w.$("#guestsChat"), false);
    await w.apply(); await settle(12);
    expect([failed, p.root.textContent.includes("Waiting for a fleet admin")])
      .toEqual([["guests", expect.stringContaining("grant names someone not seen in chat"), false, true], true]);
  });
  it("#2365 review: starting grants from an empty guest list stages grants: {} — explicit access with no one in it", async () => {
    const w = await open({ enabled: true }, { explicit: false, guests: [] });
    await w.click(w.$("#grantsConvert"));
    expect(w.$("#grantsNone").textContent).toBe("No one has guest access yet.");
    await w.apply();
    expect(w.writes().map((s) => s.body)).toEqual([{ guests: { grants: {} } }]);
  });
  it("Send sign-in code: only for saved access; it posts at once (outside Save) and the row says it was sent", async () => {
    const w = await open();
    await w.click(w.button("Edit agents", w.row("dc:111")));
    await w.check(w.name(w.row("dc:111"), "beta"), true);
    expect(w.button("Send sign-in code", w.row("dc:111")).disabled, "unsaved change: save first").toBe(true);
    const bob = w.button("Send sign-in code", w.row("tg:222"));
    expect(bob.disabled).toBe(false);
    await w.click(bob); await settle(6);
    expect(sent.filter((s) => s.path === "/api/settings/guests/send-code").map((s) => s.body)).toEqual([{ adapterId: "tg", userId: "222" }]);
    expect(w.row("tg:222").textContent).toMatch(/Code sent .* · expires /);
    expect(w.row("tg:222").textContent).toMatch(/Send again in 0:\d\d/);
    expect(w.writes(), "not part of Save").toEqual([]);
  });
  it("a DM that failed says why: Telegram's start link to pass on", async () => {
    sendCodeAnswer = { ok: false, outcome: "dm_failed", platform: "telegram", reason: "Forbidden: bot can't initiate conversation", startUrl: "https://t.me/demo_bot?start=web" };
    try {
      const w = await open();
      await w.click(w.button("Send sign-in code", w.row("tg:222"))); await settle(6);
      expect(w.row("tg:222").textContent).toContain("Couldn't DM Bob: they haven't started the bot. Send them this link: https://t.me/demo_bot?start=web");
    } finally { sendCodeAnswer = { ok: true, outcome: "sent", expiresAt: Date.now() + 600_000 }; }
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
  it("over the public link the card is not offered (the server never serves its list there), and nothing is read", async () => {
    p.document.body.setAttribute("data-public-link", "1");
    const w = await open();
    expect(w.$(".s-guest-fields")).toBeNull();
    expect(sent.filter((s) => s.path.startsWith("/api/settings/guests"))).toEqual([]);
  });
});
