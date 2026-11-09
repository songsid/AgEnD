import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
/** `kind`: "chat" (a Telegram channel, with or without a place for fleet notices), or "web" (no chat at all: the dashboard's Notices). `native`: a native-exec Windows General. */
function fleet(dir?: string, destination: boolean | "web" = true, native = false) {
  const home = dir ?? mkdtempSync(join(tmpdir(), "agend-owner-notice-")); if (!dir) roots.push(home);
  const fm = new FleetManager(home) as any;
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  fm.fleetConfig = { defaults: {}, instances: native ? { general: { general_topic: true, runtime: "windows", native_agent_id: "12345678-1234-4321-abcd-123456789012", native_adapter: "exec", working_directory: "C:\\x" } } : {}, ...(destination === "web" ? {} : { channel: destination ? { type: "telegram", group_id: "g1" } : { type: "telegram" } }) };   // a chat-connected fleet, with or without a place for fleet notices
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
  it("keeps the send claim until the send settles, however long that takes: a held promise is never sent again, and a late answer retires only its own attempt", async () => {
    const { dir, fm, control, adapter } = fleet(); let late!: { ok: () => void; fail: () => void };
    adapter.sendText.mockImplementationOnce((_chat: string, text: string) => { control.sends.push(text); return new Promise<void>((ok, fail) => { late = { ok: () => ok(), fail: () => fail(new Error("late refusal")) }; }); });
    join_(fm.runtimeCoordinator()); await settle(); expect(control.sends).toHaveLength(1);
    await settle(10 * 60_000); expect(control.sends, "ten minutes on, with the first send still held: no second physical send").toHaveLength(1); expect(pending(dir)).toHaveLength(1);
    late.fail(); await settle(); expect(pending(dir), "a late refusal keeps it").toHaveLength(1); expect(control.sends).toHaveLength(1);
    await settle(60_000); expect(control.sends, "now free: the retry sends and is acknowledged").toHaveLength(2); expect(pending(dir)).toEqual([]);
    fm.runtimeHub?.close();
    // a late acknowledgement of the old attempt after a successor exists cannot retire the successor's claim
    const second = fleet(); let held: Array<() => void> = [];
    second.adapter.sendText.mockImplementation((_chat: string, text: string) => { second.control.sends.push(text); return new Promise<void>(ok => { held.push(() => ok()); }); });
    second.fm.deliverOwnerNotice("⚠️ one"); await settle(); expect(second.control.sends).toHaveLength(1);
    held[0](); await settle(); expect(pending(second.dir)).toEqual([]);
    second.fm.deliverOwnerNotice("⚠️ two"); await settle(); expect(second.control.sends).toHaveLength(2); held[0](); await settle();          // the first attempt answers AGAIN (it already settled): nothing happens to the second
    expect(pending(second.dir).map(row => row.text)).toEqual(["⚠️ two"]); expect(second.fm.flushOwnerNotices()).toBe(1); expect(second.control.sends, "still one send for the second notice").toHaveLength(2);
    held[1](); await settle(); expect(pending(second.dir)).toEqual([]);
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
  it("on a web-only fleet it is acknowledged only by a Notice that was WRITTEN: a failed file write keeps it, and it is recovered after a restart (positive control: normal storage)", async () => {
    const ok = fleet(undefined, "web"); join_(ok.fm.runtimeCoordinator()); await settle();
    expect(pending(ok.dir), "a written Notice is the acknowledgement").toEqual([]); expect((ok.fm.webNoticeStore() as any).items.map((n: { text: string }) => n.text)).toHaveLength(1); ok.fm.runtimeHub?.close();
    const bad = fleet(undefined, "web"); mkdirSync(join(bad.dir, "web-notices.json"));                                    // the file cannot be written
    join_(bad.fm.runtimeCoordinator()); await settle();
    expect(pending(bad.dir), "an in-memory Notice is not durable: the notice is kept").toHaveLength(1);
    await settle(60_000); expect(pending(bad.dir)).toHaveLength(1);
    rmSync(join(bad.dir, "web-notices.json"), { recursive: true });                                                        // fixed, and a restart
    const next = fleet(bad.dir, "web"); next.fm.runtimeCoordinator(); await settle(30_000);
    expect(pending(bad.dir)).toEqual([]); expect(JSON.parse(readFileSync(join(bad.dir, "web-notices.json"), "utf8")).items).toHaveLength(1);
    next.fm.runtimeHub?.close(); bad.fm.runtimeHub?.close();
  });
  it("a native-exec General is never an acknowledgement (an SSE line has no receipt): it is shown once, and the notice is delivered by the channel or kept", async () => {
    const noPlace = fleet(undefined, false, true), live = vi.spyOn(noPlace.fm, "emitSseEvent");
    join_(noPlace.fm.runtimeCoordinator()); await settle();
    expect(pending(noPlace.dir), "nowhere durable to put it: kept").toHaveLength(1); expect(live.mock.calls.filter(call => call[0] === "message")).toHaveLength(1);
    await settle(3 * 60_000); expect(pending(noPlace.dir)).toHaveLength(1); expect(live.mock.calls.filter(call => call[0] === "message"), "not repeated on every retry").toHaveLength(1);
    noPlace.fm.fleetConfig.channel = { type: "telegram", group_id: "g1" }; await settle(60_000);                         // a place appears
    expect(noPlace.control.sends).toHaveLength(1); expect(pending(noPlace.dir)).toEqual([]); noPlace.fm.runtimeHub?.close();
    const chat = fleet(undefined, true, true); join_(chat.fm.runtimeCoordinator()); await settle();
    expect(chat.control.sends, "a channel exists: it goes there and that is the acknowledgement").toHaveLength(1); expect(pending(chat.dir)).toEqual([]); chat.fm.runtimeHub?.close();
    // a restart keeps what was kept
    const web = fleet(undefined, "web", true); mkdirSync(join(web.dir, "web-notices.json")); join_(web.fm.runtimeCoordinator()); await settle();
    expect(pending(web.dir)).toHaveLength(1); web.fm.runtimeHub?.close();
  });
  it("a damaged or foreign file keeps nothing it cannot read, and a legacy plain-text entry is still delivered", async () => {
    const { dir, fm, control } = fleet();
    writeFileSync(pendingFile(dir), JSON.stringify(["an old plain notice", 4, "", { id: 5 }, "x".repeat(5000), { id: "a", text: "keep me", folded: -3 }]));
    expect(fm.flushOwnerNotices()).toBeGreaterThan(0); await settle();
    expect(control.sends.sort()).toEqual(["an old plain notice", "keep me"]); expect(pending(dir)).toEqual([]);
    writeFileSync(pendingFile(dir), "{not json"); expect(fm.flushOwnerNotices()).toBe(0);
  });
});
