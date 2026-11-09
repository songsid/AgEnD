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
    let outside = c.p.root.querySelector(".pending-card")!.textContent ?? "";
    for (const d of c.p.root.querySelectorAll(".pending-card details")) outside = outside.replace(d.textContent ?? "", "");
    expect(outside).not.toContain("agend settings confirm");
  });
  it("no authenticator set up: says so and links to Access & security", async () => {
    const c = await withCode({ __status: 200 }, "zh-TW", "not_set_up");
    expect(c.text()).toContain("你目前在這台裝置還無法直接確認這項變更。");
    expect(c.text()).toContain("請先綁定驗證器 App。這張卡會留在這裡：綁好之後，直接在卡片上輸入 App 的 6 位數代碼。");
    expect((c.p.root.querySelector(".pending-code-setup a") as any).getAttribute("href")).toBe("/settings/access");
  });
});

// AGEND-118: the card says ONE next step this device can take, by state; the other ways are folded. The host's command stays
// where it was before (folded under "Advanced"), bare: the card never tells the person to run it and has no Copy for it.
describe("one next step, by state", () => {
  const NOCHAT = { kind: "host_cli", code: ID, reason: "no_chat" };
  /** What the card shows without opening a fold. */
  const shown = (c: Awaited<ReturnType<typeof card>>) => {
    const root = c.p.root.querySelector(".pending-card");
    let text = root.textContent ?? "";
    for (const d of root.querySelectorAll("details")) text = text.replace(d.textContent ?? "", "");
    return text.replace(/\s+/g, " ");
  };
  const folds = (c: Awaited<ReturnType<typeof card>>) => [...c.p.root.querySelectorAll(".pending-card details")] as any[];
  /** The fold named by its summary: "Other ways to confirm" or the bare command's "Advanced: confirm on the host". */
  const fold = (c: Awaited<ReturnType<typeof card>>, summary: string) => folds(c).find(d => d.querySelector("summary").textContent === summary);
  const OTHERS = "Other ways to confirm", ADVANCED = "Advanced: confirm on the host";
  const noHostCommandPromotion = (c: Awaited<ReturnType<typeof card>>) => {
    expect(c.text()).not.toMatch(/run:|run this command|執行：|執行這行指令/);
    expect([...c.p.root.querySelectorAll(".pending-card button")].map((b: any) => b.textContent.trim())).not.toContain("Copy");
  };

  it("authenticator set up: the code field is the step, at once — no Apply now, no host command outside the fold", async () => {
    const c = await card(view({ confirmation: NOCHAT, totp: "ready", confirm_digest: "d".repeat(32) }));
    expect(!!c.p.root.querySelector(".pending-card .pending-code-input")).toBe(true);
    expect(shown(c)).toContain("Enter the 6-digit code from your authenticator app");
    expect(shown(c)).not.toContain("Apply now");
    expect(shown(c)).not.toContain("agend settings confirm");
    // Nothing but the step and the folded bare command as before: no "other ways" fold, no instruction to run it, no Copy.
    expect(folds(c).map(d => [d.querySelector("summary").textContent, d.open ?? false])).toEqual([[ADVANCED, false]]);
    expect(fold(c, ADVANCED).querySelector("code").textContent).toBe(`agend settings confirm ${ID}`);
    noHostCommandPromotion(c);
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
    // Folded: the host's own browser (where Apply now exists); the bare command stays under Advanced, as before.
    expect(fold(c, OTHERS).textContent.replace(/\s+/g, " ")).toContain("press Apply now on this card.");
    expect(fold(c, ADVANCED).querySelector("code").textContent).toBe(`agend settings confirm ${ID}`);
    noHostCommandPromotion(c);
  });
  it("no mode tells the person to run the host command or offers to copy it (style guide rule 9)", async () => {
    for (const v of [{ totp: "ready", confirm_digest: "d".repeat(32) }, { totp: "not_set_up" }, { totp: "on_host" }, { totp: "host_browser" }, { can_self_confirm: true }, {}]) {
      for (const lang of ["en", "zh-TW"]) {
        const c = await card(view({ confirmation: NOCHAT, ...v }), undefined, lang);
        noHostCommandPromotion(c);
        expect(fold(c, lang === "en" ? ADVANCED : "進階：在主機上確認").querySelector("code").textContent).toBe(`agend settings confirm ${ID}`);
      }
    }
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
    expect(fold(hostOnly, ADVANCED).querySelector("code").textContent).toBe(`agend settings confirm ${ID}`);
  });
  it("zh-TW: the same steps; the button reads the same as the text that names it", async () => {
    const c = await card(view({ confirmation: NOCHAT, can_self_confirm: true }), undefined, "zh-TW");
    expect(shown(c)).toContain("按「立即套用」，就能在這個瀏覽器確認這項變更。");
    expect(c.button("立即套用")).toBeDefined();
    const setup = await card(view({ confirmation: NOCHAT, totp: "not_set_up" }), undefined, "zh-TW");
    expect(shown(setup)).toContain("你目前在這台裝置還無法直接確認這項變更。");
    expect((setup.p.root.querySelector(".pending-code-setup a") as any).textContent.trim()).toBe("綁定驗證器");
    expect(fold(setup, "其他確認方式").textContent).toContain("到執行 AgEnD 的那台電腦，用它自己的瀏覽器開啟 AgEnD，在這張卡上按「立即套用」。");
  });
});

describe("a change that did not go through says why, and can be sent again", () => {
  const ended = (state: string, reason: string, message = "server words") => view({ state, can_withdraw: false, remaining_ms: 0,
    outcome: { state, reason_code: reason, message, decided_at: 1 } });
  it.each([
    ["rejected", "withdrawn", "You withdrew this change, so nothing was changed.", "你已撤回這項變更，沒有任何設定被修改。"],
    ["rejected", "rejected", "An admin turned it down, so nothing was changed.", "管理者拒絕了這項變更，沒有任何設定被修改。"],
    // Not "no one confirmed it": a change that was confirmed and still applying when the five minutes ran out ends as expired too.
    ["expired", "expired", "It was not completed within 5 minutes. Check what the settings are now.", "5 分鐘內沒有完成，請確認設定目前的內容。"],
    ["expired", "not_found", "AgEnD no longer has this request (it timed out or was cleared). Check what the settings are now.", "AgEnD 已經沒有這項請求（已逾時或已清除），請確認設定目前的內容。"],
    ["stale", "settings_changed", "Settings changed after you asked for this, so it was not applied. Review them and make the change again in Settings.", "你送出之後設定又被修改了，所以沒有套用。請檢查設定後，到設定重新做一次這項變更。"],
    ["stale", "request_no_longer_current", "The sign-in that asked for it ended, or the fleet changed, so it was not applied. Make the change again in Settings.", "送出這項變更的登入已結束，或 fleet 有變動，所以沒有套用。請到設定重新做一次這項變更。"],
    ["stale", "fleet_stopped", "AgEnD stopped before it could be applied. Make the change again in Settings.", "AgEnD 在套用前停止了。請到設定重新做一次這項變更。"],
  ])("%s / %s: the reason in the page's language", async (state, reason, en, zh) => {
    expect((await card(ended(state, reason))).text()).toContain(en);
    expect((await card(ended(state, reason), undefined, "zh-TW")).text()).toContain(zh);
    expect((await card(ended(state, reason))).text()).not.toContain("server words");
    expect((await card(ended(state, reason))).text()).not.toContain("No one confirmed");
  });
  // The title said "nothing was changed", which is not so for a change confirmed and still applying when the five minutes ran
  // out (it ends as expired too): the title only says it expired, and the text under it says what to check.
  it.each([["en", "Expired", "nothing was changed"], ["zh-TW", "已逾時", "沒有任何變更"]])("an expired card's title (%s) does not claim nothing changed", async (lang, title, claim) => {
    for (const reason of ["expired", "not_found"]) {
      const c = await card(ended("expired", reason), undefined, lang);
      const head = c.p.root.querySelector(".pending-card .pending-head strong").textContent.trim();
      expect([head, head.includes(claim), c.text().includes(claim)]).toEqual([title, false, false]);
    }
  });
  it("a failed apply (or a reason a newer server adds) keeps the server's own sentence", async () => {
    expect((await card(ended("failed", "apply_failed", "Change could not be applied."))).text()).toContain("Change could not be applied.");
    expect((await card(ended("rejected", "something_new", "A new reason."))).text()).toContain("A new reason.");
  });
  it("no Send again where the page no longer has the request (tracked from a reload)", async () => {
    expect((await card(ended("rejected", "withdrawn"))).button("Send again")).toBeUndefined();
  });

  // The same write, again — only for a caller that said its body holds nothing sensitive (`resendable`). The fetch stub answers the
  // write (or its resends) from `answers`, in order: a body, { __throw } (no answer at all) or { __unreadable } (an accepted answer
  // that cannot be read); the first write is always held for confirmation and withdrawn from the card.
  type Ended = { state: string; reason: string };
  async function written(o: { section?: string; answers?: Array<Record<string, unknown>>; ending?: Ended; resendable?: boolean; via?: "write" | "operation"; body?: Record<string, any> } = {}) {
    const { section = "access", answers = [], ending = { state: "rejected", reason: "withdrawn" }, resendable = true, via = "write" } = o;
    const body = o.body ?? { windows_cli: true };
    const WRITE = via === "operation" ? { method: "POST", url: "/api/settings/quickstart/commit" } : { method: "PUT", url: "/api/settings/fleet/runtimes" };
    for (const old of mounted.splice(0)) { await old.unmount(); old.restore(); }
    vi.resetModules();
    const harness = await import("./helpers/app-harness.js");
    const p = harness.page({ storage: { agend_tour_done: "1", agend_lang: "en" } });
    mounted.push(p);
    const sent: Array<{ method: string; url: string; key: string | null; body: string | null }> = [];
    const ids = ["a", "b", "c", "d"].map(ch => ch.repeat(32));
    let writes = 0;
    const queue = [...answers];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? "GET";
      sent.push({ method, url, key: init.headers?.["Idempotency-Key"] ?? null, body: init.body ?? null });
      let answer: any = {};
      const decided = (id: string) => view({ id, section, state: ending.state, can_withdraw: false, remaining_ms: 0, outcome: { state: ending.state, reason_code: ending.reason, message: "x", decided_at: 1 } });
      if (method === WRITE.method && url === WRITE.url) {
        const n = writes++;
        answer = n > 0 && queue.length ? queue.shift() : { __status: 202, ok: true, result: "pending_confirmation", pending_change: view({ id: ids[Math.min(n, ids.length - 1)], section }) };
      } else if (method === "DELETE") answer = decided(url.split("/").pop()!);
      else if (url === "/ui/authorization") answer = { state: "none", reason: "not_authorized" };
      else if (url.startsWith("/api/settings/pending/")) answer = view({ id: url.split("/").pop()!, section });
      if (answer.__throw) throw new TypeError("network");
      const status = answer?.__status ?? 200;
      return { ok: status < 400, status, json: async () => { if (answer.__unreadable) throw new SyntaxError("not json"); return answer; } };
    }));
    const i18n = await import("/assets/app-i18n.js" as string); void i18n;
    const confirm = await import("/ui/js/settings-confirm.js" as string);
    const { PendingChanges } = await import("/assets/app-shell.js" as string);
    const { appStore } = await import("/assets/app-store.js" as string);
    await p.mount(harness.h(PendingChanges, { inline: true }));
    let result: Promise<any>;
    if (via === "operation") {
      // The real Add bot request (settings-dialogs.js): a raw token in the body, the request marked sensitive, through the real operation.
      const apply = await import("/ui/js/settings-apply.js" as string);
      apply.resetOperation();
      apply.startOperation([{ label: "Add bot", impact: null, request: { method: WRITE.method, url: WRITE.url, body, sensitive: true } }]);
      result = Promise.resolve({ ok: false });
    } else result = confirm.confirmedWrite(WRITE.url, { method: WRITE.method, body, label: "CLI on Windows", ...(resendable ? { resendable: true } : {}) });
    await settle(4);
    const button = (label: string) => [...p.root.querySelectorAll(".pending-card button")].find((b: any) => b.textContent.trim() === label) as any;
    fire(button("Withdraw"), "click"); await settle(6);
    const writeCalls = () => sent.filter(r => r.method === WRITE.method && r.url === WRITE.url);
    const retained = () => (appStore.get().pendingChanges ?? []).map((c: any) => !!c.retry);
    return { p, sent, result, button, ids, body, writeCalls, retained };
  }
  const press = async (w: Awaited<ReturnType<typeof written>>) => { fire(w.button("Send again"), "click"); await settle(8); };
  const cardIds = (w: Awaited<ReturnType<typeof written>>) => [...w.p.root.querySelectorAll(".pending-card")].map((el: any) => [el.getAttribute("data-pending"), el.className.includes("pending")]);

  it("Send again: the same request with a key of its own, held for a new confirmation; its card replaces the old", async () => {
    const w = await written();
    expect((await w.result).ok).toBe(false);            // the writer is told it did not go through
    expect(w.p.root.querySelector(".pending-card").className).toContain("rejected");
    await press(w);
    const puts = w.writeCalls();
    expect(puts).toHaveLength(2);
    expect(puts[1].body).toBe(puts[0].body);
    expect([puts[0].key, puts[1].key].every(Boolean) && puts[0].key !== puts[1].key).toBe(true);
    expect(cardIds(w)).toEqual([[w.ids[1], true]]);
  });
  it("it sends what was handed off, not what the caller's objects say later (review-checklist row 5)", async () => {
    const w = await written({ body: { windows_cli: true, nested: { on: [1] } } });
    w.body.nested.on.push(2); w.body.windows_cli = false;       // the caller reuses its object after the hand-off
    await press(w);
    expect(w.writeCalls().map(r => r.body)).toEqual([JSON.stringify({ windows_cli: true, nested: { on: [1] } }), JSON.stringify({ windows_cli: true, nested: { on: [1] } })]);
  });
  it("two quick clicks on Send again send it once (one claim per operation)", async () => {
    const w = await written();
    const again = w.button("Send again");
    fire(again, "click"); fire(again, "click"); await settle(8);
    expect(w.writeCalls()).toHaveLength(2);        // the first write, and one send again
  });
  it("Send again refused (the server says no): says so; the card stays; the next press is a new request with a new key", async () => {
    const w = await written({ answers: [{ __status: 409, error: "revision_conflict" }] });
    await press(w);
    expect(w.p.root.textContent).toContain("It could not be sent again. Make the change again in Settings.");
    expect(w.button("Send again")).toBeDefined();
    await press(w);                                // a refusal is a definite answer: nothing was made, so nothing to rejoin
    const keys = w.writeCalls().map(r => r.key);
    expect([keys.length, new Set(keys).size]).toEqual([3, 3]);
    expect(cardIds(w)).toEqual([[w.ids[2], true]]);
  });

  // Prism's P2-2: the server may have taken the resend (even be applying it) when the answer is lost. The next press must ask
  // about the same request — the same Idempotency-Key — never make a second one.
  it.each([
    ["no answer at all", { __throw: true }],
    ["an accepted answer that cannot be read", { __status: 202, __unreadable: true }],
    ["a server error", { __status: 503, error: "unavailable" }],
  ])("%s: the card says it could not tell, and the next press sends the same key", async (_what, lost) => {
    const w = await written({ answers: [lost as Record<string, unknown>] });
    await press(w);
    expect(w.p.root.textContent).toContain("We could not tell whether it was sent. Press Send again to find out; it will not be sent twice.");
    expect(w.button("Send again")).toBeDefined();
    expect(w.p.root.querySelector(".pending-card").className).toContain("rejected");      // the old card is kept until the answer is known
    await press(w);                                // the server answers with the request it holds under that key
    const keys = w.writeCalls().map(r => r.key);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[2]);                 // one identity across the uncertain answer…
    expect(keys[0]).not.toBe(keys[1]);             // …and not the original's
    expect(cardIds(w)).toEqual([[w.ids[2], true]]);
    expect(w.p.root.textContent).not.toContain("We could not tell");
  });
  it("the control: an ordinary new confirmation after a resend has a key of its own again", async () => {
    const w = await written();
    await press(w);                                // resend #1 is held (card b)
    fire(w.button("Withdraw"), "click"); await settle(6);
    await press(w);                                // resend #2 from card b
    const keys = w.writeCalls().map(r => r.key);
    expect([keys.length, new Set(keys).size]).toEqual([3, 3]);
  });

  // Only a request that can be sent again as it was: not when settings moved on (the old content would go back over what
  // changed), not when the asking session or the fleet is gone, and not for a reason this page does not know.
  it.each([
    ["rejected", "withdrawn", true], ["rejected", "rejected", true], ["expired", "expired", true], ["expired", "not_found", true], ["failed", "apply_failed", true],
    ["stale", "settings_changed", false], ["stale", "request_no_longer_current", false], ["stale", "fleet_stopped", false], ["rejected", "something_new", false],
  ])("%s / %s: Send again is offered: %s", async (state, reason, offered) => {
    const w = await written({ ending: { state, reason } });
    expect(w.p.root.querySelector(".pending-card").className).toContain(state);
    expect(!!w.button("Send again")).toBe(offered);
    if (!offered) {
      fire(w.p.root.querySelector(".pending-card .icon-btn"), "click"); await settle(3);        // closing it leaves nothing to send
      expect(w.writeCalls()).toHaveLength(1);
    }
  });

  // Prism's P2-1: no way to send it again unless the caller said the body is not sensitive — whatever `section` the server gave.
  it("a write whose caller did not say its body is not sensitive is never kept to be sent again (the default)", async () => {
    const w = await written({ resendable: false });
    expect(w.p.root.querySelector(".pending-card").className).toContain("rejected");
    expect([w.button("Send again"), w.retained()]).toEqual([undefined, [false]]);
  });
  it("Add bot, through the real operation: the raw token's request is `access` as the server projects it, and still nothing is kept", async () => {
    const w = await written({ via: "operation", section: "access", body: { channel_id: "bot", token_env: "BOT_TOKEN", token: "123456:FAKE-TOKEN-FOR-TESTS" } });
    expect(w.p.root.querySelector(".pending-card").className).toContain("rejected");
    expect([w.button("Send again"), w.retained()]).toEqual([undefined, [false]]);
    expect(w.writeCalls()).toHaveLength(1);
    expect(w.sent.some(r => (r.body ?? "").includes("FAKE-TOKEN") && r !== w.writeCalls()[0])).toBe(false);   // and it is never sent again
  });
  it("the non-sensitive control: the same flow for a plain toggle that says so offers it", async () => {
    const w = await written({ section: "access", resendable: true });
    expect([!!w.button("Send again"), w.retained()]).toEqual([true, [true]]);
  });
  it("a request the server marks as a secret is not kept either, even for a caller that said it could be", async () => {
    const w = await written({ section: "secret" });
    expect(w.p.root.querySelector(".pending-card").className).toContain("rejected");
    expect([w.button("Send again"), w.retained()]).toEqual([undefined, [false]]);
  });
});

// Prism's P2-3: a page that kept an earlier app-i18n.js (a tab left open across an upgrade) must not print raw keys, so the
// words of the new terminal card are registered with the component that reads them. (The real-browser SKEW run is
// scripts/manual/smoke/smoke-pending-skew.mts.)
describe("the card's own words travel with the card", () => {
  it("the shell registers them in both languages; the shared dictionary has none of them", async () => {
    const { readFileSync } = await import("node:fs");
    const dict = readFileSync("src/ui/shared/app-i18n.js", "utf8"), shell = readFileSync("src/ui/shared/app-shell.js", "utf8");
    expect(dict).not.toMatch(/pendingWhy_|pendingResend/);
    expect(shell).not.toMatch(/app\.pendingWhy_|app\.pendingResend/);
    const block = shell.slice(shell.indexOf('register("pendingEnded"'), shell.indexOf("const PENDING_HOST_REASONS"));
    for (const lang of ["en", '"zh-TW"']) {
      const part = block.slice(block.indexOf(`${lang}: {`), lang === "en" ? block.indexOf('"zh-TW": {') : undefined);
      for (const key of ["why_withdrawn", "why_rejected", "why_expired", "why_not_found", "why_settings_changed", "why_request_no_longer_current", "why_fleet_stopped", "resend", "resendFailed", "resendUnsure"]) expect(part, `${lang} ${key}`).toContain(`${key}:`);
    }
    // Every key the component reads in its own groups is registered in the shell.
    for (const m of shell.matchAll(/t\("(pendingHost|pendingEnded)\.([A-Za-z_]+)"\)/g)) expect(shell.slice(shell.indexOf(`register("${m[1]}"`)), `${m[1]}.${m[2]}`).toContain(`${m[2]}:`);
  });
});
