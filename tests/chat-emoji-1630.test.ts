/**
 * #1630 part C (design: the comment on #1630): a Discord server emoji in web chat, `<:name:id>` / `<a:name:id>`, is drawn
 * as its picture from the dashboard's own route (/ui/img/emoji/<id>) — only for an id of the fleet's servers (GET
 * /ui/emojis, read once per page and only when a message shows a tag); an unknown id stays the literal text; the
 * renderer escapes first, so nothing in a message can shape the tag. The real chat-render.js, chat-emojis.js and the
 * real ChatPanel in the mini DOM.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDom, settle } from "./helpers/mini-dom.js";
import { h, page, type AppPage } from "./helpers/app-harness.js";

let R: any;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  R = (globalThis as any).AgendChatRender;
});
const ID = "123456789012345678", ANIM = "223456789012345678";
const known = (id: string) => id === ID || id === ANIM;

describe("the renderer", () => {
  it("a known id becomes its picture from the dashboard's own route, alt and title its :name:", () => {
    expect(R.renderMarkdown(`hi <:blob:${ID}>!`, { emojis: known }))
      .toBe(`<p>hi <img class="emoji" src="/ui/img/emoji/${ID}" alt=":blob:" title=":blob:" decoding="async">!</p>`);
    expect(R.renderMarkdown(`<a:dance:${ANIM}>`, { emojis: known })).toContain(`src="/ui/img/emoji/${ANIM}" alt=":dance:"`);
  });
  it("an unknown id, no list, or a tag inside code stays the literal text", () => {
    expect(R.renderMarkdown("<:blob:999999999999999999>", { emojis: known })).toBe("<p>&lt;:blob:999999999999999999&gt;</p>");
    expect(R.renderMarkdown(`<:blob:${ID}>`)).toBe(`<p>&lt;:blob:${ID}&gt;</p>`);
    expect(R.renderMarkdown(`\`<:blob:${ID}>\``, { emojis: known })).toBe(`<p><code>&lt;:blob:${ID}&gt;</code></p>`);
  });
  it("nothing in a message shapes the tag: a name or id outside the pattern stays text; the src is only digits", () => {
    for (const text of [`<:bl"ob:${ID}>`, `<:blob:${ID}" onerror="x>`, `<:b:${ID}>`, `<:blob:12345>`, `<:${"x".repeat(33)}:${ID}>`, `<:blob:${ID}/../../x>`]) {
      expect(R.renderMarkdown(text, { emojis: () => true }), text).not.toContain("<img");
    }
    const out = R.renderMarkdown(`[<:blob:${ID}> link](https://example.com) and **<:blob:${ID}>**`, { emojis: known });
    expect(out.match(/<img [^>]*>/g)).toEqual([
      `<img class="emoji" src="/ui/img/emoji/${ID}" alt=":blob:" title=":blob:" decoding="async">`,
      `<img class="emoji" src="/ui/img/emoji/${ID}" alt=":blob:" title=":blob:" decoding="async">`]);
  });
});

describe("the emoji index", () => {
  it("read once, only when asked; malformed ids dropped; a failure leaves every tag text (no retry storm)", async () => {
    // @ts-expect-error — a JS module of the app, with no types
    const { createEmojiIndex } = await import("../src/ui/chat-emojis.js");
    const calls: string[] = [];
    const index = createEmojiIndex(async (url: string) => { calls.push(url); return { ok: true, json: async () => ({ emojis: [{ id: ID, name: "blob" }, { id: "x1" }, null] }) }; });
    expect([index.wants([{ text: "plain" }]), index.wants([{ text: `see <:blob:${ID}>` }]), index.known(ID)]).toEqual([false, true, false]);
    let told = 0; index.subscribe(() => told++);
    index.ensure(); index.ensure();
    await settle(); await settle();
    expect([calls, index.known(ID), index.known("x1"), told]).toEqual([["/ui/emojis"], true, false, 1]);
    const failing = createEmojiIndex(async () => { calls.push("again"); throw new Error("offline"); });
    failing.ensure(); await settle(); await settle(); failing.ensure(); await settle();
    expect([failing.known(ID), calls.filter(c => c === "again").length]).toEqual([false, 1]);
  });
});

describe("in the chat", () => {
  let panel: any, appStore: any, current: AppPage | null = null;
  const reads: string[] = [];
  let release: (() => void) | null = null;
  beforeAll(async () => {
    // @ts-expect-error — a JS module of the app, with no types
    await import("../src/ui/preview.js");
    const dom = installDom({ storage: { agend_tour_done: "1" } });
    // @ts-expect-error — a JS module of the app, with no types
    panel = await import("../src/ui/panel-chat.js");
    ({ appStore } = await import("/assets/app-store.js"));
    const fetchFake = (url: string) => {
      reads.push(url);
      if (url === "/ui/emojis") return new Promise(r => { release = () => r({ ok: true, json: async () => ({ emojis: [{ id: ID, name: "blob", animated: false }] }) }); });
      return new Promise(() => {});
    };
    panel.boot({ stream: { on() {} }, boot: null, deps: { fetch: fetchFake } });
    appStore.set({ ready: true, instances: [{ name: "w", status: "running" }, { name: "x", status: "running" }] });
    dom.restore();
  });
  afterEach(async () => { await current?.unmount(); current?.restore(); current = null; });
  const msg = (id: number, text: string) => ({ boot: "b", id, instance: "w", sender: "w", role: "agent", text, ts: `2026-01-01T00:00:0${id}Z` });

  it("a chat with no emoji tag never reads the list", async () => {
    panel.store.state.msgs.x = [{ ...msg(1, "plain words"), instance: "x" }];
    current = page({ storage: { agend_tour_done: "1" } });
    await current.mount(h(panel.ChatPanel, { route: { instance: "x" }, navKey: "x1" }));
    expect(reads.filter(u => u === "/ui/emojis")).toEqual([]);
  });
  it("a tag shows as text until the list arrives, then as the picture — and an unknown one stays text; one read", async () => {
    panel.store.state.msgs.w = [msg(1, `hello <:blob:${ID}> and <:nope:999999999999999999>`)];
    current = page({ storage: { agend_tour_done: "1" } });
    await current.mount(h(panel.ChatPanel, { route: { instance: "w" }, navKey: "w1" }));
    const md = () => current!.root.querySelector(".msg .md") as any;
    expect([md().querySelector("img.emoji"), md().textContent]).toEqual([null, `hello <:blob:${ID}> and <:nope:999999999999999999>`]);
    release!(); await settle(); await settle();
    const img = md().querySelector("img.emoji");
    expect([img?.getAttribute("src"), img?.getAttribute("alt"), md().textContent.includes("<:nope:999999999999999999>")]).toEqual([`/ui/img/emoji/${ID}`, ":blob:", true]);
    expect(reads.filter(u => u === "/ui/emojis").length).toBe(1);
  });
});
