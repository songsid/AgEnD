import { expect, it } from "vitest";
import { RequestContextV1Schema, RequestContextRefV1Schema, RequestOperationBindingV1Schema } from "../src/request-context-protocol.js";
const root = "00000000-0000-4000-8000-000000000001", child = "00000000-0000-4000-8000-000000000002";
const context = () => ({ ref: { version: 1, contextId: root, rootContextId: root }, rootEvidenceRef: "accepted-example",
  initiatingActor: { kind: "person", platform: "discord", userId: "demo-person" }, ingress: "restricted-room",
  source: { instance: "demo-source", incarnation: "demo-generation" }, sourceAudience: { kind: "room", ref: child } });
it("v1 roots and single-parent children have stable distinct identities", () => {
  expect(RequestContextV1Schema.parse(context()).ref.rootContextId).toBe(root);
  expect(RequestContextRefV1Schema.parse({ version: 1, contextId: child, rootContextId: root, parentContextId: root }).parentContextId).toBe(root);
});
it.each([
  { version: 2, contextId: root, rootContextId: root },
  { version: 1, contextId: child, rootContextId: root },
  { version: 1, contextId: root, rootContextId: root, parentContextId: child },
  { version: 1, contextId: child, rootContextId: root, parentContextId: child },
  { version: 1, contextId: child, rootContextId: root, parentContextIds: [root] },
])("rejects unknown version, absent parent, self-parent/root and DAG shape %#", input => {
  expect(RequestContextRefV1Schema.safeParse(input).success).toBe(false);
});
it("identity metadata cannot carry authority or substitute a transport adapter for a person", () => {
  expect(RequestContextV1Schema.safeParse({ ...context(), authority: "owner" }).success).toBe(false);
  expect(RequestContextV1Schema.safeParse({ ...context(), initiatingActor: { ...context().initiatingActor, adapterId: "other-bot" } }).success).toBe(false);
});
it("a Hub person/agent/assistant stays Hub-qualified and cannot turn into a native owner", () => {
  for (const kind of ["person", "agent", "assistant"]) expect(RequestContextV1Schema.safeParse({ ...context(), ingress: "hub",
    initiatingActor: { kind, platform: "hub", hubId: "demo-hub", id: "example/stable-actor" } }).success).toBe(true);
  expect(RequestContextV1Schema.safeParse({ ...context(), ingress: "hub" }).success).toBe(false);
  expect(RequestContextV1Schema.safeParse({ ...context(), ingress: "hub", initiatingActor: { kind: "unknown", reason: "unproved-recovery" } }).success).toBe(true);
});
it("operation bindings reject malformed payload digests and free-form approval claims", () => {
  const operation = { version: 1, operationId: "demo-operation", contextId: child, rootContextId: root,
    source: { instance: "demo-source", incarnation: "source-v1" }, target: { instance: "demo-worker", incarnation: "target-v1" },
    verb: "send_to_instance", payloadSha256: "a".repeat(64) };
  expect(RequestOperationBindingV1Schema.safeParse(operation).success).toBe(true);
  expect(RequestOperationBindingV1Schema.safeParse({ ...operation, payloadSha256: "bad" }).success).toBe(false);
  expect(RequestOperationBindingV1Schema.safeParse({ ...operation, approved: true }).success).toBe(false);
});
