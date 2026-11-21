import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { installDom, type MiniPage } from "./helpers/mini-dom.js";
let dom: MiniPage | null = null; const clean: Array<() => void> = [];
afterEach(() => { for (const fn of clean.splice(0)) fn(); dom?.restore(); dom = null; delete (globalThis as any).AgendAuth; });
const row = () => ({ boot: "abcd", id: 2, instance: "example", role: "user", sender: "Person", text: "Check this", ts: "2026-01-01", messageId: "web-old", delivery: "failed", retry: { owner: "web:operator", attempt: 0, failedAt: 1000 }, replyTo: { boot: "abcd", id: 1, sender: "Example", text: "Checklist" }, attachments: [] });
function render() { const c = vm.createContext({}); vm.runInContext(readFileSync("src/ui/chat-render.js", "utf8"), c); return (c as any).AgendChatRender; }
it("a new attempt resets the same bubble while late old attempts and stale history cannot regress it", () => {
  const R = render(), m = row(), newer = { ...m, messageId: "web-next", delivery: "queued", retry: { ...m.retry, attempt: 1 } };
  let rows = R.applyDelivery([m], newer.messageId, newer.delivery, newer);
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: 2, messageId: "web-next", delivery: "queued", replyTo: m.replyTo });
  rows = R.mergeMessages(rows, [m]); expect(rows[0].messageId).toBe("web-next"); expect(rows[0].delivery).toBe("queued");
  const old = { ...m, delivery: "delivered" }; expect(R.applyDelivery(rows, old.messageId, old.delivery, old)).toBe(rows);
  rows = R.applyDelivery(rows, newer.messageId, "delivered", { ...newer, delivery: "delivered", retry: { owner: newer.retry.owner, attempt: 1 } });
  expect(rows[0].delivery).toBe("delivered"); expect(R.applyDelivery(rows, newer.messageId, "queued", newer)).toBe(rows);
});

async function language(lang: "en" | "zh-TW") {
  const { t, setLang } = await import("/assets/app-i18n.js") as any; await import("/ui/js/chat-strings.js"); setLang(lang, { store: false }); return t;
}
it.each(["en", "zh-TW"] as const)("%s: the failed accepted bubble has a native Resend button and one stable identity", async lang => {
  dom = installDom({}); const t = await language(lang), doc = dom.document as any;
  const { createThread } = await import("/ui/js/chat-thread.js") as any;
  const list = doc.createElement("div"), scroll = doc.createElement("div"); scroll.append(list); doc.body.append(scroll);
  const resend = vi.fn(), m = row();
  const thread = createThread(list, scroll, { t, tf: t, isUser: (x: any) => x.role === "user", serverNow: () => 0, onJump() {}, onEmpty() {}, canResend: () => true, resendMessage: resend }); clean.push(() => thread.dispose());
  thread.render([m]); const button = list.querySelector('[data-act="resend"]');
  expect(list.querySelector(".msg-resend").textContent).toContain(lang === "en" ? "Not delivered ·" : "沒有送到 ·");
  expect(button.classList.contains("btn-ghost")).toBe(false);
  expect(button.tagName.toLowerCase()).toBe("button"); expect(button.textContent).toBe(lang === "en" ? "Resend" : "重新傳送");
  thread.onClick({ target: button }); expect(resend).toHaveBeenCalledWith("abcd-2");
  expect(list.querySelectorAll('.msg[data-key="abcd-2"]')).toHaveLength(1);
});

it("the store resends once without uploads or a new outgoing bubble, keeping the quote", async () => {
  dom = installDom({}); const t = await language("en"), m = row(); let release!: (value: any) => void;
  const pending = new Promise(resolve => release = resolve), calls: any[] = [];
  const fetch = vi.fn(async (path: string, init: any = {}) => {
    calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, json: async () => path.startsWith("/ui/history") ? { messages: [m], resendOwner: m.retry.owner } : pending };
  });
  const { createChatStore } = await import("/ui/js/chat-store.js") as any;
  const store = createChatStore({ fetch, t, toast: vi.fn(), announce: vi.fn(), now: () => 0, setTimeout });
  await store.openHistory("example");
  const first = store.resendMessage("example", "abcd-2"), second = store.resendMessage("example", "abcd-2");
  expect(calls.filter(c => c.path === "/ui/resend")).toHaveLength(1);
  expect(store.threadRows("example")).toHaveLength(1); expect(store.threadRows("example")[0].resending).toBe(true);
  release({ sent: true, message: { ...m, messageId: "web-next", delivery: "queued", retry: { ...m.retry, attempt: 1 } } });
  await first; await second;
  expect(calls[1].body).toEqual({ instance: "example", boot: "abcd", id: 2, attempt: 0 });
  expect(store.threadRows("example")).toHaveLength(1); expect(store.threadRows("example")[0]).toMatchObject({ id: 2, replyTo: m.replyTo, delivery: "queued" });
  expect(store.state.outgoing.example ?? []).toEqual([]);
});
