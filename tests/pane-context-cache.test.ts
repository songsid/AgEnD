import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInstanceContext, forgetInstanceContext } from "../src/topic-commands.js";

// resolveInstanceContext used to scrape the pane synchronously (execFileSync, 2s
// timeout) on every cache miss — and the 12s TTL was LONGER than the dashboard's 10s
// SSE tick, so roughly every other tick did N blocking captures. With ten
// non-claude-code instances and a slow tmux, that froze the whole fleet event loop
// for up to 20s per tick: no IPC, no message delivery, no watchdog ping. It is now
// stale-while-revalidate, so the polled paths never block.

const dataDir = () => mkdtempSync(join(tmpdir(), "agend-ctx-"));

describe("resolveInstanceContext (polled path)", () => {
  it("returns immediately for an unknown instance instead of blocking on tmux", () => {
    // No such tmux window exists, so the old code paid the full execFileSync round
    // trip (and up to its 2s timeout) before answering null.
    const started = Date.now();
    const result = resolveInstanceContext(dataDir(), "no-such-instance-xyz", "grok");
    const elapsed = Date.now() - started;

    expect(result).toEqual({ context: null, tokenRatio: null });
    // A spawn+wait would be milliseconds at best and 2000ms at worst; the
    // non-blocking path returns essentially instantly.
    expect(elapsed).toBeLessThan(50);
  });

  it("does not spawn a capture per call while a refresh is in flight", () => {
    // Deduped by instance: N dashboard tabs polling must not queue N captures.
    const dir = dataDir();
    const started = Date.now();
    for (let i = 0; i < 25; i++) resolveInstanceContext(dir, "dedupe-target", "grok");
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("prefers statusline.json for claude-code without touching tmux", () => {
    const dir = dataDir();
    const instanceDir = join(dir, "instances", "alpha");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "statusline.json"), JSON.stringify({
      context_window: { used_percentage: 42 },
    }));

    const result = resolveInstanceContext(dir, "alpha", "claude-code");
    expect(result.context).toBe(42);
  });

  it("stays fast across many different instances", () => {
    // The 20s-freeze scenario: a full roster tick over ten non-claude-code
    // instances, none of which has a live pane.
    const dir = dataDir();
    const started = Date.now();
    for (let i = 0; i < 10; i++) resolveInstanceContext(dir, `roster-${i}`, "grok");
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe("forgetInstanceContext", () => {
  it("is callable for an instance that was never cached", () => {
    // Called from removeInstance; nothing else evicted deleted entries before, so
    // the map grew for the life of the process.
    expect(() => forgetInstanceContext("never-seen")).not.toThrow();
  });

  it("clears a cached entry", () => {
    const dir = dataDir();
    resolveInstanceContext(dir, "to-forget", "grok");
    expect(() => forgetInstanceContext("to-forget")).not.toThrow();
    // Still answers (with a fresh background refresh) rather than throwing.
    expect(resolveInstanceContext(dir, "to-forget", "grok")).toEqual({ context: null, tokenRatio: null });
  });
});

describe("bypassCache (the /ctx path)", () => {
  it("still reads synchronously when a user is asking right now", () => {
    // Correctness over latency here: /ctx must not answer from a stale cache.
    const result = resolveInstanceContext(dataDir(), "no-such-instance-xyz", "grok", { bypassCache: true });
    expect(result).toEqual({ context: null, tokenRatio: null });
  });
});
