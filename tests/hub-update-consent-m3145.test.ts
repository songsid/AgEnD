/**
 * M-3145 (docs/design/hub-fleet-versions.md §4.1): Fleet Settings → Hub, under Shared agents — "Let this Hub's
 * administrator update this Fleet": off by default; on asks once (Allow / Cancel); off needs no question; a Fleet
 * started by hand shows it disabled with the reason; a Fleet client without the calls (older) draws nothing.
 * The real component, a stub client and the shared confirm (answered through its dialog).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let m: any, words: any, confirm: any; const pages: AppPage[] = [];
beforeAll(async () => { const p = page(); m = await import("/ui/js/settings-hub-updates.js"); words = await import("/assets/app-i18n.js"); confirm = await import("/assets/ui-confirm.js"); p.restore(); });
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } vi.restoreAllMocks(); });
const until = async (fn: () => unknown) => { for (let i = 0; i < 80 && !fn(); i++) await settle(5); expect(fn()).toBeTruthy(); };

function client(start: Record<string, unknown> = { ok: true, on: false, available: true }) {
  let st: any = start;
  return { hubUpdateConsent: vi.fn(async () => st), setHubUpdateConsent: vi.fn(async (on: boolean) => { st = { ...st, on }; return st; }) };
}
async function mount(c: any, lang = "en") {
  const p = page({ storage: { agend_lang: lang } }); pages.push(p); words.setLang(lang);
  (globalThis as any).confirm = undefined;                  // the test answers the app's own question (the confirm store)
  confirm.confirmStore.set({ queue: [] });
  await p.mount(h(m.HubUpdateConsent, { client: c, hubName: "Team Hub" })); await settle(8);
  return { p, box: () => p.root.querySelector("#hubUpdateConsent") as any, note: () => p.root.querySelector("#hubUpdateConsent-note")?.textContent };
}
/** The question the switch asked (the shell's ConfirmHost draws it; the store holds it). */
const asked = () => confirm.confirmStore.get().queue[0];

describe("the owner's switch", () => {
  it("off by default, with what it does in words naming the Hub", async () => {
    const { box, note } = await mount(client());
    expect([box().checked, box().disabled, note()]).toEqual([false, false,
      "When this is on, an administrator of Team Hub can start an AgEnD update on this computer. It installs only versions published by AgEnD, waits until your agents are idle, tells you before and after, and goes back to the previous version if the update fails. You can turn this off at any time."]);
  });

  it("turning it on asks once — Cancel leaves it off; Allow turns it on; off needs no question", async () => {
    const c = client(), { box } = await mount(c);
    box().checked = true; fire(box(), "change"); await until(() => asked());
    expect([asked().title, asked().confirmLabel]).toEqual(["Let Team Hub's administrator update this Fleet?", "Allow"]);
    confirm.answerConfirm(asked().id, false); await settle(8);
    expect([c.setHubUpdateConsent.mock.calls.length, box().checked]).toEqual([0, false]);
    box().checked = true; fire(box(), "change"); await until(() => asked());
    confirm.answerConfirm(asked().id, true); await until(() => c.setHubUpdateConsent.mock.calls.length === 1);
    await settle(5);
    expect([c.setHubUpdateConsent.mock.calls[0]?.[0], box().checked]).toEqual([true, true]);
    box().checked = false; fire(box(), "change"); await until(() => c.setHubUpdateConsent.mock.calls.length === 2);
    expect([c.setHubUpdateConsent.mock.calls[1]?.[0], asked()]).toEqual([false, undefined]);
  });

  it("a refused change: said, and the switch shows what is saved", async () => {
    const c = client({ ok: true, on: true, available: true }); c.setHubUpdateConsent.mockResolvedValue({ ok: false, code: "failed" } as never);
    const { p, box } = await mount(c);
    box().checked = false; fire(box(), "change"); await until(() => p.root.querySelector(".hub-update-consent .err"));
    expect([p.root.querySelector(".hub-update-consent .err").textContent, box().checked]).toEqual(["It wasn't changed. Try again.", true]);
  });

  it("a Fleet started by hand: shown, disabled, with the reason (zh-TW)", async () => {
    const { box, note } = await mount(client({ ok: true, on: false, available: false, reason: "not-service" }), "zh-TW");
    expect([box().disabled, box().checked, note()]).toEqual([true, false, "無法使用：這個 AgEnD 是手動啟動的，更新失敗時無法自動復原。"]);
  });

  it("M-3173: a Hub older than phase 3 — shown, disabled, saying the Hub needs updating first (en and zh-TW)", async () => {
    const en = await mount(client({ ok: true, on: false, available: false, reason: "hub-older" }));
    expect([en.box().disabled, en.note()]).toEqual([true, "Not available yet: Team Hub runs an older AgEnD that can't update Fleets. This works once the Hub is updated."]);
  });

  it("an older Fleet's client (no such calls): nothing drawn", async () => {
    const { p } = await mount({});
    expect(p.root.querySelector(".hub-update-consent")).toBeNull();
  });
});
