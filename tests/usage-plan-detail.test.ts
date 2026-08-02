import { describe, expect, it } from "vitest";
import { setUsageFetcherForTests } from "../src/usage/usage-api.js";
import { renderUsageMarkdown } from "../src/usage/format-rich.js";
import type { UsagePayload } from "../src/usage/usage-api.js";

/**
 * Probed live on the user's Team account (2026-08-02): `/api/oauth/usage`
 * carries NO plan/tier/multiplier field — the plan label comes entirely from
 * ~/.claude/.credentials.json. What the response DOES carry, and we ignored, is
 * `limits[].is_active`: which window is currently binding. On that account the
 * scoped weekly (26%) was binding while the plain weekly (15%) was not, so the
 * governing number is not always the largest one on screen.
 */

describe("binding-limit marker", () => {
  it("renders the note so the governing window is identifiable", () => {
    const payload: UsagePayload = {
      fetchedAt: "2026-08-02T00:00:00Z",
      providers: [{
        id: "claude", name: "Claude", status: "ok", plan: "Team 5x",
        metrics: [
          { label: "Weekly", type: "percent", used: 15 },
          { label: "Fable (weekly)", type: "percent", used: 26, note: "binding" },
        ],
      }],
    };
    const text = renderUsageMarkdown(payload);
    expect(text).toContain("15% Weekly");
    expect(text).toContain("26% Fable (weekly) (binding)");
  });

  it("carries a non-normal severity alongside the marker", () => {
    const payload: UsagePayload = {
      fetchedAt: "2026-08-02T00:00:00Z",
      providers: [{
        id: "claude", name: "Claude", status: "ok", plan: null,
        metrics: [{ label: "Weekly", type: "percent", used: 92, note: "binding · warning" }],
      }],
    };
    expect(renderUsageMarkdown(payload)).toContain("(binding · warning)");
  });

  it("says nothing extra when no window is binding", () => {
    const payload: UsagePayload = {
      fetchedAt: "2026-08-02T00:00:00Z",
      providers: [{
        id: "claude", name: "Claude", status: "ok", plan: null,
        metrics: [{ label: "Session", type: "percent", used: 4 }],
      }],
    };
    const text = renderUsageMarkdown(payload);
    expect(text).toContain("4% Session");
    expect(text).not.toContain("binding");
  });
});
