/**
 * #2198: custom CSS General saved went back before the person could answer — the 20 s keep window ran from the save,
 * while the person's "keep it" came back through a ~40 s chat round trip. The window is a dead-man switch for CSS that
 * hides its own Keep button (decision a94a1bab: that is the threat), so it now starts when a person's page shows the
 * trial; an agent's save waits for that (up to 10 minutes) and, never shown, goes back without having been on a screen.
 * An agent's keep also puts back the one that just expired, if a page had shown it (as `use` of it). A person's own
 * trial, saved on their page, is as before. The store on its own, on its own clock.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OWNER_CSS_AGENT_WAIT_MS, OWNER_CSS_KEEP_MS, OwnerCssStore } from "../src/web-owner-css-store.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const P = "person:discord:1";
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "agend-2198-")); dirs.push(dir);
  const active = new Map<string, string | null>();
  let now = 5_000_000;
  const s = new OwnerCssStore(dir, {
    ownerCssActive: (p) => active.get(p) ?? null,
    setOwnerCss: (p, c) => { if (c.active !== undefined) active.set(p, c.active); return { ok: true }; },
  }, () => now);
  return { s, tick: (ms: number) => { now += ms; }, active: () => active.get(P) ?? null };
}
const A = "body { outline: 2px solid #ff0000 }", B = "body { outline: 3px dashed #00ff00 }";

describe("#2198: an agent's custom CSS trial", () => {
  it("saved, shown, kept: it waits (unseen) well past 20 s, its window starts when a page shows it, and the keep holds", () => {
    const { s, tick, active } = rig();
    const saved = s.save(P, A, { by: "agent" }); if (!saved.ok) throw new Error(saved.error);
    expect(s.state(P).pending).toMatchObject({ id: saved.trial, waiting: true });
    tick(5 * 60_000);                                                   // nobody has the dashboard open for 5 minutes
    expect(s.state(P).pending).toMatchObject({ id: saved.trial, waiting: true });
    expect(s.shown(P, saved.trial)).toEqual({ ok: true, remaining_ms: OWNER_CSS_KEEP_MS, started: true });
    expect(s.state(P).pending?.waiting).toBeUndefined();
    expect(s.shown(P, saved.trial)).toMatchObject({ ok: true, started: false });   // a second page: the same window
    tick(15_000);                                                       // they say "keep it" in chat, General keeps
    expect(s.keepForAgent(P, saved.trial)).toEqual({ ok: true, active: saved.sha, restored: false });
    expect([s.state(P).pending, active()]).toEqual([null, saved.sha]);
  });
  it("saved, shown, gone back after 20 s, then kept (the ~40 s round trip): put back in force, as use of it", () => {
    const { s, tick, active } = rig();
    const before = s.save(P, B); if (!before.ok) throw new Error(before.error); s.keep(P, before.trial);
    const saved = s.save(P, A, { by: "agent" }); if (!saved.ok) throw new Error(saved.error);
    tick(2_000); s.shown(P, saved.trial);
    tick(OWNER_CSS_KEEP_MS + 1);
    expect([s.state(P).pending, active()]).toEqual([null, before.sha]);     // the dead-man switch did its job
    tick(20_000);
    expect(s.keepForAgent(P, saved.trial)).toEqual({ ok: true, active: saved.sha, restored: true });
    expect([s.state(P).pending, active()]).toEqual([null, saved.sha]);
    expect(s.keepForAgent(P, saved.trial), "once: then it is simply in force").toMatchObject({ ok: false, error: "not_on_trial" });
  });
  it("saved and never shown: it goes back at the wait's end, and a keep then does not put it in force (nobody saw it)", () => {
    const { s, tick, active } = rig();
    const saved = s.save(P, A, { by: "agent" }); if (!saved.ok) throw new Error(saved.error);
    tick(OWNER_CSS_AGENT_WAIT_MS - 1);
    expect(s.state(P).pending?.id).toBe(saved.trial);
    tick(2);
    expect([s.state(P).pending, active()]).toEqual([null, null]);
    expect(s.keepForAgent(P, saved.trial)).toMatchObject({ ok: false, error: "not_on_trial" });
    expect(active()).toBeNull();
  });
  it("reverted on purpose (Revert): not kept back", () => {
    const { s, tick } = rig();
    const saved = s.save(P, A, { by: "agent" }); if (!saved.ok) throw new Error(saved.error);
    s.shown(P, saved.trial); tick(5_000);
    expect(s.revertTrial(P, saved.trial)).toMatchObject({ ok: true, active: null });
    expect(s.keepForAgent(P, saved.trial)).toMatchObject({ ok: false, error: "not_on_trial" });
  });
  it("an expired one is kept back only within the window, and only while its version is still saved", () => {
    const { s, tick, active } = rig();
    const saved = s.save(P, A, { by: "agent" }); if (!saved.ok) throw new Error(saved.error);
    s.shown(P, saved.trial); tick(OWNER_CSS_KEEP_MS + 1); expect(s.state(P).pending).toBeNull();
    tick(OWNER_CSS_AGENT_WAIT_MS + 1);
    expect(s.keepForAgent(P, saved.trial)).toMatchObject({ ok: false, error: "not_on_trial" });
    expect(active()).toBeNull();
  });
  it("a person's own trial (saved on their page) is as before: 20 s from the save, no wait, shown() changes nothing", () => {
    const { s, tick, active } = rig();
    const saved = s.save(P, A); if (!saved.ok) throw new Error(saved.error);
    expect(s.state(P).pending?.waiting).toBeUndefined();
    expect(s.shown(P, saved.trial)).toMatchObject({ ok: true, started: false });
    tick(OWNER_CSS_KEEP_MS + 1);
    expect([s.state(P).pending, active()]).toEqual([null, null]);
    expect(s.keep(P, saved.trial)).toMatchObject({ ok: false, error: "not_on_trial" });
  });
  it("follow-up: keep names its trial — a newer trial on now (saved on their page since) is refused, never kept instead", () => {
    const { s, tick, active } = rig();
    const saved = s.save(P, A, { by: "agent" }); if (!saved.ok) throw new Error(saved.error);
    s.shown(P, saved.trial); tick(5_000);
    const mine = s.save(P, B); if (!mine.ok) throw new Error(mine.error);              // the person saves another on their page
    expect(s.keepForAgent(P, saved.trial)).toMatchObject({ ok: false, status: 409, error: "trial_mismatch" });
    expect(s.state(P).pending?.id, "theirs is still on trial, untouched").toBe(mine.trial);
    expect(active(), "theirs is what is on the page").toBe(mine.sha);
    // Gone back by itself: General's keep does not revive its own over theirs either (theirs is the last trial).
    tick(OWNER_CSS_KEEP_MS + 1);
    expect(s.keepForAgent(P, saved.trial)).toMatchObject({ ok: false, error: "not_on_trial" });
    expect(active()).toBeNull();
    expect(s.keepForAgent(P, "x")).toMatchObject({ ok: false, status: 400, error: "trial" });
    expect(s.keepForAgent(P, undefined)).toMatchObject({ ok: false, status: 400, error: "trial" });
  });
  it("shown() names its trial: another id, a malformed one, or none on trial is refused", () => {
    const { s } = rig();
    expect(s.shown(P, "x")).toMatchObject({ ok: false, error: "trial" });
    expect(s.shown(P, "a".repeat(32))).toMatchObject({ ok: false, error: "not_on_trial" });
    const saved = s.save(P, A, { by: "agent" }); if (!saved.ok) throw new Error(saved.error);
    expect(s.shown(P, "a".repeat(32))).toMatchObject({ ok: false, error: "not_on_trial" });
    expect(s.state(P).pending?.waiting).toBe(true);
  });
});
