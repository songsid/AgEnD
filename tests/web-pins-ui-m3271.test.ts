/**
 * M-3271 (the user: 「右鍵可以釘選訊息，這樣比較好找」): pinned web chat messages, the page's side, on the mini DOM:
 * - the message menu (#2272): Pin after Reply — Unpin on a pinned message; none where the page passes no pin (the Hub)
 *   or may not pin (canPin false: a status line, a non-admin);
 * - the thread's jump: a pin's jump to a message no longer in the chat opens the copy (onGone), not the notice;
 * - chat-pins.js: the header's 📌 with the count (none with no pins, none for a page the host refused), Pin / Unpin through
 *   the host (its answer is the list; pins_full said plainly), the list (newest first; a row jumps, its × unpins).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDom, MiniEvent, type MiniPage } from "./helpers/mini-dom.js";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let dom: MiniPage | null = null;
const offs: Array<() => void> = [];
const mounted: AppPage[] = [];
afterEach(async () => {
  for (const f of offs.splice(0)) f();
  (dom as MiniPage | null)?.restore(); dom = null;
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
});
async function i18n(lang: "en" | "zh-TW" = "en") {
  const { t, setLang } = await import("/assets/app-i18n.js") as any;
  await import("/ui/js/chat-strings.js");
  setLang(lang, { store: false });
  return t;
}
const row = (over: Record<string, unknown> = {}) => ({ boot: "ab12", id: 1, instance: "a", role: "agent", sender: "atlas", text: "the plan", ts: "2026-11-17T09:00:00Z", ...over });
const ev = (type: string, init: Record<string, unknown> = {}) => new MiniEvent(type, { bubbles: true, cancelable: true, ...init });

async function threadWith(rows: any[], opts: Record<string, unknown> = {}, lang: "en" | "zh-TW" = "en") {
  dom = installDom({});
  const t = await i18n(lang);
  const { createThread } = await import("/ui/js/chat-thread.js") as any;
  const doc = dom.document as any;
  const list = doc.createElement("div"), scroller = doc.createElement("div"); scroller.append(list); doc.body.append(scroller);
  const thread = createThread(list, scroller, { t, tf: t, isUser: (x: any) => x.role === "user", serverNow: () => 0, onJump() {}, onEmpty() {}, ...opts });
  thread.render(rows);
  offs.push(() => thread.dispose());
  return { doc, list, thread, t };
}

describe("the message menu: Pin / Unpin", () => {
  async function menuFor(deps: Record<string, unknown>, rows = [row(), row({ id: 2, role: "user", sender: "Ops", text: "not yet stored" })], lang: "en" | "zh-TW" = "en") {
    const { doc, list, thread, t } = await threadWith(rows, {}, lang);
    const { installMessageActions } = await import("/ui/js/chat-msg-actions.js") as any;
    offs.push(installMessageActions(list, { t, messageOf: thread.messageOf, reply() {}, copyText: async () => true, notice() {}, linkOf: () => "L", ...deps }));
    const open = (key: string) => {
      doc.dispatchEvent(ev("keydown", { key: "Escape" }));                // the open one closed first
      const el = list.querySelector(`[data-key="${key}"]`);
      (el.querySelector(".body") ?? el).dispatchEvent(ev("contextmenu", { clientX: 10, clientY: 10 }));
      return doc.body.querySelector(".msg-menu");
    };
    const items = (key: string) => (open(key)?.querySelectorAll("button") ?? []).map((b: any) => [b.dataset.item, b.textContent]);
    return { doc, open, items };
  }
  it("after Reply: Pin; on a pinned message Unpin (zh-TW: 釘選 / 取消釘選); the click pins that row", async () => {
    const pin = vi.fn(), pinned = new Set<string>();
    const m = await menuFor({ pin, pinned: (x: any) => pinned.has(`${x.boot}-${x.id}`), canPin: (x: any) => x.id !== 2 });
    expect(m.items("ab12-1")).toEqual([["reply", "Reply"], ["pin", "Pin"], ["copyText", "Copy text"], ["copyLink", "Copy link"]]);
    m.open("ab12-1").querySelector('[data-item="pin"]').dispatchEvent(ev("click"));
    expect(pin.mock.calls.map((c) => [c[0].boot, c[0].id])).toEqual([["ab12", 1]]);
    pinned.add("ab12-1");
    expect(m.items("ab12-1")[1]).toEqual(["unpin", "Unpin"]);
    expect(m.items("ab12-2").map((i: any) => i[0]), "one the page may not pin (canPin false): no Pin").toEqual(["reply", "copyText", "copyLink"]);
    offs.splice(0).forEach((f) => f()); dom?.restore(); dom = null;
    const zh = await menuFor({ pin, pinned: () => false, canPin: () => true }, [row()], "zh-TW");
    expect(zh.items("ab12-1").map((i: any) => i[1])).toEqual(["回覆", "釘選", "複製文字", "複製連結"]);
  });
  it("a page that passes no pin (the Hub) or may not pin (canPin false): the menu as before", async () => {
    const none = await menuFor({});
    expect(none.items("ab12-1")).toEqual([["reply", "Reply"], ["copyText", "Copy text"], ["copyLink", "Copy link"]]);
    offs.splice(0).forEach((f) => f()); dom?.restore(); dom = null;
    const refused = await menuFor({ pin: vi.fn(), canPin: () => false });
    expect(refused.items("ab12-1").map((i: any) => i[0])).toEqual(["reply", "copyText", "copyLink"]);
  });
});

describe("the thread's jump", () => {
  it("drawn: flashed (true); gone after reading back: onGone, not the notice (false); without onGone: the notice", async () => {
    const notice = vi.fn(), findQuoted = vi.fn(async () => false), onGone = vi.fn();
    const { list, thread } = await threadWith([row()], { notice, findQuoted });
    expect(await thread.jumpTo("ab12-1")).toBe(true);
    expect(list.querySelector('[data-key="ab12-1"]').classList.contains("flash")).toBe(true);
    expect([await thread.jumpTo("ab12-77", { onGone }), onGone.mock.calls.length, notice.mock.calls.length]).toEqual([false, 1, 0]);
    expect([await thread.jumpTo("ab12-78"), notice.mock.calls.map((c) => c[0])]).toEqual([false, ["That message is no longer in this chat."]]);
  });
});

describe("chat-pins.js", () => {
  const pinA = { key: "ab12-2", role: "user", sender: "Ops", text: "keep this", ts: "2026-11-17T09:00:02Z", pinnedAt: "2026-11-17T09:05:00Z" };
  const pinB = { key: "ab12-1", role: "agent", sender: "atlas", text: "the plan", ts: "2026-11-17T09:00:01Z", files: [{ name: "plan.png", kind: "photo" }], pinnedAt: "2026-11-17T09:04:00Z" };
  async function mod() {
    const pg = page({ url: "http://127.0.0.1:19280/ui/chat/alpha" }); mounted.push(pg);
    const t = await i18n();
    const m = await import("/ui/js/chat-pins.js") as any;
    m.pinsStore.set({});
    const toast = await import("/assets/ui-toast.js") as any;
    return { pg, t, m, toast };
  }
  const answer = (status: number, body: unknown) => async () => ({ ok: status < 300, status, json: async () => body });

  it("read: the host's list (offered); refused (not an admin): none, and not offered", async () => {
    const { m } = await mod();
    await m.readPins("alpha", answer(200, { rev: 3, pins: [pinA, pinB] }));
    expect([m.pinOffered("alpha"), m.pinsOf("alpha").map((p: any) => p.key), m.isPinned("alpha", "ab12-1"), m.isPinned("alpha", "ab12-9")]).toEqual([true, ["ab12-2", "ab12-1"], true, false]);
    await m.readPins("beta", answer(403, { error: "pins_admin_only" }));
    expect([m.pinOffered("beta"), m.pinsOf("beta")]).toEqual([false, []]);
  });

  it("pin / unpin through the host (its answer is the list); pins_full said plainly; another failure too", async () => {
    const { pg, m, toast } = await mod();
    await pg.mount(h(toast.Toasts, {})); await settle(2);
    const calls: any[] = [];
    const host = (status: number, body: unknown) => async (url: string, init: any) => { calls.push([url, init.method, JSON.parse(init.body)]); return { ok: status < 300, status, json: async () => body }; };
    expect(await m.setPin("alpha", "ab12-1", true, host(200, { rev: 1, pins: [pinB] }))).toBe(true);
    expect([calls[0], m.pinsOf("alpha").length]).toEqual([["/ui/pins/alpha", "POST", { pin: "ab12-1" }], 1]);
    expect(await m.setPin("alpha", "ab12-1", false, host(200, { rev: 2, pins: [] }))).toBe(true);
    expect([calls[1][2], m.pinsOf("alpha")]).toEqual([{ unpin: "ab12-1" }, []]);
    expect(await m.setPin("alpha", "ab12-3", true, host(409, { error: "pins_full" }))).toBe(false);
    expect(await m.setPin("alpha", "ab12-3", true, host(500, { error: "x" }))).toBe(false);
    await settle(2);
    const said = pg.root.querySelectorAll(".toast").map((x: any) => [x.textContent, x.classList.contains("ok")]);
    expect(said.slice(-4)).toEqual([["Pinned", true], ["Unpinned", true], ["This agent already has 50 pinned messages — unpin one first.", false], ["Couldn't change the pin. Try again.", false]]);
  });

  it("the header's 📌: the count, only with pins; the list newest first — a row jumps, its × unpins", async () => {
    const { pg, m } = await mod();
    const onOpen = vi.fn(), onJump = vi.fn();
    await pg.mount(h("div", {}, h(m.PinsButton, { name: "alpha", onOpen }), h(m.PinsDialog, { name: "alpha", onClose() {}, onJump })));
    await settle(2);
    expect(pg.root.querySelector(".chat-pins-btn"), "no pins: no button").toBeNull();
    expect(pg.root.querySelector(".chat-pins-dlg .note")?.textContent).toContain("Nothing pinned yet");
    m.pinsStore.set({ alpha: { offered: true, pins: [pinA, pinB], rev: 2 } }); await settle(2);
    const btn = pg.root.querySelector(".chat-pins-btn");
    expect([btn.getAttribute("aria-label"), btn.querySelector(".chat-pins-count").textContent]).toEqual(["Pinned messages: 2", "2"]);
    fire(btn, "click"); expect(onOpen).toHaveBeenCalledTimes(1);
    const rows = pg.root.querySelectorAll(".chat-pin");
    expect(rows.map((r: any) => [r.getAttribute("data-key"), r.querySelector("strong").textContent, r.querySelector(".chat-pin-text").textContent, r.querySelector(".chat-pin-files")?.textContent ?? null]))
      .toEqual([["ab12-2", "Ops", "keep this", null], ["ab12-1", "atlas", "the plan", "Files: plan.png"]]);
    fire(rows[1].querySelector(".chat-pin-go"), "click");
    expect(onJump.mock.calls.map((c) => c[0].key)).toEqual(["ab12-1"]);
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ rev: 3, pins: [pinA] }) }));
    (globalThis as any).fetch = fetcher;
    fire(rows[1].querySelector(".chat-pin-x"), "click"); await settle(3);
    expect([JSON.parse((fetcher.mock.calls[0] as any)[1].body), pg.root.querySelectorAll(".chat-pin").length]).toEqual([{ unpin: "ab12-1" }, 1]);
    m.pinsStore.set({ alpha: { offered: false, pins: [pinA] } }); await settle(2);
    expect(pg.root.querySelector(".chat-pins-btn"), "a page the host refused: no button").toBeNull();
  });

  it("a phone's ⋯ sheet: the list is a tile beside Search (not folded under Look)", async () => {
    const { pg } = await mod();
    const { AgentSheet } = await import("/assets/agent-sheet.js") as any;
    const onSelect = vi.fn();
    const inst = { name: "alpha", backend: "claude-code", status: "running" };
    await pg.mount(h(AgentSheet, { name: "alpha", inst, current: "chat", onClose() {}, items: [{ key: "pins", label: "Pinned messages · 2", icon: "pin", onSelect }] })); await settle(2);
    const look = pg.root.querySelector('.chat-sheet-row[aria-expanded]');
    if (look) { fire(look, "click"); await settle(2); }                  // Look opened: nothing of the pins in it either
    const tile = pg.root.querySelectorAll(".chat-sheet-tile").find((b: any) => b.textContent.trim() === "Pinned messages · 2");
    expect([!!tile, pg.root.querySelectorAll(".chat-sheet-row").some((b: any) => b.textContent.includes("Pinned"))]).toEqual([true, false]);
    fire(tile, "click"); expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("the copy of a pin no longer in the chat: what it kept, and why it is shown", async () => {
    const { pg, m } = await mod();
    await pg.mount(h(m.PinCopyDialog, { pin: pinB, onClose() {} })); await settle(2);
    const d = pg.root.querySelector(".chat-pin-copy");
    expect([d.querySelector(".note").textContent, d.querySelector("strong").textContent, d.querySelector(".chat-pin-copy-text").textContent, d.querySelector(".chat-pin-files").textContent])
      .toEqual(["This message is no longer in the chat. This is the copy kept with the pin.", "atlas", "the plan", "Files: plan.png"]);
  });
});
