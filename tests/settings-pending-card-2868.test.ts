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
    expect([!!input, c.text()]).toEqual([true, expect.stringContaining("Enter the 6-digit code from your authenticator app to confirm this change.")]);
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
  it("over a link (on_host): no field — confirm from the computer running AgEnD; never a host command", async () => {
    const c = await withCode({ __status: 200 }, "en", "on_host");
    expect([!!c.p.root.querySelector(".pending-code-input"), c.text()]).toEqual([false, expect.stringContaining("This device can't confirm this change over a link. Do it from the computer running AgEnD.")]);
    const outside = (c.p.root.querySelector(".pending-card")!.textContent ?? "").replace(c.p.root.querySelector(".pending-card details.pending-host")!.textContent ?? "", "");
    expect(outside).not.toContain("agend settings confirm");
  });
  it("no authenticator set up: says so and links to Access & security", async () => {
    const c = await withCode({ __status: 200 }, "zh-TW", "not_set_up");
    expect(c.text()).toContain("你目前在這台裝置還無法直接確認這項變更。");
    expect(c.text()).toContain("請先綁定驗證器 App。這張卡會留在這裡：綁好之後，直接在卡片上輸入 App 的 6 位數代碼。");
    expect((c.p.root.querySelector(".pending-code-setup a") as any).getAttribute("href")).toBe("/settings/access");
  });
});

// AGEND-118: the card says ONE next step this device can take, by state; the other ways are folded, the host's command last.
describe("one next step, by state", () => {
  const NOCHAT = { kind: "host_cli", code: ID, reason: "no_chat" };
  /** What the card shows without opening "Other ways to confirm". */
  const shown = (c: Awaited<ReturnType<typeof card>>) => {
    const root = c.p.root.querySelector(".pending-card");
    return (root.textContent ?? "").replace(root.querySelector("details.pending-host")?.textContent ?? "", "").replace(/\s+/g, " ");
  };
  const fold = (c: Awaited<ReturnType<typeof card>>) => c.p.root.querySelector(".pending-card details.pending-host") as any;

  it("authenticator set up: the code field is the step, at once — no Apply now, no host command outside the fold", async () => {
    const c = await card(view({ confirmation: NOCHAT, totp: "ready", confirm_digest: "d".repeat(32) }));
    expect(!!c.p.root.querySelector(".pending-card .pending-code-input")).toBe(true);
    expect(shown(c)).toContain("Enter the 6-digit code from your authenticator app");
    expect(shown(c)).not.toContain("Apply now");
    expect(shown(c)).not.toContain("agend settings confirm");
    expect([fold(c).querySelector("summary").textContent, fold(c).open ?? false]).toEqual(["Other ways to confirm", false]);
  });
  it("not set up, away from the host: says this device can't confirm yet, the way to set it up and what happens next; the rest folded", async () => {
    const c = await card(view({ confirmation: NOCHAT, totp: "not_set_up" }));
    const text = shown(c);
    expect(text).toContain("This device can't confirm this change yet.");
    expect(text).toContain("once it is set up, enter its 6-digit code on the card. If the time runs out before that, make the change again.");
    expect(text).not.toContain("Apply now");               // nothing here can press it: never mentioned as a step
    expect(text).not.toContain("agend settings confirm");
    expect((c.p.root.querySelector(".pending-code-setup a.btn-primary") as any).getAttribute("href")).toBe("/settings/access");
    expect((c.p.root.querySelector(".pending-code-setup a") as any).textContent.trim()).toBe("Set up authenticator");
    // Folded: the host's own browser (where Apply now exists), and the command with the id on screen.
    const more = fold(c).textContent.replace(/\s+/g, " ");
    expect(more).toContain("press Apply now on this card.");
    expect(fold(c).querySelector("code").textContent).toBe(`agend settings confirm ${ID}`);
  });
  it("the command's Copy button copies the whole command", async () => {
    const written: string[] = [];
    const c = await card(view({ confirmation: NOCHAT, totp: "not_set_up" }));
    vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => { written.push(t); } } });
    const copy = [...fold(c).querySelectorAll("button")].find((b: any) => b.textContent.trim() === "Copy") as any;
    fire(copy, "click"); await settle(4);
    expect(written).toEqual([`agend settings confirm ${ID}`]);
    expect(copy.textContent.trim()).toBe("Copied");
  });
  it("the browser may press Apply now (host): that is the step, said once, with the button", async () => {
    const c = await card(view({ confirmation: NOCHAT, can_self_confirm: true }));
    expect(shown(c)).toContain("Press Apply now to confirm this change from this browser.");
    expect(c.button("Apply now")).toBeDefined();
    expect(shown(c)).not.toContain("This browser is verified");
  });
  it("Apply now refused: the card stops offering it and says to use another way", async () => {
    const c = await card(view({ confirmation: NOCHAT, can_self_confirm: true }), undefined, "en", { [`/api/settings/pending/${ID}/confirm`]: { __status: 403, error: "self_confirm_unavailable" } });
    fire(c.button("Apply now"), "click"); await settle(4);
    expect([c.button("Apply now"), shown(c).includes("can't apply it here now. Use one of the other ways to confirm.")]).toEqual([undefined, true]);
  });
  it("no way open to this page (no flags): never mentions Apply now; the reason and what to do come first", async () => {
    const c = await card(view({ confirmation: NOCHAT }));
    expect(c.text()).not.toContain("Apply now");
    expect(shown(c)).toContain("This fleet has no chat app connected");
  });
  it("over a link / a link option: only where to do it — the host's command folded", async () => {
    const link = await card(view({ confirmation: NOCHAT, totp: "on_host" }));
    expect(shown(link)).toContain("Do it from the computer running AgEnD.");
    expect(shown(link)).not.toContain("agend settings confirm");
    const hostOnly = await card(view({ confirmation: NOCHAT, totp: "host_browser" }));
    expect(shown(hostOnly)).toContain("only the browser on the computer running AgEnD can confirm it");
    expect(fold(hostOnly).querySelector("code").textContent).toBe(`agend settings confirm ${ID}`);
  });
  it("zh-TW: the same steps; the button reads the same as the text that names it", async () => {
    const c = await card(view({ confirmation: NOCHAT, can_self_confirm: true }), undefined, "zh-TW");
    expect(shown(c)).toContain("按「立即套用」，就能在這個瀏覽器確認這項變更。");
    expect(c.button("立即套用")).toBeDefined();
    const setup = await card(view({ confirmation: NOCHAT, totp: "not_set_up" }), undefined, "zh-TW");
    expect(shown(setup)).toContain("你目前在這台裝置還無法直接確認這項變更。");
    expect((setup.p.root.querySelector(".pending-code-setup a") as any).textContent.trim()).toBe("綁定驗證器");
    expect(fold(setup).querySelector("summary").textContent).toBe("其他確認方式");
  });
});

describe("a change that did not go through says why, and can be sent again", () => {
  const ended = (state: string, reason: string, message = "server words") => view({ state, can_withdraw: false, remaining_ms: 0,
    outcome: { state, reason_code: reason, message, decided_at: 1 } });
  it.each([
    ["rejected", "withdrawn", "You withdrew this change, so nothing was changed.", "你已撤回這項變更，沒有任何設定被修改。"],
    ["rejected", "rejected", "An admin turned it down, so nothing was changed.", "管理者拒絕了這項變更，沒有任何設定被修改。"],
    ["expired", "expired", "No one confirmed it within 5 minutes, so nothing was changed.", "5 分鐘內沒有人確認，所以沒有任何設定被修改。"],
    ["expired", "not_found", "AgEnD is no longer holding this request (it timed out or was cleared), so nothing was changed.", "AgEnD 已經沒有這項等待中的請求（已逾時或已清除），沒有任何設定被修改。"],
    ["stale", "settings_changed", "Settings changed after you asked for this, so it was not applied.", "你送出之後設定又被修改了，所以沒有套用。"],
    ["stale", "request_no_longer_current", "The sign-in that asked for it ended, or the fleet changed, so it was not applied.", "送出這項變更的登入已結束，或 fleet 有變動，所以沒有套用。"],
    ["stale", "fleet_stopped", "AgEnD stopped before it could be applied.", "AgEnD 在套用前停止了。"],
  ])("%s / %s: the reason in the page's language", async (state, reason, en, zh) => {
    expect((await card(ended(state, reason))).text()).toContain(en);
    expect((await card(ended(state, reason), undefined, "zh-TW")).text()).toContain(zh);
    expect((await card(ended(state, reason))).text()).not.toContain("server words");
  });
  it("a failed apply (or a reason a newer server adds) keeps the server's own sentence", async () => {
    expect((await card(ended("failed", "apply_failed", "Change could not be applied."))).text()).toContain("Change could not be applied.");
    expect((await card(ended("rejected", "something_new", "A new reason."))).text()).toContain("A new reason.");
  });
  it("no Send again where the page no longer has the request (tracked from a reload)", async () => {
    expect((await card(ended("rejected", "withdrawn"))).button("Send again")).toBeUndefined();
  });

  // The same write, again: confirmedWrite keeps how to send it until the card is gone.
  async function written(section: string, answers: Array<Record<string, unknown>>) {
    for (const old of mounted.splice(0)) { await old.unmount(); old.restore(); }
    vi.resetModules();
    const harness = await import("./helpers/app-harness.js");
    const p = harness.page({ storage: { agend_tour_done: "1", agend_lang: "en" } });
    mounted.push(p);
    const sent: Array<{ method: string; url: string; key: string | null; body: string | null }> = [];
    const first = "a".repeat(32), second = "b".repeat(32);
    let puts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? "GET";
      sent.push({ method, url, key: init.headers?.["Idempotency-Key"] ?? null, body: init.body ?? null });
      let body: unknown = {};
      if (method === "PUT") body = { __status: 202, ok: true, result: "pending_confirmation", pending_change: view({ id: puts++ === 0 ? first : second, section }) };
      else if (method === "DELETE") body = view({ id: first, section, state: "rejected", can_withdraw: false, remaining_ms: 0, outcome: { state: "rejected", reason_code: "withdrawn", message: "x", decided_at: 1 } });
      else if (url === "/ui/authorization") body = { state: "none", reason: "not_authorized" };
      else if (url === `/api/settings/pending/${second}`) body = view({ id: second, section });
      else if (url === `/api/settings/pending/${first}`) body = view({ id: first, section });
      if (method === "PUT" && puts > 1 && answers.length) body = answers.shift();
      const status = (body as any)?.__status ?? 200;
      return { ok: status < 400, status, json: async () => body };
    }));
    const i18n = await import("/assets/app-i18n.js" as string); void i18n;
    const confirm = await import("/ui/js/settings-confirm.js" as string);
    const { PendingChanges } = await import("/assets/app-shell.js" as string);
    await p.mount(harness.h(PendingChanges, { inline: true }));
    const result = confirm.confirmedWrite("/api/settings/fleet/runtimes", { method: "PUT", body: { windows_cli: true }, label: "CLI on Windows" });
    await settle(4);
    const button = (label: string) => [...p.root.querySelectorAll(".pending-card button")].find((b: any) => b.textContent.trim() === label) as any;
    fire(button("Withdraw"), "click"); await settle(6);
    return { p, sent, result, button, first, second };
  }
  it("Send again: the same request with a key of its own, held for a new confirmation; its card replaces the old", async () => {
    const w = await written("access", []);
    expect((await w.result).ok).toBe(false);            // the writer is told it did not go through
    expect(w.p.root.querySelector(".pending-card").className).toContain("rejected");
    fire(w.button("Send again"), "click"); await settle(6);
    const puts = w.sent.filter(r => r.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[1].body).toBe(puts[0].body);
    expect([puts[0].key, puts[1].key].every(Boolean) && puts[0].key !== puts[1].key).toBe(true);
    const cards = [...w.p.root.querySelectorAll(".pending-card")];
    expect(cards.map((el: any) => [el.getAttribute("data-pending"), el.className.includes("pending")])).toEqual([[w.second, true]]);
  });
  it("Send again refused (the server says no): says so; the card stays", async () => {
    const w = await written("access", [{ __status: 409, error: "revision_conflict" }]);
    fire(w.button("Send again"), "click"); await settle(6);
    expect(w.p.root.textContent).toContain("It could not be sent again. Make the change again in Settings.");
    expect(w.button("Send again")).toBeDefined();
  });
  it("a request that touches a secret is never kept to be sent again", async () => {
    const w = await written("secret", []);
    expect(w.p.root.querySelector(".pending-card").className).toContain("rejected");
    expect(w.button("Send again")).toBeUndefined();
  });
});
