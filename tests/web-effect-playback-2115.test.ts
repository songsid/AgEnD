import { describe, expect, it } from "vitest";
import { checkPlaybackObservation, EFFECT_BLOCK_REASONS, WebEffectPlayback } from "../src/web-effect-playback.js";
const browser = await import(new URL("../src/ui/shared/effect-policy.js", import.meta.url).href);
const id = "a".repeat(32), reporter = "b".repeat(64);
const blocked = (reason = "reduced_motion") => ({ v: 1, kind: "playback", device: "standard", status: "blocked", reason });
describe("#2115 untrusted recent playback observations", () => {
  it("pins client/server closed reasons; no free-form diagnostic string is accepted", () => {
    expect(browser.EFFECT_BLOCK_REASONS).toEqual(EFFECT_BLOCK_REASONS);
    for (const reason of EFFECT_BLOCK_REASONS) expect(checkPlaybackObservation(blocked(reason))).toEqual(blocked(reason));
    for (const extra of [{ text: "secret" }, { url: "https://private" }, { viewers: 2 }, { person: "alice" }, { at: 0 }, { reason: "raw-private-code" }, { status: "healthy" }, { device: "Windows" }]) expect(checkPlaybackObservation({ ...blocked(), ...extra })).toBeNull();
    const getter = Object.defineProperty({ ...blocked() }, "reason", { get() { throw Error("must not read"); }, enumerable: true });
    expect(checkPlaybackObservation(getter)).toBeNull();
    expect(checkPlaybackObservation(Object.assign(Object.create({}), blocked()))).toBeNull();
    expect(checkPlaybackObservation({ ...blocked(), status: "playing", reason: null })).not.toBeNull();
    expect(checkPlaybackObservation({ ...blocked(), status: "playing" })).toBeNull();
  });
  it("reports some recent blocked reasons only, scoped to the instance/id, without counts, timestamps or device", () => {
    let now = 0; const store = new WebEffectPlayback(() => now);
    expect(store.record(reporter, "own", id, blocked())).toEqual({ ok: true });
    store.record("c".repeat(64), "own", id, blocked("save_data"));
    expect(store.summary("own", id)).toEqual({ status: "reported_blocked", reasons: ["reduced_motion", "save_data"] });
    expect(store.summary("other", id)).toEqual({ status: "unknown", reasons: [] });
    expect(store.record(reporter, "own", id, blocked("disabled"))).toEqual({ error: "profile_rate_limited" });
    now = 10000;
    expect(store.record(reporter, "own", id, { ...blocked(), status: "playing", reason: null })).toEqual({ ok: true });
    expect(store.summary("own", id).reasons).toEqual(["save_data"]);
    now = 300000; expect(store.summary("own", id)).toEqual({ status: "unknown", reasons: [] });
  });
  it("fails closed on a broken monotonic clock and bounds volatile storage", () => {
    let now = 100; const store = new WebEffectPlayback(() => now);
    store.record(reporter, "own", id, blocked()); now = 99; expect(store.summary("own", id).status).toBe("unknown");
    now = 100; expect(store.record(reporter, "own", id, blocked())).toEqual({ error: "profile_clock" });
    const cap = new WebEffectPlayback(() => 0);
    for (let i = 0; i < 1024; i++) expect(cap.record(i.toString(16).padStart(64, "0"), "own", id, blocked())).toEqual({ ok: true });
    expect(cap.record("f".repeat(64), "own", id, blocked())).toEqual({ error: "profile_rate_limited" });
  });
});
