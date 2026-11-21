import { expect, it } from "vitest";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { WebChatHistory } from "../src/web-chat-history.js";

it("resends a failed accepted message in place, fencing old reports and keeping attention until the new attempt lands", () => {
  const h = new WebChatHistory({ boot: "abcd" });
  const quote = h.record({ instance: "example", role: "agent", sender: "Example", text: "Quoted answer", ts: "2026-01-01" });
  const m = h.record({ instance: "example", role: "user", sender: "Person", text: "Please check", ts: "2026-01-01", messageId: "web-original", retryOwner: "web:operator", replyTo: { boot: quote.boot, id: quote.id, sender: quote.sender, text: quote.text } } as any);
  h.setDelivery("example", "web-original", "failed");
  const retry = (h as any).beginResend("example", m.boot, m.id, 0, "web:operator", "web-next");
  expect(retry.kind).toBe("started"); expect(retry.message).toBe(m);
  expect(h.find("example", m.boot, m.id)?.text).toBe("Please check"); expect(m.replyTo).toMatchObject({ id: quote.id });
  expect((h as any).failedWebDeliveries(0)).toHaveLength(1);
  expect((h as any).beginResend("example", m.boot, m.id, 0, "web:operator", "web-extra").kind).toBe("already");
  expect(h.setDelivery("example", "web-original", "delivered")).toBeNull();
  expect((h as any).failedWebDeliveries(0)).toHaveLength(1);
  h.setDelivery("example", "web-next", "delivered");
  expect((h as any).failedWebDeliveries(0)).toEqual([]);
});

it("does not let another person or an unfailed row claim a retry", () => {
  const h = new WebChatHistory({ boot: "abcd" });
  const m = h.record({ instance: "example", sender: "Person", text: "Please check", ts: "2026-01-01", messageId: "web-original", retryOwner: "dc:person" } as any);
  expect((h as any).beginResend("example", m.boot, m.id, 0, "dc:person", "web-next").kind).toBe("refused");
  h.setDelivery("example", "web-original", "failed");
  expect((h as any).beginResend("example", m.boot, m.id, 0, "dc:other", "web-next").kind).toBe("refused");
  expect(m.messageId).toBe("web-original"); expect(m.delivery).toBe("failed");
});

it("keeps a failed retry episode across a history reload, including an in-flight resend", () => {
  let saved: any[] = [];
  const h = new WebChatHistory({ boot: "abcd", store: { schedule: (_name, snapshot) => saved = snapshot(), remove: async () => {} } });
  const m = h.record({ instance: "example", sender: "Person", text: "Check it", ts: "2026-01-01", messageId: "web-old", retryOwner: "web:operator" });
  h.setDelivery("example", "web-old", "failed");
  h.beginResend("example", m.boot, m.id, 0, "web:operator", "web-new");
  const restored = new WebChatHistory({ boot: "dcba" }); restored.restore("example", saved);
  expect(restored.find("example", m.boot, m.id)).toMatchObject({ id: m.id, messageId: "web-new", delivery: "queued", retry: { attempt: 1, owner: "web:operator" } });
  expect(restored.failedWebDeliveries(0)).toHaveLength(1);
  expect(restored.setDelivery("example", "web-old", "delivered")).toBeNull();
  restored.setDelivery("example", "web-new", "delivered"); expect(restored.failedWebDeliveries(0)).toEqual([]);
});

it("acknowledges a web attention item once and reopens attention for a new failed attempt", () => {
  const h = new WebChatHistory({ boot: "abcd" });
  const m = h.record({ instance: "example", sender: "Person", text: "Check it", ts: "2026-01-01", messageId: "web-old", retryOwner: "web:operator" });
  h.setDelivery("example", "web-old", "failed"); const id = `web:${m.boot}:${m.id}`;
  expect(h.acknowledgeWebDelivery(id)).toBe(true); expect(h.acknowledgeWebDelivery(id)).toBe(false); expect(h.failedWebDeliveries(0)).toEqual([]);
  h.beginResend("example", m.boot, m.id, 0, "web:operator", "web-new"); h.setDelivery("example", "web-new", "failed");
  expect(h.failedWebDeliveries(0)).toHaveLength(1);
});

it("restores no retry authority from invalid or mismatched descriptors", () => {
  for (const info of [{ owner: "dc:other", attempt: 0, failedAt: 10 }, { owner: "dc:person", attempt: -1, failedAt: 10 }, { owner: "", attempt: 0, failedAt: 10 }]) {
    const h = new WebChatHistory({ boot: "dcba" });
    h.restore("example", [{ boot: "abcd", id: 1, instance: "example", role: "user", sender: "Person", text: "Check it", ts: "2026-01-01", from: "dc:person", retry: { info, messageId: "web-old", delivery: "failed" } }]);
    expect(h.find("example", "abcd", 1)?.retry).toBeUndefined();
    expect(h.find("example", "abcd", 1)?.delivery).toBeUndefined();
  }
});

it("exposes Resend on the same reviewed public POST surface as Send, without an extra wildcard", () => {
  expect(isPublicWebRoute("POST", "/ui/resend")).toBe(true);
  expect(isPublicWebRoute("POST", "/ui/resend/extra")).toBe(false);
});
