/**
 * #3226 D: report_result's Hub-only fields (files, buttons, poll). They are accepted only for target "agend-hub" with a
 * live Hub correlation id, and handed to the representative; any other target or a dead id refuses them, never drops them.
 * F parses buttons/poll through the reply validators before the live-correlation hook.
 */
import { describe, expect, it, vi } from "vitest";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { HUB_ANSWER_UNKNOWN, HUB_ANSWER_USED, HUB_REPORT_TARGET, parseHubReportExtras } from "../src/hub-report-target.js";

const call = async (args: Record<string, unknown>, hubReport: any = vi.fn(() => null)) => {
  let result: unknown, error: string | undefined;
  const ctx: any = { hubReport, logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }, instanceIpcClients: new Map(), fleetConfig: { instances: {} } };
  await outboundHandlers.get("report_result")!(ctx, args, (r, e) => { result = r; error = e ?? undefined; }, { instanceName: "rep", requestId: 1, fleetRequestId: undefined, senderSessionName: undefined } as any);
  return { result, error, hubReport };
};

describe("report_result Hub-only fields", () => {
  it("are refused for any other target, with the reason", async () => {
    for (const extra of [{ files: ["/tmp/a.txt"] }, { buttons: [{ label: "Yes" }] }, { poll: { seconds: 60 } }]) {
      const r = await call({ target_instance: "general", correlation_id: "cid-1", summary: "done", ...extra });
      expect(r.error).toMatch(/only for target_instance "agend-hub"/);
    }
  });
  it("files go to the representative with the answer; a dead Hub correlation id refuses them (never routed as a plain message)", async () => {
    const hubReport = vi.fn((input: any) => input.correlationId === "hub-live" ? Promise.resolve({ ok: true, message: "Delivered to the Hub asker." }) : null);
    const ok = await call({ target_instance: HUB_REPORT_TARGET, correlation_id: "hub-live", summary: "Attached.", files: ["/work/a.csv"] }, hubReport);
    expect(ok.error).toBeUndefined();
    expect(hubReport).toHaveBeenCalledWith(expect.objectContaining({ correlationId: "hub-live", text: "Attached.", extras: { files: ["/work/a.csv"] } }));
    const dead = await call({ target_instance: HUB_REPORT_TARGET, correlation_id: "hub-gone", summary: "Attached.", files: ["/work/a.csv"] }, hubReport);
    expect(dead.error).toMatch(/need a live Hub question/);
  });
  it("normalized buttons and polls reach only their live Hub correlation", async () => {
    const hubReport = vi.fn((input: any) => input.correlationId === "hub-live" ? Promise.resolve({ ok: true, message: "Delivered to the Hub asker." }) : null);
    const args = { target_instance: HUB_REPORT_TARGET, correlation_id: "hub-live", summary: "Pick one", buttons: [{ label: "A" }, { label: "B", value: "b" }], poll: { seconds: 60 } };
    const ok = await call(args, hubReport);
    expect(ok.error).toBeUndefined();
    expect(hubReport).toHaveBeenCalledWith(expect.objectContaining({ correlationId: "hub-live", extras: {
      buttons: [{ label: "A", value: "A" }, { label: "B", value: "b" }], poll: expect.objectContaining({ seconds: 60, question: "Pick one" }),
    } }));
    expect((await call({ ...args, correlation_id: "hub-gone" }, hubReport)).error).toMatch(/need a live Hub question/);
    const invalid = await call({ ...args, poll: { seconds: 0 } }, hubReport);
    expect(invalid.error).toBeDefined();
    expect(hubReport).toHaveBeenCalledTimes(2);
  });
  it("the parser: 1–10 paths; nothing extra for a plain report", () => {
    expect(parseHubReportExtras(HUB_REPORT_TARGET, {})).toEqual({ ok: true, extras: {} });
    expect(parseHubReportExtras("general", {})).toEqual({ ok: true, extras: {} });
    expect(parseHubReportExtras(HUB_REPORT_TARGET, { files: [] }).ok).toBe(false);
    expect(parseHubReportExtras(HUB_REPORT_TARGET, { files: Array.from({ length: 11 }, (_, i) => `/f${i}`) }).ok).toBe(false);
  });
});

describe("M-3637 a Hub answer nobody can take says why", () => {
  /** report_result with an explicit context: `hook` absent means no Hub connection here at all (no hubReport property). */
  const send = async (args: Record<string, unknown>, o: { hook?: any; configured?: boolean; session?: boolean } = {}) => {
    let error: string | undefined;
    const ctx: any = { logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }, instanceIpcClients: new Map(),
      sessionRegistry: new Map(o.session ? [[HUB_REPORT_TARGET, "host-agent"]] : []),
      // A registered session is a real target when its host agent is configured (as the ordinary route resolves it).
      fleetConfig: { instances: { ...(o.configured ? { [HUB_REPORT_TARGET]: {} } : {}), ...(o.session ? { "host-agent": {} } : {}) } }, ...(o.hook ? { hubReport: o.hook } : {}) };
    try {
      await outboundHandlers.get("report_result")!(ctx, args, (_r, e) => { error = e ?? undefined; }, { instanceName: "rep", requestId: 1, fleetRequestId: undefined, senderSessionName: undefined } as any);
    } catch { error = "reached the ordinary route"; }   // this bare ctx cannot finish an ordinary send; reaching it is the point
    return error;
  };
  const report = (cid: string) => ({ target_instance: HUB_REPORT_TARGET, correlation_id: cid, summary: "One more thing." });
  it("a hub-… correlation nobody claims, with no real agend-hub, is refused with the reason, never 'not found'", async () => {
    const error = await send(report("hub-gone"), { hook: vi.fn(() => null) });
    expect(error).toBe(HUB_ANSWER_UNKNOWN);
    expect(error).not.toMatch(/not found/i);
  });
  it("with no Hub connection here at all (the context has no hook), the same reason", async () => {
    expect(await send(report("hub-gone"))).toBe(HUB_ANSWER_UNKNOWN);
  });
  it("a configured agend-hub with no live IPC, or a registered agend-hub session, keeps the ordinary route (Prism #4411)", async () => {
    for (const o of [{ configured: true }, { session: true }]) expect(await send(report("hub-gone"), { hook: vi.fn(() => null), ...o }), JSON.stringify(o)).not.toBe(HUB_ANSWER_UNKNOWN);
  });
  it("the representative's own refusal (an answered question) reaches the agent as is", async () => {
    const error = await send(report("hub-used"), { hook: vi.fn(() => Promise.resolve({ ok: false, message: HUB_ANSWER_USED })) });
    expect(error).toBe(HUB_ANSWER_USED);
    expect(error).toMatch(/exactly one answer/);
  });
  it("a correlation that is not a Hub one keeps the ordinary 'not found'", async () => {
    expect(await send(report("cid-1"), { hook: vi.fn(() => null) })).toBe(`Instance or session not found: ${HUB_REPORT_TARGET}`);
  });
});
