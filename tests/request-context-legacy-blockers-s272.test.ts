// S-272: before the first On, earlier contact tickets block it; each now says what settles it (Sentinel's split).
// Pending → decide on Authorizations (the link stays); approved and still being delivered → waits for that delivery;
// approved with no or a mismatched delivery record, or unreadable → named as not settleable here (never guessed).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function blockersWith(shadow: { complete: boolean; tickets: Array<{ id: string; disposition: string; sha256?: string | null }>; blockers: Array<{ id: string; reason: string }> }, deliveries: unknown[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "s272-")); dirs.push(dir);
  const host = { dataDir: dir, fleetConfig: { instances: {} }, classicChannels: null, daemons: new Map(), requestContextCutoverErrors: [],
    requestContextPendingWork: { count: () => 0 }, requestContextShadow: () => shadow,
    captureRequestContextRuntimeSet: () => ({ advertised: () => [], labels: () => [] }),
    deliveryOutbox: { requestContextInstallation: () => ({ read: () => null }), requestContextControlInventory: () => ({ deliveries }) } };
  return (FleetManager.prototype as any).requestContextBlockers.call(host).filter((b: any) => b.kind === "legacy");
}
const t = (id: string, disposition: string, sha256: string | null = null) => ({ id, disposition, sha256 });

describe("S-272: earlier tickets before the first On, by what settles them", () => {
  it("pending / being delivered / not settleable here, each its own blocker; only pending links to Authorizations", () => {
    const tickets = [t("R1", "preserve-legacy-pending"), t("R2", "legacy-inflight"), t("R3", "legacy-unconfirmed"), t("R4", "missing-receipt"), t("R5", "malformed"), t("R6", "preserve-terminal"), t("R7", "preserve-receipt")];
    const blockers = tickets.filter(x => !x.disposition.startsWith("preserve-") || x.disposition === "preserve-legacy-pending").map(x => ({ id: x.id, reason: "legacy" }));
    expect(blockersWith({ complete: true, tickets, blockers })).toEqual([
      { id: "legacy-pending", kind: "legacy", labels: ["R1"], action: "inspect" },
      { id: "legacy-inflight", kind: "legacy", labels: ["R2"] },
      { id: "legacy-unsettled", kind: "legacy", labels: ["R3", "R4", "R5"] },          // Fable #4593: unconfirmed (e.g. uncertain) never clears by itself
    ]);
  });
  it("nothing earlier: no legacy blocker; an incomplete scan with nothing named still blocks as before", () => {
    expect(blockersWith({ complete: true, tickets: [t("R6", "preserve-terminal")], blockers: [] })).toEqual([]);
    expect(blockersWith({ complete: false, tickets: [], blockers: [] })).toEqual([{ id: "legacy", kind: "legacy", labels: [], action: "inspect" }]);
  });
  it("earlier outbox deliveries with no request: being sent waits; no Authorizations link (nothing to decide there)", () => {
    expect(blockersWith({ complete: true, tickets: [], blockers: [] }, [{ id: "d1", source: "lead", target: "worker", root: null, state: "delivering" }]))
      .toEqual([{ id: "legacy-deliveries", kind: "legacy", labels: ["lead → worker"] }]);
  });
  it("M-3897: each retirable ticket (its image readable) gets Retire; an unbound one stays named with no action", () => {
    const tickets = [t("R4", "missing-receipt", "a".repeat(64)), t("R5", "malformed", "b".repeat(64)), t("R3", "legacy-unconfirmed", "c".repeat(64)), t("R8", "malformed", null)];
    expect(blockersWith({ complete: false, tickets, blockers: tickets.map(x => ({ id: x.id, reason: "legacy" })) })).toEqual([
      { id: "legacy-retire:R4", kind: "legacy", labels: ["R4"], action: "retire" },
      { id: "legacy-retire:R5", kind: "legacy", labels: ["R5"], action: "retire" },
      { id: "legacy-retire:R3", kind: "legacy", labels: ["R3"], action: "retire" },
      { id: "legacy-unsettled", kind: "legacy", labels: ["R8"] },
    ]);
  });
  it("M-3897: earlier deliveries by state: queued/retry_wait each get Withdraw; being sent waits; uncertain is named (no action)", () => {
    const d = (id: string, state: string) => ({ id, source: "lead", target: "worker", root: null, state });
    expect(blockersWith({ complete: true, tickets: [], blockers: [] }, [d("q1", "queued"), d("r1", "retry_wait"), d("s1", "submission_started"), d("u1", "uncertain"), { ...d("x1", "queued"), root: "r" }])).toEqual([
      { id: "legacy-withdraw:q1", kind: "legacy", labels: ["lead → worker"], action: "withdraw" },
      { id: "legacy-withdraw:r1", kind: "legacy", labels: ["lead → worker"], action: "withdraw" },
      { id: "legacy-deliveries", kind: "legacy", labels: ["lead → worker"] },
      { id: "legacy-uncertain", kind: "legacy", labels: ["lead → worker"] },
    ]);
  });
});
