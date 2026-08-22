import { describe, expect, it, vi } from "vitest";
import { LoginSession, type LoginTmux, type LoginSessionEvents } from "../src/login-manager.js";
import { LOGIN_FLOWS, type LoginFlow } from "../src/login-flows.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;

function fakeTmux(overrides: Partial<LoginTmux> = {}): LoginTmux & { keys: string[]; pasted: string[]; killed: () => boolean } {
  let killed = false;
  const keys: string[] = [];
  const pasted: string[] = [];
  return {
    keys,
    pasted,
    killed: () => killed,
    createWindow: vi.fn(async () => "@9"),
    setRemainOnExit: vi.fn(async () => {}),
    capturePaneJoined: vi.fn(async () => ""),
    getPaneStatus: vi.fn(async () => ({ alive: true })),
    killWindow: vi.fn(async () => { killed = true; }),
    sendSpecialKey: vi.fn(async (key: string) => { keys.push(key); return true; }),
    pasteText: vi.fn(async (text: string) => { pasted.push(text); return true; }),
    ...overrides,
  };
}

function events(overrides: Partial<LoginSessionEvents> = {}): LoginSessionEvents & {
  menus: string[][]; hints: Array<{ url: string; code: string | null }>; inputs: string[]; done: Array<{ ok: boolean; detail: string }>;
} {
  const menus: string[][] = [];
  const hints: Array<{ url: string; code: string | null }> = [];
  const inputs: string[] = [];
  const done: Array<{ ok: boolean; detail: string }> = [];
  return {
    menus, hints, inputs, done,
    onMenu: (options) => { menus.push(options); },
    onAuthHint: (url, code) => { hints.push({ url, code }); },
    onNeedInput: (prompt) => { inputs.push(prompt); },
    onDone: (result) => { done.push(result); },
    ...overrides,
  };
}

function session(flow: LoginFlow, tmux: LoginTmux, ev: LoginSessionEvents): LoginSession {
  return new LoginSession(flow, tmux, ev, silentLogger, 5);
}

describe("LoginSession", () => {
  it("posts the auth hint exactly once and finishes on the success pattern", async () => {
    const panes = [
      "starting device flow…",
      "Go to https://auth.example/device and enter code: WXYZ-7890",
      "Go to https://auth.example/device and enter code: WXYZ-7890",
      "Login successful!",
    ];
    let call = 0;
    const tmux = fakeTmux({ capturePaneJoined: vi.fn(async () => panes[Math.min(call++, panes.length - 1)]) });
    const ev = events();
    const s = session(LOGIN_FLOWS["grok"], tmux, ev);
    await s.start();
    await vi.waitFor(() => expect(ev.done).toHaveLength(1));
    expect(ev.hints).toEqual([{ url: "https://auth.example/device", code: "WXYZ-7890" }]);
    expect(ev.done[0]).toEqual({ ok: true, detail: "success" });
    expect(tmux.killed()).toBe(true);
    expect(s.state).toBe("done");
  });

  it("drives the kiro selector: menu event once, Down×N + Enter on selection", async () => {
    let pane = "? Select login method ›\n  Builder ID\n  Google\n  GitHub\n  Your Organization";
    const tmux = fakeTmux({ capturePaneJoined: vi.fn(async () => pane) });
    const ev = events();
    const s = session(LOGIN_FLOWS["kiro-cli"], tmux, ev);
    await s.start();
    await vi.waitFor(() => expect(ev.menus).toHaveLength(1));
    expect(s.state).toBe("menu");

    expect(await s.selectMenuOption(9)).toBe(false); // out of range
    expect(await s.selectMenuOption(2)).toBe(true);  // GitHub
    expect(tmux.keys).toEqual(["Down", "Down", "Enter"]);
    expect(s.state).toBe("waiting");

    pane = "Logged in successfully";
    await vi.waitFor(() => expect(ev.done).toHaveLength(1));
    expect(ev.done[0].ok).toBe(true);
    // Menu event never repeats even though the prompt stayed on screen.
    expect(ev.menus).toHaveLength(1);
  });

  it("notifies once per distinct input prompt and pastes submitted text", async () => {
    let pane = "Enter Start URL ›";
    const tmux = fakeTmux({ capturePaneJoined: vi.fn(async () => pane) });
    const ev = events();
    const s = session(LOGIN_FLOWS["kiro-cli"], tmux, ev);
    await s.start();
    await vi.waitFor(() => expect(ev.inputs).toEqual(["Enter Start URL"]));
    expect(s.state).toBe("input");

    expect(await s.submitInput("https://corp.awsapps.com/start")).toBe(true);
    expect(tmux.pasted).toEqual(["https://corp.awsapps.com/start"]);
    expect(s.state).toBe("waiting");

    pane = "Enter Region ›";
    await vi.waitFor(() => expect(ev.inputs).toEqual(["Enter Start URL", "Enter Region"]));

    pane = "Logged in with IAM Identity Center";
    await vi.waitFor(() => expect(ev.done).toHaveLength(1));
    expect(ev.done[0].ok).toBe(true);
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

  it("cancel kills the window, reports cancelled, and blocks later input", async () => {
    const tmux = fakeTmux();
    const ev = events();
    const s = session(LOGIN_FLOWS["claude-code"], tmux, ev);
    await s.start();
    await s.cancel();
    expect(ev.done).toEqual([{ ok: false, detail: "cancelled" }]);
    expect(tmux.killed()).toBe(true);
    expect(await s.submitInput("late")).toBe(false);
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
