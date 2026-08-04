import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  parseResetsIn,
  reportProviderRateLimit,
  getProviderRateLimit,
  clearProviderRateLimitsForTests,
} from "../src/usage/provider-alerts.js";
import { AntigravityBackend } from "../src/backend/antigravity.js";
import { InstanceLifecycle, type LifecycleContext, type IncidentEventSource } from "../src/instance-lifecycle.js";

/**
 * Antigravity's quota summary API cannot see the account-level individual cap.
 * Verified live (2026-08-02, same minute): `agy -p` returned "Individual quota
 * reached … Resets in 139h12m12s" while retrieveUserQuotaSummary reported every
 * bucket at remainingFraction 1.0 — so /usage showed 🟢 0% for an account whose
 * CLI was refusing all work. The pane error is the only place the cap surfaces;
 * this chain (error monitor → in-memory alert → provider overlay) is what turns
 * it into a red row with the reset time.
 */

// The line the server relays, verbatim from the live reproduction.
const CAP_LINE = "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 139h12m12s.";

beforeEach(() => clearProviderRateLimitsForTests());
afterEach(() => vi.unstubAllGlobals());

describe("parseResetsIn", () => {
  it("parses the live message's h/m/s form", () => {
    expect(parseResetsIn(CAP_LINE)).toBe(((139 * 60 + 12) * 60 + 12) * 1000);
  });

  it("accepts partial forms", () => {
    expect(parseResetsIn("Resets in 5h")).toBe(5 * 3_600_000);
    expect(parseResetsIn("Resets in 30m10s")).toBe((30 * 60 + 10) * 1000);
    expect(parseResetsIn("resets in 45s")).toBe(45_000);
  });

  it("returns null when there is nothing to parse — the caller must not guess", () => {
    expect(parseResetsIn("Quota exhausted")).toBeNull();
    expect(parseResetsIn("Resets in a while")).toBeNull();
  });
});

describe("alert lifecycle", () => {
  it("stays live until the reset time, then disappears on its own", () => {
    const now = 1_785_684_000_000;
    reportProviderRateLimit("antigravity", CAP_LINE, now);
    const resetMs = ((139 * 60 + 12) * 60 + 12) * 1000;

    expect(getProviderRateLimit("antigravity", now + resetMs - 1)?.message).toBe(CAP_LINE);
    // "reset 後警示消失" — no cleanup job involved, expiry is the read.
    expect(getProviderRateLimit("antigravity", now + resetMs)).toBeNull();
    expect(getProviderRateLimit("antigravity", now + resetMs - 1)).toBeNull(); // deleted, not just hidden
  });

  it("falls back to a bounded TTL when the message names no reset", () => {
    // A cap with no parseable reset must not alarm forever.
    const now = 1_785_684_000_000;
    reportProviderRateLimit("antigravity", "RESOURCE_EXHAUSTED", now);
    expect(getProviderRateLimit("antigravity", now + 59 * 60_000)).not.toBeNull();
    expect(getProviderRateLimit("antigravity", now + 61 * 60_000)).toBeNull();
  });

  it("a later report replaces the earlier one", () => {
    const now = 1_785_684_000_000;
    reportProviderRateLimit("antigravity", "Resets in 1h", now);
    reportProviderRateLimit("antigravity", "Resets in 10h", now + 1000);
    expect(getProviderRateLimit("antigravity", now + 5 * 3_600_000)).not.toBeNull();
  });
});

describe("the agy error pattern that feeds the alert", () => {
  const patterns = new AntigravityBackend("/tmp").getErrorPatterns();

  it("captures the full cap line, reset time included", () => {
    const pane = `some output\n${CAP_LINE}\n> `;
    const hit = patterns.find(p => p.pattern.test(pane))!;
    expect(hit.type).toBe("quota");
    const match = [...pane.matchAll(new RegExp(hit.pattern.source, hit.pattern.flags + "g"))].at(-1)!;
    const message = hit.formatMessage!(match);
    expect(message).toContain("Individual quota reached");
    expect(message).toContain("Resets in 139h12m12s");
  });

  it("is ordered before the generic quota pattern, which would lose the reset time", () => {
    // The monitor fires the FIRST matching pattern; the generic /quota/i one
    // reports a static "Quota exhausted" with nothing to parse.
    const idxSpecific = patterns.findIndex(p => p.pattern.source.includes("quota reached"));
    const idxGeneric = patterns.findIndex(p => p.pattern.source === "RESOURCE_EXHAUSTED|quota");
    expect(idxSpecific).toBeGreaterThanOrEqual(0);
    expect(idxSpecific).toBeLessThan(idxGeneric);
  });
});

describe("wiring: pty_error → alert → usage row", () => {
  function lifecycleWithBackend(backend: string) {
    const ctx = {
      fleetConfig: { instances: { agy1: { backend } }, defaults: {} },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      eventLog: null,
      isPlannedRestart: () => false,
      notifyInstanceTopic() {},
      webhookEmit() {},
      clearCancelButton() {},
      checkModelFailover() {},
      restartSingleInstance: async () => {},
      // The auth_error case walks pause() → isPaused() → hasPausedMarker(dir);
      // without this the rejection escaped the test as an unhandled error.
      getInstanceDir: (n: string) => `/nonexistent/${n}`,
    } as unknown as LifecycleContext;
    const lifecycle = new InstanceLifecycle(ctx);
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle() {} }) as unknown as IncidentEventSource & EventEmitter;
    lifecycle.attachIncidentHandlers("agy1", daemon);
    return daemon;
  }

  it("an antigravity quota error registers the alert", () => {
    const daemon = lifecycleWithBackend("antigravity");
    daemon.emit("pty_error", { name: "agy1", type: "quota", action: "notify", message: CAP_LINE });
    expect(getProviderRateLimit("antigravity")?.message).toBe(CAP_LINE);
  });

  it("the same error from a non-agy backend does not touch the antigravity row", () => {
    const daemon = lifecycleWithBackend("kiro-cli");
    daemon.emit("pty_error", { name: "agy1", type: "quota", action: "notify", message: CAP_LINE });
    expect(getProviderRateLimit("antigravity")).toBeNull();
  });

  it("a non-quota agy error does not either", () => {
    const daemon = lifecycleWithBackend("antigravity");
    daemon.emit("pty_error", { name: "agy1", type: "auth_error", action: "pause", message: "UNAUTHENTICATED" });
    expect(getProviderRateLimit("antigravity")).toBeNull();
  });
});

describe("the usage row under an active cap", () => {
  it("goes red with the reset time, and makes no quota API call", async () => {
    const { fetchAllUsage } = await import("../src/usage/providers.js");
    reportProviderRateLimit("antigravity", CAP_LINE);
    const fetchSpy = vi.fn();  // any network call would throw — and must not happen
    vi.stubGlobal("fetch", fetchSpy);

    const all = await fetchAllUsage();
    const agy = all.providers.find(p => p.id === "antigravity")!;

    expect(agy.status).toBe("error");            // statusDot renders error as 🔴
    expect(agy.error).toContain("Individual cap reached");
    expect(agy.error).toMatch(/resets in ~(5d|6d)/);
    // The buckets read 0% used while the CLI is blocked — showing them is the
    // exact misleading 🟢 this overlay corrects, so they are withheld.
    expect(agy.metrics).toEqual([]);
    const quotaCalls = fetchSpy.mock.calls.filter(c => String(c[0]).includes("retrieveUserQuotaSummary"));
    expect(quotaCalls).toEqual([]);
  });

  it("renders as a red row in the rich output", async () => {
    const { renderUsageMarkdown } = await import("../src/usage/format-rich.js");
    reportProviderRateLimit("antigravity", CAP_LINE);
    const text = renderUsageMarkdown({
      fetchedAt: new Date().toISOString(),
      providers: [{
        id: "antigravity", name: "Antigravity", status: "error",
        error: "Individual cap reached — CLI is rate limited (resets in ~6d).", metrics: [],
      }],
    });
    expect(text).toContain("🔴 **Antigravity**");
    expect(text).toContain("> ⚠️ Individual cap reached");
  });
});
