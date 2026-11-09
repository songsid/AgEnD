import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

/**
 * A computer that joins with an install-command token is approved by the token alone, so the owner's out-of-band notice is the control that says it happened. These tests
 * drive the real audit hook of the real fleet's Runtime coordinator and the real notice routing, with an inert chat adapter whose sends can be made to reject later: the notice
 * is kept on disk first and removed only when a delivery is ACKNOWLEDGED, so no destination yet, a refused send (at once or on a retry), a restart and a full queue all
 * keep it recoverable.
 */
const roots: string[] = [];
beforeEach(() => { vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const dir of roots.splice(0)) { if (!resolve(dir).startsWith(resolve(tmpdir()))) throw Error("Unsafe scratch path"); rmSync(dir, { recursive: true, force: true }); } });

const quiet = () => {};
function fleet(dir?: string, destination = true) {
  const home = dir ?? mkdtempSync(join(tmpdir(), "agend-owner-notice-")); if (!dir) roots.push(home);
  const fm = new FleetManager(home) as any;
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  fm.fleetConfig = { defaults: {}, instances: {}, channel: destination ? { type: "telegram", group_id: "g1" } : { type: "telegram" } };   // a chat-connected fleet, with or without a place for fleet notices
  // sends: "ok" resolves, "reject" rejects after being dispatched, "none" is no adapter at all
  const sends: string[] = []; let mode: "ok" | "reject" | "none" = "ok";
  const adapter = { id: "telegram", type: "telegram", sendText: vi.fn((_chat: string, text: string): Promise<void> => { sends.push(text); return mode === "reject" ? Promise.reject(new Error("the platform refused it")) : Promise.resolve(); }) };
  fm.adapters.set("telegram", adapter);
  fm.adapter = null;
  const control = { sends, set(next: typeof mode) { mode = next; fm.adapter = next === "none" ? null : adapter; } };
  control.set("ok");
  return { dir: home, fm, control, adapter };
}
const join_ = (hub: any, name = "Desk"): void => {
  const issued = hub.createEnrollment("admin:0123456789abcdef");
  hub.enroll({ token: issued.token, fingerprint: hub.serverFingerprint(), name, platform: "win32", hostname: "DESK-01" });
};
const pendingFile = (dir: string): string => join(dir, "pending-owner-notices.json");
const pending = (dir: string): Array<{ id: string; text: string; folded?: number }> => existsSync(pendingFile(dir)) ? JSON.parse(readFileSync(pendingFile(dir), "utf8")) : [];
const settle = async (ms = 0): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); };

describe("the notice that a computer joined with an install-command token", () => {
  it("is delivered at once and leaves nothing behind (positive control)", async () => {
    const { dir, fm, control } = fleet();
    join_(fm.runtimeCoordinator()); await settle();
    expect(control.sends).toHaveLength(1); expect(control.sends[0]).toMatch(/joined AgEnD with a one-time install-command token/); expect(control.sends[0]).not.toMatch(/agend_enroll_/);
    expect(pending(dir)).toEqual([]); fm.runtimeHub?.close();
  });
  it("is kept when the fleet has no place to send it, survives a restart, and is delivered once a destination exists", async () => {
    const { dir, fm, control } = fleet(undefined, false);
    join_(fm.runtimeCoordinator()); await settle();
    expect(control.sends).toEqual([]); const kept = pending(dir); expect(kept).toHaveLength(1);
    await settle(60_000); expect(control.sends, "tried again, still nowhere to go").toEqual([]); expect(pending(dir)).toHaveLength(1);
    // A restart: a new fleet over the same folder, now with a destination, finds what was kept and delivers it.
    const next = fleet(dir); next.fm.runtimeCoordinator(); await settle(30_000);
    expect(next.control.sends).toEqual([kept[0].text]); expect(pending(dir)).toEqual([]);
    next.fm.runtimeHub?.close(); fm.runtimeHub?.close();
  });
  it("is kept when the platform refuses it AFTER it was dispatched (the send's promise rejects), and a later retry delivers it", async () => {
    const { dir, fm, control } = fleet(); control.set("reject");
    join_(fm.runtimeCoordinator()); await settle();
    expect(control.sends, "it was dispatched").toHaveLength(1); expect(pending(dir), "but not acknowledged: still kept").toHaveLength(1);
    control.set("ok"); await settle(60_000);
    expect(control.sends).toHaveLength(2); expect(pending(dir)).toEqual([]); fm.runtimeHub?.close();
  });
  it("a kept notice whose retry is refused again is not deleted: it stays until a delivery is acknowledged", async () => {
    const { dir, fm, control } = fleet(undefined, false);
    join_(fm.runtimeCoordinator()); await settle(); expect(pending(dir)).toHaveLength(1);
    fm.fleetConfig.channel = { type: "telegram", group_id: "g1" }; control.set("reject");                // a destination appears, but the platform refuses
    await settle(60_000); expect(control.sends).toHaveLength(1); expect(pending(dir), "the rejected retry did not delete it").toHaveLength(1);
    await settle(60_000); expect(control.sends).toHaveLength(2); expect(pending(dir)).toHaveLength(1);
    control.set("ok"); await settle(60_000);
    expect(control.sends).toHaveLength(3); expect(pending(dir)).toEqual([]); fm.runtimeHub?.close();
  });
  it("does not let a second attempt start while one is waiting for its answer, and keeps unrelated notices apart", async () => {
    const { dir, fm, control, adapter } = fleet(); let answer!: () => void;
    adapter.sendText.mockImplementationOnce((_chat: string, text: string) => { control.sends.push(text); return new Promise<void>(done => { answer = done; }); });
    join_(fm.runtimeCoordinator()); await settle(); expect(control.sends).toHaveLength(1); expect(pending(dir)).toHaveLength(1);
    expect(fm.flushOwnerNotices(), "a flush while the first is in flight does not send it again").toBe(1); expect(control.sends).toHaveLength(1);
    answer(); await settle(); expect(pending(dir)).toEqual([]); fm.runtimeHub?.close();
  });
  it("past the capacity the oldest undelivered notices are folded into ONE notice with a count, never silently dropped, and that notice is delivered too", async () => {
    const { dir, fm, control } = fleet(undefined, false); const cap = (FleetManager as any).OWNER_NOTICE_CAP as number;
    expect(cap).toBeGreaterThan(51);                                                         // below the coordinator's 64 active machines the old reader silently lost the first one
    const hub = fm.runtimeCoordinator();
    for (let i = 0; i < cap + 20; i++) fm.deliverOwnerNotice(`⚠️ computer ${i} joined AgEnD with a one-time install-command token`);
    const rows = pending(dir); expect(rows.length).toBeLessThanOrEqual(cap);
    const folded = rows[0]; expect(folded.folded, "the oldest were folded, with their number").toBe(21);
    expect(folded.text).toMatch(/21 more computers joined AgEnD with a one-time install-command token/);
    expect(rows.slice(1).map(row => row.text)).toEqual(Array.from({ length: cap - 1 }, (_, i) => `⚠️ computer ${i + 21} joined AgEnD with a one-time install-command token`));
    control.set("ok"); fm.fleetConfig.channel = { type: "telegram", group_id: "g1" }; control.sends.length = 0;
    await settle(60_000); expect(control.sends[0]).toBe(folded.text); expect(control.sends).toHaveLength(rows.length); expect(pending(dir)).toEqual([]);
    // folding again adds to the same count
    fm.fleetConfig.channel = { type: "telegram" }; control.set("ok");
    for (let i = 0; i < cap + 5; i++) fm.deliverOwnerNotice(`n${i}`);
    expect(pending(dir)[0].folded).toBe(6); hub.close?.(); fm.runtimeHub?.close();
  });
  it("a damaged or foreign file keeps nothing it cannot read, and a legacy plain-text entry is still delivered", async () => {
    const { dir, fm, control } = fleet();
    writeFileSync(pendingFile(dir), JSON.stringify(["an old plain notice", 4, "", { id: 5 }, "x".repeat(5000), { id: "a", text: "keep me", folded: -3 }]));
    expect(fm.flushOwnerNotices()).toBeGreaterThan(0); await settle();
    expect(control.sends.sort()).toEqual(["an old plain notice", "keep me"]); expect(pending(dir)).toEqual([]);
    writeFileSync(pendingFile(dir), "{not json"); expect(fm.flushOwnerNotices()).toBe(0);
  });
});
