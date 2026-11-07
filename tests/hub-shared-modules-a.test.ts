/**
 * Hub PR A (#3226): the chat's drawing moves to src/ui/shared/ (served under /assets/ by the fleet and by the Hub listener),
 * with the old /ui/js/ paths re-exporting it for tabs opened before the move.
 * - served: every moved module is in the /assets map and lives under shared/; each old path is only a re-export of it, and
 *   both paths give the same module (one instance: the thread's caches and timers are not doubled); the Hub's own
 *   module list (HUB_UI_MODULES) contains Hub-only modules — it reaches the shared ones through /assets/.
 * - a file's URL: an attachment's own `url` is used only when it is a plain same-origin path (the Hub's room-scoped files);
 *   anything else (another origin, "//", "..", a quote, a space) is the fleet's /ui/file/<id>, for the picture, the link and
 *   the HTML loader alike.
 * - ComposerInput (the composer's row): the box is the IME's while it composes (the draft is handed over once, at
 *   compositionend); Attach only when asked for; Send/Stop as the caller says. RailFrame and PageHead draw what the usage
 *   rail and Settings drew before (the real-Chrome smoke compares the whole DOM with the base).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { isServedAsset } from "../src/auth-api.js";
import { HUB_UI_MODULES } from "../src/hub/http/compose.js";

const MOVED = ["chat-thread.js", "chat-render.js", "preview.js", "html-attachment.js", "chat-time.js", "chat-strings.js", "chat-md-strings.js"];
const NEW = ["chat-composer.js", "side-rail.js", "page-head.js"];
const ui = (...p: string[]) => join(process.cwd(), "src", "ui", ...p);

describe("where the shared chat modules are served (#3226 PR A)", () => {
  it("each moved or new module is under shared/ and in the /assets map; each old path only re-exports it", () => {
    for (const f of [...MOVED, ...NEW]) expect([f, existsSync(ui("shared", f)), isServedAsset(f)]).toEqual([f, true, true]);
    for (const f of MOVED) {
      const code = readFileSync(ui(f), "utf8").split("\n").filter((l) => l.trim() && !l.trim().startsWith("//"));
      expect(code, f).toEqual([["chat-render.js", "preview.js", "chat-strings.js", "chat-md-strings.js"].includes(f) ? `import "/assets/${f}";` : `export * from "/assets/${f}";`]);
    }
    for (const f of NEW) expect(existsSync(ui(f)), `${f} has no old path`).toBe(false);
  });
  it("the old path and /assets are one module (one instance)", async () => {
    const pairs = [["chat-thread.js", "createThread"], ["chat-time.js", "chatTime"], ["html-attachment.js", "loadHtmlAttachment"]] as const;
    for (const [f, name] of pairs) {
      const old = await import(/* @vite-ignore */ `/ui/js/${f}`), shared = await import(/* @vite-ignore */ `/assets/${f}`);
      expect(old[name], f).toBe(shared[name]);
    }
  });
  it("the Hub's own module list holds only Hub modules: it reaches the shared ones through /assets/", () => {
    expect([...HUB_UI_MODULES]).toEqual(["panel-hub.js", "hub-client.js", "hub-strings.js", "hub-chat-store.js", "hub-chat-strings.js", "hub-quota.js", "hub-owner-strings.js", "hub-button-actions.js", "hub-preview.js", "hub-attachments.js",
      "hub-welcome.js", "hub-group-policy.js", "hub-group-strings.js"]);   // #3298 S-89 (lazy: loaded only with the session's group-policy mark)
  });
});

describe("a file's URL: the Hub's own room-scoped path, or the fleet's /ui/file/<id>", () => {
  const id = "a".repeat(32);
  let R: any, html: any;
  beforeAll(async () => { await import("/assets/chat-render.js"); R = (globalThis as any).AgendChatRender; html = await import("/assets/html-attachment.js"); });
  it("only a plain same-origin path is taken", () => {
    const hub = `/hub/v1/rooms/0b6e7c2a-1111-4222-8333-444455556666/files/${id}`;
    expect(R.attachmentUrl({ id, url: hub })).toBe(hub);
    for (const bad of ["//evil.example/x", "https://evil.example/x", "/a/../b", "/a/./b", '/x"onerror=1', "/x y", "/", "", undefined, 7])
      expect(R.attachmentUrl({ id, url: bad }), String(bad)).toBe(`/ui/file/${id}`);
  });
  it("the picture, the download link and the HTML loader all read it", async () => {
    const hub = `/hub/v1/rooms/r1/files/${id}`;
    const out = R.attachmentsHtml([{ id, name: "a.png", size: 9, kind: "photo", url: hub }, { id: "b".repeat(32), name: "b.csv", size: 9, url: "//evil.example/b" }]);
    expect(out).toContain(`<img src="${hub}"`);
    expect(out).toContain(`href="/ui/file/${"b".repeat(32)}"`);
    expect(out).not.toContain("evil.example");
    const asked: string[] = [];
    await html.loadHtmlAttachment({ id, name: "p.html", size: 5, url: hub }, async (u: string) => { asked.push(u); return { ok: true, arrayBuffer: async () => new TextEncoder().encode("<p>x</p>").buffer }; });
    await html.loadHtmlAttachment({ id, name: "p.html", size: 5 }, async (u: string) => { asked.push(u); return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }; });
    expect(asked).toEqual([hub, `/ui/file/${id}`]);
  });
});

describe("ComposerInput, RailFrame and PageHead", () => {
  let p: AppPage, C: any, Rail: any, Head: any;
  beforeAll(async () => {
    p = page({ url: "http://127.0.0.1:19283/ui", storage: { agend_tour_done: "1" } });
    C = await import("/assets/chat-composer.js"); Rail = await import("/assets/side-rail.js"); Head = await import("/assets/page-head.js");
  });
  afterAll(() => p.restore());
  const props = (over: Record<string, unknown> = {}) => {
    const got: string[] = [];
    return { got, props: { value: "", placeholder: "Ask Alpha", onValue: (v: string) => got.push(v), onKeyDown: () => {}, onPaste: () => {},
      stop: { hidden: true, disabled: false, title: "Stop", label: "Stop", onClick: () => {} },
      send: { hidden: false, disabled: true, label: "Send", onClick: () => {} }, ...over } };
  };
  it("the box is the IME's while composing: the draft is handed over once, at compositionend", async () => {
    const { got, props: pr } = props();
    await p.mount(h(C.ComposerInput, pr)); await settle(2);
    const box = p.root.querySelector("#msgIn");
    fire(box, "compositionstart", {});
    box.value = "ㄋ"; fire(box, "input", { isComposing: true });
    box.value = "你"; fire(box, "input", { isComposing: true });
    expect(got).toEqual([]);
    fire(box, "compositionend", {});
    expect(got).toEqual(["你"]);
    box.value = "你好"; fire(box, "input", {});
    expect(got).toEqual(["你", "你好"]);
    expect([box.getAttribute("aria-label"), p.root.querySelector(".composer-ph").textContent]).toEqual(["Ask Alpha", "Ask Alpha"]);
    await p.unmount();
  });
  it("Attach only when asked for; its files go to the caller", async () => {
    const files: unknown[] = [];
    const { props: none } = props();
    await p.mount(h(C.ComposerInput, none)); await settle(2);
    expect([p.root.querySelector("#attachBtn"), p.root.querySelector('input[type="file"]')]).toEqual([null, null]);
    await p.unmount();
    const { props: withAttach } = props({ attach: { title: "Attach a file", onFiles: (l: unknown) => files.push(l) } });
    await p.mount(h(C.ComposerInput, withAttach)); await settle(2);
    expect(p.root.querySelector("#attachBtn").getAttribute("aria-label")).toBe("Attach a file");
    const input = p.root.querySelector('input[type="file"]'); (input as any).files = ["f1"]; fire(input, "change", {});
    expect(files).toEqual([["f1"]]);
    expect([p.root.querySelector("#sendBtn").disabled, p.root.querySelector("#stopBtn").hidden]).toEqual([true, true]);
    await p.unmount();
  });
  it("RailFrame: the usage rail's frame; × is the caller's", async () => {
    let closed = 0;
    await p.mount(h(Rail.RailFrame, { trust: "hub-context", label: "About this chat", title: "Info", closeLabel: "Hide", onClose: () => { closed++; } }, h("p", null, "body")));
    await settle(2);
    const aside = p.root.querySelector("aside.u-rail");
    expect([aside.getAttribute("data-trust"), aside.getAttribute("aria-label"), aside.querySelector(".u-rail-head h2").textContent, aside.querySelector(".u-rail-body p").textContent])
      .toEqual(["hub-context", "About this chat", "Info", "body"]);
    fire(aside.querySelector(".u-rail-head button"), "click", {});
    expect(closed).toBe(1);
    await p.unmount();
  });
  it("PageHead: Settings' page head (title, scope, lead, actions only when there are some)", async () => {
    await p.mount(h(Head.PageHead, { title: "My shared agents", scope: "You", lead: "Who may ask them" })); await settle(2);
    const head = p.root.querySelector("header.s-page-head");
    expect([head.querySelector("h2").textContent, head.querySelector(".s-scope").textContent, head.querySelector(".s-page-lead").textContent, head.querySelector(".s-page-actions")])
      .toEqual(["My shared agents", "You", "Who may ask them", null]);
    await p.unmount();
  });
});
