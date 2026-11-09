/**
 * #3313 review r3: Daemon.startupCliEnded (a failed start's own cleanup: kill, then confirm; remembers the window and
 * its pane process when the end is not proven) and Daemon.startupIncarnationEnded (every later re-check: READ-ONLY —
 * a retry of the same agent may run in a window with the same id). Called on a stand-in `this`; tmux is never run.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import { TmuxManager } from "../src/tmux-manager.js";

afterEach(() => { vi.restoreAllMocks(); });

function fake(over: { windowId?: string | null; killConfirmed?: boolean | "throws"; pids?: Array<number | null | "throws"> } = {}) {
  const kills: string[] = [];
  const pids = [...(over.pids ?? [])];
  const self: any = {
    nativePaneLifecycle: null, tmuxSessionName: "agend",
    tmux: {
      getWindowId: () => over.windowId === undefined ? "@7" : over.windowId,
      killWindowConfirmed: async () => { kills.push("kill"); if (over.killConfirmed === "throws") throw new Error("tmux"); return over.killConfirmed ?? false; },
    },
    paneHost: { getPanePid: async () => { const v = pids.length ? pids.shift() : null; if (v === "throws") throw new Error("tmux"); return v; } },
  };
  return { self, kills, cleanup: () => (Daemon.prototype as any).startupCliEnded.call(self) as Promise<boolean>, recheck: () => (Daemon.prototype as any).startupIncarnationEnded.call(self) as Promise<boolean> };
}

describe("a failed start's own cleanup, then read-only re-checks", () => {
  it("confirmed gone at cleanup: ended, nothing remembered (a re-check says ended without listing)", async () => {
    const f = fake({ killConfirmed: true, pids: [4242] });
    const list = vi.spyOn(TmuxManager, "listWindowsStrict");
    expect(await f.cleanup()).toBe(true);
    expect(await f.recheck()).toBe(true);
    expect(list).not.toHaveBeenCalled();
  });
  it("not proven at cleanup: the same window still running the same pane process → not ended — and a re-check never kills", async () => {
    const f = fake({ pids: [4242, 4242] });
    vi.spyOn(TmuxManager, "listWindowsStrict").mockResolvedValue([{ id: "@7", name: "w" }]);
    expect(await f.cleanup()).toBe(false);
    expect(await f.recheck()).toBe(false);
    expect(f.kills).toEqual(["kill"]);                                     // only the start's own cleanup
  });
  it("a retry respawned into the same window id (a different pane process): the old one has ended — and the retry is never killed", async () => {
    const f = fake({ pids: [4242, 5151] });
    vi.spyOn(TmuxManager, "listWindowsStrict").mockResolvedValue([{ id: "@7", name: "retry" }]);
    expect(await f.cleanup()).toBe(false);
    expect(await f.recheck()).toBe(true);
    expect(f.kills).toEqual(["kill"]);
  });
  it("the window gone → ended; tmux cannot list, or the pane process cannot be read → not ended", async () => {
    const gone = fake({ pids: [4242] });
    vi.spyOn(TmuxManager, "listWindowsStrict").mockResolvedValueOnce([{ id: "@9", name: "other" }]);
    expect(await gone.cleanup()).toBe(false);
    expect(await gone.recheck()).toBe(true);
    const blind = fake({ pids: [4242] });
    vi.spyOn(TmuxManager, "listWindowsStrict").mockRejectedValueOnce(new Error("no server"));
    expect(await blind.cleanup()).toBe(false);
    expect(await blind.recheck()).toBe(false);
    const nopid = fake({ pids: [null] });
    vi.spyOn(TmuxManager, "listWindowsStrict").mockResolvedValueOnce([{ id: "@7", name: "w" }]);
    expect(await nopid.cleanup()).toBe(false);
    expect(await nopid.recheck()).toBe(false);
  });
  it("no window was ever asked for: ended at cleanup; a cleanup that could not confirm and never learned a window stays not ended", async () => {
    expect(await fake({ windowId: null, killConfirmed: true }).cleanup()).toBe(true);
    const f = fake({ windowId: null, killConfirmed: "throws" });
    expect(await f.cleanup()).toBe(false);
    expect(await f.recheck()).toBe(false);
  });
});
