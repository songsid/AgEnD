import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WebEffectLibrary } from "../src/web-effect-library.js";
import { EFFECT_TRIAL_TTL_MS, WebEffectTrials, effectTrialOffer } from "../src/web-effect-trials.js";

const roots: string[] = [], owners: WebEffectTrials[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const o of owners.splice(0)) o.dispose(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const viewer = (patch: Record<string, unknown> = {}) => ({ via: "session", surface: "local", tier: "admin", sessionHash: "a".repeat(64), epoch: "b".repeat(16), person: "person:discord:123", ownerCss: "off", ...patch });
const files = (title = "Fixture", code = "agend.ready()") => new Map([
  ["effect.json", Buffer.from(JSON.stringify({ v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "fixture", title, regions: ["page"], layer: "front", wants: ["theme"] }))],
  ["worker.js", Buffer.from(code)],
]);
function fixture() {
  mkdirSync(".artifacts", { recursive: true }); const root = mkdtempSync(join(process.cwd(), ".artifacts/effect-trials-")); roots.push(root);
  const library = new WebEffectLibrary(root); let now = 0, wall = 1_000_000, known: (name: string) => boolean = () => true;
  const trials = new WebEffectTrials({ library, known: n => known(n), monotonic: () => now, now: () => wall }); owners.push(trials);
  function upload(kind: "agent" | "human" = "agent", who = "agent", title = "Fixture", code = "agend.ready()") {
    const staged = library.stage(files(title, code), { kind, id: who }); if (!staged.ok) throw Error(staged.error);
    const c = library.commit(staged.stageId); if (!c.ok) throw Error(c.error); return c.ids[0]!;
  }
  const id = upload();
  function offer(name = "agent", effect = id) { const r = trials.offer(name, effect); if (!r.ok) throw Error(r.error); return r; }
  function start(o = offer().offer, a: unknown = viewer(), name = "agent") { const r = trials.start(o.offer, name, a); if (!r.ok) throw Error(r.error); return r; }
  return { root, library, trials, id, upload, offer, start, at: (n: number) => { now = n; }, wall: (n: number) => { wall = n; }, known: (fn: (name: string) => boolean) => { known = fn; } };
}
const unavailable = { ok: false, error: "trial_unavailable" };
function disk(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => {
    const path = join(e.parentPath, e.name); return [path.slice(root.length), readFileSync(path).toString("base64")];
  }));
}

describe("#1629 volatile local-admin Try authority (unmounted)", () => {
  it("offers and opens a session/epoch-bound sample without writing a file, claim, preference or placement", () => {
    const f = fixture(), before = disk(f.root), offered = f.offer();
    expect(offered).toMatchObject({ ok: true, created: true, offer: { v: 1, id: f.id, title: "Fixture", expiresAt: 1_600_000 } });
    expect(offered.offer.offer).toMatch(/^[0-9a-f]{32}$/); expect(Object.isFrozen(offered.offer)).toBe(true);
    const trial = f.start(offered.offer); expect(trial.trial).toMatch(/^[0-9a-f]{32}$/); expect(trial.trial).not.toBe(offered.offer.offer);
    const read = f.trials.read(trial.trial, "agent", viewer()); expect(read).toMatchObject({ ok: true, id: f.id, instance: "agent", entry: { manifest: { regions: ["page"], layer: "front" } } });
    expect(f.library.read(f.id, { kind: "human", id: viewer().person }).ok).toBe(false);
    expect(f.library.list({ kind: "human", id: viewer().person })).toMatchObject({ ok: true, entries: [] });
    expect(disk(f.root)).toEqual(before);
    expect(f.trials.stop(trial.trial, viewer())).toEqual({ ok: true }); expect(f.trials.read(trial.trial, "agent", viewer())).toEqual(unavailable); expect(disk(f.root)).toEqual(before);
  });
  it("repeated offer is idempotent with its original deadline; a different id replaces and invalidates old trials", () => {
    const f = fixture(), o = f.offer(), t = f.start(o.offer); f.at(100_000); f.wall(2_000_000);
    expect(f.offer()).toEqual({ ok: true, offer: o.offer, created: false });
    const other = f.upload("agent", "agent", "Another", "// other"); const next = f.offer("agent", other);
    expect(next.offer.offer).not.toBe(o.offer.offer); expect(next.offer.id).toBe(other);
    expect(f.trials.start(o.offer.offer, "agent", viewer())).toEqual(unavailable); expect(f.trials.read(t.trial, "agent", viewer())).toEqual(unavailable);
    expect(f.trials.read(f.start(next.offer).trial, "agent", viewer())).toMatchObject({ ok: true, id: other });
  });
  it.each([EFFECT_TRIAL_TTL_MS, EFFECT_TRIAL_TTL_MS + 1])("offer and trial expire without timer delivery at %dms", at => {
    const f = fixture(), o = f.offer().offer, t = f.start(o); f.at(EFFECT_TRIAL_TTL_MS - 1);
    expect(f.trials.read(t.trial, "agent", viewer()).ok).toBe(true); f.at(at);
    expect(f.trials.start(o.offer, "agent", viewer())).toEqual(unavailable); expect(f.trials.read(t.trial, "agent", viewer())).toEqual(unavailable);
    expect(f.offer().offer.offer).not.toBe(o.offer);
  });
  it("a trial started just before expiry cannot extend the offer, and wall-clock changes cannot renew it", () => {
    const f = fixture(), o = f.offer().offer; f.at(599_999); f.wall(0); const t = f.start(o);
    expect(t.remainingMs).toBe(1); expect(t.offer.expiresAt).toBe(o.expiresAt); f.at(600_000); expect(f.trials.read(t.trial, "agent", viewer())).toEqual(unavailable);
  });
  it("returns a floored monotonic remainder for a conservative request-start deadline, never a wall-clock lease", () => {
    const f = fixture(), o = f.offer().offer; expect(f.start(o).remainingMs).toBe(600_000);
    f.at(10_000.25); f.wall(0); expect(f.start(o).remainingMs).toBe(589_999);
    f.at(599_999.75); expect(f.trials.start(o.offer, "agent", viewer())).toEqual(unavailable);
  });
  it.each([
    { surface: "gateway" }, { surface: "public" }, { via: "header-token" }, { via: "agent" }, { tier: "read" }, { tier: undefined },
    { ownerCss: "on" }, { ownerCss: "loading" }, { ownerCss: "unknown" }, { ownerCss: null }, { ownerCss: undefined },
    { sessionHash: "a".repeat(63) }, { sessionHash: "x".repeat(64) }, { epoch: "b".repeat(15) }, { epoch: "B".repeat(16) },
    { person: "" }, { person: "x".repeat(257) }, { extra: true },
  ])("refuses start AND each read for an ineligible/fail-closed viewer %j", patch => {
    const f = fixture(), o = f.offer().offer, t = f.start(o), before = disk(f.root), a = viewer(patch);
    expect(f.trials.start(o.offer, "agent", a)).toEqual(unavailable); expect(f.trials.read(t.trial, "agent", a)).toEqual(unavailable); expect(disk(f.root)).toEqual(before);
    expect(f.trials.read(t.trial, "agent", viewer()).ok).toBe(true);
  });
  it.each([null, [], "admin", {}, Object.create(viewer())])("no implicit operator, inherited viewer or anonymous admission: %j", a => {
    const f = fixture(), o = f.offer().offer; expect(f.trials.start(o.offer, "agent", a)).toEqual(unavailable);
  });
  it.each([{ sessionHash: "c".repeat(64) }, { epoch: "c".repeat(16) }, { person: "person:telegram:123" }])("knowing the token never crosses session, epoch or platform-person binding %j", patch => {
    const f = fixture(), t = f.start(); expect(f.trials.read(t.trial, "agent", viewer(patch))).toEqual(unavailable);
    expect(f.trials.stop(t.trial, viewer(patch))).toEqual(unavailable); expect(f.trials.read(t.trial, "agent", viewer()).ok).toBe(true);
  });
  it("web-only operator is permitted only as an explicit signed-in local admin and remains session-bound", () => {
    const f = fixture(), t = f.start(undefined, viewer({ person: "operator" }));
    expect(f.trials.read(t.trial, "agent", viewer({ person: "operator" })).ok).toBe(true);
    expect(f.trials.read(t.trial, "agent", viewer({ person: "operator", sessionHash: "d".repeat(64) }))).toEqual(unavailable);
  });
  it("captures actor data independently; stopping remains allowed after custom CSS becomes unknown", () => {
    const f = fixture(), a = viewer(), t = f.start(undefined, a); a.person = "attacker"; a.epoch = "0".repeat(16);
    expect(f.trials.read(t.trial, "agent", viewer()).ok).toBe(true); expect(f.trials.read(t.trial, "agent", a)).toEqual(unavailable);
    expect(f.trials.stop(t.trial, viewer({ ownerCss: "unknown" }))).toEqual({ ok: true }); expect(f.trials.read(t.trial, "agent", viewer())).toEqual(unavailable);
  });
  it("only the origin agent's current own/shared access authorizes offer/open/read, even with a retaining reference", () => {
    const f = fixture(), privateId = f.upload("human", "bob", "Private", "// private");
    expect(f.trials.offer("agent", privateId)).toEqual(unavailable);
    expect(f.library.setShared(privateId, { kind: "human", id: "bob" }, true)).toEqual({ ok: true });
    const o = f.offer("agent", privateId).offer, t = f.start(o); expect(f.trials.read(t.trial, "agent", viewer()).ok).toBe(true);
    expect(f.library.setShared(privateId, { kind: "human", id: "bob" }, false)).toEqual({ ok: true });
    expect(f.library.readReferenced(privateId, `trial-offer:${o.offer}`).ok).toBe(true);
    expect(f.trials.start(o.offer, "agent", viewer())).toEqual(unavailable); expect(f.trials.read(t.trial, "agent", viewer())).toEqual(unavailable);
    expect(f.trials.offer("agent", privateId)).toEqual(unavailable);
    expect(f.trials.read(t.trial, "agent", viewer({ person: "bob" }))).toEqual(unavailable);
  });
  it("an independent private claim held by the viewer never substitutes for the origin agent's rights", () => {
    const f = fixture(), o = f.offer().offer, t = f.start(o);
    const s = f.library.stage(files(), { kind: "human", id: viewer().person }); if (!s.ok) throw Error(s.error); expect(f.library.commit(s.stageId).ok).toBe(true);
    // A viewer claim is not a substitute for a known, currently authorized origin agent.
    f.known(() => false); expect(f.trials.read(t.trial, "agent", viewer())).toEqual(unavailable);
    expect(f.library.read(f.id, { kind: "human", id: viewer().person }).ok).toBe(true);
  });
  it("unknown/deleted instance or a different instance cannot use an old offer or trial", () => {
    const f = fixture(), o = f.offer().offer, t = f.start(o);
    expect(f.trials.start(o.offer, "other", viewer())).toEqual(unavailable); expect(f.trials.read(t.trial, "other", viewer())).toEqual(unavailable);
    f.known(() => false); expect(f.trials.start(o.offer, "agent", viewer())).toEqual(unavailable); expect(f.trials.read(t.trial, "agent", viewer())).toEqual(unavailable); expect(f.trials.offer("agent", f.id)).toEqual(unavailable);
  });
  it("display ids and trial tokens have separate purposes and cannot name another resource", () => {
    const f = fixture(), o = f.offer().offer, t = f.start(o);
    expect(f.trials.read(o.offer, "agent", viewer())).toEqual(unavailable); expect(f.trials.start(t.trial, "agent", viewer())).toEqual(unavailable);
    for (const token of ["", "a".repeat(31), "x".repeat(32), "__proto__"]) {
      expect(f.trials.read(token, "agent", viewer())).toEqual(unavailable); expect(f.trials.start(token, "agent", viewer())).toEqual(unavailable); expect(f.trials.stop(token, viewer())).toEqual(unavailable);
    }
  });
  it.each([["", "valid"], ["x".repeat(129), "valid"], ["agent", "bad"]])("invalid instance/id %j %j never publishes a reference", (name, value) => {
    const f = fixture(); expect(f.trials.offer(name, value === "valid" ? f.id : value)).toEqual(unavailable);
    expect(f.library.deleteClaim(f.id, { kind: "agent", id: "agent" }).ok).toBe(true);
  });
  it("starting again replaces only that session's trial; other sessions survive", () => {
    const f = fixture(), o = f.offer().offer, a = f.start(o), bViewer = viewer({ sessionHash: "c".repeat(64) }), b = f.start(o, bViewer), next = f.start(o);
    expect(f.trials.read(a.trial, "agent", viewer())).toEqual(unavailable); expect(f.trials.read(next.trial, "agent", viewer()).ok).toBe(true); expect(f.trials.read(b.trial, "agent", bViewer).ok).toBe(true);
  });
  it("retains bytes but no claim, expires with no timer, and replacement releases the old reference", () => {
    const f = fixture(), o = f.offer().offer;
    expect(f.library.deleteClaim(f.id, { kind: "agent", id: "agent" })).toMatchObject({ ok: false, error: "effect_in_use" });
    expect(f.library.readReferenced(f.id, `trial-offer:${o.offer}`).ok).toBe(true);
    const other = f.upload("agent", "agent", "Other", "// next"); f.offer("agent", other);
    expect(f.library.readReferenced(f.id, `trial-offer:${o.offer}`).ok).toBe(false);
    expect(f.library.deleteClaim(f.id, { kind: "agent", id: "agent" }).ok).toBe(true);
    f.at(600_000); expect(f.library.deleteClaim(other, { kind: "agent", id: "agent" }).ok).toBe(true);
  });
  it("a last mod-holder release retains a trial blob but revokes access, then expiry permits real collection", async () => {
    const f = fixture(), principal = { kind: "agent" as const, id: "agent" }, holder = `mod:${"d".repeat(32)}`;
    const staged = f.library.stage(files("Mod", "// mod"), principal, { holder }); if (!staged.ok) throw Error(staged.error);
    const committed = f.library.commit(staged.stageId); if (!committed.ok) throw Error(committed.error); const id = committed.ids[0]!;
    const o = f.offer("agent", id).offer, t = f.start(o); expect(f.library.releaseHolder(holder, principal)).toMatchObject({ ok: true, released: [id] });
    await Promise.resolve(); expect(existsSync(join(f.root, "web-effects", id))).toBe(true);
    expect(f.library.readReferenced(id, `trial-offer:${o.offer}`).ok).toBe(true); expect(f.trials.read(t.trial, "agent", viewer())).toEqual(unavailable);
    f.at(600_000); f.library.collectUnreferenced([id]); await Promise.resolve(); expect(existsSync(join(f.root, "web-effects", id))).toBe(false);
  });
  it("there is one volatile registry per library, and restart/disposal cannot restore an interactive offer", () => {
    const f = fixture(), o = f.offer().offer, t = f.start(o); expect(() => new WebEffectTrials({ library: f.library, known: () => true })).toThrow("Duplicate reference source");
    f.trials.dispose(); f.trials.dispose(); expect(f.trials.read(t.trial, "agent", viewer())).toEqual(unavailable); expect(f.trials.offer("agent", f.id)).toEqual(unavailable);
    const replacement = new WebEffectTrials({ library: f.library, known: () => true }); owners.push(replacement);
    expect(replacement.start(o.offer, "agent", viewer())).toEqual(unavailable); expect(replacement.read(t.trial, "agent", viewer())).toEqual(unavailable);
    expect(f.library.readReferenced(f.id, `trial-offer:${o.offer}`).ok).toBe(false);
  });
  it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER])("invalid monotonic time %j latches denial and makes reference collection fail closed", async time => {
    const f = fixture(), o = f.offer().offer, t = f.start(o), before = disk(f.root); f.at(time);
    expect(f.trials.read(t.trial, "agent", viewer())).toEqual(unavailable); f.at(0);
    expect(f.trials.start(o.offer, "agent", viewer())).toEqual(unavailable);
    f.library.collectUnreferenced([f.id]); await Promise.resolve(); expect(disk(f.root)).toEqual(before);
    expect(f.library.deleteClaim(f.id, { kind: "agent", id: "agent" })).toMatchObject({ ok: false, error: "references_unreadable" });
  });
  it("rollback observed by the reference provider also permanently refuses admission and deletion", async () => {
    const f = fixture(), o = f.offer().offer; f.at(100); expect(f.library.readReferenced(f.id, `trial-offer:${o.offer}`).ok).toBe(true); f.at(99);
    expect(f.library.readReferenced(f.id, `trial-offer:${o.offer}`).ok).toBe(false); f.at(100);
    expect(f.trials.start(o.offer, "agent", viewer())).toEqual(unavailable); const before = disk(f.root); f.library.collectUnreferenced([f.id]); await Promise.resolve(); expect(disk(f.root)).toEqual(before);
  });
  it.each([NaN, -1, Infinity, Number.MAX_SAFE_INTEGER, 0.5])("display clock %j cannot publish an offer", wall => {
    const f = fixture(); f.wall(wall); expect(f.trials.offer("agent", f.id)).toEqual(unavailable);
  });
  it("checks the monotonic deadline after host/library callbacks, without relying on a timer", () => {
    const f = fixture(), o = f.offer().offer, t = f.start(o); f.known(() => { f.at(600_000); return true; });
    expect(f.trials.read(t.trial, "agent", viewer())).toEqual(unavailable);
    const g = fixture(), p = g.offer().offer; g.known(() => { g.at(600_000); return true; }); expect(g.trials.start(p.offer, "agent", viewer())).toEqual(unavailable);
  });
  it("reentrant policy callbacks cannot overwrite ownership; disposal during policy evaluation wins", () => {
    const f = fixture(), o = f.offer().offer; let nested: unknown;
    f.known(() => { nested = f.trials.offer("other", f.id); return true; }); expect(f.trials.start(o.offer, "agent", viewer()).ok).toBe(true); expect(nested).toEqual({ ok: false, error: "trial_busy" });
    f.known(() => { f.trials.dispose(); return true; }); expect(f.trials.start(o.offer, "agent", viewer())).toEqual(unavailable);
  });
  it("global offer cap is 128, replacement/idempotence work at capacity, expiry releases capacity", () => {
    const f = fixture(); expect(f.library.setShared(f.id, { kind: "agent", id: "agent" }, true).ok).toBe(false);
    // Agents cannot share; a human explicitly makes this fixture readable by every origin.
    const shared = f.upload("human", "bob", "Shared", "// shared"); expect(f.library.setShared(shared, { kind: "human", id: "bob" }, true).ok).toBe(true);
    for (let i = 0; i < 128; i++) expect(f.trials.offer(`agent-${i}`, shared)).toMatchObject({ ok: true, created: true });
    expect(f.trials.offer("overflow", shared)).toEqual({ ok: false, error: "trial_capacity" });
    expect(f.trials.offer("agent-0", shared)).toMatchObject({ ok: true, created: false }); expect(f.trials.offer("agent-0", f.id)).toEqual(unavailable);
    const own = f.upload("agent", "agent-0", "Own", "// own"); expect(f.trials.offer("agent-0", own)).toMatchObject({ ok: true, created: true });
    f.at(600_000); expect(f.trials.offer("overflow", shared)).toMatchObject({ ok: true });
  });
  it("global trial cap is 128; replacing one session works at capacity, expiry releases it", () => {
    const f = fixture(), o = f.offer().offer;
    for (let i = 0; i < 128; i++) expect(f.trials.start(o.offer, "agent", viewer({ sessionHash: i.toString(16).padStart(64, "0") }))).toMatchObject({ ok: true });
    expect(f.trials.start(o.offer, "agent", viewer())).toEqual({ ok: false, error: "trial_capacity" });
    expect(f.trials.start(o.offer, "agent", viewer({ sessionHash: "0".repeat(64) }))).toMatchObject({ ok: true });
    f.at(600_000); const next = f.offer().offer; expect(f.trials.start(next.offer, "agent", viewer())).toMatchObject({ ok: true });
  });
  it("rejects accessor/symbol/non-enumerable viewer data without invoking getters", () => {
    const f = fixture(), o = f.offer().offer, getter = vi.fn(() => "admin"), a = viewer(); Object.defineProperty(a, "tier", { get: getter });
    expect(f.trials.start(o.offer, "agent", a)).toEqual(unavailable); expect(getter).not.toHaveBeenCalled();
    const b = viewer(); Object.defineProperty(b, "person", { value: b.person, enumerable: false }); expect(f.trials.start(o.offer, "agent", b)).toEqual(unavailable);
    expect(f.trials.start(o.offer, "agent", { ...viewer(), [Symbol()]: 1 })).toEqual(unavailable);
  });
});

describe("closed Try display codec (no authority)", () => {
  const valid = () => ({ v: 1, offer: "a".repeat(32), id: "b".repeat(32), title: "👨‍👩‍👧".repeat(10), expiresAt: 600_000 });
  it("copies and freezes canonical grapheme-bounded metadata", () => {
    const input = valid(), r = effectTrialOffer(input); expect(r).toEqual(input); expect(Object.isFrozen(r)).toBe(true); input.title = "changed"; expect(r?.title).not.toBe(input.title);
    expect(effectTrialOffer({ ...valid(), title: "x́".normalize("NFC").repeat(40) })).not.toBeNull();
  });
  it.each([{ v: 2 }, { offer: "x".repeat(32) }, { id: "b".repeat(31) }, { title: "x".repeat(41) }, { title: "x\n" }, { title: " x" }, { title: "e\u0301" }, { title: "x\u200e" }, { expiresAt: -1 }, { expiresAt: NaN }, { expiresAt: 0.5 }, { extra: 1 }])("rejects noncanonical or unknown metadata %j", patch => {
    expect(effectTrialOffer({ ...valid(), ...patch })).toBeNull();
  });
  it("rejects oversized UTF-16 data, inherited properties, symbols, unreadable proxies and getters", () => {
    expect(effectTrialOffer({ ...valid(), title: "x" + "\u0301".repeat(400) })).toBeNull();
    expect(effectTrialOffer(Object.create(valid()))).toBeNull(); expect(effectTrialOffer({ ...valid(), [Symbol()]: 1 })).toBeNull();
    const input = valid(), getter = vi.fn(() => "Title"); Object.defineProperty(input, "title", { get: getter }); expect(effectTrialOffer(input)).toBeNull(); expect(getter).not.toHaveBeenCalled();
    expect(effectTrialOffer(new Proxy({}, { ownKeys: () => { throw Error("unreadable"); } }))).toBeNull();
  });
});
