import { afterEach, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
let pg: AppPage | undefined, confirm: any;
afterEach(async () => { confirm?.resetConfirmations(); vi.useRealTimers(); if (pg) { await pg.unmount(); pg.restore(); } vi.unstubAllGlobals(); });
describe("#3457 Hub stop copy", () => {
  it.each(["en", "zh-TW"])("the disabled Hub has a neutral switch label (%s)", async language => {
    pg = page(); const i18n = await import("/assets/app-i18n.js"); i18n.setLang(language, { store: false });
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({ initialized: true, enabled: false }) }));
    const { HubRunSettings } = await import("/ui/js/settings-hub-run.js");
    await pg.mount(h(HubRunSettings, {})); await settle(8);
    expect(pg.root.querySelector("label")?.textContent).toBe(language === "en" ? " Run this Hub" : " 執行這個 Hub");
    expect((pg.root.querySelector("input") as any).checked).toBe(false);
  });
  it.each(["en", "zh-TW"])("the confirmation keeps the page's description after server polling (%s)", async language => {
    pg = page(); const i18n = await import("/assets/app-i18n.js"); i18n.setLang(language, { store: false });
    confirm = await import("/ui/js/settings-confirm.js"); confirm.resetConfirmations();
    const { appStore } = await import("/assets/app-store.js");
    vi.useFakeTimers(); let decided = false;
    const view = () => ({ id: "a".repeat(32), state: decided ? "applied" : "pending", summary: ["Stop this fleet's Hub. Everyone is signed out."], remaining_ms: 60000,
      section: "access", confirmation: { kind: "web" }, outcome: decided ? { result: { ok: true, enabled: false } } : null });
    vi.stubGlobal("fetch", async (_url: string, options: any = {}) => ({ ok: true, status: options.method ? 202 : 200,
      json: async () => options.method ? { result: "pending_confirmation", pending_change: view() } : view() }));
    const description = language === "en" ? "Stop the Hub; keep its records." : "停止 Hub，並保留紀錄。";
    const attached = confirm.track(view()); // an SSE/reload attach may win the race with the write response
    const saved = confirm.confirmedWrite("/api/settings/hub/run", { method: "PUT", body: { enabled: false }, displaySummary: () => [description] });
    await vi.advanceTimersByTimeAsync(0);
    expect(appStore.get().pendingChanges[0].summary).toEqual([description]);
    decided = true; await vi.advanceTimersByTimeAsync(2000); const result = await saved; await attached;
    expect(result.confirmed.summary).toEqual(view().summary); // presentation cannot rewrite the server's retained diff
    expect(appStore.get().pendingChanges[0].summary).toEqual([description]);
    expect(appStore.get().pendingChanges[0].state).toBe("applied");
  });
});
