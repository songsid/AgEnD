import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { roomListSchema, roomListResultSchema, roomPostSchema, roomPostResultSchema, encodeMemberFrame, parseMemberFrame, parseServerFrame } from "../src/hub/protocol.js";
const exposureId = randomUUID(), roomId = randomUUID(), messageId = randomUUID(), requestId = randomUUID();
const post = { exposureId, room: roomId, text: "@Notes hello", idempotencyKey: randomUUID() };
it("encodes strict room list/post member frames without caller or ancestry selectors", () => {
  expect(roomListSchema.parse({ exposureId })).toEqual({ exposureId });
  expect(roomPostSchema.parse(post)).toEqual(post);
  expect(parseMemberFrame(encodeMemberFrame({ v: 1, requestId, linkEpoch: 4, type: "room.post", payload: post }))).toMatchObject({ requestId, linkEpoch: 4, payload: post });
  for (const field of ["caller", "owner", "depth", "sourceMessageId"]) expect(roomPostSchema.safeParse({ ...post, [field]: "forged" }).success).toBe(false);
});
it("bounds posting inputs and preserves exact unique room names", () => {
  expect(roomPostSchema.parse({ ...post, room: "研發例會" }).room).toBe("研發例會");
  for (const room of ["", "\n", "x".repeat(129)]) expect(roomPostSchema.safeParse({ ...post, room }).success).toBe(false);
  expect(roomPostSchema.safeParse({ ...post, text: " " }).success).toBe(false);
});
it("returns typed successful results on the captured request and epoch", () => {
  const payload = { ok: true as const, roomId, messageId, at: 123 };
  expect(roomPostResultSchema.parse(payload)).toEqual(payload);
  expect(parseServerFrame(Buffer.from(JSON.stringify({ v: 1, requestId, linkEpoch: 4, type: "room.post-result", payload })))).toMatchObject({ requestId, linkEpoch: 4, payload });
  expect(roomListResultSchema.parse({ ok: true, exposureId, rooms: [{ id: roomId, name: "Room" }] })).toMatchObject({ exposureId });
});
it("bounds failure codes, retry instants and eligible choices", () => {
  expect(roomPostResultSchema.parse({ ok: false, code: "rate-limited", retryAt: 60000 })).toEqual({ ok: false, code: "rate-limited", retryAt: 60000 });
  expect(roomPostResultSchema.safeParse({ ok: false, code: "raw internal error" }).success).toBe(false);
  expect(roomPostResultSchema.safeParse({ ok: false, code: "rate-limited", retryAt: -1 }).success).toBe(false);
  expect(roomListResultSchema.safeParse({ ok: true, exposureId, rooms: Array.from({ length: 201 }, () => ({ id: roomId, name: "Room" })) }).success).toBe(false);
});
it("bounds canonical human receipts, read frames and exact post-answer identities", () => {
  const receiptId = `hmsg-${randomUUID()}`;
  expect(roomPostSchema.parse({ ...post, onBehalfOf: { receiptId } })).toMatchObject({ onBehalfOf: { receiptId } });
  expect(roomPostSchema.safeParse({ ...post, onBehalfOf: { receiptId: "hmsg-short" } }).success).toBe(false);
  for (const [type, payload] of [["room.members", { exposureId, room: roomId }], ["people.search", { exposureId, q: "Al" }], ["room.post-answer-ack", { id: randomUUID() }]])
    expect(parseMemberFrame(Buffer.from(JSON.stringify({ v: 1, requestId, linkEpoch: 4, type, payload })))).toMatchObject({ type, payload });
  const payload = { id: randomUUID(), postId: messageId, roomId, exposureId, receiptId, message: { id: randomUUID(), author: { name: "Planner" }, text: "Answer", at: 123 } };
  expect(parseServerFrame(Buffer.from(JSON.stringify({ v: 1, requestId, linkEpoch: 4, type: "room.post-answer", payload })))).toMatchObject({ payload });
});
