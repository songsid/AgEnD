/**
 * #2217: the chat's identity card, compact. The user (2026-10-19): no toggle row; the picture and bio fold away, leaving the
 * banner. The user (2026-10-20, a hotfix): no control on the card at all — never on the banner, nor in its body. The chat
 * header carries one card button opening a menu of two checkboxes: Show card, and Show picture and bio (disabled while
 * the card is hidden, or when it cannot fold). Both choices are this device's, kept like the hide-card choice always was (localStorage). The header
 * buttons on the real chat page: web-details-n2.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const PIC = "a".repeat(32);
const FULL = { banner: { src: `/api/card/a/banner?v=${PIC}`, by: "agent" }, portrait: { src: `/api/card/a/portrait?v=${PIC}`, by: "agent" },
  tagline: { text: "Reviews your PRs", by: "agent" }, bio: { text: "Line one\nLine two", by: "human" } };
const pages: any[] = [];
afterEach(async () => { for (const pg of pages.splice(0)) { await pg.unmount().catch(() => {}); pg.restore(); } });
async function mount(props: Record<string, unknown>) {
  vi.resetModules();
  const { page, h, settle } = await import("./helpers/app-harness.js");
  const pg = page({ url: "http://127.0.0.1:19280/ui/chat/a" }); pages.push(pg);
  const card = await import("/assets/identity-card.js");
  await pg.mount(h(card.IdentityCard, { name: "a", compact: true, ...props }));
  await settle(2);
  return { pg, card };
}
const controls = (pg: any) => pg.root.querySelectorAll(".id-card button").length;

describe("the chat card: no control on the card (the user, 2026-10-20)", () => {
  it("shown: banner and row, and not one button anywhere on the card", async () => {
    const { pg } = await mount({ card: FULL });
    expect([!!pg.root.querySelector(".id-banner"), !!pg.root.querySelector(".id-row"), controls(pg)]).toEqual([true, true, 0]);
  });
  it("folded (rowHidden): only the banner — no row, no picture, no bio — and still no button", async () => {
    const { pg } = await mount({ card: FULL, rowHidden: true });
    expect([pg.root.querySelector(".id-card").getAttribute("class"), pg.root.querySelector(".id-row"), pg.root.querySelector(".id-portrait"), pg.root.querySelector(".id-bio"), !!pg.root.querySelector(".id-banner"), controls(pg)])
      .toEqual(["id-card card-c bs-m row-hidden", null, null, null, true, 0]);
  });
  it("a card that cannot fold ignores rowHidden: no banner (it would be the card hidden), or a banner with nothing on the row", async () => {
    const noBanner = await mount({ card: { ...FULL, banner: undefined }, rowHidden: true });
    expect([!!noBanner.pg.root.querySelector(".id-row"), !!noBanner.pg.root.querySelector(".id-bio")]).toEqual([true, true]);
    const { card } = noBanner;
    expect([card.cardFoldable(FULL), card.cardFoldable({ ...FULL, banner: undefined }), card.cardFoldable({ banner: FULL.banner }),
      card.cardFoldable({ banner: FULL.banner, portrait: FULL.portrait }), card.cardFoldable({ banner: FULL.banner, tagline: FULL.tagline }), card.cardFoldable(null)])
      .toEqual([true, false, false, true, true, false]);
  });
  it("a banner that failed to load (its img error): the card cannot fold — the row stays even when rowHidden, and cardFoldable says no (Prism)", async () => {
    const { pg, card } = await mount({ card: FULL, rowHidden: true });
    expect([card.cardFoldable(FULL), !!pg.root.querySelector(".id-row")], "drawn: it folds").toEqual([true, false]);
    pg.root.querySelector("img.id-banner").dispatchEvent(new (globalThis as any).Event("error"));
    const { settle } = await import("./helpers/app-harness.js"); await settle(2);
    expect([pg.root.querySelector("img.id-banner"), !!pg.root.querySelector(".id-row"), !!pg.root.querySelector(".id-bio"), card.cardFoldable(FULL), card.brokenPictures.get()[FULL.banner.src]])
      .toEqual([null, true, true, false, true]);
  });
  it("no button class of the old on-card controls is left in the page code", () => {
    const src = readFileSync(new URL("../src/ui/shared/identity-card.js", import.meta.url), "utf8") + readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8");
    expect(src).not.toMatch(/id-ctl|id-hide|id-unfold|id-fold/);
  });
  it("the card menu's words, en and zh-TW (the user's 顯示小圖和介紹)", async () => {
    vi.resetModules();
    const { page } = await import("./helpers/app-harness.js");
    const pg = page({ url: "http://127.0.0.1:19280/ui/chat/a" }); pages.push(pg);
    const i18n = await import("/assets/app-i18n.js"); await import("/assets/card-strings.js");
    const words = () => ["card.menu", "card.show", "card.showRow"].map((k) => i18n.t(k));
    i18n.setLang("en", { store: false }); const en = words();
    i18n.setLang("zh-TW", { store: false }); const zh = words();
    expect([en, zh]).toEqual([["Identity card", "Show card", "Show picture and bio"], ["身分卡", "顯示卡片", "顯示小圖和介紹"]]);
  });
});

describe("the chat's choice, kept on this device like Hide card's", () => {
  it("both start from localStorage and write back there; the header menu and the card share one store", async () => {
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
