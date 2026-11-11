/**
 * M-2921 (Hub UX U1, spec 1.1): the one Hub input's classification table, the messages it maps to, and the sign-in
 * wait on the Fleet card (the countdown, Reopen tab / Cancel, and S1's refusals of the pending request).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
let one: any, fleet: any;
const mounted: AppPage[] = [];
beforeAll(async () => { const p = page({ storage: { agend_lang: "en" } }); one = await import("/ui/js/hub-join-one-strings.js"); fleet = await import("/ui/js/settings-hub-company-join.js"); p.restore(); });
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("M-2921: what the one input holds", () => {
  it.each([
    ["", { kind: "empty" }],
    ["   ", { kind: "empty" }],
    ["https://hub.example.com", { kind: "address", address: "https://hub.example.com" }],
    ["https://hub.example.com/", { kind: "address", address: "https://hub.example.com" }],
    ["https://hub.example.com:9443", { kind: "address", address: "https://hub.example.com:9443" }],
    ["  hub.example.com  ", { kind: "address", address: "https://hub.example.com" }],
    ["Hub.Example.com:8443", { kind: "address", address: "https://hub.example.com:8443" }],
    ["10.0.0.5", { kind: "address", address: "https://10.0.0.5" }],
    ["https://hub.example.com/join-info#hub=YWJj", { kind: "address", address: "https://hub.example.com/join-info#hub=YWJj" }],
    ["https://hub.example.com/join-info#invite=YWJj", { kind: "address", address: "https://hub.example.com/join-info#invite=YWJj" }],
    ["hub.example.com ABCD-EF01", { kind: "address", address: "https://hub.example.com", code: "ABCD-EF01" }],
    ["hub.example.com abcdef01", { kind: "address", address: "https://hub.example.com", code: "ABCDEF01" }],
    ["abcdef012345", { kind: "pairing", code: "abcdef012345" }],
    ["ABCD-EF01-2345", { kind: "pairing", code: "ABCD-EF01-2345" }],
    ["https://hub.example.com abcdef012345", { kind: "pairing", address: "https://hub.example.com", code: "abcdef012345" }],
    ["http://hub.example.com", { kind: "error", error: "E2" }],
    ["hub.example.com ABCO-EF01", { kind: "error", error: "E1" }],
    ["https://hub.example.com/path", { kind: "error", error: "E1" }],
    ["https://hub.example.com/join-info#other=1", { kind: "error", error: "E1" }],
    ["https://user:pw@hub.example.com", { kind: "error", error: "E1" }],
    ["ftp://hub.example.com", { kind: "error", error: "E1" }],
    ["javascript:alert(1)", { kind: "error", error: "E1" }],
    ["hub.example.com:99999", { kind: "error", error: "E1" }],
    ["not a hub", { kind: "error", error: "E1" }],
    ["-bad.example.com", { kind: "error", error: "E1" }],
  ])("%j → %j", (typed, kind) => { expect(one.classifyHubInput(typed)).toEqual(kind); });
  it("S1 refusals of a pending request map to E13 / E10 / E9 / E11; anything else to nothing", () => {
    expect(one.waitingMessage("offer-pending")).toContain("Another connection with a pairing code");
    expect(one.waitingMessage("limit-reached")).toContain("limit of connected Fleets");
    expect(one.waitingMessage("denied")).toContain("may not connect a Fleet");
    expect(one.waitingMessage("backpressure")).toContain("will retry shortly");
    expect(one.waitingMessage(null)).toBeNull(); expect(one.waitingMessage("other")).toBeNull();
  });
  it("E12 only when nothing was issued; an issued expiry keeps the existing wording", () => {
    expect(one.reasonMessage({ reason: "expired", issued: false })).toContain("nothing was created");
    expect(one.reasonMessage({ reason: "expired", issued: true })).toBeNull();
  });
  it("mm:ss left", () => { expect(one.leftOf(1_000 + 125_000, 1_000)).toBe("2:05"); expect(one.leftOf(0, 5_000)).toBe("0:00"); });
});

describe("M-2921: the sign-in wait on the Fleet card", () => {
  async function waitingCard(waiting: string | null) {
    const operation = { operationId: "0f1e2d3c-4b5a-4968-8776-655443322110", state: "awaiting-sign-in", issued: false, outcomeKnown: true, hubOrigin: "https://hub.example.test", expiresAt: Date.now() + 125_000, waiting };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, operation, bound: false }) })));
    const p = page({ url: "http://127.0.0.1:19290/settings/hub", storage: { agend_lang: "en" } }); mounted.push(p); await p.mount(h(fleet.CompanyJoinSettings)); await settle(12); return p;
  }
  it("shows the opened tab with a countdown, Reopen tab and Cancel", async () => {
    const p = await waitingCard(null);
    expect(p.root.querySelector(".hub-join-opened").textContent).toMatch(/^Opened the sign-in tab for hub\.example\.test… 2:0[45] left$/);
    const labels = [...p.root.querySelectorAll("a, button")].map((b: any) => b.textContent);
    expect(labels).toContain("Reopen tab"); expect(labels).toContain("Cancel");
    expect(p.root.querySelector('[role="alert"]')).toBeNull();
  });
  it("a Hub refusal of the pending request shows on the Fleet card (E13), not only in the Hub tab", async () => {
    const p = await waitingCard("offer-pending");
    expect(p.root.querySelector('[role="alert"]').textContent).toBe("Another connection with a pairing code is still in progress for you. Finish or stop it on the Hub first.");
  });
});
