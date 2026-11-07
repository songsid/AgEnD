/**
 * #3305 review P2-5: runQuiet — a deadline is a failure whatever happens after it (a late exit 0 included); SIGINT at
 * the deadline, SIGKILL after the grace period, and the promise settles at the latest a short while after SIGKILL.
 * An inert stand-in child; no executable runs.
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { runQuiet } from "../src/quiet-run.js";

function child(onKill: (sig: string, c: any) => void = () => {}) {
  const c: any = new EventEmitter(); c.signals = [] as string[];
  c.kill = (sig: string) => { c.signals.push(sig); onKill(sig, c); return true; };
  return c;
}
const opts = (c: any) => ({ timeoutMs: 20, graceMs: 20, killWaitMs: 20, spawn: () => c });

describe("runQuiet (#3305 review P2-5)", () => {
  it("an exit before the deadline is its code", async () => {
    const c = child(); const p = runQuiet("x", [], {}, opts(c)); setTimeout(() => c.emit("exit", 0), 5);
    expect(await p).toMatchObject({ code: 0 }); expect(c.signals).toEqual([]);
  });
  it("past the deadline it is a timeout, even if the child then exits 0", async () => {
    const c = child((sig, k) => { if (sig === "SIGINT") setTimeout(() => k.emit("exit", 0), 5); });
    expect(await runQuiet("x", [], {}, opts(c))).toMatchObject({ code: null, timedOut: true });
    expect(c.signals).toEqual(["SIGINT"]);
  });
  it("a child that ignores SIGINT gets SIGKILL; a child that never exits still settles", async () => {
    const stubborn = child((sig, k) => { if (sig === "SIGKILL") setTimeout(() => k.emit("exit", null), 5); });
    expect(await runQuiet("x", [], {}, opts(stubborn))).toMatchObject({ code: null, timedOut: true });
    expect(stubborn.signals).toEqual(["SIGINT", "SIGKILL"]);
    // #3305 r1: kills that fail and no exit — the answer is a bounded failure, but `gone` stays open until an exit is seen.
    const deaf = child(); deaf.kill = (sig: string) => { deaf.signals.push(sig); return false; };
    const r = await runQuiet("x", [], {}, opts(deaf));
    expect(r).toMatchObject({ code: null, timedOut: true });
    expect(deaf.signals).toEqual(["SIGINT", "SIGKILL"]);
    let isGone = false; void r.gone.then(() => { isGone = true; });
    await new Promise((res) => setTimeout(res, 30)); expect(isGone, "not gone until an exit is seen").toBe(false);
    deaf.emit("exit", null); await new Promise((res) => setTimeout(res, 1)); expect(isGone).toBe(true);
  });
  it("#3305 r2: an error on a started child (a kill that failed: EPERM) is not its end — `gone` waits for the exit", async () => {
    const c = child((sig, k) => { if (sig === "SIGINT") k.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" })); });
    c.pid = 4242;
    const r = await runQuiet("x", [], {}, opts(c));
    expect(r).toMatchObject({ code: null, timedOut: true });
    let isGone = false; void r.gone.then(() => { isGone = true; });
    await new Promise((res) => setTimeout(res, 40)); expect(isGone).toBe(false);
    expect(c.signals, "the escalation went on after the error").toEqual(["SIGINT", "SIGKILL"]);
    c.emit("exit", null); await new Promise((res) => setTimeout(res, 1)); expect(isGone).toBe(true);
  });
  it("not found or not started: a failure", async () => {
    const c = child(); const p = runQuiet("x", [], {}, opts(c)); setTimeout(() => c.emit("error", new Error("ENOENT")), 2);   // no pid: never started
    const nf = await p; expect(nf).toMatchObject({ code: null });
    let ok = false; await Promise.race([nf.gone.then(() => { ok = true; }), new Promise((res) => setTimeout(res, 20))]); expect(ok, "never started: gone").toBe(true);
    expect(await runQuiet("x", [], {}, { spawn: () => { throw new Error("spawn"); } })).toMatchObject({ code: null });
  });
});
