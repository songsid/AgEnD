/**
 * #2193 (Fable r1 P2): in a chat with no placements and a person with no personal effect, a Try card is the only thing
 * that wakes the sleeping effects runtime. Rendered while asleep, the offer asks the waker to start it and says
 * "checking"; once the runtime runs, the card is drawn again with the runtime's own status. The real Chat page modules
 * in the mini DOM; the runtime module is a stub (its own suites cover it).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { settle } from "./helpers/mini-dom.js";
import type { AppPage } from "./helpers/app-harness.js";

const M = vi.hoisted(() => ({ starts: 0, status: "ready" as string, trialFns: [] as Array<() => void>, owner: null as any }));
vi.mock("/ui/js/app-effects.js", () => ({
  startAppEffects: () => {
    M.starts++;
    M.owner = { dead: false, api: { ok: true }, trialStatus: () => M.status, trialFailure: () => null, canTry: () => M.status === "ready",
      subscribeTrial: (fn: () => void) => { M.trialFns.push(fn); return () => {}; }, onEnd: () => () => {}, gates: () => ({}), attachChat: () => ({ ok: false }) };
    return M.owner;
  },
  getAppEffects: () => M.owner,
}));

const pages: AppPage[] = [];
afterEach(async () => { for (const pg of pages.splice(0)) { await pg.unmount(); pg.restore(); } M.starts = 0; M.status = "ready"; M.trialFns.length = 0; M.owner = null; });

function fakeStream() {
  const subs = new Map<string, Array<(d: any) => void>>();
  return { on(name: string, fn: (d: any) => void) { subs.set(name, [...(subs.get(name) ?? []), fn]); return () => {}; },
    emit(name: string, d: any) { for (const fn of subs.get(name) ?? []) fn(d); } };
}
async function chatPage() {
  vi.resetModules();
  const harness = await import("./helpers/app-harness.js");
  const p = harness.page(); pages.push(p);
  const app = await import("/assets/app-store.js");
  const panel = await import("/ui/js/panel-chat.js");
  const stream = fakeStream();
  stream.on("status", app.applyStatus);
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ messages: [] }) });
  panel.boot({ stream, boot: null, deps: { fetch, toast: () => {}, setTimeout: () => 1 } });
  const mount = (name: string) => p.mount(harness.h("main", { id: "main" }, harness.h(panel.ChatPanel, { route: { panel: "chat", instance: name }, navKey: `chat|${name}` })));
  return { p, stream, mount };
}
const offer = (n: number) => ({ boot: "b", id: n, instance: "w", sender: "agend", role: "status", text: "", ts: "2026-01-01T00:00:00Z",
  effectTrial: { v: 1, offer: "c".repeat(32), id: "d".repeat(32), title: "Snowfall", expiresAt: Date.now() + 600_000 } });
const card = (c: { p: AppPage }) => (c.p.root.querySelector(".effect-trial-offer")?.textContent ?? "").replace(/\s+/g, " ");

describe("#2193: a Try card wakes the sleeping effects runtime", () => {
  it("asleep, the offer says it is checking and starts the runtime; awake, the card is drawn with the runtime's status", async () => {
    const c = await chatPage();
    c.stream.emit("status", { uptime: 1, instances: [{ name: "w", status: "running", state: "idle", backend: "claude-code" }] });   // no placements
    await c.mount("w"); await settle();
    expect(M.starts, "nothing to play yet: asleep").toBe(0);
    c.stream.emit("message", offer(5));
    await settle();
    // Drawn at least once while asleep: "checking", and the waker was asked.
    for (let i = 0; i < 5 && M.starts === 0; i++) await settle();
    expect(M.starts, "the offer woke it, once").toBe(1);
    for (let i = 0; i < 5; i++) await settle();
    expect(card(c)).toContain("A sample on this page");                    // the runtime's "ready", not "checking"
    expect(card(c)).not.toContain("Checking this session");
    expect(c.p.root.querySelector(".effect-trial-offer button.effect-trial-start")).not.toBeNull();
    // Its later changes reach the card (the thread follows the runtime's trial updates from the wake on).
    M.status = "inactive"; for (const fn of M.trialFns) fn(); await settle();
    expect(card(c)).not.toContain("A sample on this page");
  });
  it("before the runtime answers, the card says checking (never a Try button)", async () => {
    const c = await chatPage();
    c.stream.emit("status", { uptime: 1, instances: [{ name: "w", status: "running", state: "idle", backend: "claude-code" }] });
    await c.mount("w"); await settle();
    c.stream.emit("message", offer(6));
    // The first draw, synchronously after the message: the runtime's import has not resolved yet.
    expect(card(c)).toContain("Checking this session");
    expect(c.p.root.querySelector(".effect-trial-offer button.effect-trial-start")).toBeNull();
  });
});
