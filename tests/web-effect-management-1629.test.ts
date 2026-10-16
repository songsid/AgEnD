/** Caller-only management metadata and one bounded profile snapshot per listing. No runtime or fleet. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebEffectLibrary, type EffectPrincipal } from "../src/web-effect-library.js";
import { WebEffectProfiles } from "../src/web-effect-profiles.js";
import { WebEffectService } from "../src/web-effect-service.js";
import { WebEffectTools } from "../src/web-effect-tools.js";
import { ThemeStore } from "../src/web-theme-store.js";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const human = (id: string): EffectPrincipal => ({ kind: "human", id });
const profile = (fps = 60, device = "standard") => ({ v: 1, device, verdict: "ok", reason: null, samples: 1, fps_p50: fps, fps_p10: fps,
  fps_floor: 54, long_task_p95: null, long_task_samples: 0, attributed_long_task_p95: null, attributed_samples: 0, attribution: "unknown", load_ms: null });
function fixture() {
  mkdirSync(".artifacts", { recursive: true }); const root = mkdtempSync(join(process.cwd(), ".artifacts/effect-management-")); roots.push(root);
  const library = new WebEffectLibrary(root), profiles = new WebEffectProfiles(root), themes = new ThemeStore(root);
  const service = new WebEffectService({ library, profiles, themes, known: () => true, changed() {} });
  const upload = (principal: EffectPrincipal, tag: string) => {
    const files = new Map([["effect.json", Buffer.from(JSON.stringify({ v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "fixture", title: "Fixture", regions: ["chat"], layer: "behind", wants: [] }))], ["worker.js", Buffer.from(`//${tag}\nagend.ready()`)] ]);
    const staged = library.stage(files, principal); if (!staged.ok) throw Error(staged.error);
    const committed = library.commit(staged.stageId); if (!committed.ok) throw Error(committed.error); return committed.ids[0]!;
  };
  return { root, library, profiles, service, upload };
}
describe("#1629 effect management projection", () => {
  it("reports only the caller's own claim and sharing choice, never another principal or holder", () => {
    const f = fixture(), id = f.upload(human("bob"), "same"), hidden = f.upload(human("bob"), "private");
    expect(f.service.list("alice")).toEqual({ effects: [] }); expect(f.library.setShared(id, human("bob"), true).ok).toBe(true);
    expect(f.service.list("alice")).toMatchObject({ effects: [{ id, ownClaim: false, sharedByYou: false }] });
    expect(f.upload(human("alice"), "same")).toBe(id);
    expect(f.service.list("alice")).toMatchObject({ effects: [{ id, ownClaim: true, sharedByYou: false }] });
    expect(f.service.share("alice", { id, shared: true })).toEqual({ id, shared: true });
    const view = f.service.list("alice"); expect(view).toMatchObject({ effects: [{ id, ownClaim: true, sharedByYou: true }] });
    for (const secret of [hidden, "bob", "principal", "holders", "uploaded"]) expect(JSON.stringify(view)).not.toContain(secret);
    expect(f.library.managementList({ kind: "agent", id: "worker" })).toEqual({ ok: false, error: "invalid_principal" });
    const ordinary = f.library.list(human("alice")); if (!ordinary.ok) throw Error(ordinary.error);
    expect(Object.keys(ordinary.entries[0]!).sort()).toEqual(["bytes", "id", "manifest"]);
  });
  it("human listing parses profiles once, returns latest per class, and never widens its effect ACL", () => {
    const f = fixture(), a = f.upload(human("alice"), "a"), b = f.upload(human("bob"), "b"), hidden = f.upload(human("bob"), "hidden");
    f.library.setShared(b, human("bob"), true);
    for (const [id, fps, device] of [[a, 60, "standard"], [a, 30, "standard"], [a, 40, "constrained"], [hidden, 10, "standard"]] as const) expect(f.profiles.record(id, profile(fps, device)).ok).toBe(true);
    const load = vi.spyOn(f.profiles as any, "load"), read = vi.spyOn(f.profiles, "read");
    const result = f.service.list("alice") as any;
    expect(load).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled();
    expect(result.effects.map((e: any) => e.id).sort()).toEqual([a, b].sort());
    expect(result.effects.find((e: any) => e.id === a).profiles.records.map((p: any) => p.fps_p50)).toEqual([30, 40]);
    expect(result.effects.find((e: any) => e.id === b).profiles).toEqual({ status: "unmeasured", records: [] });
    expect(JSON.stringify(result)).not.toContain(hidden);
  });
  it("agent listing uses one authorized-id batch without the per-id reader", () => {
    const f = fixture(), a = f.upload({ kind: "agent", id: "worker" }, "a"), b = f.upload(human("bob"), "b"), hidden = f.upload(human("bob"), "hidden");
    f.library.setShared(b, human("bob"), true);
    const batch = vi.fn((ids: readonly string[]) => f.service.profileSummaries(ids)), fallback = vi.fn(() => ({ status: "unmeasured", records: [] }));
    const tools = new WebEffectTools({ library: f.library, limiter: null as any, authorize: () => null, placed: () => [], place: () => ({ ok: true, rev: 1 }), changed() {}, preview: async () => ({}), profiles: fallback, profileSummary: fallback, profileSummaries: batch });
    expect((tools.list("worker") as any).effects.map((e: any) => e.id).sort()).toEqual([a, b].sort());
    expect(batch).toHaveBeenCalledTimes(1); expect([...batch.mock.calls[0]![0]].sort()).toEqual([a, b].sort()); expect(fallback).not.toHaveBeenCalled();
    expect(JSON.stringify(tools.list("worker"))).not.toContain(hidden);
  });
  it("empty listings do not parse profiles, and unreadability is never reported as unmeasured", () => {
    const f = fixture(), read = vi.spyOn(f.profiles, "readSummaries"); expect(f.service.list("alice")).toEqual({ effects: [] }); expect(read).not.toHaveBeenCalled();
    const id = f.upload(human("alice"), "a"); writeFileSync(f.profiles.path, "{");
    expect(f.service.list("alice")).toMatchObject({ effects: [{ id, profiles: { error: "profiles_unreadable" } }] });
  });
  it("profile summary snapshots are independent and omit older windows", () => {
    const f = fixture(), id = f.upload(human("alice"), "a"); f.profiles.record(id, profile(60)); f.profiles.record(id, profile(30));
    const a = f.profiles.readSummaries(); if (!a.ok) throw Error(a.error); expect(a.summaries[id]!.records).toHaveLength(1);
    a.summaries[id]!.records[0]!.fps_p50 = 999;
    const b = f.profiles.readSummaries(); if (!b.ok) throw Error(b.error); expect(b.summaries[id]!.records[0]!.fps_p50).toBe(30);
  });
});
