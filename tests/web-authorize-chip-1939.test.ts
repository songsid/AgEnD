/**
 * #1939 S2b: the "Authorize this browser" line (under the composer, and in the session menu), as rendered against a fake
 * /ui/authorization: verified (until when), waiting for the card (with its countdown), "Not verified · Authorize this
 * browser", every reason it can't be authorized here (the switch off links to Settings → Web), the refusals an ask can get,
 * and the temporary public link (says why, never asks). A guest's page has none.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage, state: any, askAnswer: any, signedOut = false;
let sent: Array<{ method: string; path: string }> = [];
const realFetch = (globalThis as any).fetch;
const fakeFetch = async (path: string, init: { method?: string } = {}) => {
  const method = init.method ?? "GET";
  sent.push({ method, path });
  if (path === "/ui/authorization" && method === "POST") return { ok: askAnswer.ok, status: 200, json: async () => askAnswer };
  if (path === "/ui/authorization") return signedOut ? { ok: false, status: 401, json: async () => ({ error: "unauthorized" }) } : { ok: true, status: 200, json: async () => state };
  return { ok: true, status: 200, json: async () => ({}) };
};
beforeAll(() => { p = page({ url: "http://127.0.0.1:19280/ui/chat/alpha" }); (globalThis as any).fetch = fakeFetch; });
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(() => { sent = []; signedOut = false; askAnswer = { ok: true, expiresInMs: 300_000 }; });
afterEach(async () => { await p.unmount(); p.document.body.removeAttribute("data-public-link"); p.document.body.removeAttribute("data-tier"); });

async function chip(st: any) {
  state = st;
  const { AuthorizeChip, resetWebAuthorization } = await import("/assets/web-authorize.js");
  resetWebAuthorization();                                                               // each case is its own page load
  await p.unmount();
  await p.mount(h(AuthorizeChip, {}));
  await settle(8);
  return p.root.querySelector(".webauth-chip") as any;
}

describe("this browser's authorization line", () => {
  it("verified: says until when", async () => {
    const c = await chip({ state: "verified", until: Date.now() + 3_600_000 });               // an hour ahead: never a fixed date (it expired 2026-10-20 09:00 UTC)
    expect(c.dataset.state).toBe("verified");
    expect(c.textContent).toMatch(/Verified · speaks as you until /);
    expect(c.querySelector("button")).toBeNull();
  });
  it("not authorized: the button; pressing it asks once (POST) and says it was sent", async () => {
    const c = await chip({ state: "none", reason: "not_authorized" });
    const btn = c.querySelector("button");
    expect(btn.textContent).toBe("Authorize this browser");
    fire(btn, "click"); await settle(8);
    expect(sent.filter(s => s.method === "POST").map(s => s.path)).toEqual(["/ui/authorization"]);
    const after = p.root.querySelector(".webauth-chip") as any;
    expect(after.dataset.state).toBe("pending");
    expect(after.textContent).toContain("Sent — confirm it in your DM within 5 minutes.");
    expect(after.textContent).toMatch(/Waiting for your Confirm in Discord or Telegram \(\d:\d\d\)/);
  });
  it("an end that isn't today says the day too (an authorization lasts up to 48 h)", async () => {
    const later = new Date(Date.now() + 2 * 86_400_000);
    const c = await chip({ state: "verified", until: later.getTime() });
    expect(c.textContent).toContain(later.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  });
  it("once the card is decided, 'Sent —' goes with it (the next poll's answer is verified)", async () => {
    const c = await chip({ state: "none", reason: "not_authorized" });
    fire(c.querySelector("button"), "click"); await settle(8);
    expect(p.root.querySelector(".webauth-chip").textContent).toContain("Sent —");
    state = { state: "verified", until: Date.now() + 3_600_000 };
    await new Promise((r) => setTimeout(r, 3_100)); await settle(8);
    const after = p.root.querySelector(".webauth-chip") as any;
    expect(after.dataset.state).toBe("verified");
    expect(after.textContent).not.toContain("Sent —");
  });
  it("#2126 P3: 'Verified · until X' is read again at X: a page left open says Not verified after it ends", async () => {
    await chip({ state: "verified", until: Date.now() + 1_500 });
    expect(p.root.querySelector(".webauth-chip").dataset.state).toBe("verified");
    state = { state: "none", reason: "authorization_expired" };
    const reads = sent.filter((s) => s.path === "/ui/authorization").length;
    await new Promise((r) => setTimeout(r, 2_800)); await settle(8);
    expect(sent.filter((s) => s.path === "/ui/authorization").length).toBe(reads + 1);
    expect(p.root.querySelector(".webauth-chip").dataset.state).toBe("none");
    expect(p.root.querySelector(".webauth-chip button").textContent).toBe("Authorize this browser");
  });
  it("signed out while a card waits (Not me): the next poll answers 401 and the line goes", async () => {
    await chip({ state: "pending", expiresInMs: 200_000 });
    signedOut = true;
    await new Promise((r) => setTimeout(r, 3_100)); await settle(8);
    expect(p.root.querySelector(".webauth-chip")).toBeNull();
  });
  it("an authorization that ran out offers the button again", async () => {
    const c = await chip({ state: "none", reason: "authorization_expired" });
    expect(c.querySelector("button").textContent).toBe("Authorize this browser");
  });
  it.each([
    ["rate_limited", { ok: false, refusal: "rate_limited", retryAfterMs: 25 * 60_000 }, "Three requests this hour — try again in 25 min."],
    ["pending", { ok: false, refusal: "pending" }, "A request is already waiting in your DM."],
    ["dm_unavailable", { ok: false, refusal: "dm_unavailable" }, "Couldn't send you a DM. Open your DMs with the bot, then try again."],
    ["a §3 reason", { ok: false, refusal: "not_admin" }, "Your account is not a fleet admin here."],
  ])("an ask refused (%s) says why", async (_n, answer, text) => {
    const c = await chip({ state: "none", reason: "not_authorized" });
    askAnswer = answer;
    fire(c.querySelector("button"), "click"); await settle(8);
    expect(p.root.querySelector(".webauth-chip [role=status]").textContent).toBe(text);
  });
  it("pending: the countdown", async () => {
    const c = await chip({ state: "pending", expiresInMs: 125_000 });
    expect(c.textContent).toMatch(/Waiting for your Confirm in Discord or Telegram \(2:0\d\)/);
  });
  it.each([
    ["disabled", "Not verified: Web authority is turned off.", true],
    ["loopback_only", "Not verified: Only this computer can authorize, and this browser is not on it.", true],
    ["no_account", "Not verified: This browser was not signed in as an account (agend web): sign in with /web to authorize.", false],
    ["not_admin", "Not verified: Your account is not a fleet admin here.", false],
    ["token_rotated", "Not verified: The dashboard's token changed: sign in again.", false],
    ["something_new", "Not verified: This browser can't be authorized here.", false],
  ])("can't be authorized here (%s): says why, never offers the button", async (reason, text, settings) => {
    const c = await chip({ state: "none", reason });
    expect(c.textContent.trim()).toBe(settings ? `${text} Settings` : text);
    expect(c.querySelector("button")).toBeNull();
    expect(c.querySelector('a[href="/settings/access"]') !== null).toBe(settings);
  });
  // §0.3: over the public link the server answers too — Authorize while its link's option is on, why not while it is off.
  it("the temporary public link: asks the server like any page — the option off says how to turn it on (no Settings link: not over the link)", async () => {
    p.document.body.setAttribute("data-public-link", "1");
    const c = await chip({ state: "none", reason: "quick_link_off" });
    expect(c.textContent).toBe("Not verified: Over the temporary public link: turn on \"Also over the temporary public link\" in Settings → Access & security on this computer.");
    expect(c.querySelector('a[href="/settings/web"]')).toBeNull();
    expect(sent.filter(s => s.path === "/ui/authorization").length).toBe(1);
    const off = await chip({ state: "none", reason: "loopback_only" });
    expect(off.querySelector('a[href="/settings/web"]'), "#2525 review: no Settings link over the link").toBeNull();
  });
  it("the temporary public link with its option on: Authorize, as on this computer", async () => {
    p.document.body.setAttribute("data-public-link", "1");
    const c = await chip({ state: "none", reason: "not_authorized" });
    expect(c.querySelector("button")?.textContent).toBe("Authorize this browser");
  });
  it("one read per page load: a second line (the session menu's) and coming back read nothing", async () => {
    const c = await chip({ state: "verified", until: Date.now() + 3_600_000 });               // an hour ahead: never a fixed date (it expired 2026-10-20 09:00 UTC)
    expect(c).not.toBeNull();
    const { AuthorizeChip } = await import("/assets/web-authorize.js");
    sent.length = 0;
    await p.unmount();
    await p.mount(h(AuthorizeChip, {})); await settle(8);
    expect(p.root.querySelector(".webauth-chip").dataset.state).toBe("verified");
    expect(sent.filter(s => s.path === "/ui/authorization")).toEqual([]);
  });
  it("a guest's page has none, and asks nothing", async () => {
    p.document.body.setAttribute("data-tier", "guest");
    const c = await chip({ state: "none", reason: "not_authorized" });
    expect(c).toBeNull();
    expect(sent.filter(s => s.path === "/ui/authorization")).toEqual([]);
  });
});
