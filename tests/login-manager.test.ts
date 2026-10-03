import { describe, expect, it, vi } from "vitest";
import { LoginSession, type LoginTmux, type LoginSessionEvents } from "../src/login-manager.js";
import { LOGIN_FLOWS, type LoginFlow } from "../src/login-flows.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;

function fakeTmux(overrides: Partial<LoginTmux> = {}): LoginTmux & { killed: () => boolean } {
  let killed = false;
  return {
    killed: () => killed,
    createWindow: vi.fn(async () => "@9"),
    setRemainOnExit: vi.fn(async () => {}),
    capturePaneJoined: vi.fn(async () => ""),
    getPaneStatus: vi.fn(async () => ({ alive: true })),
    killWindow: vi.fn(async () => { killed = true; }),
    ...overrides,
  };
}

function events(overrides: Partial<LoginSessionEvents> = {}): LoginSessionEvents & {
  done: Array<{ ok: boolean; detail: string }>;
} {
  const done: Array<{ ok: boolean; detail: string }> = [];
  return {
    done,
    onDone: (result) => { done.push(result); },
    ...overrides,
  };
}

function session(flow: LoginFlow, tmux: LoginTmux, ev: LoginSessionEvents): LoginSession {
  return new LoginSession(flow, tmux, ev, silentLogger, 5);
}

describe("LoginSession (a command run in a dedicated window — today the CLI installers)", () => {
  it("finishes on the success pattern, once, and removes the window", async () => {
    let pane = "downloading…";
    const tmux = fakeTmux({ capturePaneJoined: vi.fn(async () => pane) });
    const ev = events();
    const s = session(LOGIN_FLOWS["codex"], tmux, ev);
    await s.start();
    expect(s.state).toBe("starting");
    pane = "Successfully logged in.";
    await vi.waitFor(() => expect(ev.done).toHaveLength(1));
    expect(ev.done[0]).toEqual({ ok: true, detail: "success" });
    expect(tmux.killed()).toBe(true);
    expect(s.state).toBe("done");
  });

  it("what the pane shows besides the verdict is nobody's business: URLs, menus and prompts raise nothing", async () => {
    const pane = "? Select login method ›\n  Builder ID\nEnter Start URL ›\nhttps://auth.openai.com/codex/device\nABCD-1234\n";
    const capture = vi.fn(async () => pane);
    const tmux = fakeTmux({ capturePaneJoined: capture });
    const ev = events();
    const s = session(LOGIN_FLOWS["kiro-cli"], tmux, ev);
    await s.start();
    await vi.waitFor(() => expect(capture.mock.calls.length).toBeGreaterThan(3));
    expect(ev.done).toEqual([]);
    expect(s.state).toBe("starting");
    await s.cancel();
  });

  it("treats a clean CLI exit as success and a non-zero exit as failure with evidence", async () => {
    for (const [exitCode, ok] of [[0, true], [1, false]] as const) {
      const tmux = fakeTmux({
        capturePaneJoined: vi.fn(async () => "some closing output"),
        getPaneStatus: vi.fn(async () => ({ alive: false, exitCode })),
      });
      const ev = events();
      const s = session(LOGIN_FLOWS["codex"], tmux, ev);
      await s.start();
      await vi.waitFor(() => expect(ev.done).toHaveLength(1));
      expect(ev.done[0].ok).toBe(ok);
      if (!ok) expect(ev.done[0].detail).toContain("exited with code 1");
      expect(tmux.killed()).toBe(true);
    }
  });

  it("cancel kills the window and reports cancelled", async () => {
    const tmux = fakeTmux();
    const ev = events();
    const s = session(LOGIN_FLOWS["claude-code"], tmux, ev);
    await s.start();
    await s.cancel();
    expect(ev.done).toEqual([{ ok: false, detail: "cancelled" }]);
    expect(tmux.killed()).toBe(true);
    // finish() is idempotent — a racing poll cannot double-report.
    await s.cancel();
    expect(ev.done).toHaveLength(1);
  });

  it("times out via the flow timeout", async () => {
    const tmux = fakeTmux();
    const ev = events();
    const flow = { ...LOGIN_FLOWS["codex"], timeoutMs: 20 };
    const s = session(flow, tmux, ev);
    await s.start();
    await vi.waitFor(() => expect(ev.done).toHaveLength(1));
    expect(ev.done[0]).toEqual({ ok: false, detail: "timeout" });
    expect(tmux.killed()).toBe(true);
  });
});
