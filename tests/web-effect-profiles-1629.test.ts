import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, statSync, symlinkSync, rmSync, constants } from "node:fs";
import { join, relative } from "node:path";
import { WebEffectProfiles, checkEffectProfile, EFFECT_PROFILE_FILE_BYTES } from "../src/web-effect-profiles.js";
import * as atomic from "../src/atomic-write.js";
const probe = vi.hoisted(() => ({ observe: false, flags: 0 }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, openSync(path: Parameters<typeof fs.openSync>[0], flags: Parameters<typeof fs.openSync>[1], mode?: Parameters<typeof fs.openSync>[2]) {
    if (probe.observe && typeof path === "string" && path.endsWith("web-effect-profiles.json") && typeof flags === "number") probe.flags = flags;
    return fs.openSync(path, flags, mode);
  } };
});
const { createEffectProfileCollector } = await import(new URL("../src/ui/shared/effect-profiles.js", import.meta.url).href);
const { EffectBudget } = await import(new URL("../src/ui/shared/effect-profiler.js", import.meta.url).href);
const A = "a".repeat(32), B = "b".repeat(32), paths: string[] = [];
const profile = (patch: Record<string, unknown> = {}) => ({ v: 1, device: "standard", verdict: "ok", reason: null, samples: 1, fps_p50: 60, fps_p10: 60, fps_floor: 54,
  long_task_p95: null, long_task_samples: 0, attributed_long_task_p95: null, attributed_samples: 0, attribution: "unknown", load_ms: null, ...patch });
const snapshot = (patch: Record<string, unknown> = {}) => ({ key: "slot", id: A, device: "standard", verdict: "ok", reason: null, remove: false, forward: true, quality: "normal", pointerHz: 60, badWindows: 0, loadMs: 7,
  metrics: { at: 0, hostFps: 60, hostLongTaskMsPerSecond: null, attributedLongTaskMsPerSecond: null, attribution: "unknown", fpsFloor: 54, windowMs: 2000 }, ...patch });
function collector(patch = {}) { let n = 0; const c = createEffectProfileCollector({ key: "slot", id: A, device: "standard", clock: () => n, ...patch }); return { at: (t: number) => { n = t; }, c, sample: (raw: any = snapshot()) => c.add({ ...raw, metrics: raw.metrics ? { ...raw.metrics, at: n } : null }) }; }
function fixture() {
  mkdirSync(join(process.cwd(), ".artifacts"), { recursive: true }); const root = mkdtempSync(join(process.cwd(), ".artifacts/profiles-test-")); paths.push(root); let now = 1000;
  return { root, dir: join(root, "data"), at: (t: number) => { now = t; }, s: new WebEffectProfiles(join(root, "data"), { now: () => now }) };
}
afterEach(() => { vi.restoreAllMocks(); probe.observe = false; probe.flags = 0; for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
describe("#1629 host profile codec and durable retention", () => {
  it("constructor/read are lazy and distinguish unmeasured from healthy", () => {
    const f = fixture(); expect(existsSync(f.dir)).toBe(false); expect(f.s.read(A)).toEqual({ ok: true, status: "unmeasured", records: [] }); expect(existsSync(f.dir)).toBe(false);
    expect(f.s.record(A, profile())).toMatchObject({ ok: true, profile: { source: "reported_host", at: 1000 } }); expect(statSync(f.s.path).mode & 0o777).toBe(0o600);
    expect(f.s.read(A)).toMatchObject({ ok: true, status: "reported", records: [{ source: "reported_host" }] });
  });
  it("retains last twenty independently per content id and device, across reopening", () => {
    const f = fixture();
    for (let n = 0; n < 25; n++) { f.at(1000 + n); expect(f.s.record(A, profile({ fps_p50: n + 1, fps_p10: n + 1 })).ok).toBe(true); }
    f.s.record(A, profile({ device: "constrained", fps_p50: 30, fps_p10: 30 })); f.s.record(B, profile()); const read = new WebEffectProfiles(f.dir).read(A); expect(read.ok).toBe(true); if (!read.ok) return;
    expect(read.records.filter(r => r.device === "standard").map(r => r.fps_p50)).toEqual(Array.from({ length: 20 }, (_, i) => i + 6)); expect(read.records.filter(r => r.device === "constrained")).toHaveLength(1);
    expect(f.s.read(B)).toMatchObject({ records: [expect.objectContaining({ fps_p50: 60 })] });
    read.records[0]!.fps_p50 = 999; expect(f.s.read(A)).not.toMatchObject({ records: [expect.objectContaining({ fps_p50: 999 })] });
  });
  it("server timestamps are owned, clamped on rollback and never accepted from the report", () => {
    const f = fixture(); f.s.record(A, profile()); f.at(1); expect(f.s.record(A, profile())).toMatchObject({ profile: { at: 1000 } });
    const bytes = readFileSync(f.s.path); expect(f.s.record(A, profile({ at: 99999 }))).toEqual({ ok: false, error: "profile_args" }); expect(readFileSync(f.s.path)).toEqual(bytes);
  });
  it.each(["content", "text", "user", "url", "instance", "worker_fps", "worker_cpu_ms", "lag_p95", "source"])("report field %s is rejected and never written", field => {
    const f = fixture(); expect(f.s.record(A, profile({ [field]: "private content must not persist" }))).toEqual({ ok: false, error: "profile_args" }); expect(existsSync(f.dir)).toBe(false);
  });
  it.each([
    { verdict: "healthy" }, { reason: "user message" }, { device: "phone" }, { attribution: "verified" }, { v: 2 }, { samples: 0 }, { samples: 121 }, { samples: 1.1 }, { fps_p50: Infinity }, { fps_p10: -1 }, { fps_p50: 1001 },
    { fps_p10: 61 }, { fps_floor: 0 }, { long_task_p95: 1 }, { long_task_samples: 1 }, { attributed_samples: 1 }, { long_task_samples: 2, long_task_p95: 0 }, { load_ms: -1 }, { load_ms: 600001 },
    { samples: 2, attributed_samples: 1, attributed_long_task_p95: 0, attribution: "observed" }, { attributed_long_task_p95: 0 }, { attribution: "observed" },
  ])("closed numeric/enum/coverage contract %j", patch => { expect(checkEffectProfile(profile(patch)).ok).toBe(false); });
  it("partial known task attribution remains explicit and cannot turn unknown into zero", () => {
    const p = profile({ samples: 10, long_task_samples: 5, long_task_p95: 100, attributed_samples: 1, attributed_long_task_p95: 200, attribution: "observed" });
    // Quantiles use different observed subsets: own p95 can exceed all-host p95, but coverage is explicit.
    expect(checkEffectProfile(p).ok).toBe(true); expect(checkEffectProfile(profile()).ok).toBe(true); expect(checkEffectProfile(profile({ long_task_p95: 0 })).ok).toBe(false);
  });
  it.each([NaN, Infinity, -1, 1.1])("invalid server clock %s writes nothing", time => { const f = fixture(); f.at(time); expect(f.s.record(A, profile())).toEqual({ ok: false, error: "profile_clock" }); expect(existsSync(f.dir)).toBe(false); });
  it("unknown ids, throwing accessors and foreign prototypes refuse without I/O", () => {
    const f = fixture(); expect(f.s.record("../x", profile())).toMatchObject({ error: "profile_args" }); expect(f.s.read("__proto__")).toMatchObject({ error: "profile_args" });
    const input = profile(); Object.defineProperty(input, "fps_p50", { get: () => { throw Error("host failure"); } }); expect(f.s.record(A, input)).toMatchObject({ error: "profile_args" }); expect(checkEffectProfile(Object.create(profile())).ok).toBe(false); expect(existsSync(f.dir)).toBe(false);
  });
  it.each(["json", "utf8", "schema", "record-extra", "version", "order", "class", "source", "count", "ids", "rev"])("corrupt index (%s) is refused, never repaired", kind => {
    const f = fixture(); f.s.record(A, profile()); const doc = JSON.parse(readFileSync(f.s.path, "utf8"));
    if (kind === "schema") doc.extra = true;
    if (kind === "record-extra") doc.entries[A].standard[0].content = "not a performance field";
    if (kind === "version") doc.version = 2;
    if (kind === "order") doc.entries[A].standard = [{ ...doc.entries[A].standard[0], at: 2 }, { ...doc.entries[A].standard[0], at: 1 }];
    if (kind === "class") doc.entries[A].standard[0].device = "constrained";
    if (kind === "source") doc.entries[A].standard[0].source = "worker";
    if (kind === "count") doc.entries[A].standard = Array.from({ length: 21 }, () => doc.entries[A].standard[0]);
    if (kind === "ids") doc.entries = Object.fromEntries(Array.from({ length: 513 }, (_, n) => [n.toString(16).padStart(32, "0"), doc.entries[A]]));
    if (kind === "rev") doc.rev = -1;
    const invalidUtf8 = Buffer.concat([Buffer.from('{"version":"'), Buffer.from([0xff]), Buffer.from('","version":1,"rev":1,"entries":{}}')]);
    writeFileSync(f.s.path, kind === "json" ? "{" : kind === "utf8" ? invalidUtf8 : JSON.stringify(doc)); const before = readFileSync(f.s.path);
    expect(f.s.read(A)).toEqual({ ok: false, error: "profiles_unreadable" }); expect(f.s.record(A, profile())).toEqual({ ok: false, error: "profiles_unreadable" }); expect(readFileSync(f.s.path)).toEqual(before);
  });
  it("oversized/symlink indexes refuse before parsing and are never replaced", () => {
    const f = fixture(); mkdirSync(f.dir); const target = join(f.root, "target"), valid = '{"version":1,"rev":0,"entries":{}}'; writeFileSync(target, valid); symlinkSync(target, f.s.path);
    expect(f.s.record(A, profile())).toMatchObject({ error: "profiles_unreadable" }); expect(readFileSync(target, "utf8")).toBe(valid); rmSync(f.s.path);
    const bytes = Buffer.alloc(EFFECT_PROFILE_FILE_BYTES, 0x20); bytes.write(valid); writeFileSync(f.s.path, bytes); expect(f.s.read(A)).toEqual({ ok: true, status: "unmeasured", records: [] });
    writeFileSync(f.s.path, Buffer.concat([bytes, Buffer.from(" ")])); expect(f.s.read(A)).toMatchObject({ error: "profiles_unreadable" }); expect(statSync(f.s.path).size).toBe(EFFECT_PROFILE_FILE_BYTES + 1);
  });
  it("the regular-file probe opens nonblocking before any fstat/type check", () => {
    const f = fixture(); f.s.record(A, profile()); probe.observe = true; expect(f.s.read(A).ok).toBe(true); expect(probe.flags & (constants.O_NONBLOCK ?? 0)).toBe(constants.O_NONBLOCK ?? 0); expect(probe.flags & (constants.O_NOFOLLOW ?? 0)).toBe(constants.O_NOFOLLOW ?? 0);
  });
  it("failed atomic write keeps the previous readable file and no fictitious cached record", () => {
    const f = fixture(); f.s.record(A, profile()); const before = readFileSync(f.s.path); vi.spyOn(atomic, "atomicWriteFileSync").mockImplementation(() => { throw Error("disk full"); });
    expect(f.s.record(A, profile({ fps_p50: 30, fps_p10: 30 }))).toMatchObject({ error: "profiles_write_failed" }); expect(readFileSync(f.s.path)).toEqual(before); expect(f.s.read(A)).toMatchObject({ records: [expect.objectContaining({ fps_p50: 60 })] });
  });
  it("revision and id bounds refuse without overwriting previously stored reports", () => {
    const f = fixture(); f.s.record(A, profile()); const doc = JSON.parse(readFileSync(f.s.path, "utf8")), one = doc.entries[A]; doc.entries = Object.fromEntries(Array.from({ length: 512 }, (_, n) => [n.toString(16).padStart(32, "0"), one])); writeFileSync(f.s.path, JSON.stringify(doc));
    expect(f.s.read("0".repeat(32)).ok).toBe(true); let before = readFileSync(f.s.path); expect(f.s.record(A, profile())).toMatchObject({ error: "profiles_bound" }); expect(readFileSync(f.s.path)).toEqual(before);
    doc.entries = { [A]: one }; doc.rev = Number.MAX_SAFE_INTEGER; writeFileSync(f.s.path, JSON.stringify(doc)); before = readFileSync(f.s.path); expect(f.s.record(A, profile())).toMatchObject({ error: "profiles_bound" }); expect(readFileSync(f.s.path)).toEqual(before);
  });
  it("a reentrant clock callback cannot overwrite a nested accepted write", () => {
    const f = fixture(); let s: WebEffectProfiles; s = new WebEffectProfiles(f.dir, { now: () => { expect(s.record(B, profile())).toEqual({ ok: false, error: "profiles_busy" }); return 1000; } });
    expect(s.record(A, profile()).ok).toBe(true); expect(s.read(B)).toMatchObject({ status: "unmeasured", records: [] });
  });
  it("two participant objects with the same resolved path share the synchronous write fence", () => {
    const f = fixture(), other = new WebEffectProfiles(relative(process.cwd(), f.dir)); const s = new WebEffectProfiles(f.dir, { now: () => { expect(other.record(B, profile())).toMatchObject({ error: "profiles_busy" }); return 1000; } });
    expect(s.record(A, profile()).ok).toBe(true); expect(other.read(B)).toMatchObject({ status: "unmeasured" }); expect(other.record(B, profile()).ok).toBe(true);
  });
});

describe("#1629 per-owned-mount host profile collector", () => {
  it("aggregates real profiler snapshots without inventing private worker cost", () => {
    const h = collector(); let n = 0; const budget = new EffectBudget({ device: "standard", baselineFps: 60, clock: () => n, longTasksSupported: false });
    expect(h.c.report()).toBeNull(); for (let i = 1; i <= 300; i++) { n = i * 1000 / 60; budget.frame(); if (i % 60 === 0) { h.at(n); h.c.add({ key: "slot", id: A, device: "standard", ...budget.poll() }); } }
    const report = h.c.report(); expect(report.id).toBe(A); expect(report.profile).toMatchObject({ samples: 3, verdict: "ok", attribution: "unknown", long_task_p95: null, attributed_long_task_p95: null, long_task_samples: 0, attributed_samples: 0 }); expect(checkEffectProfile(report.profile).ok).toBe(true); expect(JSON.stringify(report)).not.toContain("worker");
  });
  it("real budget frame/gates/stop snapshots never resample or refresh a frozen poll window", () => {
    let now=0;const h=collector(), budget=new EffectBudget({device:"standard",baselineFps:60,clock:()=>now,longTasksSupported:false});
    const add=(value:Record<string,unknown>)=>{h.at(now);return h.c.add({key:"slot",id:A,device:"standard",...value});};
    for(let i=1;i<=300;i++){now=i*1000/60;budget.frame();if(i%60===0)add(budget.poll());}
    expect(h.c.report().profile.samples).toBe(3);const stamp=budget.snapshot().metrics.at;
    for(let i=1;i<=30;i++){now=5000+i*1000;expect(add(budget.frame())).toBe(false);expect(add(budget.gates({hidden:false,reducedMotion:false,saveData:false,show:true}))).toBe(false);}
    expect(budget.snapshot().metrics.at).toBe(stamp);expect(h.c.report()).toBeNull();
    // A genuinely new poll may recover freshness once. stop()/gates() cannot add windows afterward.
    expect(add(budget.poll())).toBe(true);expect(h.c.report().profile.samples).toBe(4);
    expect(add(budget.stop("host_budget"))).toBe(false);expect(h.c.report().profile).toMatchObject({samples:4,verdict:"paused",reason:"host_budget"});
    for(let i=1;i<=20;i++){now+=1000;expect(add(budget.gates({hidden:false,reducedMotion:false,saveData:false,show:true}))).toBe(false);}
    expect(h.c.report()).toBeNull();expect(budget.snapshot().metrics.at).toBe(35000);
  });
  it("delayed first receipt and replayed windows cannot forge observation time", () => {
    const h=collector();h.at(5001);expect(h.c.add(snapshot())).toBe(false);expect(h.c.report()).toBeNull();
    h.at(6000);expect(h.c.add(snapshot({metrics:{...snapshot().metrics,at:6000}}))).toBe(true);
    h.at(7000);expect(h.c.add(snapshot({metrics:{...snapshot().metrics,at:5999}}))).toBe(false);expect(h.c.report().profile.samples).toBe(1);
    h.at(11001);expect(h.c.add(snapshot({metrics:{...snapshot().metrics,at:6000}}))).toBe(false);expect(h.c.report()).toBeNull();
    const future=collector();expect(future.c.add(snapshot({metrics:{...snapshot().metrics,at:1}}))).toBe(false);expect(future.c.report()).toBeNull();
    const delayed=collector();delayed.at(1000);expect(delayed.c.add(snapshot())).toBe(true);delayed.at(5000);expect(delayed.c.report()).not.toBeNull();delayed.at(5001);expect(delayed.c.report()).toBeNull();
  });
  it.each([undefined, -1, NaN, Infinity, "0"])("invalid observation stamp %s fails closed", at => {
    const h=collector();expect(h.c.add(snapshot({metrics:{...snapshot().metrics,at}}))).toBe(false);expect(h.c.report()).toBeNull();
  });
  it("nearest-rank quantiles use observed windows and explicit attribution coverage", () => {
    const h = collector();
    for (let i = 1; i <= 10; i++) { h.at(i * 1000); h.sample(snapshot({ metrics: { at: i * 1000, hostFps: i * 10, hostLongTaskMsPerSecond: i % 2 ? null : i, attributedLongTaskMsPerSecond: i === 10 ? 8 : null, attribution: i === 10 ? "observed" : "unknown", fpsFloor: 54, windowMs: 2000 } })); }
    expect(h.c.report().profile).toMatchObject({ samples: 10, fps_p50: 50, fps_p10: 10, long_task_p95: 10, long_task_samples: 5, attributed_long_task_p95: 8, attributed_samples: 1, attribution: "observed" });
    const p = h.c.report(); p.profile.fps_p50 = 999; expect(h.c.report().profile.fps_p50).toBe(50); expect(h.c.report({ off: true }).profile.verdict).toBe("off");
  });
  it("sample cadence and retention are bounded independently of callback count", () => {
    const h = collector(); expect(h.sample(snapshot())).toBe(true); h.at(999); expect(h.sample(snapshot())).toBe(false); h.at(1000); expect(h.sample(snapshot())).toBe(true);
    for (let n = 2; n < 125; n++) { h.at(n * 1000); expect(h.sample(snapshot({ metrics: { ...snapshot().metrics, hostFps: n } }))).toBe(true); }
    expect(h.c.report().profile).toMatchObject({ samples: 120, fps_p50: 64, fps_p10: 16 });
  });
  it("warmup and stale observations yield no new report; a fresh observed window can recover staleness", () => {
    const h = collector(); expect(h.sample(snapshot({ metrics: null }))).toBe(false); expect(h.c.report()).toBeNull(); expect(h.sample(snapshot())).toBe(true); h.at(5000); expect(h.c.report()).not.toBeNull(); h.at(5001); expect(h.c.report()).toBeNull(); expect(h.sample(snapshot())).toBe(true); expect(h.c.report()).not.toBeNull();
  });
  it.each(["key", "id", "device"])("wrong %s ownership cannot refresh or report old metrics", field => {
    const h = collector(); h.sample(snapshot()); expect(h.sample(snapshot({ [field]: "other" }))).toBe(false); expect(h.c.report()).toBeNull();
  });
  it("unknown fields are refused without reading their content getter", () => {
    const h = collector(), raw = snapshot(); Object.defineProperty(raw, "content", { enumerable: true, get() { throw Error("content getter read"); } }); expect(h.c.add(raw)).toBe(false); expect(h.c.report()).toBeNull();
  });
  it.each([{ verdict: "healthy" }, { verdict: "healthy", quality: "low", pointerHz: 30 }, { reason: "message" }, { quality: "high" }, { pointerHz: 120 }, { badWindows: 4 }, { loadMs: Infinity }, { remove: true }, { forward: "yes" },
    { verdict: "paused", reason: "host_budget", quality: "low", pointerHz: 30, remove: false, forward: false, badWindows: 3 }, { verdict: "paused", reason: "host_budget", quality: "low", pointerHz: 30, remove: true, forward: true, badWindows: 3 },
    { metrics: { ...snapshot().metrics, content: "not an observed field" } }, { metrics: { ...snapshot().metrics, hostFps: -1 } }, { metrics: { ...snapshot().metrics, fpsFloor: 0 } }, { metrics: { ...snapshot().metrics, windowMs: 1000 } }, { metrics: { ...snapshot().metrics, attribution: "verified" } }, { metrics: { ...snapshot().metrics, hostLongTaskMsPerSecond: -1 } },
    { metrics: { ...snapshot().metrics, hostLongTaskMsPerSecond: 1, attributedLongTaskMsPerSecond: 2, attribution: "observed" } }, { metrics: { ...snapshot().metrics, attributedLongTaskMsPerSecond: 1 } }])("malformed host snapshot %j fails closed", patch => {
    const h = collector(); expect(h.sample(snapshot(patch))).toBe(false); expect(h.c.report()).toBeNull();
  });
  it("the pre-effect floor cannot change within an owned collector", () => { const h = collector(); h.sample(snapshot()); h.at(1000); expect(h.sample(snapshot({ metrics: { ...snapshot().metrics, fpsFloor: 20 } }))).toBe(false); expect(h.c.report()).toBeNull(); });
  it("clock failure or rollback revokes a collector permanently", () => {
    const h = collector(); h.at(1000); h.sample(snapshot()); h.at(999); expect(h.c.report()).toBeNull(); h.at(2000); expect(h.sample(snapshot())).toBe(false); expect(h.c.report()).toBeNull();
    expect(collector({ clock: () => NaN }).c.ok).toBe(false);
  });
  it("disposal prevents stale reports and future samples", () => { const h = collector(); h.sample(snapshot()); h.c.dispose(); expect(h.c.report()).toBeNull(); h.at(1000); expect(h.sample(snapshot())).toBe(false); });
  it("unknown constructor/report options refuse without reading their extra getters", () => {
    expect(createEffectProfileCollector(null).ok).toBe(false); expect(createEffectProfileCollector().ok).toBe(false); const h = collector(); h.sample(snapshot());
    const extra = Object.defineProperty({}, "content", { enumerable: true, get() { throw Error("private content read"); } }); expect(h.c.report(extra)).toBeNull(); expect(h.c.report(null)).toBeNull(); expect(h.c.report({ off: "yes" })).toBeNull(); expect(h.c.report()).not.toBeNull();
  });
});
