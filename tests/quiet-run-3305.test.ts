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
    expect(await p).toEqual({ code: 0 }); expect(c.signals).toEqual([]);
  });
  it("past the deadline it is a timeout, even if the child then exits 0", async () => {
    const c = child((sig, k) => { if (sig === "SIGINT") setTimeout(() => k.emit("exit", 0), 5); });
    expect(await runQuiet("x", [], {}, opts(c))).toEqual({ code: null, timedOut: true });
    expect(c.signals).toEqual(["SIGINT"]);
  });
  it("a child that ignores SIGINT gets SIGKILL; a child that never exits still settles", async () => {
    const stubborn = child((sig, k) => { if (sig === "SIGKILL") setTimeout(() => k.emit("exit", null), 5); });
    expect(await runQuiet("x", [], {}, opts(stubborn))).toEqual({ code: null, timedOut: true });
    expect(stubborn.signals).toEqual(["SIGINT", "SIGKILL"]);
    const deaf = child();
    expect(await runQuiet("x", [], {}, opts(deaf))).toEqual({ code: null, timedOut: true });
    expect(deaf.signals).toEqual(["SIGINT", "SIGKILL"]);
  });
  it("not found or not started: a failure", async () => {
    const c = child(); const p = runQuiet("x", [], {}, opts(c)); setTimeout(() => c.emit("error", new Error("ENOENT")), 2);
    expect(await p).toEqual({ code: null });
    expect(await runQuiet("x", [], {}, { spawn: () => { throw new Error("spawn"); } })).toEqual({ code: null });
  });
});
