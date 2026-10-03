import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { probe, postMessage, close, input } = vi.hoisted(() => ({
  probe: vi.fn(), postMessage: vi.fn(), close: vi.fn(), input: { mode: "models", backend: "codex" },
}));
vi.mock("node:worker_threads", () => ({ workerData: input, parentPort: { postMessage, close } }));
vi.mock("../src/backend/cli-env-probe.js", () => ({ runBackendProbe: probe }));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => vi.resetModules());
describe("CLI env worker message boundary", () => {
  it("passes the whole input to the isolated probe and closes after its result", async () => {
    const result = [{ id: "private", label: "Private" }];
    probe.mockResolvedValue(result);
    await import("../src/backend/cli-env-probe-worker.js");
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(probe).toHaveBeenCalledWith(input);
    expect(postMessage).toHaveBeenCalledWith({ ok: true, result });
    expect(postMessage.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]!);
  });
  it("reports probe failure and closes without leaving the parent waiting forever", async () => {
    probe.mockRejectedValue(new Error("CLI unavailable"));
    await import("../src/backend/cli-env-probe-worker.js");
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(postMessage).toHaveBeenCalledWith({ ok: false, error: "CLI unavailable" });
  });
});
