/** Existing nonce/admin gate, current durable controller and honest edits of the one General notice. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { getLocale, setLocale } from "../src/locale.js";
import type { HubSharingNotice } from "../src/hub-sharing-notice.js";
let locale: ReturnType<typeof getLocale>;
beforeEach(() => { locale = getLocale(); setLocale("en"); }); afterEach(() => { setLocale(locale); });
function world() {
  const nonce = "a".repeat(32), key = "b".repeat(64), at = Date.now();
  const value: HubSharingNotice = { key, hubName: "Demo Hub", byName: "Owner", at, undoUntil: at + 86_400_000, version: 2, state: "complete",
    rows: [{ name: "Documents", kind: "agent", action: "share", state: "shared" }] };
  const controller = { view: vi.fn(() => value), undo: vi.fn(async (_key: string, _actor: string, current: () => boolean) => {
    if (!current()) throw Error("stale"); return { ...value, state: "undone" as const, rows: [{ ...value.rows[0], state: "undone" as const }] };
  }) };
  const host = { pendingHubSharing: new Map([[nonce, { key, controller }]]), hubSharingController: controller, shuttingDown: false,
    fleetAdminGate: vi.fn(() => "ok"), logger: { warn: vi.fn() }, retireNonceButtons: vi.fn(async (_entry: unknown, _messageId: string, _text: string) => {}),
    consumeNonceCallback: vi.fn((_prefix, _pattern, _data, _adapter, _receiving, _stale, authorized) => authorized("fake-admin") ? { entry: { messageId: "notice" }, action: "undo" } : "consumed") };
  const handle = () => (FleetManager.prototype as any).handleHubSharingCallback.call(host, { callbackData: `hub-share:${nonce}:undo`, userId: "fake-admin", messageId: "notice" }, "demo-chat", {});
  return { value, host, controller, handle };
}
it("the existing Fleet-admin check refuses another person's click without consuming or applying Undo", async () => {
  const w = world(); w.host.fleetAdminGate.mockReturnValue("denied");
  expect(await w.handle()).toBe(true); expect(w.controller.undo).not.toHaveBeenCalled(); expect(w.host.pendingHubSharing.size).toBe(1);
});
it("edits the original notice with the actual completed Undo instead of the restart fallback", async () => {
  const w = world(); await w.handle();
  expect(w.controller.undo).toHaveBeenCalledTimes(1); expect(w.host.pendingHubSharing.size).toBe(0);
  const text = w.host.retireNonceButtons.mock.calls[0]![2];
  expect(text).toContain("Documents: no longer shared"); expect(text).not.toContain("restart");
  const current = w.controller.undo.mock.calls[0]![2]; expect(current()).toBe(true);
  w.host.shuttingDown = true; expect(current()).toBe(false);
});
it("uses the deadline in the durable notice and distinguishes expiry from uncertain outcome", async () => {
  const expired = world(); expired.value.undoUntil = Date.now() - 1; await expired.handle();
  expect(expired.controller.undo).not.toHaveBeenCalled(); expect(expired.host.retireNonceButtons.mock.calls[0]![2]).toContain("Use Settings → Hub");
  const uncertain = world(); uncertain.controller.undo.mockRejectedValue(new Error("lost result")); await uncertain.handle();
  expect(uncertain.host.retireNonceButtons.mock.calls[0]![2]).toContain("not confirmed yet");
});
it("retains the pre-restart fallback and refuses a controller replaced after the old button was posted", async () => {
  const w = world(); w.host.hubSharingController = { ...w.controller }; await w.handle();
  expect(w.controller.undo).not.toHaveBeenCalled(); expect(w.host.retireNonceButtons.mock.calls[0]![2]).toContain("Use Undo in Notices on the web");
  expect(w.host.consumeNonceCallback.mock.calls[0]![5]).toMatchObject({ keepText: true, notice: expect.stringContaining("after a restart") });
});
