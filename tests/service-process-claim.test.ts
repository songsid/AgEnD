/** Strict inert process observation, including the production observer's start-time seam. */
import { afterEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ start: vi.fn(() => 2000 as number | null) }));
vi.mock("../src/update-check.js", () => ({ processStartMs: native.start }));
vi.mock("../src/fleet-stop-budget.js", () => ({ FLEET_STOP_TIMEOUT_MS: 300_000,
  detachedProcessExited: () => false, detachedProcessStart: () => "fixed-birth" }));
import { captureServiceProcess } from "../src/service-drain.js";
afterEach(() => { vi.restoreAllMocks(); native.start.mockReset().mockReturnValue(2000); });
it("reads the default observer's start time once, ignoring only a provably younger PID claim", () => {
  const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    expect(pid).toBe(40); expect(signal).toBe(0); return true;
  });
  expect(captureServiceProcess(40, undefined, 1000)()).toBe(true);
  expect(native.start).toHaveBeenCalledExactlyOnceWith(40); expect(kill).toHaveBeenCalledOnce();
  native.start.mockReturnValue(null);
  expect(captureServiceProcess(40, undefined, 1000)()).toBe(false);
  native.start.mockReturnValue(1000);
  expect(captureServiceProcess(40, undefined, 1000)()).toBe(false);
});
