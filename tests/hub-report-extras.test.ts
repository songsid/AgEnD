/**
 * #3226 D: report_result's Hub-only fields (files, buttons, poll). They are accepted only for target "agend-hub" with a
 * live Hub correlation id, and handed to the representative; any other target or a dead id refuses them, never drops them.
 * Buttons and polls say "not supported yet" until F fills them in.
 */
import { describe, expect, it, vi } from "vitest";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { HUB_REPORT_TARGET, parseHubReportExtras } from "../src/hub-report-target.js";

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
  it("buttons and polls are not supported yet on a Hub answer", async () => {
    const r = await call({ target_instance: HUB_REPORT_TARGET, correlation_id: "hub-live", summary: "Pick one", buttons: [{ label: "A" }, { label: "B" }] });
    expect(r.error).toMatch(/not supported yet/);
    expect(r.hubReport).not.toHaveBeenCalled();
  });
  it("the parser: 1–10 paths; nothing extra for a plain report", () => {
    expect(parseHubReportExtras(HUB_REPORT_TARGET, {})).toEqual({ ok: true, extras: {} });
    expect(parseHubReportExtras("general", {})).toEqual({ ok: true, extras: {} });
    expect(parseHubReportExtras(HUB_REPORT_TARGET, { files: [] }).ok).toBe(false);
    expect(parseHubReportExtras(HUB_REPORT_TARGET, { files: Array.from({ length: 11 }, (_, i) => `/f${i}`) }).ok).toBe(false);
  });
});
