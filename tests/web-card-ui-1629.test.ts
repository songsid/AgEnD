/**
 * #1629 r4.1 Q3 (a)/(b), the page side of the identity card:
 * - the size: every card's default and the cards set apart (at most 200, the oldest dropped; the default removes an
 *   entry); instance names are own keys ("__proto__" too); one class token per size; a page that may not write the
 *   host's preferences (the public link, the anonymous reader) keeps it on this device only.
 * - fitPicture: a picture that fits goes as it is; one that does not is fitted only after the person agrees (declined:
 *   nothing to send), re-encoded until it is small enough, or refused.
 * - checkCard: only this card's own same-origin picture paths and text fields survive.
 * - Nothing on the card is markup: no innerHTML or style attribute in its module (#1300).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, settle, type AppPage } from "./helpers/app-harness.js";

let pg: AppPage | null = null;
afterEach(() => { vi.unstubAllGlobals(); if (pg) { pg.restore(); pg = null; } });
async function load(opts: { publicLink?: boolean } = {}) {
  vi.resetModules();
  pg = page({ url: "http://127.0.0.1:19280/ui/fleet/agent/a" });
  if (opts.publicLink) pg.document.body.dataset.publicLink = "1";
  const posts: unknown[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { method?: string; body?: string } = {}) => { posts.push([init.method ?? "GET", url, init.body ?? null]); return { ok: true, status: 200, json: async () => ({}) }; });
  const card = await import("/assets/identity-card.js");
  return { card, posts };
}

describe("the card's size", () => {
  it("the default (M unless chosen); a card set apart; choosing the default removes its entry", async () => {
    const { card } = await load();
    expect([card.cardSizeDefault(), card.cardSizeFor("a")]).toEqual(["m", "m"]);
    card.setCardSize("a", "l");
    expect([card.cardSizeFor("a"), card.cardSizeFor("b"), JSON.parse(pg!.storage.get("agend_card_sizes")!)]).toEqual(["l", "m", { a: "l" }]);
    card.setCardSizeDefault("s");
    expect([card.cardSizeFor("a"), card.cardSizeFor("b"), pg!.storage.get("agend_card_size")]).toEqual(["l", "s", "s"]);
    card.setCardSize("a", "s");                                   // now the default: the entry goes
    expect([card.cardSizeFor("a"), pg!.storage.get("agend_card_sizes") ?? null]).toEqual(["s", null]);
    card.setCardSizeDefault("m");
    expect(pg!.storage.get("agend_card_size") ?? null).toBeNull();
  });
  it("at most 200 set apart: the oldest goes; a changed one moves last; names are own keys", async () => {
    const { card } = await load();
    for (let i = 0; i < 201; i++) card.setCardSize(`n${i}`, "l");
    let kept = Object.keys(JSON.parse(pg!.storage.get("agend_card_sizes")!));
    expect([kept.length, kept[0], kept.at(-1)]).toEqual([200, "n1", "n200"]);
    card.setCardSize("n1", "s");
    card.setCardSize("__proto__", "s");
    kept = Object.keys(JSON.parse(pg!.storage.get("agend_card_sizes")!));
    expect([kept.length, kept.includes("n1"), kept.at(-2), kept.at(-1), kept.includes("n2")]).toEqual([200, true, "n1", "__proto__", false]);
    expect([card.cardSizeFor("__proto__"), card.cardSizeFor("constructor"), ({} as Record<string, unknown>).l]).toEqual(["s", "m", undefined]);
  });
  it("over the public link: kept on this device only — nothing is written to the host", async () => {
    const { card, posts } = await load({ publicLink: true });
    card.setCardSize("a", "l"); card.setCardSizeDefault("s");
    await new Promise(r => setTimeout(r, 500)); await settle(2);
    expect([card.cardSizeFor("a"), posts.filter((p) => (p as string[])[0] === "POST")]).toEqual(["l", []]);
  });
});

describe("fitPicture", () => {
  const limit = { max_width: 100, max_height: 200, max_bytes: 1000 };
  const file = (type: string, size: number) => ({ type, size });
  const io = (w: number, h: number, sizes: number[]) => {
    const encoded: Array<[number, number, number]> = [];
    return { encoded, io: { decode: async () => ({ width: w, height: h }), encode: async (_b: unknown, nw: number, nh: number, q: number) => { encoded.push([nw, nh, q]); const s = sizes.shift(); return s === undefined ? null : { size: s, type: "image/webp" }; } } };
  };
  it("fits: sent as it is, nobody asked, nothing encoded", async () => {
    const { card } = await load();
    const f = file("image/png", 1000), t = io(100, 200, []), ask = vi.fn();
    expect(await card.fitPicture(f, limit, ask, t.io)).toBe(f);
    expect([ask.mock.calls.length, t.encoded]).toEqual([0, []]);
  });
  it("too large: asked first (its size and the new one) — declined sends nothing; agreed is drawn smaller until small enough", async () => {
    const { card } = await load();
    const declined = io(400, 400, []), no = vi.fn(async () => false);
    expect(await card.fitPicture(file("image/png", 50), limit, no, declined.io)).toBeNull();
    expect([no.mock.calls[0], declined.encoded]).toEqual([[400, 400, 100, 100], []]);
    const agreed = io(400, 400, [5000, 3000, 900]);
    const out = await card.fitPicture(file("image/jpeg", 50), limit, async () => true, agreed.io);
    expect([out, agreed.encoded]).toEqual([{ size: 900, type: "image/webp" }, [[100, 100, 0.9], [100, 100, 0.8], [100, 100, 0.7]]]);
    const smaller = io(400, 400, [5000, 5000, 5000, 800]);
    await card.fitPicture(file("image/jpeg", 50), limit, async () => true, smaller.io);
    expect(smaller.encoded.at(-1)).toEqual([80, 80, 0.9]);                       // a fifth smaller after three tries
  });
  it("one byte over, or a type the server does not take (gif), is fitted too; one that cannot be made small enough is refused", async () => {
    const { card } = await load();
    const over = io(100, 200, [999]);
    expect(await card.fitPicture(file("image/png", 1001), limit, async () => true, over.io)).toEqual({ size: 999, type: "image/webp" });
    const gif = io(10, 10, [10]);
    expect(await card.fitPicture(file("image/gif", 10), limit, async () => true, gif.io)).toEqual({ size: 10, type: "image/webp" });
    await expect(card.fitPicture(file("image/png", 5000), limit, async () => true, io(100, 200, Array(18).fill(5000)).io)).rejects.toThrow("too_large");
  });
});

describe("loadCard: the version this page wants now (#1889 review)", () => {
  const id = "a".repeat(32);
  const body = (tag: string) => ({ tagline: { text: tag, by: "agent" } });
  function held() {
    const pending: Array<{ resolve: () => void; tag: string }> = [];
    const fetcher = (tag: string) => () => new Promise<any>(r => pending.push({ tag, resolve: () => r({ ok: true, json: async () => body(tag) }) }));
    return { pending, fetcher };
  }
  it("an older answer released after a newer one is dropped; the newer one stays", async () => {
    const { card } = await load();
    const h = held();
    const one = card.loadCard("a", "v1", h.fetcher("old")), two = card.loadCard("a", "v2", h.fetcher("new"));
    h.pending[1]!.resolve(); await two;
    h.pending[0]!.resolve(); await one;
    expect(card.cardsStore.get().a).toMatchObject({ v: "v2", card: { tagline: { text: "new", by: "agent" } } });
    void id;
  });
  it("a held answer after the card was cleared does not bring it back", async () => {
    const { card } = await load();
    const h = held();
    const one = card.loadCard("a", "v1", h.fetcher("old"));
    await card.loadCard("a", null);
    h.pending[0]!.resolve(); await one;
    expect(Object.hasOwn(card.cardsStore.get(), "a")).toBe(false);
  });
  it("A → B → A: the first A's read (its body held, holding B) is not reused or applied; the second A reads afresh (#1889 review r2)", async () => {
    const { card } = await load();
    let releaseFirst!: () => void;
    const firstBody = new Promise<void>(r => { releaseFirst = r; });
    const calls: string[] = [];
    const first = card.loadCard("a", "A", async () => { calls.push("first"); return { ok: true, json: async () => { await firstBody; return body("B served under A"); } }; });
    await new Promise(r => setTimeout(r, 0));
    await card.loadCard("a", "B", async () => { calls.push("b"); return { ok: true, json: async () => body("B") }; });
    expect(card.cardsStore.get().a).toMatchObject({ v: "B", card: { tagline: { text: "B" } } });
    const fresh = card.loadCard("a", "A", async () => { calls.push("fresh"); return { ok: true, json: async () => body("A again") }; });
    releaseFirst(); await Promise.all([first, fresh]);
    expect([calls, card.cardsStore.get().a]).toEqual([["first", "b", "fresh"], expect.objectContaining({ v: "A", card: { tagline: { text: "A again", by: "agent" } } })]);
    await card.loadCard("a", "A", async () => { calls.push("again"); return { ok: true, json: async () => body("x") }; });
    expect(calls.at(-1)).toBe("fresh");                                       // read in this epoch: no second read
  });
  it("A read in an earlier epoch does not count for A wanted again: B's failed read in between, then A reads afresh", async () => {
    const { card } = await load();
    const calls: string[] = [];
    await card.loadCard("a", "A", async () => { calls.push("a1"); return { ok: true, json: async () => body("A1") }; });
    await card.loadCard("a", "B", async () => { calls.push("b"); return { ok: false, json: async () => ({}) }; });
    await card.loadCard("a", "A", async () => { calls.push("a2"); return { ok: true, json: async () => body("A2") }; });
    expect([calls, card.cardsStore.get().a.card]).toEqual([["a1", "b", "a2"], { tagline: { text: "A2", by: "agent" } }]);
  });
  it("an older read ending never removes its replacement: the current epoch's read is still shared", async () => {
    const { card } = await load();
    const h = held();
    const old = card.loadCard("a", "A", h.fetcher("A"));
    const calls: string[] = [];
    let releaseB!: () => void;
    const bHeld = new Promise<void>(r => { releaseB = r; });
    const b = card.loadCard("a", "B", async () => { calls.push("b1"); await bHeld; return { ok: true, json: async () => body("B") }; });
    h.pending[0]!.resolve(); await old;
    const again = card.loadCard("a", "B", async () => { calls.push("b2"); return { ok: true, json: async () => body("B2") }; });
    releaseB(); await Promise.all([b, again]);
    expect([calls, card.cardsStore.get().a.card]).toEqual([["b1"], { tagline: { text: "B", by: "agent" } }]);
  });
  it("control: the same version asked twice while out is read once, and applied", async () => {
    const { card } = await load();
    const h = held();
    const one = card.loadCard("a", "v1", h.fetcher("one")), again = card.loadCard("a", "v1", h.fetcher("again"));
    expect(h.pending.length).toBe(1);
    h.pending[0]!.resolve(); await Promise.all([one, again]);
    expect(card.cardsStore.get().a).toMatchObject({ v: "v1", card: { tagline: { text: "one", by: "agent" } } });
  });
});

describe("checkCard", () => {
  it("the host's bounds: 280 emoji families are shown; past the units bound, dropped (#1889 review)", async () => {
    const { card } = await load();
    const family = "👨‍👩‍👧".repeat(280);
    expect(card.checkCard("a", { bio: { text: family, by: "human" } })).toEqual({ bio: { text: family, by: "human" } });
    expect(card.checkCard("a", { bio: { text: "x".repeat(2801), by: "human" } })).toBeNull();
    expect(card.checkCard("a", { tagline: { text: "x".repeat(600), by: "human" } })).not.toBeNull();
    expect(card.checkCard("a", { tagline: { text: "x".repeat(601), by: "human" } })).toBeNull();
  });
  it("keeps this card's own picture paths and text; drops another card's, a remote one, and anything malformed", async () => {
    const { card } = await load();
    const id = "a".repeat(32);
    expect(card.checkCard("a b", {
      portrait: { id, by: "agent", src: `/api/card/a%20b/portrait?v=${id}` },
      banner: { id, by: "human", src: `/api/card/other/banner?v=${id}` },
      tagline: { text: "Hi", by: "human" }, bio: { text: "", by: "agent" }, limits: {},
    })).toEqual({ portrait: { src: `/api/card/a%20b/portrait?v=${id}`, by: "agent" }, tagline: { text: "Hi", by: "human" } });
    for (const src of [`https://evil/x.png`, `/api/card/a%20b/portrait?v=${id}&x=1`, `/api/card/a%20b/banner?v=${id}`, `//evil/api/card/a%20b/portrait?v=${id}`]) {
      expect(card.checkCard("a b", { portrait: { id, by: "agent", src } }), src).toBeNull();
    }
    expect(card.checkCard("a", [])).toBeNull();
  });
  it("the card module writes no markup and no style attribute", () => {
    const src = readFileSync(join(process.cwd(), "src/ui/shared/identity-card.js"), "utf8");
    expect([/innerHTML|outerHTML|insertAdjacentHTML|dangerously/.test(src), /\bstyle=/.test(src), /\.style\b/.test(src)]).toEqual([false, false, false]);
  });
});
