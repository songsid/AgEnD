/**
 * The composer's row (#2215, the user's request, 2026-10-19): this browser's web authority in a few words, sharing one row
 * with the key hint — what each state would say at length is in its tooltip and accessible name, and a tap shows it.
 * - Verified: "✓ Verified" only; when it ends is in the tooltip, the accessible name and the bubble a tap opens.
 * - Not verified: "Not verified · Authorize" (the button's tooltip and name say what it does); pressing it asks once,
 *   and what it answered is said in the row, in the hint's place — never laid over the composer (#2216 review).
 * - Waiting: the short countdown; the ask in its tooltip.
 * - Why it can't be authorized: "Not verified" with the reason in its tooltip and for screen readers; the switch off
 *   links to Settings → Web.
 * - The temporary public link: its sentence; a guest's page: nothing (the chat shows the guest's note).
 * - The chat's dock: one row, the authority before the hint.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage, state: any, askAnswer: any;
let sent: Array<{ method: string; path: string }> = [];
const realFetch = (globalThis as any).fetch;
const fakeFetch = async (path: string, init: { method?: string } = {}) => {
  const method = init.method ?? "GET";
  sent.push({ method, path });
  if (path === "/ui/authorization" && method === "POST") return { ok: askAnswer.ok, status: 200, json: async () => askAnswer };
  if (path === "/ui/authorization") return { ok: true, status: 200, json: async () => state };
  return { ok: true, status: 200, json: async () => ({}) };
};
beforeAll(() => { p = page({ url: "http://127.0.0.1:19280/ui/chat/alpha" }); (globalThis as any).fetch = fakeFetch; });
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(() => { sent = []; askAnswer = { ok: true, expiresInMs: 300_000 }; });
afterEach(async () => { await p.unmount(); p.document.body.removeAttribute("data-public-link"); p.document.body.removeAttribute("data-tier"); });

async function row(st: any) {
  state = st;
  const { ComposerAuth, resetWebAuthorization } = await import("/assets/web-authorize.js");
  resetWebAuthorization();
  await p.unmount();
  await p.mount(h(ComposerAuth, {}));
  await settle(8);
  return p.root.querySelector(".webauth-row") as any;
}
const tip = () => p.root.querySelector(".webauth-tip") as any;
const UNTIL = /speaks as you until \S/;

describe("the composer row's authority: a few words, the rest in its tooltip", () => {
  it("verified: '✓ Verified' only; until when is in the tooltip, the accessible name and the bubble a tap opens", async () => {
    const r = await row({ state: "verified", until: Date.now() + 3_600_000 });
    const ok = r.querySelector("button.webauth-ok");
    expect([r.dataset.state, ok.textContent, UNTIL.test(ok.getAttribute("title")), UNTIL.test(ok.getAttribute("aria-label")), ok.getAttribute("aria-expanded")])
      .toEqual(["verified", "✓ Verified", true, true, "false"]);
    expect([tip().hidden, ok.getAttribute("aria-controls") === tip().id]).toEqual([true, true]);
    fire(ok, "click"); await settle(4);
    expect([tip().hidden, UNTIL.test(tip().textContent), ok.getAttribute("aria-expanded")]).toEqual([false, true, "true"]);
    fire(ok, "click"); await settle(4);
    expect(tip().hidden).toBe(true);
    fire(ok, "click"); await settle(4); fire(ok, "blur"); await settle(4);
    expect(tip().hidden).toBe(true);                                                    // tapping elsewhere closes it
    fire(ok, "click"); await settle(4); fire(ok, "keydown", { key: "Escape" }); await settle(4);
    expect(tip().hidden).toBe(true);                                                    // and Escape
  });
  it("a bubble left open is closed by a state change: back to verified later, it is not open by itself", async () => {
    await row({ state: "verified", until: Date.now() + 1_500 });
    fire(p.root.querySelector("button.webauth-ok"), "click"); await settle(4);
    expect(tip().hidden).toBe(false);
    state = { state: "none", reason: "authorization_expired" };
    await new Promise((r) => setTimeout(r, 2_800)); await settle(8);                      // re-read at its end
    expect(p.root.querySelector(".webauth-row").dataset.state).toBe("none");
    state = { state: "verified", until: Date.now() + 3_600_000 };
    fire(p.root.querySelector("button.webauth-ask"), "click"); await settle(8);           // asked again; the next read says verified
    await new Promise((r) => setTimeout(r, 3_100)); await settle(8);
    expect([p.root.querySelector(".webauth-row").dataset.state, tip().hidden]).toEqual(["verified", true]);
  });
  it("not verified: 'Authorize' asks once; 'Sent —' is in the bubble (open), and the countdown in the row", async () => {
    const r = await row({ state: "none", reason: "not_authorized" });
    const btn = r.querySelector("button.webauth-ask");
    expect([btn.textContent, btn.getAttribute("title"), btn.getAttribute("aria-label")])
      .toEqual(["Authorize", "Not verified: authorize this browser to speak as you", "Not verified: authorize this browser to speak as you"]);
    expect(r.textContent).toBe("Not verified ·Authorize");                              // the state, then the button (its name says both)
    fire(btn, "click"); await settle(8);
    expect(sent.filter(s => s.method === "POST").map(s => s.path)).toEqual(["/ui/authorization"]);
    const after = p.root.querySelector(".webauth-row") as any;
    expect(after.dataset.state).toBe("pending");
    expect(after.querySelector(".note").textContent).toMatch(/^Waiting for your Confirm \(\d:\d\d\)$/);
    expect(after.querySelector(".note").getAttribute("title")).toMatch(/^Waiting for your Confirm in Discord or Telegram \(\d:\d\d\) — Sent — confirm it in your DM within 5 minutes\.$/);
    const said = after.querySelector(".webauth-notice");
    expect([said.textContent, said.getAttribute("role"), tip()]).toEqual(["Sent — confirm it in your DM within 5 minutes.", "status", null]);   // in the row, no bubble
  });
  it("a refused ask says why in the row", async () => {
    askAnswer = { ok: false, refusal: "dm_unavailable" };
    const r = await row({ state: "none", reason: "not_authorized" });
    fire(r.querySelector("button"), "click"); await settle(8);
    expect([p.root.querySelector(".webauth-notice").textContent, tip()]).toEqual(["Couldn't send you a DM. Open your DMs with the bot, then try again.", null]);
  });
  it("can't be authorized here: 'Not verified', the reason in its tooltip and for screen readers; the switch off links to Settings → Web", async () => {
    const off = await row({ state: "none", reason: "disabled" });
    const note = off.querySelector(".note");
    expect([note.getAttribute("title"), note.querySelector(".sr-only").textContent, off.querySelector('a[href="/settings/web"]')?.textContent])
      .toEqual(["Web authority is turned off.", ": Web authority is turned off.", "Settings"]);
    expect(note.textContent.replace(note.querySelector(".sr-only").textContent, "")).toBe("Not verified");
    const admin = await row({ state: "none", reason: "not_admin" });
    expect([admin.querySelector(".note").getAttribute("title"), admin.querySelector("a")]).toEqual(["Your account is not a fleet admin here.", null]);
  });
  it("the temporary public link: its sentence (the tooltip holds it too); a guest's page: nothing", async () => {
    p.document.body.setAttribute("data-public-link", "1");
    const pub = await row({ state: "none", reason: "public_link" });
    expect([pub.dataset.state, pub.textContent, pub.getAttribute("title")]).toEqual(["public", "Not on the temporary public link: open the dashboard directly to authorize.",
      "Not on the temporary public link: open the dashboard directly to authorize."]);
    p.document.body.removeAttribute("data-public-link");
    p.document.body.setAttribute("data-tier", "guest");
    expect(await row({ state: "none", reason: "not_admin_session" })).toBeNull();
  });
});
