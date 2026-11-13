import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { parseMemberFrame, parseServerFrame, HUB_OPTIONAL_CAPABILITIES } from "../src/hub/protocol.js";

it("round-trips the room ask, answer, ACK and coarse presence without a direct grant envelope", () => {
  const messageId = randomUUID(), roomId = randomUUID(), exposureId = randomUUID(), answerId = randomUUID();
  const base = { v: 1, requestId: randomUUID(), linkEpoch: 1 };
  const ask = { ...base, type: "room.ask", payload: { messageId, roomId, exposureId, roomName: "Weekly", asker: { name: "Alex" }, text: "Status?", context: [{ author: "Bob", text: "Earlier", at: 100 }] } };
  expect(parseServerFrame(JSON.stringify(ask))).toEqual(ask);
  const answer = { ...base, type: "room.answer", payload: { messageId, roomId, exposureId, answerId, text: "Ready" } };
  expect(parseMemberFrame(JSON.stringify(answer))).toEqual(answer);
  expect(parseServerFrame(JSON.stringify({ ...base, type: "room.answer-ack", payload: { messageId, answerId } })).type).toBe("room.answer-ack");
  expect(parseMemberFrame(JSON.stringify({ ...base, type: "agent.state", payload: { exposureId, state: "paused", note: "Waiting for sign-in" } })).type).toBe("agent.state");
  expect(() => parseMemberFrame(JSON.stringify({ ...answer, type: "answer" }))).toThrow();
  expect(HUB_OPTIONAL_CAPABILITIES).not.toContain("room-ask-v1"); // no dispatch before R2
});

it("keeps a single older replied-to anchor beside the latest 30 and refuses unbounded contexts", () => {
  const row = { author: "Alex", text: "Context", at: 100 }, payload = { messageId: randomUUID(), roomId: randomUUID(), exposureId: randomUUID(), roomName: "Room", asker: { name: "Alex" }, text: "Question", context: Array.from({ length: 31 }, () => ({ ...row })) };
  const frame = { v: 1, requestId: randomUUID(), linkEpoch: 1, type: "room.ask", payload };
  expect(() => parseServerFrame(JSON.stringify(frame))).toThrow();
  Object.assign(payload.context[0]!, { repliedTo: true }); expect(parseServerFrame(JSON.stringify(frame)).type).toBe("room.ask");
  payload.context.push(row); expect(() => parseServerFrame(JSON.stringify(frame))).toThrow();
});
