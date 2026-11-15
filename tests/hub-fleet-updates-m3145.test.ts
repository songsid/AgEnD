/**
 * M-3145 (docs/design/hub-fleet-versions.md §4.2, §4.5; API M-3144): on Administration → Connected fleets, a Fleet that
 * is behind and whose owner allows it has **Update**; one whose owner does not, "Owner updates it"; above the list,
 * "Update {n} Fleets that allow it". Each asks first (the administrator's press is the Hub side's consent); the target is
 * always the saved recommendation, guarded by its revision. While a request is open, its one status line (and Cancel /
 * Try again) replaces the button. An older Hub (no phase-3 fields): nothing.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let v: any, words: any, confirm: any; const pages: AppPage[] = [];
beforeAll(async () => { const p = page(); v = await import("/ui/js/hub-fleet-versions.js"); words = await import("/assets/app-i18n.js"); confirm = await import("/assets/ui-confirm.js"); p.restore(); });
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } vi.restoreAllMocks(); });
const until = async (fn: () => unknown) => { for (let i = 0; i < 80 && !fn(); i++) await settle(5); expect(fn()).toBeTruthy(); };
const asked = () => confirm.confirmStore.get().queue[0];

const NOW = Date.now(), HOUR = 3_600_000;
const row = (over: Record<string, unknown> = {}) => ({ id: "f1", status: "active", label: "design-pc", owner: { name: "陳主任" }, version: "2.4.0-beta.1",
  connected: true, versionState: "needs-update", updatesAllowed: true, updateRequest: null, ...over });
const req = (over: Record<string, unknown>) => ({ id: "r1", fleetId: "f1", version: "2.4.0", requestedBy: { name: "Ada" }, requestedAt: NOW - 2 * HOUR,
  expiresAt: NOW + HOUR, updatedAt: NOW - HOUR, startedAt: null, waitingSince: null, ...over });
function client(over: Record<string, any> = {}) {
  return { updateFleets: vi.fn(async (b: any) => ({ ok: true, requests: b.fleetIds.map((id: string) => ({ id: `r-${id}`, fleetId: id, state: "queued" })), refused: [] })),
    cancelFleetUpdate: vi.fn(async () => ({ ok: true })), ...over };
}
async function mount(node: any, lang = "en") {
  const p = page({ storage: { agend_lang: lang } }); pages.push(p); words.setLang(lang);
  (globalThis as any).confirm = undefined; confirm.confirmStore.set({ queue: [] });
  await p.mount(node); await settle(5);
  return p;
}
const button = (p: AppPage, text: string) => [...p.root.querySelectorAll("button")].find((b: any) => b.textContent.trim() === text) as any;

describe("the words and the rules (pure)", () => {
  it("one status line per state (§4.5), and its one action", () => {
    words.setLang("en");
    const s = (r: any, f: any = {}) => { const x = v.updateStatus(row({ updateRequest: r, ...f }), NOW); return [x?.text, x?.action ?? null]; };
    expect([
      s(req({ state: "queued" })), s(req({ state: "queued" }), { connected: false }), s(req({ state: "waiting", waitingSince: NOW - 3 * HOUR })),
      s(req({ state: "updating" })), s(req({ state: "done", version: "2.4.0", updatedAt: NOW - HOUR })), s(req({ state: "rolled-back", currentVersion: "2.4.0-beta.1" })),
      s(req({ state: "expired", reasonCode: "busy-24h" })), s(req({ state: "expired", reasonCode: "offline-7d" })), s(req({ state: "cancelled" })),
      s(req({ state: "failed", reasonCode: "rollback-failed" })), s(req({ state: "refused", reasonCode: "owner-disabled" })), s(req({ state: "refused", reasonCode: "already-current", currentVersion: "2.4.0" })),
    ]).toEqual([
      ["Sending…", null], ["Waiting for the Fleet to connect", null], ["Waiting for its agents to be idle · since 3 hours ago", "cancel"],
      ["Updating…", null], ["Updated to v2.4.0 · 1 hour ago", null], ["Update failed; back on v2.4.0-beta.1", "retry"],
      ["Did not start: agents were busy for 24 hours", "retry"], ["Did not start: the Fleet has not connected for 7 days.", "retry"], ["The owner cancelled this update", null],
      ["Update failed and the Fleet has not come back. Contact 陳主任.", null], ["The owner no longer allows updates from the Hub.", "retry"], ["Already on v2.4.0.", null],
    ]);
    words.setLang("zh-TW");
    expect(v.updateStatus(row({ updateRequest: req({ state: "queued" }), connected: false }), NOW).text).toBe("等待 Fleet 連接");
  });

  it("updatable: active, behind, allowed, nothing open — and only with a recommendation", () => {
    expect([v.updatable(row(), "2.4.0"), v.updatable(row(), null), v.updatable(row({ updatesAllowed: false }), "2.4.0"), v.updatable(row({ updatesAllowed: null }), "2.4.0"),
      v.updatable(row({ versionState: "current" }), "2.4.0"), v.updatable(row({ updateRequest: req({ state: "waiting" }) }), "2.4.0"),
      v.updatable(row({ updateRequest: req({ state: "expired", reasonCode: "busy-24h" }) }), "2.4.0"), v.updatable(row({ status: "suspended" }), "2.4.0")])
      .toEqual([true, false, false, false, false, false, true, false]);
    expect([v.hasUpdates([row()]), v.hasUpdates([{ id: "x", status: "active" }])]).toEqual([true, false]);
  });
});

describe("a row's update part", () => {
  it("allowed: Update asks (naming the Fleet and the version), then starts it for that Fleet, guarded by the revision", async () => {
    const c = client(), changed = vi.fn();
    const p = await mount(h(v.FleetUpdateCell, { fleet: row(), recommended: "2.4.0", revision: 7, client: c, onChanged: changed }));
    fire(button(p, "Update"), "click"); await until(() => asked());
    expect([asked().message, asked().confirmLabel]).toEqual(["Update design-pc to AgEnD v2.4.0? It starts when that Fleet's agents are idle. Its owner is told now and when it finishes.", "Update"]);
    confirm.answerConfirm(asked().id, true); await until(() => c.updateFleets.mock.calls.length === 1);
    const body = c.updateFleets.mock.calls[0][0];
    expect([body.fleetIds, body.ifRevision, typeof body.idempotencyKey, "version" in body]).toEqual([["f1"], 7, "string", false]);
    await until(() => changed.mock.calls.length === 1);
  });

  it("said no: nothing is sent", async () => {
    const c = client(); const p = await mount(h(v.FleetUpdateCell, { fleet: row(), recommended: "2.4.0", revision: 7, client: c }));
    fire(button(p, "Update"), "click"); await until(() => asked());
    confirm.answerConfirm(asked().id, false); await settle(8);
    expect(c.updateFleets).not.toHaveBeenCalled();
  });

  it("not allowed (or an older Fleet): \"Owner updates it\", no button (zh-TW)", async () => {
    const p = await mount(h("div", {}, h(v.FleetUpdateCell, { fleet: row({ updatesAllowed: false }), recommended: "2.4.0", client: client() }),
      h(v.FleetUpdateCell, { fleet: row({ id: "f2", updatesAllowed: null }), recommended: "2.4.0", client: client() })), "zh-TW");
    expect([[...p.root.querySelectorAll(".hub-fleet-owner-updates")].map((n: any) => n.textContent), p.root.querySelector("button")]).toEqual([["由擁有者自行更新", "由擁有者自行更新"], null]);
  });

  it("waiting: its line and Cancel, which cancels that request (no question)", async () => {
    const c = client(), p = await mount(h(v.FleetUpdateCell, { fleet: row({ updateRequest: req({ state: "waiting", waitingSince: NOW - HOUR }) }), recommended: "2.4.0", client: c }));
    expect(p.root.querySelector(".hub-fleet-update-status").textContent).toMatch(/^Waiting for its agents to be idle · since /);
    fire(button(p, "Cancel"), "click"); await until(() => c.cancelFleetUpdate.mock.calls.length === 1);
    expect([c.cancelFleetUpdate.mock.calls[0][0], asked()]).toEqual(["r1", undefined]);
  });

  it("refused when started: the reason in words", async () => {
    const c = client({ updateFleets: vi.fn(async () => ({ ok: true, requests: [], refused: [{ fleetId: "f1", code: "not-service" }] })) });
    const p = await mount(h(v.FleetUpdateCell, { fleet: row(), recommended: "2.4.0", revision: 1, client: c }));
    fire(button(p, "Update"), "click"); await until(() => asked()); confirm.answerConfirm(asked().id, true);
    await until(() => p.root.querySelector(".hub-fleet-update .err"));
    expect(p.root.querySelector(".hub-fleet-update .err").textContent).toBe("This Fleet was started by hand, so it cannot be updated from here.");
  });

  it("current, nothing open: nothing at all", async () => {
    const p = await mount(h(v.FleetUpdateCell, { fleet: row({ versionState: "current" }), recommended: "2.4.0", client: client() }));
    expect(p.root.querySelector(".hub-fleet-update")).toBeNull();
  });
});

describe("Update {n} Fleets that allow it", () => {
  it("counts only those that qualify; asks once for all; says how many started and how many could not", async () => {
    const fleets = [row(), row({ id: "f2", label: "b" }), row({ id: "f3", updatesAllowed: false }), row({ id: "f4", updateRequest: req({ state: "waiting" }) }), row({ id: "f5", versionState: "current" })];
    const c = client({ updateFleets: vi.fn(async () => ({ ok: true, requests: [{ id: "r-f1", fleetId: "f1", state: "queued" }], refused: [{ fleetId: "f2", code: "request-open" }] })) });
    const p = await mount(h(v.UpdateAllowedButton, { fleets, recommended: "2.4.0", revision: 3, client: c }));
    fire(button(p, "Update 2 Fleets that allow it"), "click"); await until(() => asked());
    expect(asked().message).toBe("Update 2 Fleets to AgEnD v2.4.0?");
    confirm.answerConfirm(asked().id, true); await until(() => p.root.querySelector(".hub-fleet-update-all .err"));
    expect([c.updateFleets.mock.calls[0][0].fleetIds, p.root.querySelector(".hub-fleet-update-all .err").textContent]).toEqual([["f1", "f2"], "Started for 1 Fleets; 1 could not start."]);
  });

  it("none qualifies: no button", async () => {
    const p = await mount(h(v.UpdateAllowedButton, { fleets: [row({ updatesAllowed: false })], recommended: "2.4.0", client: client() }));
    expect(p.root.querySelector(".hub-fleet-update-all")).toBeNull();
  });
});
