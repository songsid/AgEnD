import { describe, expect, it } from "vitest";
import {
  formatCrossInstanceInboundMessage,
  isRedundantTaskSummary,
} from "../src/cross-instance-envelope.js";

/**
 * #1037: the injected block must not echo the body as task_summary.
 * Senders auto-derive task_summary from the first 200 chars when none is
 * given (outbound-handlers) — rendering it unconditionally repeats the body.
 * Logs and Telegram labels keep the raw value; only the injected block dedups.
 */

const BASE_META = {
  from_instance: "agend-leader",
  message_id: "xmsg-1",
  correlation_id: "cid-1",
  request_kind: "report",
};

describe("isRedundantTaskSummary", () => {
  it("flags an auto-derived prefix of the body", () => {
    const body = "The full report text goes here and on and on";
    expect(isRedundantTaskSummary(body, body.slice(0, 20))).toBe(true);
  });

  it("flags a summary equal to the body", () => {
    expect(isRedundantTaskSummary("same text", "same text")).toBe(true);
  });

  it("keeps an explicit summary that says more than the body", () => {
    expect(isRedundantTaskSummary("fix the bug", "fix the bug in auth and add a regression test")).toBe(false);
  });

  it("keeps a distinct summary and tolerates blanks", () => {
    expect(isRedundantTaskSummary("unrelated body", "port the provider")).toBe(false);
    expect(isRedundantTaskSummary("body", "")).toBe(false);
    expect(isRedundantTaskSummary("body", "   ")).toBe(false);
    expect(isRedundantTaskSummary("", "something")).toBe(false);
  });
});

describe("formatCrossInstanceInboundMessage (#1037)", () => {
  it("omits the task_summary line when it echoes the body", () => {
    const body = "The full report text goes here and on and on past two hundred characters".repeat(4);
    const out = formatCrossInstanceInboundMessage(body, { ...BASE_META, task_summary: body.slice(0, 200) });
    expect(out).toContain(body);
    expect(out).not.toContain("task_summary:");
    expect(out).toContain("message_id: xmsg-1");
  });

  it("still shows an explicit distinct task_summary", () => {
    const out = formatCrossInstanceInboundMessage("please do the thing", {
      ...BASE_META,
      task_summary: "port the provider",
    });
    expect(out).toContain("task_summary: port the provider");
  });

  it("omits an explicit summary that is a prefix of the body", () => {
    const out = formatCrossInstanceInboundMessage("fix the flake in CI now", {
      ...BASE_META,
      task_summary: "fix the flake",
    });
    expect(out).not.toContain("task_summary:");
  });
});
