/**
 * #1854 rank 7: a quiet first Chat.
 * - No agent selected: one instruction ("Choose an agent to start chatting.", a phone's "Choose an agent" button); no
 *   agent at all: one instruction and one action ("Create an agent to start chatting." / "New agent"). No connect-a-
 *   chat-app card here (it stays in Settings: first-run-1519.test.ts).
 * - An agent's empty history: "Type a task below." and nothing else; the composer hint keeps two keyboard cues, the
 *   commands and Esc cues move to its tooltip.
 * - The usage rail on a device that never chose is hidden (web-usage-rail-1673.test.ts).
 * The real ChatPanel in the mini DOM, EN and zh-TW.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, h, type AppPage } from "./helpers/app-harness.js";

let p: AppPage;
const fetchFake = async (path: string) => ({ ok: true, status: 200, json: async () => (path.startsWith("/ui/history") ? { messages: [] } : {}) });
const stream = { on() { return () => {}; } };
let chat: any, app: any, i18n: any;
const AGENTS = { uptime: 1, connections: 0, instances: [{ name: "alpha", status: "running", state: "idle", execution_state: "idle" }] };

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  i18n = await import("/assets/app-i18n.js");
  app = await import("/assets/app-store.js");
  chat = await import("/ui/js/panel-chat.js");
  chat.boot({ stream, boot: null, deps: { fetch: fetchFake } });
});
afterAll(() => { i18n.setLang("en"); p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => { await p.unmount(); i18n.setLang("en"); });

const mount = (instance: string | null) => p.mount(h(chat.ChatPanel, { route: { panel: "chat", instance }, navKey: `chat:${instance}|1|${i18n.lang()}` }));
const shown = () => ({
  empties: (p.root.querySelectorAll(".empty") as any[]).length,
  title: (p.root.querySelector(".empty-title") as any)?.textContent ?? null,
  hint: (p.root.querySelector(".empty-hint") as any)?.textContent ?? null,
  buttons: (p.root.querySelectorAll(".empty button") as any[]).map(b => b.textContent.trim()),
  cards: (p.root.querySelectorAll(".first-run, .card") as any[]).length,
});

describe("#1854 rank 7: the first Chat page says one thing", () => {
  for (const [lang, pick, choose, none, create] of [
    ["en", "Choose an agent to start chatting.", "Choose an agent", "Create an agent to start chatting.", "New agent"],
    ["zh-TW", "選一個 Agent 開始聊天。", "選擇 Agent", "先建立一個 Agent，再開始聊天。", "新增 Agent"],
  ] as const) {
    it(`${lang}: agents but none chosen → one instruction (and the phone's list button), no card, no second line`, async () => {
      i18n.setLang(lang);
      app.applyStatus(AGENTS);
      await mount(null);
      expect(shown()).toEqual({ empties: 1, title: pick, hint: null, buttons: [choose], cards: 0 });
    });
    it(`${lang}: no agent at all (even web-only) → one instruction and one action, no card`, async () => {
      i18n.setLang(lang);
      app.applyStatus({ ...AGENTS, instances: [] });
      await mount(null);
      expect(shown()).toEqual({ empties: 1, title: none, hint: null, buttons: [create], cards: 0 });
    });
  }
});

describe("#1854 rank 7: an agent's first chat", () => {
  for (const [lang, task, keys, more] of [
    ["en", "Type a task below.", "Enter to send · Shift+Enter for a new line", "/ for commands · Esc stops the reply"],
    ["zh-TW", "直接在下方輸入任務。", "Enter 送出 · Shift+Enter 換行", "/ 叫出指令 · Esc 中止回覆"],
  ] as const) {
    it(`${lang}: empty history → "${task}" alone; the composer hint keeps two cues, the rest is its tooltip`, async () => {
      i18n.setLang(lang);
      app.applyStatus(AGENTS);
      await mount("alpha");
      for (let n = 0; n < 6; n++) await new Promise(r => setTimeout(r, 0));
      const hint = p.root.querySelector(".composer .hint, p.hint") as any;
      expect([shown().title, shown().hint, hint?.textContent, hint?.getAttribute("title")]).toEqual([task, null, keys, more]);
      expect(keys.split(" · ")).toHaveLength(2);
    });
  }
});
