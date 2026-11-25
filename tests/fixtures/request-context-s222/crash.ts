// Owned data-only child fixture. No Fleet, adapter, process launcher, account or network is started.
import { DeliveryOutbox } from "../../../src/delivery-outbox.js";
import { requestContextDigest } from "../../../src/request-context-store.js";
import type Database from "better-sqlite3";
const [path, phase] = process.argv.slice(2);
if (!path || !["before", "after"].includes(phase!)) throw Error("invalid fixture arguments");
const box = new DeliveryOutbox(path, "child", { requestContextDispatchVersion: 1 });
const root = "00000000-0000-4000-8000-000000000001", audience = "00000000-0000-4000-8000-000000000003";
const c = { ref: { version: 1 as const, contextId: root, rootContextId: root }, rootEvidenceRef: "accepted-fixture",
  initiatingActor: { kind: "person" as const, platform: "discord" as const, userId: "demo-person" }, ingress: "restricted-room" as const,
  source: { instance: "source", incarnation: "source-generation" }, sourceAudience: { kind: "room" as const, ref: audience } };
const i = { operationId: "op-1", sourceKey: "source-key", sourceInstance: "source", sourceDaemonBootId: "source-boot",
  targetInstance: "target", kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "Synthetic labelled request; authority none" } };
if (phase === "before") {
  const db = (box as unknown as { db: Database.Database }).db;
  db.function("fixture_crash", () => process.exit(91));
  // The parent established the schema but no context/operation: exit inside the real insert transaction.
  db.exec("CREATE TRIGGER crash_companion BEFORE INSERT ON request_context_operations_v1 BEGIN SELECT fixture_crash(); END");
}
box.admitWithRequestContext(i, c, { version: 1, operationId: i.operationId, contextId: root, rootContextId: root,
  source: c.source, target: { instance: "target", incarnation: "target-generation" }, verb: "send_to_instance", payloadSha256: requestContextDigest(i.payload) });
process.exit(92); // Commit completed; emulate loss of the caller's acknowledgement without another write.
