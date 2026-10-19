/**
 * #2217: the chat's identity card, compact (the user, 2026-10-19): no toggle row — Hide card is on the card (the banner's
 * top-right corner, or the row's when there is no banner), and the picture and bio fold away from the row's bottom-right,
 * leaving the banner, with the way back on the banner's bottom-right. Both are this device's choice, kept like the
 * hide-card choice always was (localStorage). Details and View pass no handlers: their cards have no such controls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const PIC = "a".repeat(32);
const FULL = { banner: { src: `/api/card/a/banner?v=${PIC}`, by: "agent" }, portrait: { src: `/api/card/a/portrait?v=${PIC}`, by: "agent" },
  tagline: { text: "Reviews your PRs", by: "agent" }, bio: { text: "Line one\nLine two", by: "human" } };
const pages: any[] = [];
afterEach(async () => { for (const pg of pages.splice(0)) { await pg.unmount().catch(() => {}); pg.restore(); } });
async function mount(props: Record<string, unknown>, lang = "en") {
  vi.resetModules();
  const { page, h, settle } = await import("./helpers/app-harness.js");
  const pg = page({ url: "http://127.0.0.1:19280/ui/chat/a" }); pages.push(pg);
  (await import("/assets/app-i18n.js")).setLang(lang, { store: false });
  const card = await import("/assets/identity-card.js");
  await pg.mount(h(card.IdentityCard, { name: "a", compact: true, ...props }));
  await settle(2);
  return { pg, h, settle, card };
}
const ctl = (pg: any) => [...pg.root.querySelectorAll(".id-ctl")].map((b: any) => [b.parentNode.getAttribute("class"), b.getAttribute("class"), b.getAttribute("aria-label"), b.getAttribute("aria-expanded")]);

describe("the chat card's own controls", () => {
  it("with a banner: Hide card on the banner; Hide picture and bio at the row's end; folded, only the banner and the way back", async () => {
    const onHide = vi.fn(), onToggleRow = vi.fn();
    const { pg, h, settle, card } = await mount({ card: FULL, onHide, onToggleRow });
    expect(ctl(pg)).toEqual([["id-banner-box", "id-ctl id-hide", "Hide card", null], ["id-row", "id-ctl id-fold", "Hide picture and bio", "true"]]);
    expect(pg.root.querySelector(".id-hide").getAttribute("title")).toBe("Hide card");
    pg.root.querySelector(".id-fold").click(); pg.root.querySelector(".id-hide").click();
    expect([onToggleRow.mock.calls.length, onHide.mock.calls.length]).toEqual([1, 1]);
    await pg.unmount();
    await pg.mount(h(card.IdentityCard, { name: "a", compact: true, card: FULL, onHide, onToggleRow, rowHidden: true })); await settle(2);
    expect([pg.root.querySelector(".id-card").getAttribute("class"), pg.root.querySelector(".id-row"), pg.root.querySelector(".id-portrait"), pg.root.querySelector(".id-bio"), !!pg.root.querySelector(".id-banner")])
      .toEqual(["id-card card-c bs-m row-hidden", null, null, null, true]);
    expect(ctl(pg)).toEqual([["id-banner-box", "id-ctl id-hide", "Hide card", null], ["id-banner-box", "id-ctl id-fold id-unfold", "Show picture and bio", "false"]]);
  });
  it("no banner: Hide card on the row, and nothing to fold (hiding the row would be hiding the card) — even when asked to", async () => {
    const { pg } = await mount({ card: { ...FULL, banner: undefined }, onHide() {}, onToggleRow() {}, rowHidden: true });
    expect(ctl(pg)).toEqual([["id-row", "id-ctl id-hide", "Hide card", null]]);
    expect(!!pg.root.querySelector(".id-bio")).toBe(true);
  });
  it("a banner and nothing else: Hide card only", async () => {
    const { pg } = await mount({ card: { banner: FULL.banner }, onHide() {}, onToggleRow() {} });
    expect(ctl(pg)).toEqual([["id-banner-box", "id-ctl id-hide", "Hide card", null]]);
  });
  it("no bio, a picture: it still folds (the picture is on the row)", async () => {
    const { pg } = await mount({ card: { banner: FULL.banner, portrait: FULL.portrait }, onHide() {}, onToggleRow() {} });
    expect(ctl(pg).map((c) => c[1])).toEqual(["id-ctl id-hide", "id-ctl id-fold"]);
  });
  it("Details and View (no handlers): no controls on the card", async () => {
    const { pg } = await mount({ card: FULL, compact: false });
    expect(pg.root.querySelectorAll(".id-ctl").length).toBe(0);
  });
  it("zh-TW names", async () => {
    const { pg } = await mount({ card: FULL, onHide() {}, onToggleRow() {} }, "zh-TW");
    expect(ctl(pg).map((c) => c[2])).toEqual(["隱藏卡片", "隱藏小圖與介紹"]);
  });
});

describe("the chat's choice, kept on this device like Hide card's", () => {
  it("both start from localStorage and write back there; the header button and the card share one store", async () => {
    vi.resetModules();
    const { page } = await import("./helpers/app-harness.js");
    const pg = page({ url: "http://127.0.0.1:19280/ui/chat/a", storage: { agend_chat_card: "open", agend_chat_card_row: "hidden" } }); pages.push(pg);
    const chat = await import("/ui/js/panel-chat.js");
    expect(chat.chatCardPrefs.get()).toEqual({ open: true, rowHidden: true });
    chat.setChatCardRowHidden(false);
    expect([chat.chatCardPrefs.get(), pg.storage.get("agend_chat_card_row") ?? null]).toEqual([{ open: true, rowHidden: false }, null]);
    chat.setChatCardRowHidden(true); chat.setChatCardOpen(false);
    expect([chat.chatCardPrefs.get(), pg.storage.get("agend_chat_card_row"), pg.storage.get("agend_chat_card") ?? null]).toEqual([{ open: false, rowHidden: true }, "hidden", null]);
  });
});
