/**
 * M-3385 (the user: the contact-request card was hard to read). The card (contact-authorizations.js TicketCard, in Fleet →
 * Authorizations and in Needs you), en and zh-TW, on #4232's rule (Approve once / a matching admin grant endorses this one
 * delivery; the receiving agent's origin is unchanged):
 * - the request's text is labelled ("What it asks");
 * - a waiting request says how long it waits (its expiry from when it was asked: 30 minutes) and that nothing is forwarded
 *   after that, even approved;
 * - the approval note (Fable's #4232 C1): the receiving agent's later contacts are judged by its own history only, and if
 *   that allows it, the approved content may flow on to other agents without another approval;
 * - "also allow" says who, what kind, from where to where, and where it lives (the target's Permissions), and is offered
 *   only for a request from exactly one person (the server refuses any other grant);
 * - Needs you's link says where it goes ("Open in Authorizations").
 */
import { afterEach, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

const g = globalThis as any;
const pages: AppPage[] = [];
const realFetch = g.fetch;
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } g.fetch = realFetch; });
const ALEX = { platform: "discord", adapterId: "dc-main", userId: "1001", label: "Alex" };
const KIM = { platform: "telegram", adapterId: "tg-main", userId: "7", label: "Kim" };
const ticket = (o: any = {}) => ({ id: "R12", revision: 2, scope: "peer.dispatch", state: "pending", source: "classic-ops", target: "web-dev",
  sourceGeneration: "s1", targetGeneration: "t1", verb: "send_to_instance", origin: { kind: "human", people: [ALEX], receiptIds: ["hmsg-1"], chain: ["classic-ops"] },
  message: "Please rerun the nightly report.", requestHash: "h", correlationId: "c", resultRecipient: "classic-ops",
  createdAt: "2026-11-19T08:00:00Z", expiresAt: "2026-11-19T08:30:00Z", canDecide: true, ...o });
const text = (el: any) => (el?.textContent || "").replace(/\s+/g, " ").trim();

async function card(lang: "en" | "zh-TW", tk: any) {
  const p = page({ url: "http://127.0.0.1:19280/ui/fleet/authorizations", storage: { agend_tour_done: "1" } }); pages.push(p);
  g.fetch = async () => ({ ok: true, status: 200, json: async () => tk });
  const i18n = await import("/assets/app-i18n.js" as string);
  i18n.setLang(lang, { store: false });
  const { TicketCard } = await import("/ui/js/contact-authorizations.js" as string);
  await p.mount(h(TicketCard, { ticket: tk }));
  await settle(4);
  return { p, root: p.root as any, en: () => i18n.setLang("en", { store: false }) };
}

describe("M-3385: the contact-request card says what each part is and does", () => {
  it("en: the labelled request, how long it waits, the approval note (C1), and what 'also allow' adds and where", async () => {
    const c = await card("en", ticket());
    expect(text(c.root.querySelector(".contact-ticket-label"))).toBe("What it asks");
    expect(text(c.root.querySelector(".contact-ticket-times"))).toContain("a request waits 30 minutes for a decision. After that nothing is forwarded, even if it was approved.");
    expect(text(c.root.querySelector(".contact-decide .note"))).toBe("Approving forwards this request once, with your endorsement. The receiving agent's later contacts are judged by its own history only; this approval doesn't carry the requester's origin forward. So if its own history allows it, the receiving agent may pass the approved content on to other agents without another approval.");
    expect(text(c.root.querySelector(".contact-toggle"))).toBe("From now on, also forward Alex's message requests from classic-ops to web-dev without asking");
    expect(text(c.root.querySelector(".contact-allow-hint"))).toBe("This adds an allowed contact to web-dev's Permissions. It lasts until the date below, or until the uses run out; you can remove it there at any time.");
  });
  it("zh-TW: the same", async () => {
    const c = await card("zh-TW", ticket());
    try {
      expect(text(c.root.querySelector(".contact-ticket-label"))).toBe("請求內容");
      expect(text(c.root.querySelector(".contact-ticket-times"))).toContain("申請只等待 30 分鐘，逾時後即使已核准也不會轉交。");
      expect(text(c.root.querySelector(".contact-decide .note"))).toBe("核准代表你同意轉交這筆請求一次。接收 Agent 之後聯絡其他 Agent 時，只看它自己原本的歷史，這次核准不會把提問者的來源帶過去；因此，如果它自己的歷史允許，它可以把已核准的內容繼續轉交給其他 Agent，不必再次取得核准。");
      expect(text(c.root.querySelector(".contact-toggle"))).toBe("之後 Alex 從 classic-ops 發給 web-dev 的訊息請求，也直接轉交，不必再核准");
      expect(text(c.root.querySelector(".contact-allow-hint"))).toBe("這會在 web-dev 的權限頁新增一筆常用轉交，到下方的到期時間或次數用完為止；隨時可以在那裡移除。");
    } finally { c.en(); }
  });
  it("a request from more than one person: no 'also allow' (a standing grant is one person's; the server would refuse it)", async () => {
    const c = await card("en", ticket({ origin: { kind: "mixed", people: [ALEX, KIM], receiptIds: ["a", "b"], chain: ["classic-ops"] } }));
    expect([c.root.querySelector(".contact-toggle"), c.root.querySelector(".contact-allow-hint"), !!c.root.querySelector(".contact-decide button")]).toEqual([null, null, true]);
  });
  it("a decided request keeps 'Asked … · … by …' (no wait sentence)", async () => {
    const c = await card("en", ticket({ state: "delivered", canDecide: false, decidedAt: "2026-11-19T08:05:00Z", decidedBy: ALEX }));
    expect(text(c.root.querySelector(".contact-ticket-times"))).not.toContain("waits");
  });
  it("Needs you's link says where it goes", async () => {
    const p = page({ url: "http://127.0.0.1:19280/ui/needs", storage: { agend_tour_done: "1" } }); pages.push(p);
    g.fetch = async () => ({ ok: true, status: 200, json: async () => ticket() });
    const i18n = await import("/assets/app-i18n.js" as string);
    for (const [lang, want] of [["en", "Open in Authorizations"], ["zh-TW", "在「授權」頁開啟"]] as const) {
      i18n.setLang(lang, { store: false });
      const { ContactNeedsItem } = await import("/ui/js/contact-needs.js" as string);
      await p.unmount();
      await p.mount(h(ContactNeedsItem, { item: { id: "contact:R12", type: "contact", reason: "contact_request", instance: "web-dev", since: 0, contactTicket: { id: "R12", source: "classic-ops", target: "web-dev" } } }));
      await settle(6);
      expect(text(p.root.querySelector(".n-actions a"))).toBe(want);
    }
    i18n.setLang("en", { store: false });
  });
});
