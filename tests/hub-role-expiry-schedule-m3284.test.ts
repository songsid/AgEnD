import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoleExpiryResult } from "../src/hub/roles/expiry.js";
import { scheduleHubRoleExpiry } from "../src/hub/roles/expiry-schedule.js";

const schedules: ReturnType<typeof scheduleHubRoleExpiry>[] = [];
afterEach(async () => { for (const s of schedules.splice(0)) await s.close(); vi.useRealTimers(); });
function rig() {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  let deadline: number | null = null, current = true;
  const expiry = {
    nextExpiry: vi.fn(() => deadline),
    settle: vi.fn(async (): Promise<RoleExpiryResult> => { if (deadline !== null && deadline <= Date.now()) deadline = null; return { ok: true as const, settled: 0 }; }),
    close: vi.fn(),
  };
  const held = vi.fn();
  const s = scheduleHubRoleExpiry({ expiry, current: () => current, now: Date.now, held }); schedules.push(s);
  return { s, expiry, held, deadline: (at: number | null) => { deadline = at; }, retire: () => { current = false; } };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
describe("Hub expiry deadline scheduling", () => {
  it("settles at the nearest deadline rather than the old 30-second poll", async () => {
    const r = rig(); r.deadline(Date.now() + 250); await flush();
    expect(r.expiry.settle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249); expect(r.expiry.settle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(r.expiry.settle).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000); expect(r.expiry.settle).toHaveBeenCalledTimes(2);
  });
  it("replans earlier, later and removed terms after committed role edits", async () => {
    const r = rig(); r.deadline(Date.now() + 20_000); await flush();
    r.deadline(Date.now() + 100); r.s.replan();
    await vi.advanceTimersByTimeAsync(100); expect(r.expiry.settle).toHaveBeenCalledTimes(2);
    r.deadline(Date.now() + 100); r.s.replan();
    r.deadline(Date.now() + 500); r.s.replan();
    await vi.advanceTimersByTimeAsync(100); expect(r.expiry.settle).toHaveBeenCalledTimes(2);
    r.deadline(null); r.s.replan();
    await vi.advanceTimersByTimeAsync(500); expect(r.expiry.settle).toHaveBeenCalledTimes(2);
  });
  it.each(["held", "thrown"])("retries a %s settlement after one second without a zero-delay loop", async mode => {
    const r = rig(); r.deadline(Date.now());
    if (mode === "held") r.expiry.settle.mockResolvedValueOnce({ ok: false, code: "conflict" });
    else r.expiry.settle.mockRejectedValueOnce(Error("directory unavailable"));
    await flush(); expect(r.held).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999); expect(r.expiry.settle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(r.expiry.settle).toHaveBeenCalledTimes(2);
  });
  it("serializes replans behind an in-flight settlement and drains it at close", async () => {
    const r = rig(); let resolve!: (value: { ok: true; settled: number }) => void;
    r.expiry.settle.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await flush(); r.deadline(Date.now()); r.s.replan();
    await vi.advanceTimersByTimeAsync(30_000); expect(r.expiry.settle).toHaveBeenCalledTimes(1);
    let closed = false; const closing = r.s.close().then(() => { closed = true; });
    await flush(); expect(closed).toBe(false); resolve({ ok: true, settled: 0 }); await closing;
    await vi.advanceTimersByTimeAsync(30_000); expect(r.expiry.settle).toHaveBeenCalledTimes(1);
  });
  it("keeps the bounded safety recheck and stops on owner retirement", async () => {
    const r = rig(); await flush();
    await vi.advanceTimersByTimeAsync(30_000); expect(r.expiry.settle).toHaveBeenCalledTimes(2);
    r.retire(); await vi.advanceTimersByTimeAsync(30_000); expect(r.expiry.settle).toHaveBeenCalledTimes(2);
  });
});
