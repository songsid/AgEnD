/** Durable remote references are identities, never encoded local paths. Scratch SQLite only, no fleet. */
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { randomUUID } from "node:crypto"; import Database from "better-sqlite3";
import { DeliveryOutbox, type DeliveryAttemptEvidence } from "../src/delivery-outbox.js";
import { PANE_TRANSCRIPT_EMPTY_ANCHOR, validateRuntimeTranscriptReference, type RuntimeTranscriptReference } from "../src/runtime-pane-transcript-protocol.js";
const clean: Array<() => void> = []; afterEach(() => { for (const fn of clean.splice(0).reverse()) fn(); });
function rig() {
 const root = mkdtempSync(join(tmpdir(), "agend-runtime-outbox-")), file = join(root, "outbox.db"); clean.push(() => rmSync(root, { recursive: true, force: true }));
 let outbox = new DeliveryOutbox(file, "manager-test"); clean.push(() => outbox.close());
 const row = outbox.admit({ operationId: "runtime-proof-operation", sourceKey: "runtime-proof-source", sourceInstance: "source", sourceDaemonBootId: "source-boot", targetInstance: "worker", kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "canary", meta: {} } }).delivery;
 expect(outbox.claimNext("manager-test", () => "worker-boot", new Set())?.deliveryId).toBe(row.deliveryId);
 const reference: RuntimeTranscriptReference = { version: 1, machineId: randomUUID(), hostBootId: randomUUID(), paneId: randomUUID(), agentId: randomUUID(), launchId: randomUUID(), provider: "codex", cursor: { sessionId: randomUUID(), offset: 0, fileId: null, anchor: PANE_TRANSCRIPT_EMPTY_ANCHOR } };
 const evidence: DeliveryAttemptEvidence = { backend: "codex", windowId: reference.paneId, transcriptPath: null, transcriptSessionId: reference.cursor.sessionId, transcriptOffset: 0, submissionMode: "idle_submit", runtimeTranscript: reference };
 const begin = (value = evidence) => outbox.begin(row.deliveryId, "worker-boot", 1, value);
 const candidates = () => { outbox.markTargetReconciliationPending("worker", "worker-boot"); return outbox.getReconciliationCandidates("worker"); };
 const reopen = () => { outbox.close(); outbox = new DeliveryOutbox(file, "manager-test"); return outbox; };
 return { file, row, reference, evidence, begin, candidates, reopen, get outbox() { return outbox; } };
}
it("commits the exact remote scope before paste, retains it across reopen, and gives old readers no local path", () => {
 const f = rig(); expect(f.begin()).toBe("begun"); expect(f.begin()).toBe("duplicate"); f.candidates(); f.reopen();
 const [candidate] = f.outbox.getReconciliationCandidates("worker"); expect(candidate.attempt).toMatchObject({ transcriptPath: null, runtimeTranscript: f.reference }); expect(candidate.attempt).not.toHaveProperty("runtimeTranscriptInvalid");
 const db = new Database(f.file); try { const old = db.prepare("SELECT transcript_path,transcript_offset,transcript_session_id FROM delivery_attempts WHERE delivery_id=?").get(f.row.deliveryId) as any; expect(old).toEqual({ transcript_path: null, transcript_offset: 0, transcript_session_id: f.reference.cursor.sessionId }); } finally { db.close(); }
});
it("a deferred first-turn file is still pinned to one exact native session at offset zero", () => {
 const f = rig(); f.evidence.runtimeTranscript = { ...f.reference, machineId: "local", provider: "claude-code" }; f.evidence.backend = "claude-code";
 expect(f.begin()).toBe("begun"); expect(f.candidates()[0].attempt.runtimeTranscript).toEqual(f.evidence.runtimeTranscript);
});
it("refuses a cross-pane/provider/session/offset or hybrid local-path checkpoint before acquiring the begin permit", () => {
 const f = rig(); let checked = 0;
 for (const change of [{ windowId: randomUUID() }, { backend: "claude-code" }, { transcriptSessionId: randomUUID() }, { transcriptOffset: 1 }, { transcriptPath: "C:\\Users\\private\\session.jsonl" }]) {
  expect(() => f.begin({ ...f.evidence, ...change })).toThrow("differs from its delivery attempt"); expect(f.outbox.get(f.row.deliveryId)?.state).toBe("delivering"); checked++;
 }
 expect(checked).toBe(5); expect(f.begin()).toBe("begun");
});
it("corrupt or mismatched stored runtime evidence holds and never reactivates an injected local path", () => {
 const f = rig(); expect(f.begin()).toBe("begun"); f.candidates(); const db = new Database(f.file);
 try {
  const set = db.prepare("UPDATE delivery_attempts SET runtime_transcript_json=?,transcript_path=? WHERE delivery_id=?"); let checked = 0;
  for (const value of ["invalid JSON PRIVATE_CANARY", JSON.stringify({ ...f.reference, provider: "claude-code" }), JSON.stringify({ ...f.reference, path: "/tmp/unowned" }), "x".repeat(4097)]) {
   set.run(value, "/tmp/do-not-open", f.row.deliveryId); const [candidate] = f.outbox.getReconciliationCandidates("worker"); expect(candidate.attempt).toMatchObject({ runtimeTranscript: null, runtimeTranscriptInvalid: true, transcriptPath: null }); checked++;
  }
  expect(checked).toBe(4);
 } finally { db.close(); }
});
it("additive migration leaves legacy local evidence intact and adds no invented remote reference", () => {
 const f = rig(); const local: DeliveryAttemptEvidence = { ...f.evidence, windowId: "@local", transcriptPath: "/scratch/local.jsonl", runtimeTranscript: undefined };
 expect(f.begin(local)).toBe("begun"); f.candidates(); f.outbox.close(); const db = new Database(f.file);
 try { db.exec("ALTER TABLE delivery_attempts DROP COLUMN runtime_transcript_json"); } finally { db.close(); }
 f.reopen(); const [candidate] = f.outbox.getReconciliationCandidates("worker"); expect(candidate.attempt.transcriptPath).toBe(local.transcriptPath); expect(candidate.attempt).not.toHaveProperty("runtimeTranscript"); expect(candidate.attempt).not.toHaveProperty("runtimeTranscriptInvalid");
});
it("the reference grammar has no executable, arbitrary path or unbounded machine identity fields", () => {
 const f = rig(); expect(validateRuntimeTranscriptReference(f.reference)).toEqual(f.reference); let checked = 0;
 for (const extra of [{ path: "/tmp/unowned" }, { version: 2 }, { machineId: "../other" }, { paneId: "@local" }, { launchId: randomUUID() + "extra" }, { cursor: { ...f.reference.cursor, path: "C:\\private" } }]) { expect(() => validateRuntimeTranscriptReference({ ...f.reference, ...extra })).toThrow(); checked++; }
 expect(checked).toBe(6);
});
