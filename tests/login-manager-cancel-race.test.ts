import { describe, expect, it, vi } from "vitest";
import { LoginSession, type LoginTmux } from "../src/login-manager.js";
import type { LoginFlow } from "../src/login-flows.js";

/**
 * sol (PR-B round 3, B1): cancel() racing an in-flight createWindow() used to
 * kill nothing (the window did not exist yet) and then let the window be
 * created — an owner-less login window after the session was "done".
 * start() must re-check at the resource boundary and remove it.
 */
function harness() {
  let releaseCreate!: () => void;
  const created = new Promise<void>(r => { releaseCreate = r; });
  let alive = false;
  const kills: number[] = [];
  const tmux: LoginTmux = {
    async createWindow() { await created; alive = true; return "@1"; },
    async setRemainOnExit() {},
    async capturePaneJoined() { return ""; },
    async getPaneStatus() { return { alive }; },
    async killWindow() { kills.push(Date.now()); alive = false; },
    async sendSpecialKey() { return true; },
    async pasteText() { return true; },
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
  it("a window created after cancel() is removed by start() itself; no live window remains", async () => {
    const h = harness();
    const starting = h.session.start();                 // parked inside createWindow
    await h.session.cancel("cancelled");                // kills nothing yet — the window does not exist
    expect(h.kills).toHaveLength(1);
    expect(h.done).toHaveLength(1);
    h.releaseCreate();                                  // tmux now creates the window
    await starting;
    expect(h.kills).toHaveLength(2);                    // start() noticed `finished` and killed the late window
    expect(h.isAlive()).toBe(false);
    expect(h.session.state).toBe("done");
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
