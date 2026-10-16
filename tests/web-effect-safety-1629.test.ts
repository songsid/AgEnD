import { describe, expect, it, vi } from "vitest";
const { createEffectSafety } = await import(new URL("../src/ui/shared/effect-safety.js", import.meta.url).href);
const A = "a".repeat(32), B = "b".repeat(32), DAY = 86400000, PREFIX = "agend_effect_safety_v1:";
function rig() {
  const data = new Map<string, string>(); let seq = 0, now = 1000;
  const storage = { get length() { return data.size; }, key: vi.fn((i: number): string | null => [...data.keys()][i] ?? null),
    getItem: vi.fn((k: string): string | null => data.get(k) ?? null), setItem: vi.fn((k: string, v: string) => { data.set(k, v); }), removeItem: vi.fn((k: string) => { data.delete(k); }) };
  const crypto = { getRandomValues: vi.fn((a: Uint8Array) => { new DataView(a.buffer).setUint32(12, ++seq); return a; }) };
  const create = (patch = {}) => createEffectSafety({ storage, crypto, wall: () => now, ...patch });
  const begin = (s: any, id = A, device = "standard") => s.begin({ id, device, key: "effect-0" });
  const pause = (s: any, id = A, device = "standard") => s.pause({ id, device, reason: "host_budget", get metrics() { throw Error("must not read metrics or content"); } });
  return { data, storage, crypto, create, begin, pause, at(n: number) { now = n; }, records: () => [...data.values()].map(s => JSON.parse(s)) };
}
describe("#1629 browser effect safety participant (unmounted)", () => {
  it.each(["delete", "edit", "foreign-resume"])("%s of a live owned probation fails closed on the next read", mode => {
    const h = rig(), a = h.create(), token = h.begin(a), [key, text] = [...h.data][0]!;
    if (mode === "delete") h.data.delete(key);
    else if (mode === "edit") { const row = JSON.parse(text); row.at++; h.data.set(key, JSON.stringify(row)); }
    else { const b = h.create(); expect(b.resume(A, "standard")).toBe(true); expect(b.allowed(A, "standard")).toBe(true); }
    expect(a.status(A, "standard").state).toBe("unknown"); expect(a.allowed(A, "standard")).toBe(false); expect(a.finish(token, "healthy")).toBe(false);
    h.data.set(key, text); expect(a.allowed(B, "standard")).toBe(false); expect(a.resume(A, "standard")).toBe(false);
  });
  it("healthy own cleanup and unrelated storage changes do not revoke a live participant", () => {
    const h = rig(), s = h.create(), token = h.begin(s); h.data.set("unrelated", "anything");
    expect(s.allowed(A, "standard")).toBe(true); expect(s.finish(token, "healthy")).toBe(true); expect(s.allowed(A, "standard")).toBe(true);
    expect(s.allowed(B, "constrained")).toBe(true); expect(h.data.size).toBe(1);
  });
  it("construction/status write nothing, and probation is persisted before a positive receipt", () => {
    const h = rig(), s = h.create(); expect(s.allowed(A, "standard")).toBe(true); expect(h.storage.setItem).not.toHaveBeenCalled();
    const token = h.begin(s); expect(token).toMatch(/^[a-f0-9]{32}$/); expect(h.records()).toEqual([{ v: 1, kind: "probation", id: A, device: "standard", token, owner: "0".repeat(31) + "1", at: 1000 }]);
    expect(s.finish("f".repeat(32), "healthy")).toBe(false); expect(h.data.size).toBe(1);
    expect(s.allowed(A, "standard")).toBe(true); expect(s.finish(token, "healthy")).toBe(true); expect(h.data.size).toBe(0); expect(s.finish(token, "healthy")).toBe(false); expect(s.allowed(B, "standard")).toBe(true);
  });
  it("reload and another tab treat a leftover marker as interrupted, never as proof of blame", () => {
    const h = rig(), old = h.create(), token = h.begin(old), fresh = h.create();
    expect(fresh.status(A, "standard").state).toBe("interrupted"); expect(fresh.allowed(A, "standard")).toBe(false); expect(h.begin(fresh)).toBeNull();
    expect(fresh.finish(token, "healthy")).toBe(false); expect(h.data.size).toBe(1); expect(old.finish(token, "disposed")).toBe(true); expect(fresh.allowed(A, "standard")).toBe(true);
  });
  it("human Resume clears an interrupted foreign marker but preserves this page's live marker", () => {
    const h = rig(), a = h.create(); h.begin(a); const b = h.create(); expect(b.resume(A, "standard")).toBe(true); expect(h.data.size).toBe(0);
    const token = h.begin(b); expect(b.resume(A, "standard")).toBe(true); expect(h.data.size).toBe(1); expect(b.finish(token, "human_resume")).toBe(true);
  });
  it("a pause persists one immutable history record and a soft latch; Resume acknowledges exactly it", () => {
    const h = rig(), s = h.create(); expect(h.pause(s)).toBe(true); expect(s.status(A, "standard")).toMatchObject({ state: "paused", history: { pauses: [1000], off: false } });
    expect(h.begin(s)).toBeNull(); expect(s.resume(A, "standard")).toBe(true); expect(s.status(A, "standard")).toMatchObject({ state: "ok", history: { pauses: [1000] } });
    expect(h.records().map(r => r.kind).sort()).toEqual(["pause", "resume"]); const writes = h.storage.setItem.mock.calls.length;
    expect(s.resume(A, "standard")).toBe(true); expect(h.storage.setItem).toHaveBeenCalledTimes(writes);
  });
  it("three pauses in 24h persist sticky off across Resume, reload and timestamp aging", () => {
    const h = rig(), s = h.create();
    for (let n = 0; n < 3; n++) { h.at(1000 + n); expect(h.pause(s)).toBe(true); if (n < 2) expect(s.resume(A, "standard")).toBe(true); }
    expect(s.status(A, "standard").state).toBe("off"); const writes = h.storage.setItem.mock.calls.length; expect(s.resume(A, "standard")).toBe(false); expect(h.storage.setItem).toHaveBeenCalledTimes(writes);
    h.at(DAY * 7); const fresh = h.create(); expect(fresh.status(A, "standard").state).toBe("off"); expect(fresh.resume(A, "standard")).toBe(false); expect(h.begin(fresh)).toBeNull();
    expect(fresh.allowed(B, "standard")).toBe(true); expect(fresh.allowed(A, "constrained")).toBe(true);
  });
  it("the rolling 24h boundary and a wall rollback reuse the reviewed pure history policy", () => {
    const h = rig(), s = h.create(); h.at(0); h.pause(s); s.resume(A, "standard"); h.at(DAY); h.pause(s); s.resume(A, "standard");
    expect(s.status(A, "standard")).toMatchObject({ state: "ok", history: { pauses: [DAY], off: false } });
    h.at(1); h.pause(s); expect(s.status(A, "standard")).toMatchObject({ state: "paused", history: { pauses: [DAY, DAY], lastWall: DAY } }); s.resume(A, "standard");
    h.at(0); h.pause(s); expect(s.status(A, "standard")).toMatchObject({ state: "off", history: { pauses: [DAY, DAY, DAY] } });
  });
  it("two tabs append independent pause receipts rather than overwriting a shared index", () => {
    const h = rig(), a = h.create(), b = h.create(); let once = false;
    h.storage.setItem.mockImplementation((key, value) => { if (!once) { once = true; expect(h.pause(b)).toBe(true); } h.data.set(key, value); });
    expect(h.pause(a)).toBe(true); expect(h.records()).toHaveLength(2); expect(a.status(A, "standard").history.pauses).toHaveLength(2);
    expect(a.resume(A, "standard")).toBe(true); h.pause(b); expect(a.status(A, "standard").state).toBe("off");
  });
  it("a new pause racing Resume is not acknowledged by the older human action", () => {
    const h = rig(), a = h.create(), b = h.create(); h.pause(a); let once = false;
    h.storage.setItem.mockImplementation((key, value) => { h.data.set(key, value); if (!once) { once = true; h.pause(b); } });
    expect(a.resume(A, "standard")).toBe(false); expect(a.status(A, "standard").state).toBe("paused"); expect(h.records().filter(r => r.kind === "resume")).toHaveLength(1);
  });
  it("a foreign probation appearing during admission prevents a positive begin receipt", () => {
    const h = rig(), a = h.create(), b = h.create(); let once = false;
    h.storage.setItem.mockImplementation((key, value) => { if (!once) { once = true; expect(h.begin(b)).toBeTypeOf("string"); } h.data.set(key, value); });
    expect(h.begin(a)).toBeNull(); expect(h.records()).toHaveLength(1); expect(a.status(A, "standard").state).toBe("interrupted");
  });
  it("marker replacement is not removed by an old receipt, and latches this participant closed", () => {
    const h = rig(), s = h.create(), token = h.begin(s), [key, text] = [...h.data][0]!; h.data.set(key, text + " ");
    expect(s.finish(token, "healthy")).toBe(false); expect(h.data.get(key)).toBe(text + " "); expect(s.allowed(B, "standard")).toBe(false);
  });
  it("a marker removed between write verification and final admission cannot yield a positive token", () => {
    const h = rig(), s = h.create();
    h.storage.getItem.mockImplementation(key => { const text = h.data.get(key) ?? null; if (text !== null) h.data.delete(key); return text; });
    expect(h.begin(s)).toBeNull(); expect(h.data.size).toBe(0); expect(s.allowed(B, "standard")).toBe(false);
  });
  it("history replay is ordered independently of localStorage enumeration", () => {
    const h = rig(), s = h.create();
    for (const at of [0, DAY * 2, DAY * 4]) { h.at(at); h.pause(s); s.resume(A, "standard"); }
    h.storage.key.mockImplementation(i => [...h.data.keys()].reverse()[i] ?? null);
    expect(h.create().status(A, "standard")).toMatchObject({ state: "ok", history: { off: false, pauses: [DAY * 4] } });
  });
  it("snapshot history cannot mutate the stored authority", () => {
    const h = rig(), s = h.create(); h.pause(s); const snap = s.status(A, "standard"); snap.history.pauses.push(2000, 3000); snap.history.off = true;
    expect(s.status(A, "standard")).toMatchObject({ state: "paused", history: { pauses: [1000], off: false } });
  });
  it.each(["getItem", "key", "setItem", "removeItem"] as const)("storage %s failure is not success and cannot reset the latch", method => {
    const h = rig(), s = h.create(), token = h.begin(s); h.storage[method].mockImplementation(() => { throw Error("private storage failure"); });
    const result = method === "setItem" ? h.pause(s) : method === "removeItem" ? s.finish(token, "healthy") : s.allowed(A, "standard"); expect(result).toBe(false);
    h.storage[method].mockReset(); expect(s.allowed(B, "standard")).toBe(false); expect(s.resume(A, "standard")).toBe(false);
  });
  it.each(["write", "remove"])("a silently ineffective storage %s is rejected", kind => {
    const h = rig(), s = h.create();
    if (kind === "write") { h.storage.setItem.mockImplementation(() => {}); expect(h.begin(s)).toBeNull(); }
    else { const token = h.begin(s); h.storage.removeItem.mockImplementation(() => {}); expect(s.finish(token, "healthy")).toBe(false); }
    expect(s.status(A, "standard").state).toBe("unknown");
  });
  it("a silently ineffective pause write is not acknowledged even without a probation marker", () => {
    const h = rig(), s = h.create(); h.storage.setItem.mockImplementation(() => {}); expect(h.pause(s)).toBe(false); expect(s.status(A, "standard").state).toBe("unknown");
  });
  it("repairing storage does not clear this page's unknown-outcome latch", () => {
    const h = rig(), s = h.create(); h.storage.setItem.mockImplementation(() => { throw Error("quota"); }); expect(h.pause(s)).toBe(false);
    h.storage.setItem.mockImplementation((key, text) => { h.data.set(key, text); }); expect(s.allowed(B, "standard")).toBe(false); expect(s.resume(A, "standard")).toBe(false);
    expect(h.create().allowed(B, "standard")).toBe(true);
  });
  it.each(["broken", "schema", "key", "orphan", "null", "large"])("malformed owned storage (%s) refuses without repair writes", kind => {
    const h = rig(), old = h.create(); h.pause(old); const [key, text] = [...h.data][0]!; h.data.clear(); const r = JSON.parse(text);
    if (kind === "broken") h.data.set(key, "{");
    if (kind === "schema") h.data.set(key, JSON.stringify({ ...r, extra: true }));
    if (kind === "key") h.data.set(key.replace(A, B), text);
    if (kind === "orphan") h.data.set(key.replace(":pause:", ":resume:"), JSON.stringify({ v: 1, kind: "resume", id: A, device: "standard", token: r.token }));
    if (kind === "null") { h.data.set(key, text); h.storage.getItem.mockReturnValue(null); }
    if (kind === "large") h.data.set(key, " ".repeat(1025));
    const s = h.create(), writes = h.storage.setItem.mock.calls.length; expect(s.status(A, "standard").state).toBe("unknown"); expect(h.begin(s)).toBeNull(); expect(s.resume(A, "standard")).toBe(false); expect(h.storage.setItem).toHaveBeenCalledTimes(writes);
  });
  it("the aggregate receipt budget is bounded independently of each record's length", () => {
    const h = rig();
    const fill = (from: number, to: number) => { for (let n = from; n < to; n++) { const token = n.toString(16).padStart(32, "0"), r = { v: 1, kind: "pause", id: A, device: "standard", token, at: n }; h.data.set(`${PREFIX}pause:${A}:standard:${token}`, JSON.stringify(r)); } };
    fill(0, 800); expect(h.create().status(A, "standard").state).toBe("off"); fill(800, 1500); const s = h.create(); expect(s.status(A, "standard").state).toBe("unknown"); expect(h.begin(s)).toBeNull();
  });
  it("record enums, timestamps and ownership are validated before replay", () => {
    for (const patch of [{ kind: "other" }, { device: "phone" }, { id: "bad" }, { token: "bad" }, { at: -1 }, { at: 0.1 }, { v: 2 }]) {
      const h = rig(), old = h.create(); h.pause(old); const [key, text] = [...h.data][0]!; h.data.set(key, JSON.stringify({ ...JSON.parse(text), ...patch })); expect(h.create().status(A, "standard").state).toBe("unknown");
    }
    const h = rig(), old = h.create(); h.begin(old); const [key, text] = [...h.data][0]!; h.data.set(key, JSON.stringify({ ...JSON.parse(text), owner: "bad" })); expect(h.create().status(A, "standard").state).toBe("unknown");
  });
  it.each(["probation", "resume"])("extra %s fields do not become trusted authority", kind => {
    const h = rig(), old = h.create(); if (kind === "probation") h.begin(old); else { h.pause(old); old.resume(A, "standard"); }
    const [key, text] = [...h.data].find(([, text]) => JSON.parse(text).kind === kind)!; h.data.set(key, JSON.stringify({ ...JSON.parse(text), arbitrary: "not authority" }));
    expect(h.create().status(A, "standard").state).toBe("unknown");
  });
  it("unrelated keys are neither parsed nor changed", () => {
    const h = rig(); h.data.set("agend_other", "not JSON"); const s = h.create(); expect(s.allowed(A, "standard")).toBe(true); const token = h.begin(s); s.finish(token, "disposed"); expect([...h.data]).toEqual([["agend_other", "not JSON"]]);
  });
  it.each(["count", "duplicate", "changed"])("unknown enumeration (%s) refuses", kind => {
    const h = rig(); h.data.set("a", "1"); h.data.set("b", "2");
    if (kind === "count") Object.defineProperty(h.storage, "length", { get: () => 4097 });
    if (kind === "duplicate") h.storage.key.mockReturnValue("a");
    if (kind === "changed") h.storage.key.mockImplementation(i => { if (i === 1) h.data.set("c", "3"); return ["a", "b"][i] ?? null; });
    expect(h.create().allowed(A, "standard")).toBe(false);
  });
  it("exactly 4096 valid origin keys are readable, while a 4097th refuses before enumeration", () => {
    const h = rig(), keys = Array.from({ length: 4096 }, (_, i) => "unrelated-" + i); for (const key of keys) h.data.set(key, "value"); h.storage.key.mockImplementation(i => keys[i] ?? null);
    const s = h.create(); expect(s.allowed(A, "standard")).toBe(true); h.data.set("extra", "value"); keys.push("extra"); h.storage.key.mockClear();
    expect(s.allowed(A, "standard")).toBe(false); expect(h.storage.key).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, -1, 0.1, Number.MAX_SAFE_INTEGER + 1])("invalid wall clock %s cannot produce a durable receipt", at => {
    const h = rig(), s = h.create(); h.at(at); expect(h.begin(s)).toBeNull(); expect(h.pause(s)).toBe(false); expect(h.data.size).toBe(0);
  });
  it("nonce collisions do not overwrite an existing probation or pause", () => {
    const h = rig(); h.crypto.getRandomValues.mockImplementation(a => a); const s = h.create(), token = h.begin(s), before = [...h.data]; expect(token).toBeTypeOf("string"); expect(h.begin(s)).toBeNull(); expect([...h.data]).toEqual(before);
    const other = rig(); other.crypto.getRandomValues.mockImplementation(a => a); const p = other.create(); expect(other.pause(p)).toBe(true); const initial = [...other.data]; expect(other.pause(p)).toBe(false); expect([...other.data]).toEqual(initial);
  });
  it("partial Resume failure keeps history and refuses further admission", () => {
    const h = rig(), s = h.create(); h.pause(s); s.resume(A, "standard"); h.pause(s); h.storage.setItem.mockImplementation(() => { throw Error("quota"); });
    expect(s.resume(A, "standard")).toBe(false); expect(s.allowed(A, "standard")).toBe(false); expect(h.records().filter(r => r.kind === "pause")).toHaveLength(2); expect(h.create().status(A, "standard").state).toBe("paused");
  });
  it.each([null, {}, { id: A, device: "phone", key: "x" }, { id: "bad", device: "standard", key: "x" }, { id: "a".repeat(31), device: "standard", key: "x" }, { id: "a".repeat(33), device: "standard", key: "x" }, { id: A, device: "standard", key: "" }, { id: A, device: "standard", key: "x".repeat(257) }])("invalid admission spec %j writes nothing", spec => {
    const h = rig(), s = h.create(); expect(s.begin(spec)).toBeNull(); expect(h.data.size).toBe(0);
  });
  it("unsupported storage/crypto fail closed without using weaker randomness", () => {
    expect(createEffectSafety().allowed(A, "standard")).toBe(false); const h = rig(); expect(h.create({ crypto: {} }).allowed(A, "standard")).toBe(false);
    h.crypto.getRandomValues.mockImplementation(() => { throw Error("crypto unavailable"); }); expect(h.create().allowed(A, "standard")).toBe(false);
  });
  it("a Promise or missing return from the randomness provider is not synchronous entropy", () => {
    for (const result of [undefined, Promise.resolve(new Uint8Array(16))]) {
      const h = rig(); h.crypto.getRandomValues.mockReturnValue(result as any); const s = h.create(); expect(s.allowed(A, "standard")).toBe(false); expect(h.begin(s)).toBeNull(); expect(h.data.size).toBe(0);
    }
  });
  it("invalid ids/devices/reasons cannot read authority or mutate receipts", () => {
    const h = rig(), s = h.create(), token = h.begin(s); expect(s.status("bad", "standard").state).toBe("unknown"); expect(s.resume(A, "other")).toBe(false); expect(s.finish(token, "")).toBe(false);
    expect(s.pause({ id: A, device: "standard", reason: "healthy" })).toBe(false); expect(s.finish(token, "disposed")).toBe(true);
  });
  it("records only closed ids/device/time and receipts, never the host key, metrics or instance name", () => {
    const h = rig(), s = h.create(); s.begin({ id: A, device: "standard", key: "private-instance-name" }); h.pause(s);
    expect([...h.data.values()].join("\n")).not.toContain("private-instance-name"); expect([...h.data.values()].join("\n")).not.toContain("metrics");
  });
});
