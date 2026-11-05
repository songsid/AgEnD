import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { parseStrictJson } from "../src/hub/validation.js";
import { parseMemberFrame, parseServerFrame, encodeMemberFrame, HUB_CAPABILITIES } from "../src/hub/protocol.js";
const hello = () => ({ v: 1, type: "hello", requestId: randomUUID(), linkEpoch: 0, payload: { supportedVersions: [1], capabilities: [...HUB_CAPABILITIES], memberBootId: randomUUID() } } as const);
describe("Hub P1 closed protocol", () => {
  it("accepts bounded scalar JSON and a member hello, with no server-direction fallback", () => {
    const frame = hello(); expect(parseMemberFrame(JSON.stringify(frame))).toEqual(frame);
    expect(parseMemberFrame(encodeMemberFrame(frame))).toEqual(frame);
    expect(() => parseServerFrame(JSON.stringify(frame))).toThrow();
    expect(parseStrictJson('{"nested":[1,0.5,true,null,{"escaped":"\\\"/"}]}')).toEqual({ nested: [1, 0.5, true, null, { escaped: '"/' }] });
  });
  it.each([
    '{"v":1,"v":1}', '{"outer":{"key":1,"\\u006bey":2}}', '{"x":1,"x":2}',
    '{"s":"\\ud800"}', '{"n":1e400}', '{"n":9007199254740992}', '{"n":NaN}',
    '{"x":1,}', '[1,]', '[] false', '{"x":01}', '{"x":"unterminated}',
    '["raw\nnewline"]', '{"x":undefined}', '{"x":truefalse}',
  ])("refuses ambiguous or unsafe JSON: %s", input => expect(() => parseStrictJson(input)).toThrow());
  it("rejects invalid UTF8, literal unpaired surrogates, excessive nesting and size", () => {
    expect(() => parseStrictJson(Buffer.from([0x22, 0xc0, 0xaf, 0x22]))).toThrow();
    expect(() => parseStrictJson('"\ud800"')).toThrow();
    expect(() => parseStrictJson("[".repeat(34) + "0" + "]".repeat(34))).toThrow();
    expect(() => parseStrictJson('"' + "x".repeat(256 * 1024) + '"')).toThrow();
  });
  it.each([
    (f: any) => { f.authority = "web-verified"; }, (f: any) => { f.payload.person = { realm: "local" }; },
    (f: any) => { f.v = 2; }, (f: any) => { f.linkEpoch = -1; }, (f: any) => { f.requestId = "admin"; },
    (f: any) => { f.payload.supportedVersions = [Number.MAX_SAFE_INTEGER + 1]; },
    (f: any) => { f.payload.memberBootId = f.payload.memberBootId.toUpperCase(); },
  ])("rejects unnegotiated fields and malformed identities", mutate => {
    const frame = structuredClone(hello()); mutate(frame); expect(() => parseMemberFrame(JSON.stringify(frame))).toThrow();
  });
  it("requires the exact phase fields and limits machine exposure enumeration", () => {
    const frame = { v: 1, type: "authorize.request", requestId: randomUUID(), linkEpoch: 1,
      payload: { messageId: randomUUID(), operationId: randomUUID(), exposureRevision: 1, phase: "tool" } };
    expect(() => parseMemberFrame(JSON.stringify(frame))).toThrow();
    const snapshot = { ...frame, type: "exposure.snapshot", payload: { revision: 1, exposures: Array(65).fill({}) } };
    expect(() => parseMemberFrame(JSON.stringify(snapshot))).toThrow();
    const revoke = { ...frame, type: "revoke", payload: { revocationVersion: 2, reasonCode: "revoked", scope: {} } };
    expect(() => parseServerFrame(JSON.stringify(revoke))).toThrow();
  });
});
