import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fire, installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";
let panel: any, previews: any, pp: any, lb: any, current: AppPage | null = null;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  // @ts-expect-error browser JS module
  await import("../src/ui/chat-render.js");
  const base = installDom();
  // @ts-expect-error browser JS module
  panel = await import("../src/ui/panel-chat.js");
  // @ts-expect-error browser JS module
  previews = await import("../src/ui/reply-file-preview.js");
  // @ts-expect-error browser JS module
  pp = await import("../src/ui/preview-panel.js");
  // @ts-expect-error browser JS module
  lb = await import("../src/ui/image-lightbox.js");
  const { appStore } = await import("/assets/app-store.js");
  panel.boot({ stream: { on() {} }, boot: null, deps: { fetch: () => new Promise(() => {}) } });
  appStore.set({ ready: true, instances: [{ name: "agent-alpha", status: "running" }] }); base.restore();
});
afterEach(async () => { globalThis.fetch = realFetch; pp.closePanel(); lb.closeLightbox(); await current?.unmount(); panel.store.state.msgs["agent-alpha"] = []; current?.restore(); current = null; });
const message = (role = "agent") => ({ boot: "b", id: 1, instance: "agent-alpha", sender: "Example helper", role, text: "Changed.", ts: "2026-01-01T00:00:00Z", previews: [{ path: "src/<example>.ts", line: 1000, endLine: 1002 }] });
async function chat(guest = false, role = "agent") {
  current = page(); if (guest) current.document.body.dataset.tier = "guest";
  panel.store.state.msgs["agent-alpha"] = [message(role)];
  await current.mount(h(panel.ChatPanel, { route: { instance: "agent-alpha" }, navKey: "one" })); return current.document as any;
}
describe("inert reply preview controls", () => {
  it("renders the path as text, reads nothing until clicked, then opens the exact reference", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ kind: "text", path: "src/<example>.ts", text: "example", size: 7 }) })); globalThis.fetch = fetch as any;
    const doc = await chat(), button = doc.querySelector('[data-reply-preview="0"]');
    expect(button?.textContent).toContain("src/<example>.ts:1000–1002"); expect(doc.querySelector("example")).toBeNull(); expect(fetch.mock.calls.filter(([url]: any) => String(url).startsWith("/ui/reply-preview"))).toHaveLength(0);
    fire(button, "click"); await settle();
    expect(pp.panelStore.get().open).toMatchObject({ kind: "reply-file", instance: "agent-alpha", spec: message().previews[0] });
    expect(fetch).toHaveBeenCalledWith(previews.replyPreviewUrl("agent-alpha", "src/<example>.ts"), expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
  });
  it("offers no file button to guests or on a human message", async () => {
    let doc = await chat(true); expect(doc.querySelector("[data-reply-preview]")).toBeNull();
    await current!.unmount(); current!.restore(); current = null;
    doc = await chat(false, "user"); expect(doc.querySelector("[data-reply-preview]")).toBeNull();
  });
  it("never lets an external or non-file URL enter the image viewer", () => {
    current = page();
    expect(lb.openReplyPreviewImage("https://example.com/picture.png", "Picture", null)).toBe(false);
    expect(lb.openReplyPreviewImage("/ui/reply-preview?instance=agent-alpha&path=picture.png&op=meta", "Picture", null)).toBe(false);
    expect(lb.lightboxStore.get().open).toBeNull();
  });
});
