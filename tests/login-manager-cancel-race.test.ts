import { describe, expect, it, vi } from "vitest";
import { LoginSession, type LoginTmux } from "../src/login-manager.js";
import type { LoginFlow } from "../src/login-flows.js";

/**
 * sol (PR-B round 3, B1): cancel() racing an in-flight createWindow() used to
 * kill nothing (the window did not exist yet) and then let the window be
 * created — an owner-less login window after the session was "done".
 * start() must re-check at the resource boundary and remove it.
 */
function harness(opts: { confirmable?: boolean; killFails?: boolean } = {}) {
  let releaseCreate!: () => void;
  const created = new Promise<void>(r => { releaseCreate = r; });
  let alive = false;
  const kills: number[] = [];
  const tmux: LoginTmux = {
    async createWindow() { await created; alive = true; return "@1"; },
    async setRemainOnExit() {},
    async capturePaneJoined() { return ""; },
    async getPaneStatus() { return { alive }; },
    async killWindow() { kills.push(Date.now()); if (!opts.killFails) alive = false; },   // production killWindow swallows errors
    async sendSpecialKey() { return true; },
    async pasteText() { return true; },
    ...(opts.confirmable ? { async killWindowConfirmed() { kills.push(Date.now()); if (!opts.killFails) alive = false; return !alive; } } : {}),
  };
  const flow: LoginFlow = { backend: "codex", command: "codex login --device-auth", successPattern: /never/, timeoutMs: 60_000 };
  const done: unknown[] = [];
  const session = new LoginSession(flow, tmux, {
    onMenu: () => {}, onAuthHint: () => {}, onNeedInput: () => {},
    onDone: r => { done.push(r); },
  }, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, 50);
  return { session, releaseCreate, isAlive: () => alive, kills, done };
}

describe("LoginSession cancel racing createWindow", () => {
  it("cancel() waits for the in-flight createWindow, then kills once; no live window remains and start arms nothing", async () => {
    const h = harness();
    const starting = h.session.start();                 // parked inside createWindow
    let settled = false;
    const cancelling = h.session.cancel("cancelled").then(() => { settled = true; });
    await new Promise(r => setTimeout(r, 30));
    expect(settled).toBe(false);                        // not "done" while the window may still appear
    expect(h.kills).toHaveLength(0);
    h.releaseCreate();                                  // tmux now creates the window
    await cancelling;
    await starting;
    expect(h.kills).toHaveLength(1);                    // one kill, after the window exists
    expect(h.isAlive()).toBe(false);
    expect(h.done).toHaveLength(1);
    expect((h.done[0] as { cleanupFailed?: boolean }).cleanupFailed).toBeUndefined();
    expect(h.session.state).toBe("done");
  });

  it("M1: with a confirmable kill, a window that cannot be removed is reported as cleanupFailed — not silent success", async () => {
    const h = harness({ confirmable: true, killFails: true });
    const starting = h.session.start();
    const cancelling = h.session.cancel("cancelled");
    h.releaseCreate();
    await cancelling;
    await starting;
    expect(h.isAlive()).toBe(true);
    expect((h.done[0] as { cleanupFailed?: boolean }).cleanupFailed).toBe(true);
  });

  it("the normal path is unchanged: start completes, cancel kills once", async () => {
    const h = harness();
    const starting = h.session.start();
    h.releaseCreate();
    await starting;
    expect(h.isAlive()).toBe(true);
    await h.session.cancel("cancelled");
    expect(h.kills).toHaveLength(1);
    expect(h.isAlive()).toBe(false);
  });
});
