/**
 * #1854 rank 9: factual corrections in the web UI, no policy change.
 * - The stuck timeout shown when none is set is the detector's own default, 10 minutes (DEFAULT_STUCK_TIMEOUT_MS) — in
 *   General, an agent's inherited value, the config default and the hang notification (hang-button-security.test.ts).
 * - Directions: web settings are under Web (not General); the section is "Connections" (no "Connections & Bots");
 *   a loosening change is confirmed in chat (General topic) or on the host, not "in General".
 * - The public-link hint no longer says "No preview exposure": previews get their own temporary tunnel unless
 *   web.preview_on_public_link is false.
 * - Needs you does not promise Discord: a fleet with no chat connection is told only "it shows here".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { page, h, type AppPage } from "./helpers/app-harness.js";
import { DEFAULT_STUCK_TIMEOUT_MS } from "../src/daemon.js";
import { DEFAULT_HANG_DETECTOR } from "../src/config.js";
// @ts-expect-error — a JS module of the app, with no types
import { HANG_TIMEOUT_DEFAULT_MINUTES, agentForm } from "../src/ui/settings-model.js";

const src = (f: string) => readFileSync(join(process.cwd(), "src", f), "utf8");

describe("#1854 rank 9: the stuck timeout's default is 10 minutes everywhere it is shown", () => {
  it("the UI constant and the config default are the detector's DEFAULT_STUCK_TIMEOUT_MS", () => {
    expect([HANG_TIMEOUT_DEFAULT_MINUTES * 60_000, DEFAULT_HANG_DETECTOR.timeout_minutes * 60_000]).toEqual([DEFAULT_STUCK_TIMEOUT_MS, DEFAULT_STUCK_TIMEOUT_MS]);
    expect(DEFAULT_STUCK_TIMEOUT_MS).toBe(10 * 60_000);
  });
  it("an agent with nothing set shows 10; a fleet default or its own value still wins", () => {
    expect([agentForm({}, {}).hang, agentForm({}, { hang_detector: { timeout_minutes: 7 } }).hang,
      agentForm({ hang_detector: { timeout_minutes: 3 } }, { hang_detector: { timeout_minutes: 7 } }).hang]).toEqual(["10", "7", "3"]);
  });
  it("General's form, its baseline and the agent dialog's inherited display use the constant, not a literal 15", () => {
    const settings = src("ui/panel-settings.js"), dialogs = src("ui/settings-dialogs.js");
    expect([
      /hang: String\(hang\.timeout_minutes \?\? HANG_TIMEOUT_DEFAULT_MINUTES\)/.test(settings),
      /timeout_minutes: hang\.timeout_minutes \?\? HANG_TIMEOUT_DEFAULT_MINUTES \}/.test(settings),
      /hang_detector\.timeout_minutes\) \?\? HANG_TIMEOUT_DEFAULT_MINUTES\)/.test(dialogs),
      /\?\? 15\b/.test(settings + dialogs + src("ui/settings-model.js")),
    ]).toEqual([true, true, true, false]);
  });
});

let p: AppPage;
let i18n: any, app: any, N: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/needs", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  i18n = await import("/assets/app-i18n.js");
  app = await import("/assets/app-store.js");
  await import("/ui/js/settings-strings.js");
  await import("/ui/js/panel-log.js");
  N = await import("/ui/js/panel-needs.js");
});
afterAll(() => { i18n.setLang("en"); p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => { await p.unmount(); i18n.setLang("en"); });

describe("#1854 rank 9: directions and claims in Settings and Log", () => {
  const both = (key: string) => { i18n.setLang("en"); const en = i18n.t(key); i18n.setLang("zh-TW"); const zh = i18n.t(key); i18n.setLang("en"); return [en, zh]; };
  it("Settings help: General holds agent and ClassicBot defaults; the web settings are under Web", () => {
    const [en, zh] = both("settings.help4");
    expect([en.includes("web chat"), /\bWeb: .*public link/.test(en), zh.includes("網頁聊天"), /網頁：.*公開連結/.test(zh)]).toEqual([false, true, false, true]);
  });
  it("the access hint names the Connections section that exists", () => {
    const [en, zh] = both("settings.accessMovedHint");
    expect([en.includes("Connections & Bots"), en.includes("under Connections."), zh.includes("連線與機器人"), zh.includes("「連線」")]).toEqual([false, true, false, true]);
  });
  it("a loosening change waits for a fleet admin in chat (General topic) or on the host — Web's lead and the Log's wait", () => {
    const [lead, leadZh] = both("settings.webLead"), [wait, waitZh] = both("log.enabling");
    expect([lead, wait].map(s => s.includes("in chat (General topic) or on the host"))).toEqual([true, true]);
    expect([leadZh, waitZh].map(s => s.includes("在聊天（General topic）或主機上確認"))).toEqual([true, true]);
  });
  it("the public-link hint says previews get their own tunnel (no false \"No preview exposure\")", () => {
    const [en, zh] = both("settings.publicLinkHint");
    expect([en.includes("No preview exposure"), en.includes("web.preview_on_public_link"), zh.includes("不公開 preview"), zh.includes("web.preview_on_public_link")]).toEqual([false, true, false, true]);
  });
});

describe("#1854 rank 9: Needs you, empty, with and without a chat connection", () => {
  it("the phone note names no single platform, and a web-only fleet is told to keep this page", () => {
    const pick = (k: string) => { i18n.setLang("en"); const en = i18n.t(k); i18n.setLang("zh-TW"); const zh = i18n.t(k); i18n.setLang("en"); return en + " | " + zh; };
    expect([pick("needs.notifyMobile").includes("Discord"), pick("needs.notifyMobileWeb")]).toEqual([false,
      "On a phone, open this page to see what needs you. | 在手機上請打開這個頁面查看等你處理的事。"]);
    expect(/tn\(connections > 0 \? "notifyMobile" : "notifyMobileWeb"\)/.test(src("ui/panel-needs.js"))).toBe(true);
  });
  const mount = () => p.mount(h(N.NeedsPanel, { route: { panel: "needs" }, navKey: "needs:|1|en" }));
  const hint = () => (p.root.querySelector(".empty") as any)?.textContent ?? "";
  for (const [connections, want, wantZh] of [
    [0, "When an agent waits for you, it shows here.", "agent 在等你時，會出現在這裡。"],
    [null, "When an agent waits for you, it shows here.", "agent 在等你時，會出現在這裡。"],
    [2, "When an agent waits for you, it shows here — and in your chat app's General.", "agent 在等你時，會出現在這裡——也會出現在聊天 app 的 General。"],
  ] as const) {
    it(`connections: ${connections} → ${connections ? "points at General" : "only here"}, never "Discord"`, async () => {
      app.appStore.set({ needs: [], instances: [], connections });
      await mount();
      const en = hint();
      await p.unmount(); i18n.setLang("zh-TW"); await mount();     // a standalone panel reads the language when it renders
      const zh = hint();
      expect([en.includes(want), en.includes("Discord"), zh.includes(wantZh), zh.includes("Discord")]).toEqual([true, false, true, false]);
    });
  }
});
