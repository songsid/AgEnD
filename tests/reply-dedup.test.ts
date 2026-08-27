import { describe, expect, it, vi } from "vitest";
import { ReplyDeduper } from "../src/reply-dedup.js";
import { SLOW_TOOLS, daemonBudgetMs, SLOW_IPC_BUDGET_MS, mcpTimeoutMs } from "../src/channel/ipc-timeouts.js";

/**
 * Duplicate-reply suppression. The pipeline has no idempotency and every layer
 * above it retries on an uncertain outcome: the daemon times reply out at its
 * budget while the adapter send is still waiting out a Discord rate limit (and
 * will succeed), or an HTTP agent's shell tool kills a slow `agend-agent reply`.
 * The agent re-sends the identical text; the channel used to show it twice.
 */

describe("ReplyDeduper", () => {
  it("passes identical text through again after the first platform send settles", () => {
    const d = new ReplyDeduper();
    const first = d.begin("alpha", "done!");
    expect(first.duplicate).toBe(false);
    if (first.duplicate) throw new Error("unreachable");
    first.complete({ messageId: "m1" });

    // This can be a legitimate second "done!". Replaying m1 here would claim
    // success without a second platform POST.
    expect(d.begin("alpha", "done!").duplicate).toBe(false);
  });

  it("attaches an in-flight duplicate to the original send's outcome", () => {
    // The actual race: the retry arrives while the original is still waiting
    // out a rate limit. One real send; both callers get its outcome.
    const d = new ReplyDeduper();
    const first = d.begin("alpha", "done!");
    if (first.duplicate) throw new Error("unreachable");

    const retry = d.begin("alpha", "done!");
    if (!retry.duplicate) throw new Error("unreachable");
    const seen = vi.fn();
    retry.subscribe(seen);
    expect(seen).not.toHaveBeenCalled(); // still in flight

    first.complete({ messageId: "m1" });
    expect(seen).toHaveBeenCalledWith({ messageId: "m1" }, undefined);
  });

  it("lets a retry through after a genuine failure", () => {
    const d = new ReplyDeduper();
    const first = d.begin("alpha", "done!");
    if (first.duplicate) throw new Error("unreachable");
    first.complete(null, "network down");

    // Retrying a real failure is correct behaviour, not a duplicate.
    expect(d.begin("alpha", "done!").duplicate).toBe(false);
  });

  it("scopes by instance, text, and files", () => {
    const d = new ReplyDeduper();
    const a = d.begin("alpha", "done!");
    if (a.duplicate) throw new Error("unreachable");
    a.complete("ok");

    expect(d.begin("beta", "done!").duplicate).toBe(false);      // other instance
    expect(d.begin("alpha", "done!!").duplicate).toBe(false);    // other text
    expect(d.begin("alpha", "done!", ["/tmp/a.png"]).duplicate).toBe(false); // files differ
    expect(d.begin("alpha", "done!").duplicate).toBe(false);     // completed exact repeat
  });

  it("releases duplicate waiters and the key when an in-flight send never settles", () => {
    vi.useFakeTimers();
    try {
      const d = new ReplyDeduper(1_000);
      const first = d.begin("alpha", "ok");
      if (first.duplicate) throw new Error("unreachable");
      const retry = d.begin("alpha", "ok");
      if (!retry.duplicate) throw new Error("unreachable");
      const seen = vi.fn();
      retry.subscribe(seen);

      vi.advanceTimersByTime(1_001);
      expect(seen).toHaveBeenCalledWith(null, expect.stringContaining("did not settle"));
      expect(d.begin("alpha", "ok").duplicate).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a late double complete without deleting a newer in-flight send", () => {
    const d = new ReplyDeduper();
    const first = d.begin("alpha", "ok");
    if (first.duplicate) throw new Error("unreachable");
    first.complete("sent");

    const second = d.begin("alpha", "ok");
    if (second.duplicate) throw new Error("unreachable");
    expect(() => first.complete("sent-again")).not.toThrow();

    const retry = d.begin("alpha", "ok");
    if (!retry.duplicate) throw new Error("unreachable");
    const seen = vi.fn();
    retry.subscribe(seen);
    expect(seen).not.toHaveBeenCalled();
    second.complete("second-send");
    expect(seen).toHaveBeenCalledWith("second-send", undefined);
  });
});

describe("reply budget", () => {
  it("is in SLOW_TOOLS so a rate-limit stall does not read as failure", () => {
    expect(SLOW_TOOLS.has("reply")).toBe(true);
    expect(daemonBudgetMs("reply")).toBe(SLOW_IPC_BUDGET_MS);
    // The MCP ceiling stays above the daemon budget by construction.
    expect(mcpTimeoutMs("reply")).toBeGreaterThan(daemonBudgetMs("reply"));
  });
});
