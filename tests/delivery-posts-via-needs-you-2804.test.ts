/**
 * #2804 part 4 (the user's decision): delivery problems reach the person only through Needs you. The fleet no longer posts
 * "N queued deliveries expired" to General on its own — the expired rows (failed) are Needs-you items, so the list is
 * re-read — and the count is logged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale } from "../src/locale.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe("#2804: expired deliveries are a Needs-you matter, not a General post", () => {
  it("the outbox's expired event re-reads Needs you and logs the count; nothing is posted", () => {
    setLocale("en");
    const dir = mkdtempSync(join(tmpdir(), "agend-2804-expired-")); roots.push(dir);
    const fm: any = new FleetManager(dir);
    fm.ensureDeliveryOutbox();
    try {
      const notice = vi.spyOn(fm, "notifyFleetError").mockReturnValue(true);
      const warned = vi.spyOn(fm.logger, "warn");
      const poke = vi.fn();
      fm.needsYou = { poke };
      vi.spyOn(fm, "scheduleDeliveryOutboxPump").mockImplementation(() => {});
      fm.deliveryOutbox.emit("expired", { count: 2, uncertain: 1 });
      expect(notice).not.toHaveBeenCalled();
      expect(poke).toHaveBeenCalledTimes(1);
      expect(warned.mock.calls.filter(c => (c[0] as any)?.count === 2 && (c[0] as any)?.uncertain === 1)).toHaveLength(1);
    } finally {
      clearInterval(fm.replyObligationTimer);
      fm.wakeCoordinator?.stop?.();
      fm.deliveryOutbox?.close?.();
    }
  });
});
