import { parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { KiroDbReader } from "./kiro-db-reader.js";
import type { KiroWorkerRequest } from "./kiro-transcript-lane.js";

const readers = new Map<number, KiroDbReader>();
parentPort?.on("message", (message: KiroWorkerRequest | { close: number }) => {
  if ("close" in message) { readers.get(message.close)?.close(); readers.delete(message.close); return; }
  const { id, owner, input, deadlineAt } = message;
  if (performance.now() >= deadlineAt) { parentPort?.postMessage({ id, reply: null }); return; }
  let reader = readers.get(owner);
  if (!reader) {
    reader = new KiroDbReader(input.workingDirectory, input.dbPath, input.createdAt, false);
    readers.set(owner, reader);
  }
  if (input.cursor) reader.restore(input.cursor);
  if (input.baseline) reader.baseline();
  const events = input.baseline ? { toolUses: [], toolResults: [], assistantTexts: [] } : reader.read();
  parentPort?.postMessage({ id, reply: { events, cursor: reader.cursor() } });
});
