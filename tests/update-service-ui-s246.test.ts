/**
 * M-3770 S-246: Settings → Version and update → "Updates on this machine", a fleet that isn't a service: the
 * Install as a service button asks first (every agent stops briefly; Cancel sends nothing), then POSTs the fix with
 * the page's confirmation. A refusal says why and that AgEnD keeps running; the hand-over says AgEnD is restarting,
 * waits for it to come back, and says whether it is a service now.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

type Req = { method: string; url: string; key: string | null; body: any };
let reqs: Req[] = [];
let answer: (r: Req) => { status?: number; body?: unknown } | "down" | undefined = () => undefined;
async function fetchFake(url: string, init: any = {}) {
  const headers = init.headers || {};
  const r: Req = { method: init.method || "GET", url, key: headers["Idempotency-Key"] ?? null, body: init.body ? JSON.parse(init.body) : null };
  reqs.push(r);
  const a = answer(r) ?? (url === "/api/settings/restart-pending" ? { body: { pending: false } } : { status: 404, body: {} });
  if (a === "down") throw new TypeError("Failed to fetch");
  const status = a.status ?? 200;
  return { ok: status >= 200 && status < 300, status, json: async () => a.body, text: async () => JSON.stringify(a.body) };
}
const pf = (cls: string, checks: unknown[]) => ({ class: cls, checkedAt: 1, pressHere: true, checks });
const NOT_SERVICE = pf("admin-only", [{ id: "P1", ok: true }, { id: "P3", ok: false, code: "not-service" }]);
const SERVICE = pf("self", [{ id: "P1", ok: true }, { id: "P3", ok: true }]);
const ADMIN = (preflight: unknown) => ({ admin: true, current: "2.4.0", offer: { version: "2.4.1", channel: "beta", installable: true }, checked_at: 1, check_failed: false,
  progress: null, now: Date.now(), card: { version: "2.4.1", channel: "beta", installable: true, state: "offered" }, preflight });

let p: AppPage, upd: any, uc: any, confirm: any, Toasts: any, ConfirmHost: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19282/ui/settings", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  upd = await import("/assets/app-update.js");
  uc = await import("/assets/update-card-ui.js");
  confirm = await import("/assets/ui-confirm.js");
  Toasts = (await import("/assets/ui-toast.js")).Toasts;
  ConfirmHost = confirm.ConfirmHost;
  // The app's own dialog, answered here: no auto-answer (the harness answers only while globalThis.confirm is a function).
  (globalThis as any).confirm = undefined; (p.window as any).confirm = undefined;
});
beforeEach(async () => {
  await p.unmount();
  reqs = []; answer = () => undefined;
  upd.updateStore.set({ info: null, loadedVersion: null, skew: 0, starting: false, later: null, dismissed: null, reloadDismissed: null, log: null });
});
const machine = () => p.root.querySelector(".uc-machine");
const serviceButton = () => ([...(machine()?.querySelectorAll("button") ?? [])] as any[]).find((b) => b.textContent === "Install as a service");
const mount = async (fix?: (r: Req) => { status?: number; body?: unknown }) => {
  answer = r => (r.url === "/ui/update" ? { body: ADMIN(NOT_SERVICE) } : r.url === "/api/settings/fleet" ? { body: {} } : r.url === "/ui/update/fixes" && fix ? fix(r) : undefined);
  const { UpdateSection } = await import("/ui/js/settings-update.js");
  await p.mount(h("div", {}, h(UpdateSection, {}), h(Toasts, {}), h(ConfirmHost, {}))); await settle(10);
};
const fixes = () => reqs.filter(r => r.url === "/ui/update/fixes");
const shown = () => [...p.root.querySelectorAll(".toasts .toast")].map((e: any) => [e.textContent, e.classList.contains("ok")]);
const asked = () => confirm.confirmStore.get().queue;

describe("S-246: Install as a service", () => {
  it("asks first: what happens to the Agents; Cancel sends nothing", async () => {
    await mount();
    expect(serviceButton()).toBeDefined();
    serviceButton().click(); await settle(6);
    expect(asked()).toHaveLength(1);
    expect(asked()[0]).toMatchObject({ title: "Install AgEnD as a service?", confirmLabel: "Install and restart",
      message: "AgEnD restarts as a service: every agent stops briefly and comes back on its own.\n\nAfter that, AgEnD can bring itself back after an update. To go back, run agend uninstall." });
    confirm.answerConfirm(asked()[0].id, false); await settle(6);
    expect(fixes()).toEqual([]);
    expect(serviceButton().disabled).toBe(false);
  });

  it("confirmed: one POST with the confirmation and a key; a refusal says why in the check's block (no toast), and that AgEnD keeps running", async () => {
    await mount(() => ({ status: 422, body: { error: "fix_failed", reason: "Failed to connect to bus: No medium found", cause: "user-manager", preflight: NOT_SERVICE } }));
    const before = shown().length;
    serviceButton().click(); await settle(6);
    confirm.answerConfirm(asked()[0].id, true);
    await vi.waitFor(() => expect(fixes().length).toBe(1)); await settle(10);
    expect(fixes()[0]).toMatchObject({ method: "POST", body: { fix: "service", confirm: "restart-as-service" } });
    expect(fixes()[0]!.key).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
    expect(shown().slice(before)).toEqual([]);
    // The cause in the product's words, the raw words as a code detail, then the next step (#4564 look).
    expect(machine()!.querySelector(".uc-fix-refused")?.textContent).toBe("AgEnD couldn't install the service: this computer's user service manager can't be reached. AgEnD keeps running as before. Details: Failed to connect to bus: No medium found");
    expect(machine()!.querySelector(".uc-fix-refused code")?.textContent).toBe("Failed to connect to bus: No medium found");
    expect(machine()!.querySelector(".uc-fix-next")?.textContent).toContain("run wsl --update in Windows");
    expect(serviceButton()).toBeUndefined();                                                          // pressing again is not the next step
    expect(machine()!.querySelector("details.uc-how")).toBeNull();                                   // its agend install is what just failed
    // A later check (Check for updates: a newer checkedAt) brings the button back.
    const info = upd.updateStore.get().info;
    upd.updateStore.set({ info: { ...info, preflight: { ...info.preflight, checkedAt: (info.preflight.checkedAt || 0) + 1000 } } }); await settle(6);
    expect(serviceButton()).toBeDefined();
    expect(machine()!.querySelector(".uc-fix-refused")).toBeNull();
  });

  it("the hand-over: restarting → AgEnD gone → back; it looks again and says it is a service now", async () => {
    // AgEnD still answers once while it stops (its graceful shutdown), then is gone, then is back as a service.
    let phase: "up" | "stopping" | "down" | "back" = "up";
    const preflights: unknown[] = [];
    answer = r => {
      if (r.url === "/ui/update/fixes") { phase = "stopping"; return { status: 202, body: { restarting: true } }; }
      if (r.url === "/ui/update") {
        if (phase === "stopping") { phase = "down"; return { body: ADMIN(NOT_SERVICE) }; }
        if (phase === "down") { phase = "back"; return "down"; }
        const body = ADMIN(phase === "back" ? SERVICE : NOT_SERVICE); preflights.push(body.preflight); return { body };
      }
      if (r.url === "/ui/update/check") return { body: { ok: true } };
      return undefined;
    };
    await p.mount(h("div", {}, h(Toasts, {}))); await settle(4);
    upd.updateStore.set({ info: ADMIN(NOT_SERVICE) });
    const deps = upd.cardDeps, before = shown().length;
    const sleeps: number[] = [];
    let during: unknown[] = [], startingDuring: unknown = null;
    const said: string[] = [];
    const out = await uc.fixCheck("service", { id: "P3", ok: false, code: "not-service" }, deps, { onStatus: (t: string) => said.push(t), sleep: async (ms: number) => { if (!sleeps.length) { await settle(2); during = shown().slice(before); startingDuring = upd.updateStore.get().starting; } sleeps.push(ms); }, tries: 10 });
    await settle(6);
    expect(out).toEqual({ ok: true, refused: false });
    expect(said).toEqual(["AgEnD is installing the service and restarting. This page reconnects when it's back."]);   // in the check's block
    expect(sleeps.every(ms => ms === 3000)).toBe(true);
    expect(reqs.map(r => `${r.method} ${r.url}`)).toEqual(["POST /ui/update/fixes", "GET /ui/update", "GET /ui/update", "GET /ui/update", "POST /ui/update/check", "GET /ui/update"]);
    expect(during).toEqual([]);
    expect([startingDuring, upd.updateStore.get().starting]).toEqual([true, false]);              // the card's other buttons off meanwhile (#4564 look)                                                                      // no toast over the page while it restarts
    expect(shown().slice(before)).toEqual([["AgEnD is back, running as a service.", true]]);
    expect(upd.updateStore.get().info.preflight).toEqual(SERVICE);
  });

  it("no answer at all (AgEnD stopped first) is the hand-over too; back but still not a service → says where to look", async () => {
    answer = r => (r.url === "/ui/update/fixes" ? "down" : r.url === "/ui/update" ? { body: ADMIN(NOT_SERVICE) } : r.url === "/ui/update/check" ? { body: {} } : undefined);
    await p.mount(h("div", {}, h(Toasts, {}))); await settle(4);
    upd.updateStore.set({ info: ADMIN(NOT_SERVICE) });
    const before = shown().length;
    const said: string[] = [];
    const out = await uc.fixCheck("service", { id: "P3", ok: false, code: "not-service" }, upd.cardDeps, { onStatus: (t: string) => said.push(t), sleep: async () => {}, tries: 3 });
    await settle(6);
    expect(out).toEqual({ ok: false, refused: true });
    expect(said).toEqual(["AgEnD is installing the service and restarting. This page reconnects when it's back.", "AgEnD isn't running as a service yet. What happened is in service-install.log in the AgEnD folder."]);
    expect(shown().slice(before)).toEqual([]);
  });

  it("still running after the server's wait (202 pending): says to check again, never \"restarting\"; no toast, no second press (#4564 review)", async () => {
    await mount(() => ({ status: 202, body: { pending: true, preflight: NOT_SERVICE } }));
    const before = shown().length;
    serviceButton().click(); await settle(6);
    confirm.answerConfirm(asked()[0].id, true);
    await vi.waitFor(() => expect(fixes().length).toBe(1)); await settle(10);
    expect(machine()!.querySelector(".uc-fix-refused")?.textContent).toBe("AgEnD is still setting up the service. Check again in a minute: once it has gone through, this line turns ✓.");
    expect(machine()!.textContent).not.toContain("restarting.");
    expect(shown().slice(before)).toEqual([]);
    expect(serviceButton()).toBeUndefined();
    expect(reqs.filter(r => r.url === "/ui/update").length).toBeLessThanOrEqual(2);                    // no restart wait loop
  });
  it("the words in English and zh-TW: every key, the same placeholders; zh says 「Agent」", async () => {
    const i18n = await import("/assets/app-i18n.js");
    const keys = ["serviceIt", "serviceBusy", "serviceTitle", "serviceAsk", "serviceGo", "serviceRestarting", "serviceBack", "serviceFailed_user-manager", "serviceFailed_other", "serviceDetails", "serviceNext_user-manager", "serviceNext_other", "serviceStill", "servicePending"];
    for (const k of keys) {
      const en = i18n.tIn("en", `updatecard.${k}`), zh = i18n.tIn("zh-TW", `updatecard.${k}`);
      expect(en, k).not.toBe(`updatecard.${k}`);
      expect(zh, k).not.toBe(en);
      expect(zh.match(/\{\d\}/g) ?? [], k).toEqual(en.match(/\{\d\}/g) ?? []);
      expect(zh, k).not.toMatch(/代理|艦隊|公司/);
    }
    expect(i18n.tIn("zh-TW", "updatecard.serviceAsk")).toContain("Agent");
  });
});
