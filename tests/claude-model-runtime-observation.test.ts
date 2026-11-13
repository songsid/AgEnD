import { expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { RuntimeTranscriptSource } from "../src/runtime-transcript-source.js";
import { TranscriptMonitor } from "../src/transcript-monitor.js";
import { ClaudeModelObserver } from "../src/claude-model-observation.js";
import { PANE_TRANSCRIPT_EMPTY_ANCHOR, type PaneTranscriptCursor, type RuntimeTranscriptReference } from "../src/runtime-pane-transcript-protocol.js";
import type { RuntimeTranscriptPort } from "../src/runtime-transcript-delta-reader.js";
import pino from "pino";
function rig() {
 let data = "", online = true, gap = false, complete = true;
 const reference: RuntimeTranscriptReference = { version: 1, machineId: randomUUID(), hostBootId: randomUUID(), paneId: randomUUID(), launchId: randomUUID(), agentId: randomUUID(), provider: "claude-code", cursor: { sessionId: randomUUID(), offset: 0, fileId: null, anchor: PANE_TRANSCRIPT_EMPTY_ANCHOR } };
 const batch = (cursor: PaneTranscriptCursor) => ({ state: "ready" as const, cursor: { ...cursor, offset: Buffer.byteLength(data), fileId: "a".repeat(64), anchor: createHash("sha256").update(data.slice(-4096)).digest("hex") }, data: Buffer.from(data.slice(cursor.offset)).toString("base64"), gap, complete });
 const port: RuntimeTranscriptPort = { isTranscriptObservationCurrent: () => online, readTranscript: vi.fn(async cursor => batch(cursor)) };
 const source = new RuntimeTranscriptSource(port, reference), monitor = new TranscriptMonitor("/no-local-runtime-path", pino({ level: "silent" }) as any, source);
 const record = () => ({ type: "system", subtype: "model_refusal_fallback", sessionId: reference.cursor.sessionId, uuid: randomUUID(), timestamp: new Date().toISOString(), originalModel: "claude-opus-5-5", fallbackModel: "claude-opus-4-8", scope: "session" });
 const add = (...rows: unknown[]) => { data += rows.map(r => JSON.stringify(r) + "\n").join(""); };
 return { source, monitor, reference, port, record, add, offline: () => { online = false; }, gap: () => { gap = true; }, partial: () => { complete = false; } };
}
it("native metadata uses the pinned session, preserves history baseline and never reads a local statusline", async () => {
 const f = rig(); f.add(f.record()); await f.monitor.initialize(); const events: any[] = [];
 f.monitor.on("model_observation", (...args) => events.push(args));
 await f.monitor.pollIncrement(); expect(events).toEqual([]);
 f.add(f.record(), { ...f.record(), sessionId: randomUUID() }, { ...f.record(), isSidechain: true });
 await f.monitor.pollIncrement(); expect(events).toHaveLength(1); expect(events[0][0].kind).toBe("switch");
 expect(f.source.currentPath()).toBeNull(); expect(await f.source.checkpoint()).toBeNull();
});
it("a valid partial native batch still reports metadata without claiming complete follow progress", async () => {
 const f = rig(); await f.monitor.initialize(); f.partial(); f.add(f.record()); const events: any[] = [];
 f.monitor.on("model_observation", e => events.push(e)); await f.monitor.pollIncrement(); expect(f.source.following()).toBe(false); expect(events).toHaveLength(1);
});
it("pending checkpoint metadata cannot escape after native ownership is lost", async () => {
 const f = rig(); await f.monitor.initialize(); f.add(f.record()); await f.source.runtimeCheckpoint(); f.offline();
 const events: any[] = []; f.monitor.on("model_observation", e => events.push(e)); await f.monitor.pollIncrement(); expect(events).toEqual([]);
});
it("a native gap preserves typed evidence and suppresses inferred switches across missing intent", async () => {
 const f = rig(); await f.monitor.initialize(); f.gap(); const observer = new ClaudeModelObserver("claude-opus-5-5", "claude-opus-5-5");
 f.monitor.on("model_observation", (r, model, infer) => observer.observe(r, model, infer));
 f.add({ type: "assistant", sessionId: f.reference.cursor.sessionId, uuid: randomUUID(), timestamp: new Date().toISOString(), message: { id: "served", role: "assistant", model: "claude-opus-4-8", content: [] } });
 await f.monitor.pollIncrement(); expect(observer.snapshot()).toMatchObject({ lastServed: "claude-opus-4-8", active: null, session: null });
 f.add(f.record()); await f.monitor.pollIncrement(); expect(observer.snapshot().active?.cause).toBe("safeguards");
});
