import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let ui: any, clients: any, i18n: any, hubWords: any;
const pages: AppPage[] = [];
beforeAll(async () => { const p = page(); ui = await import("/ui/js/settings-hub.js"); clients = await import("/ui/js/hub-client.js"); i18n = await import("/assets/app-i18n.js"); hubWords = await import("/ui/js/hub-strings.js"); p.restore(); });
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } clients.setHubClient(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each(["en", "zh-TW"])("a rejected member explains recovery in %s and uses only existing disconnect/cancel", async language => {
  const p = page({ storage: { agend_lang: language } }); pages.push(p); i18n.setLang(language);
  const shown = { state: "held", hold: "rejected", hubId: "11111111-2222-4333-8444-555555555555", binding: "b".repeat(64), memberOrigin: "https://hub.test" };
  let state: any = shown, finish!: (value: any) => void;
  const settled = new Promise(resolve => { finish = resolve; });
  const c = { stub: false, pairing: vi.fn(async () => state), subscribe: () => () => {},
    disconnect: vi.fn(async () => ({ ok: true, pendingConfirmation: true, settled })),
    cancel: vi.fn(async () => { state = { state: "unpaired" }; return state; }), connect: vi.fn(), pairingNotices: () => [] };
  clients.setHubClient(c); vi.stubGlobal("confirm", () => true);
  await p.mount(h(ui.HubConnectCard, {})); await settle(20);
  expect(p.root.querySelector(".hub-held p")?.textContent).toContain(language === "en" ? "restored" : "還原");
  const button: any = p.root.querySelector(".hub-held button"); expect(button?.textContent).toBe(language === "en" ? "Reconnect" : "重新連接");
  expect(c.disconnect).not.toHaveBeenCalled(); expect(c.connect).not.toHaveBeenCalled();
  fire(button, "click"); await settle(20);
  expect(c.disconnect).toHaveBeenCalledExactlyOnceWith(shown); expect(c.cancel).not.toHaveBeenCalled();
  expect(p.root.querySelector(".s-hub-connect > p[role=status]")?.textContent).toContain(language === "en" ? "confirmation" : "確認");
  state = { ...shown, hold: "disconnected" }; finish({ state: "applied" }); await settle(20);
  const start: any = p.root.querySelector(".hub-held button"); expect(start?.textContent).toBe(language === "en" ? "Start over" : "重新開始");
  fire(start, "click"); await settle(20);
  expect(c.cancel).toHaveBeenCalledOnce(); expect(p.root.querySelector("form.hub-connect")).not.toBeNull();
  expect(c.connect).not.toHaveBeenCalled();
});
it("a known revocation offers the same recovery while retaining its distinct reason", async () => {
  const p = page(); pages.push(p); i18n.setLang("en");
  const c = { stub: false, pairing: async () => ({ state: "held", hold: "revoked", hubId: "h", binding: "b", memberOrigin: "https://hub.test" }), subscribe: () => () => {}, cancel: vi.fn() };
  clients.setHubClient(c); await p.mount(h(ui.HubConnectCard, {})); await settle(20);
  expect(p.root.querySelector(".hub-held p")?.textContent).toContain("revoked");
  expect(p.root.querySelector(".hub-held button")?.textContent).toBe("Reconnect");
  expect(c.cancel).not.toHaveBeenCalled();
});

it("new recovery controls tolerate cached strings and the original client interface", async () => {
  const p = page(); pages.push(p); i18n.setLang("en"); const original = hubWords.hw;
  vi.spyOn(hubWords, "hw").mockImplementation((...args: unknown[]) => args[0] === "hold_rejected" ? "hub.hold_rejected" : original(...args));
  const c = { stub: false, pairing: async () => ({ state: "held", hold: "rejected", hubId: "h", binding: "b", memberOrigin: "https://hub.test" }), subscribe: () => () => {} };
  clients.setHubClient(c); await p.mount(h(ui.HubConnectCard, {})); await settle(20);
  expect(p.root.querySelector(".hub-held p")?.textContent).toBe("The Hub refused the connection.");
  expect(p.root.querySelector(".hub-held button")?.textContent).toBe("Reconnect");
  expect(p.root.textContent).not.toContain("hub.hold_rejected");
});

it("an old Hub's silent offline state offers conditional recovery without claiming rejection", async () => {
  const p = page(); pages.push(p); i18n.setLang("en");
  const c = { stub: false, pairing: async () => ({ state: "paired", link: "offline", binding: "b", hub: { hubId: "h", name: "Example Hub", memberOrigin: "https://hub.test", webOrigin: "https://web.test", fingerprint: { kind: "hub-key", digest: "a".repeat(64) } } }),
    subscribe: () => () => {}, exposures: async () => [], pairingNotices: () => [] };
  clients.setHubClient(c); await p.mount(h(ui.HubConnectCard, {})); await settle(20);
  expect(p.root.querySelector(".hub-held")).toBeNull();
  expect(p.root.querySelector(".hub-reconnect-help")?.textContent).toContain("temporary outage reconnects automatically");
  expect(p.root.querySelector(".hub-repair")?.textContent).toBe("Reconnect");
});
