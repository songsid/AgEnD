import { describe, expect, it, vi } from "vitest";
import { signIn } from "../scripts/manual/smoke-fixture/sign-in.js";

function fixture(auto = true, refused = false) {
  let navigated = false, inFlight = false, sends = 0;
  const send = () => { if (!inFlight) { sends++; inFlight = true; if (!refused) navigated = true; } };
  const input = { value: "", dispatchEvent: vi.fn(() => { if (auto) send(); }), form: { requestSubmit: vi.fn(send) } };
  const page = {
    waitForSelector: vi.fn(async () => {}),
    // Reproduce the old race: the 3s wait loses to navigation, then #go no longer exists.
    fill: vi.fn(async () => {}),
    waitForURL: vi.fn(async (_home: string, opts: { timeout: number }) => {
      if (opts.timeout === 3000) { navigated = true; throw Error("short navigation wait expired"); }
      if (!navigated) throw Error("sign-in refused");
    }),
    locator: vi.fn((selector: string) => ({
      isEnabled: async () => { throw Error("removed #go after automatic navigation"); },
      evaluate: async (fn: (element: typeof input, value: string) => void, value: string) => {
        expect(selector).toBe("#code"); fn(input, value);
      },
    })),
    click: vi.fn(async () => { throw Error("unexpected second submit"); }),
  };
  return { page, input, sends: () => sends };
}

describe("M-3551 fixture sign-in navigation race", () => {
  it("submits in one page turn and never queries a removed button after automatic navigation", async () => {
    const f = fixture();
    await signIn(f.page, "EXAMPLE1", "http://fixture/ui");
    expect(f.input.value).toBe("EXAMPLE1");
    expect(f.input.dispatchEvent).toHaveBeenCalledOnce();
    expect(f.input.form.requestSubmit).toHaveBeenCalledOnce();
    expect(f.sends()).toBe(1); // product's input + submit in-flight deduplication
    expect(f.page.waitForURL).toHaveBeenCalledExactlyOnceWith("http://fixture/ui", { timeout: 15000 });
    expect(f.page.fill).not.toHaveBeenCalled();
    expect(f.page.click).not.toHaveBeenCalled();
  });
  it("explicitly submits when automatic input submission is unavailable", async () => {
    const f = fixture(false);
    await signIn(f.page, "EXAMPLE1", "http://fixture/ui");
    expect(f.sends()).toBe(1);
  });
  it("fails a refused navigation without a retry or longer wait", async () => {
    const f = fixture(true, true);
    await expect(signIn(f.page, "EXAMPLE1", "http://fixture/ui")).rejects.toThrow("sign-in refused");
    expect(f.sends()).toBe(1);
    expect(f.page.waitForURL).toHaveBeenCalledExactlyOnceWith("http://fixture/ui", { timeout: 15000 });
  });
});
