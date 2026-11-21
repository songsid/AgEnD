import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { InstanceLifecycle } from "../src/instance-lifecycle.js";

it("reports the actual input failure without calling a live window gone, retaining the failed web receipt", async () => {
  const lifecycle = Object.create(InstanceLifecycle.prototype) as any;
  const warn = vi.fn(), finishDeliveryStatus = vi.fn(), insert = vi.fn();
  lifecycle.ctx = { logger: { warn, error: vi.fn() }, finishDeliveryStatus, eventLog: { insert } };
  const daemon = new EventEmitter(); lifecycle.attachDeliveryStatusHandlers("example", daemon);
  daemon.emit("message_failed", { chatId: "web", messageId: "web-example", phase: "stranded-input", proof: "input-not-clear-timeout" });
  await Promise.resolve();
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({ phase: "stranded-input", proof: "input-not-clear-timeout" }), "Message delivery failed");
  expect(insert).toHaveBeenCalledWith("example", "message_failed", { messageId: "web-example", phase: "stranded-input", proof: "input-not-clear-timeout" });
  expect(finishDeliveryStatus).toHaveBeenCalledWith("example", "web", "web-example", "failed", undefined);
});
