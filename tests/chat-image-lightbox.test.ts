/**
 * A chat image opens full size in the page (a dark lightbox), not in a new tab — for a plain left click only. The
 * thumbnail's link is unchanged (chat-render.js, pinned by web-chat-c2): with ctrl/meta/shift/alt it does what the
 * browser does. ✕, a click on the dark area and Esc close it and focus goes back to the thumbnail; several images in a
 * message step with previous / next and the arrow keys; only a chat file URL is ever shown; no style attribute (#1300).
 * The real modules (panel-chat mounts the thread and the lightbox) in the mini DOM; what a browser does is the PR's smoke.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { fire, installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";

let panel: any, lb: any;
let current: AppPage | null = null;
const A = "a".repeat(32), B = "b".repeat(32), C = "c".repeat(32);

beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/preview.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  // @ts-expect-error — a JS module of the app, with no types
  panel = await import("../src/ui/panel-chat.js");
  // @ts-expect-error — a JS module of the app, with no types
  lb = await import("../src/ui/image-lightbox.js");
  const { appStore } = await import("/assets/app-store.js");
  panel.boot({ stream: { on() {} }, boot: null, deps: { fetch: () => new Promise(() => {}) } });
  appStore.set({ ready: true, instances: [{ name: "w", status: "running" }, { name: "x", status: "running" }] });
  base.restore();
});
afterEach(async () => {
  await current?.unmount();
  lb.closeLightbox();
  panel.store.state.msgs.w = [];
  current?.restore();
  current = null;
});

const photo = (id: string, name: string) => ({ id, kind: "photo", name, size: 10 });
const msg = (id: number, attachments: unknown[]) => ({ boot: "b", id, instance: "w", sender: "w", role: "agent", text: "look", ts: `2026-01-01T00:00:0${id}Z`, attachments });
async function chat(msgs: unknown[]) {
  current = page({ storage: { agend_tour_done: "1" } });
  panel.store.state.msgs.w = msgs;
  await current.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "one" }));
  return current.document as any;
}
const thumbs = (doc: any) => [...doc.querySelectorAll(".msg .att-img")] as any[];
const box = (doc: any) => doc.querySelector("dialog.lb") ?? null;
/** "open" or null — never the node (a failure stays a plain AssertionError). */
const isOpen = (doc: any) => (box(doc) ? "open" : null);
const shown = (doc: any) => box(doc)?.querySelector(".lb-img")?.getAttribute("src") ?? null;
async function clickThumb(doc: any, i: number, init: Record<string, unknown> = {}) {
  const e = fire(thumbs(doc)[i], "click", { button: 0, ...init });
  await settle();
  return e;
}

describe("a plain click shows the image in the page", () => {
  it("a dark dialog: modal, labelled, the image fitted, ✕ labelled and focused, Open original — the same URL in a new tab", async () => {
    const doc = await chat([msg(1, [photo(A, "cat.png")])]);
    const e = await clickThumb(doc, 0);
    const d = box(doc);
    expect([e.defaultPrevented, d?.open ?? null, d?.getAttribute("role") ?? null, d?.getAttribute("aria-modal") ?? null, d?.getAttribute("aria-label") ?? null])
      .toEqual([true, true, "dialog", "true", "Image: cat.png"]);
    expect([shown(doc), d.querySelector(".lb-img").getAttribute("alt")]).toEqual([`/ui/file/${A}`, "cat.png"]);
    const close = d.querySelector(".lb-close");
    expect([close?.getAttribute("aria-label") ?? null, doc.activeElement === close]).toEqual(["Close", true]);
    const orig = d.querySelector(".lb-orig");
    expect([orig?.getAttribute("href"), orig?.getAttribute("target"), orig?.getAttribute("rel")]).toEqual([`/ui/file/${A}`, "_blank", "noopener noreferrer"]);
    expect(doc.documentElement.classList.contains("lb-open"), "the chat behind it does not scroll").toBe(true);
    expect([...d.querySelectorAll("[style]")].length + (d.hasAttribute("style") ? 1 : 0), "no style attribute (#1300)").toBe(0);
  });

  it.each([["ctrl", { ctrlKey: true }], ["meta (⌘)", { metaKey: true }], ["shift", { shiftKey: true }], ["alt", { altKey: true }], ["not the main button", { button: 1 }]])(
    "%s-click: no lightbox, and the link does what the browser does (not prevented)", async (_n, init) => {
      const doc = await chat([msg(1, [photo(A, "cat.png")])]);
      const e = await clickThumb(doc, 0, init);
      expect([e.defaultPrevented, isOpen(doc)]).toEqual([false, null]);
    });

  it("the thumbnail's link is the same: href, target _blank, lazy image (chat-render unchanged)", async () => {
    const doc = await chat([msg(1, [photo(A, "cat.png")])]);
    const a = thumbs(doc)[0];
    expect([a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel"), a.querySelector("img").getAttribute("loading")])
      .toEqual([`/ui/file/${A}`, "_blank", "noopener noreferrer", "lazy"]);
  });
});

describe("closing", () => {
  const closedAndFocused = (doc: any) => [isOpen(doc), doc.activeElement === thumbs(doc)[0], doc.documentElement.classList.contains("lb-open")];
  it("✕", async () => {
    const doc = await chat([msg(1, [photo(A, "cat.png")])]);
    await clickThumb(doc, 0);
    box(doc).querySelector(".lb-close").click(); await settle();
    expect(closedAndFocused(doc)).toEqual([null, true, false]);
  });
  it("Esc (the dialog's cancel)", async () => {
    const doc = await chat([msg(1, [photo(A, "cat.png")])]);
    await clickThumb(doc, 0);
    const e = fire(box(doc), "cancel", { bubbles: false }); await settle();
    expect([e.defaultPrevented, ...closedAndFocused(doc)]).toEqual([true, null, true, false]);
  });
  it("a click on the dark area (the dialog, or the stage around the image) — but not on the image or the bar", async () => {
    const doc = await chat([msg(1, [photo(A, "cat.png")])]);
    await clickThumb(doc, 0);
    fire(box(doc).querySelector(".lb-img"), "click"); await settle();
    expect(isOpen(doc), "the image keeps it open").toBe("open");
    fire(box(doc).querySelector(".lb-name"), "click"); await settle();
    expect(isOpen(doc), "the bar keeps it open").toBe("open");
    fire(box(doc).querySelector(".lb-stage"), "click"); await settle();
    expect(closedAndFocused(doc)).toEqual([null, true, false]);
    await clickThumb(doc, 0);
    fire(box(doc), "click"); await settle();
    expect(isOpen(doc)).toBeNull();
  });
  it("the chat going (another instance) takes it with it", async () => {
    const doc = await chat([msg(1, [photo(A, "cat.png")])]);
    await clickThumb(doc, 0);
    await current!.mount(h(panel.ChatPanel, { route: { instance: "x" }, navKey: "two" }));
    expect([isOpen(doc), lb.lightboxStore.get().open ? "open" : null, doc.documentElement.classList.contains("lb-open")]).toEqual([null, null, false]);
  });
});

describe("several images in a message", () => {
  it("starts at the one clicked; previous / next and the arrow keys wrap; the count says where; another message's images are not in it", async () => {
    const doc = await chat([msg(1, [photo(A, "a.png"), photo(B, "b.png"), { id: "d".repeat(32), kind: "document", name: "r.pdf", size: 1 }]), msg(2, [photo(C, "c.png")])]);
    await clickThumb(doc, 1);
    const count = () => box(doc)?.querySelector(".lb-count")?.textContent ?? null;
    expect([shown(doc), count()]).toEqual([`/ui/file/${B}`, "2 / 2"]);
    box(doc).querySelector(".lb-next").click(); await settle();
    expect([shown(doc), count()]).toEqual([`/ui/file/${A}`, "1 / 2"]);
    fire(box(doc), "keydown", { key: "ArrowLeft" }); await settle();
    expect(shown(doc)).toBe(`/ui/file/${B}`);
    fire(box(doc), "keydown", { key: "ArrowRight" }); await settle();
    expect([shown(doc), box(doc).querySelector(".lb-prev")?.getAttribute("aria-label") ?? null]).toEqual([`/ui/file/${A}`, "Previous image"]);
  });
  it("one image: no previous / next, no count", async () => {
    const doc = await chat([msg(1, [photo(A, "a.png")])]);
    await clickThumb(doc, 0);
    expect([box(doc)?.querySelector(".lb-nav")?.className ?? null, box(doc)?.querySelector(".lb-count")?.textContent ?? null]).toEqual([null, null]);
  });
});

describe("only a chat file URL is shown", () => {
  it("openLightbox leaves out anything else, and opens nothing when the clicked one is not a chat file", () => {
    const link = (href: string, alt = "x") => ({ getAttribute: (k: string) => (k === "href" ? href : null), querySelector: () => ({ getAttribute: () => alt }) });
    const ok = link(`/ui/file/${A}`), bad = link("javascript:alert(1)"), other = link("https://evil.example/x.png");
    expect(lb.openLightbox([bad, ok, other], bad)).toBe(false);
    expect(lb.lightboxStore.get().open ? "open" : null).toBeNull();
    expect(lb.openLightbox([bad, ok, other], ok)).toBe(true);
    expect(lb.lightboxStore.get().open.items).toEqual([{ src: `/ui/file/${A}`, name: "x" }]);
  });
});
