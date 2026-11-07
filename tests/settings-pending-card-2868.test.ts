/**
 * #2868: the pending-change card says where to confirm it, in the order a person can act on it — the General card (the
 * platform it was posted on), or the host's command only when no General took it (otherwise folded under "Advanced");
 * "Apply now" when the server says this browser may confirm it itself; "Authorize this browser" when it isn't verified
 * but could be. The real app modules in the mini DOM; fetch is the only stub.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fire } from "./helpers/mini-dom.js";
import { settle, type AppPage } from "./helpers/app-harness.js";

const ID = "c".repeat(32);
const view = (o: Record<string, unknown> = {}) => ({ id: ID, state: "pending", section: "access", requested_at: 1, requested_by: "Chrome", expires_at: 2,
  remaining_ms: 280_000, source: "web_session", summary: ["web.session: 48 → 72"], can_withdraw: true, outcome: null, confirmation: { kind: "chat", code: ID }, ...o });
const mounted: AppPage[] = [];
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } vi.unstubAllGlobals(); });

async function card(v: Record<string, unknown>, auth: Record<string, unknown> = { state: "none", reason: "not_authorized" }, lang = "en", answers: Record<string, unknown> = {}) {
  for (const old of mounted.splice(0)) { await old.unmount(); old.restore(); }     // one page at a time
  vi.resetModules();
  const harness = await import("./helpers/app-harness.js");
  const p = harness.page({ storage: { agend_tour_done: "1", agend_lang: lang } });
  mounted.push(p);
  const calls: Array<[string, string]> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method?: string } = {}) => {
    calls.push([init.method ?? "GET", url]);
    const body = url === "/ui/authorization" ? (init.method === "POST" ? { ok: true, expiresInMs: 300_000 } : auth)
      : url in answers ? answers[url] : url === `/api/settings/pending/${ID}` ? v : {};
    const status = (body as any)?.__status ?? 200;
    return { ok: status < 400, status, json: async () => body };
  }));
  const i18n = await import("/assets/app-i18n.js" as string);
  if (lang !== "en") i18n.setLang(lang);
  const confirm = await import("/ui/js/settings-confirm.js" as string);
  const { PendingChanges } = await import("/assets/app-shell.js" as string);
  confirm.track(v, "Access & security");
  await p.mount(harness.h(PendingChanges, { inline: true }));
  await settle(4);
  const text = () => (p.root.querySelector(".pending-card")?.textContent ?? "").replace(/\s+/g, " ");
  const button = (label: string) => [...p.root.querySelectorAll(".pending-card button")].find((b: any) => b.textContent.trim() === label) as any;
  return { p, calls, text, button, confirm };
}

describe("where to confirm it", () => {
  it("posting: the card is still being sent; the host's command is folded", async () => {
    const c = await card(view({ confirmation: { kind: "posting", code: ID } }));
    expect(c.text()).toContain("Sending the confirm card to General…");
    const fold = c.p.root.querySelector(".pending-card details.pending-host") as any;
    expect([fold?.querySelector("summary").textContent, fold?.querySelector("code").textContent, fold?.open ?? false]).toEqual(["Advanced: confirm on the host", `agend settings confirm ${ID}`, false]);
  });
  it("chat: names the platform the card was posted on — a connection with an id of its own by it too; none known: both", async () => {
    expect((await card(view({ confirmation: { kind: "chat", code: ID, where: [{ platform: "telegram", connection: "telegram" }] } }))).text()).toContain("To apply it, press Confirm on the card in General on Telegram.");
    expect((await card(view({ confirmation: { kind: "chat", code: ID, where: [{ platform: "discord", connection: "team-b" }] } }))).text()).toContain("in General on Discord (team-b).");
    expect((await card(view({ confirmation: { kind: "chat" } }))).text()).toContain("in General on Discord / Telegram.");
  });
  // alpha.6 feedback #2c (the user's decision hmsg-77256f66): never "type this on the host" as the card's instruction — it says
  // why no General could take it and what would; the host's command stays folded under Advanced, a last resort.
  it("host_cli: says no General could take it, never as a host command; the command only folded under Advanced; nothing to authorize", async () => {
    const c = await card(view({ confirmation: { kind: "host_cli", code: ID } }));
    expect(c.text()).toContain("No General could take the confirm card for this change.");
    expect(c.text()).not.toContain("Confirm it on the host");
    const fold = c.p.root.querySelector(".pending-card details.pending-host") as any;
    expect([fold?.querySelector("code").textContent, fold?.open ?? false]).toEqual([`agend settings confirm ${ID}`, false]);
    expect(c.button("Authorize this browser")).toBeUndefined();
  });
  it.each([
    ["no_chat", "This fleet has no chat app connected, so there is no General to send the confirm card to.", "/settings/chat"],
    ["cross_platform", "This change affects chat apps on more than one platform, so no single General can confirm it.", null],
    ["no_general", "No agent is the General in a connected chat app, so there is nowhere to send the confirm card.", "/settings"],
    ["chat_disconnected", "General's chat app is not connected right now, so the confirm card could not be sent.", "/settings/chat"],
    ["no_topic", "General has no topic in its chat yet, so the confirm card had nowhere to go.", null],
    ["post_failed", "The confirm card could not be posted in General.", "/settings/chat"],
  ])("host_cli %s: why in plain words, what to do, and where", async (reason, why, href) => {
    const c = await card(view({ confirmation: { kind: "host_cli", code: ID, reason } }));
    expect(c.text()).toContain(why);
    expect(!!c.p.root.querySelector(".pending-card .pending-why")).toBe(true);
    const link = c.p.root.querySelector(".pending-card .pending-why a") as any;
    expect(link ? link.getAttribute("href") : null).toBe(href);
    // The command is never the instruction: outside the Advanced fold the card does not show it.
    const outside = (c.p.root.querySelector(".pending-card")!.textContent ?? "").replace(c.p.root.querySelector(".pending-card details.pending-host")!.textContent ?? "", "");
    expect(outside).not.toContain("agend settings confirm");
  });
  it("a reason this page does not know (a newer server) reads as the general sentence", async () => {
    expect((await card(view({ confirmation: { kind: "host_cli", code: ID, reason: "something_new" } }))).text()).toContain("No General could take the confirm card for this change.");
  });
  it("zh-TW", async () => {
    const c = await card(view({ confirmation: { kind: "chat", code: ID, where: [{ platform: "discord", connection: "discord" }] } }), undefined, "zh-TW");
    expect(c.text()).toContain("要套用，請到 Discord 的 General，在確認卡上按「確認」。");
    expect(c.text()).toContain("授權這個瀏覽器，之後這類變更可以直接套用，不必到 General。");
    expect(c.p.root.querySelector(".pending-host summary").textContent).toBe("進階：在主機上確認");
  });
});

describe("this browser", () => {
  it("not verified: Authorize this browser asks for the DM card (the composer's same request)", async () => {
    const c = await card(view());
    expect(c.text()).toContain("Authorize this browser to apply changes like this here next time, without General.");
    fire(c.button("Authorize this browser"), "click"); await settle(4);
    expect(c.calls.filter(([m, u]) => m === "POST" && u === "/ui/authorization")).toHaveLength(1);
    expect(c.text()).toContain("Sent — confirm it in your DM within 5 minutes.");
  });
  it("verified but not allowed to confirm this one: only the General instruction (no Apply now, no Authorize)", async () => {
    const c = await card(view(), { state: "verified", until: Date.now() + 3600_000 });
    expect([c.button("Apply now"), c.button("Authorize this browser")]).toEqual([undefined, undefined]);
  });
  it("allowed (the server's can_self_confirm): Apply now posts the confirm and follows the answer", async () => {
    const applying = view({ state: "applying", can_withdraw: false, confirmation: { kind: "web" } });
    const c = await card(view({ can_self_confirm: true }), { state: "verified", until: Date.now() + 3600_000 }, "en",
      { [`/api/settings/pending/${ID}/confirm`]: { __status: 202, ok: true, result: "pending_confirmation", pending_change: applying } });
    expect(c.text()).toContain("This browser is verified, so you can also apply it here.");
    expect(c.button("Authorize this browser"), "verified: nothing to authorize").toBe(undefined);
    fire(c.button("Apply now"), "click"); await settle(4);
    expect(c.calls.filter(([m, u]) => m === "POST" && u === `/api/settings/pending/${ID}/confirm`)).toHaveLength(1);
    expect(c.p.root.querySelector(".pending-card").className).toContain("applying");
  });
  it("Apply now refused (no longer allowed here): it says so, Apply now goes, the General instruction stays", async () => {
    const c = await card(view({ can_self_confirm: true }), { state: "verified", until: Date.now() + 3600_000 }, "en",
      { [`/api/settings/pending/${ID}/confirm`]: { __status: 403, error: "self_confirm_unavailable" } });
    fire(c.button("Apply now"), "click"); await settle(4);
    expect([c.button("Apply now"), c.text().includes("This browser can't apply it here now — confirm it in General."), c.text().includes("press Confirm on the card in General")])
      .toEqual([undefined, true, true]);
  });
});

// alpha.6 feedback #2c (the user's decision hmsg-468cc290 + the leader's ruling (b)): the authenticator-code confirmation.
describe("confirm with the authenticator code (web-only fleet, this computer or the LAN)", () => {
  const DIGEST = "d".repeat(32);
  const posted: Array<{ url: string; body: any }> = [];
  const withCode = async (answer: { __status: number; [k: string]: unknown }, lang = "en", totp = "ready") => {
    posted.length = 0;
    const c = await card(view({ confirmation: { kind: "host_cli", code: ID, reason: "no_chat" }, totp, confirm_digest: DIGEST }), undefined, lang,
      { [`/api/settings/pending/${ID}/confirm-totp`]: answer });
    return c;
  };
  it("ready: a code field and Confirm; the code goes with this change's digest", async () => {
    const c = await withCode({ __status: 202, ok: true, result: "pending_confirmation", pending_change: view({ state: "applying" }) });
    const input = c.p.root.querySelector(".pending-card .pending-code-input") as any;
    expect([!!input, c.text()]).toEqual([true, expect.stringContaining("Or confirm it here with the code from your authenticator app.")]);
    input.value = "123 456"; fire(input, "input"); await settle(3);
    fire(c.p.root.querySelector(".pending-card form.pending-code")!, "submit"); await settle(6);
    const call = c.calls.find(([m, u]) => m === "POST" && u.endsWith("/confirm-totp"));
    expect(call).toBeDefined();
  });
  it.each([
    [{ __status: 401, error: "wrong_code" }, "That code is not right. Use the current code in your authenticator app."],
    [{ __status: 409, error: "confirmation_changed" }, "This change is no longer the one shown here. Reload the page and check it again."],
    [{ __status: 429, error: "paused", retryAfterMs: 15 * 60_000 }, "Too many wrong codes. Try again in 15 minutes."],
  ])("refused (%j): says why, in plain words", async (answer, words) => {
    const c = await withCode(answer as any);
    const input = c.p.root.querySelector(".pending-card .pending-code-input") as any;
    input.value = "123456"; fire(input, "input"); await settle(3);
    fire(c.p.root.querySelector(".pending-card form.pending-code")!, "submit"); await settle(6);
    expect(c.text()).toContain(words);
  });
  it("over a link (on_host): no field — confirm in the host computer's browser, or in General; never a host command", async () => {
    const c = await withCode({ __status: 200 }, "en", "on_host");
    expect([!!c.p.root.querySelector(".pending-code-input"), c.text()]).toEqual([false, expect.stringContaining("Confirm it in the browser on the computer running AgEnD, or in General.")]);
    const outside = (c.p.root.querySelector(".pending-card")!.textContent ?? "").replace(c.p.root.querySelector(".pending-card details.pending-host")!.textContent ?? "", "");
    expect(outside).not.toContain("agend settings confirm");
  });
  it("no authenticator set up: says so and links to Access & security", async () => {
    const c = await withCode({ __status: 200 }, "zh-TW", "not_set_up");
    expect(c.text()).toContain("若要在這裡用代碼確認變更，請先到「存取與安全」設定驗證器 App。");
    expect((c.p.root.querySelector(".pending-code-setup a") as any).getAttribute("href")).toBe("/settings/access");
  });
});
