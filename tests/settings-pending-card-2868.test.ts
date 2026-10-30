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
  it("host_cli: the command is the way, shown at once, not folded; nothing to authorize", async () => {
    const c = await card(view({ confirmation: { kind: "host_cli", code: ID } }));
    expect(c.text()).toContain(`No General can take the confirm card. Confirm it on the host: agend settings confirm ${ID}`);
    expect([c.p.root.querySelector(".pending-host"), c.button("Authorize this browser")]).toEqual([null, undefined]);
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
