/**
 * M-2457 C-4 §5: the first start on AgEnD's own tmux tells an UPGRADED home, once, that `tmux attach` no longer shows the
 * agents. A fresh home (no migration journal: no 2.3 window ids were ever found) is marked done without a notice (Fable
 * #3312 N3); a notice that could not be dispatched (no place to post yet) is tried again on the next start.
 * Isolation: a scratch AGEND_HOME; notifyFleetError is stubbed (nothing is posted anywhere).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function home(upgraded: boolean): string {
  const h = mkdtempSync(join(tmpdir(), "agend-owntmux-")); roots.push(h);
  vi.stubEnv("AGEND_HOME", h);
  if (upgraded) writeFileSync(join(h, "tmux-migration.json"), JSON.stringify({ server: null, windows: {}, released: {}, pending: { dev: "@3" } }));
  return h;
}
const marker = (h: string) => join(h, "tmux", "own-server-announced");

describe("the own-tmux notice", () => {
  it("a fresh home: no notice, and it is marked so it is never sent later", () => {
    const h = home(false);
    const fm = new FleetManager(h);
    const notify = vi.spyOn(fm, "notifyFleetError").mockReturnValue(true);
    fm.announceOwnTmux();
    expect(notify).not.toHaveBeenCalled();
    expect(existsSync(marker(h))).toBe(true);
  });

  it("an upgraded home: one notice, then never again", () => {
    const h = home(true);
    const fm = new FleetManager(h);
    const notify = vi.spyOn(fm, "notifyFleetError").mockReturnValue(true);
    fm.announceOwnTmux();
    fm.announceOwnTmux();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0]![0])).toMatch(/View panel/);
    expect(notify.mock.calls[0]![1]).toEqual({ throttle: false });
    expect(existsSync(marker(h))).toBe(true);
  });

  it("an upgraded home with nowhere to post yet: not marked, so the next start tries again", () => {
    const h = home(true);
    const fm = new FleetManager(h);
    const notify = vi.spyOn(fm, "notifyFleetError").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fm.announceOwnTmux();
    expect(existsSync(marker(h))).toBe(false);
    fm.announceOwnTmux();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(existsSync(marker(h))).toBe(true);
  });
});

// Fable #3312 N3: a cleanly stopped 2.3 fleet deletes its window ids at stop, so the normal update path (stop, install,
// start) leaves no migration journal. The evidence is agent state from before this start with no AgEnD tmux record.
describe("which home is an upgraded one (decided at fleet start, before any agent of this start writes)", () => {
  const agent = (h: string, name: string, files: string[]) => { const d = join(h, "instances", name); mkdirSync(d, { recursive: true }); for (const f of files) writeFileSync(join(d, f), "x"); };
  it("a cleanly stopped 2.3 home (output log and session id, no window-id, no server.json): upgraded → the notice", () => {
    const h = home(false);
    agent(h, "dev", ["output.log", "session-id"]);
    expect(FleetManager.ownTmuxUpgraded(h, null)).toBe(true);
    const fm = new FleetManager(h);
    fm.ownTmuxUpgradedHome = FleetManager.ownTmuxUpgraded(h, null);
    const notify = vi.spyOn(fm, "notifyFleetError").mockReturnValue(true);
    fm.announceOwnTmux();
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it("a fresh home (instance directories, nothing from an earlier start): not upgraded → no notice", () => {
    const h = home(false);
    agent(h, "dev", []);
    expect(FleetManager.ownTmuxUpgraded(h, null)).toBe(false);
    const fm = new FleetManager(h);
    fm.ownTmuxUpgradedHome = FleetManager.ownTmuxUpgraded(h, null);
    const notify = vi.spyOn(fm, "notifyFleetError").mockReturnValue(true);
    fm.announceOwnTmux();
    expect(notify).not.toHaveBeenCalled();
    expect(existsSync(marker(h))).toBe(true);
  });
  it("a home that already ran AgEnD's own tmux (server.json recorded): not an upgrade", () => {
    const h = home(false);
    agent(h, "dev", ["output.log", "session-id"]);
    expect(FleetManager.ownTmuxUpgraded(h, { socket: "agend", serverPid: 1 })).toBe(false);
  });
});

// alpha.6 leg M (real Mac): the first start on the own tmux records server.json at once, but posts the notice only after
// its startup batch. A restart in between (a slow first start) read the recorded server as "not an upgrade" and marked
// the notice done unsent. The decision is now persisted before the record; only a dispatch clears it.
describe("a restart during a slow first start", () => {
  const agent = (h: string, name: string, files: string[]) => { const d = join(h, "instances", name); mkdirSync(d, { recursive: true }); for (const f of files) writeFileSync(join(d, f), "x"); };
  const pending = (h: string) => FleetManager.ownTmuxPendingPath(h);
  const recorded = { socket: "agend", serverPid: 4242 };
  // fleet start's own call (before it records server.json)
  const start = (h: string, previous: unknown) => {
    const fm = new FleetManager(h);
    fm.ownTmuxUpgradedHome = FleetManager.ownTmuxStartDecision(h, previous);
    return fm;
  };

  it("still sends the notice once, on the start after the restart", () => {
    const h = home(false);
    agent(h, "dev", ["output.log", "session-id"]);           // a cleanly stopped 2.3 home: no journal
    const first = start(h, null);                            // server.json not yet recorded
    const n1 = vi.spyOn(first, "notifyFleetError").mockReturnValue(true);
    expect(existsSync(pending(h))).toBe(true);               // persisted before the record
    // …the first start records server.json, then is restarted before its batch completes: no announceOwnTmux()
    const second = start(h, recorded);                       // the restarted start sees the recorded server
    expect(second.ownTmuxUpgradedHome).toBe(false);
    const n2 = vi.spyOn(second, "notifyFleetError").mockReturnValue(true);
    second.announceOwnTmux();
    expect(n1).not.toHaveBeenCalled();
    expect(n2).toHaveBeenCalledTimes(1);
    expect(existsSync(marker(h))).toBe(true);
    expect(existsSync(pending(h))).toBe(false);              // only a dispatch clears it
    const third = start(h, recorded);
    const n3 = vi.spyOn(third, "notifyFleetError").mockReturnValue(true);
    third.announceOwnTmux();
    expect(n3).not.toHaveBeenCalled();
  });

  it("nowhere to post after the restart: the pending notice stays until a dispatch", () => {
    const h = home(false);
    agent(h, "dev", ["output.log", "session-id"]);
    start(h, null);
    const second = start(h, recorded);
    const n2 = vi.spyOn(second, "notifyFleetError").mockReturnValue(false);
    second.announceOwnTmux();
    expect(n2).toHaveBeenCalledTimes(1);
    expect(existsSync(pending(h))).toBe(true);
    expect(existsSync(marker(h))).toBe(false);
    const third = start(h, recorded);
    const n3 = vi.spyOn(third, "notifyFleetError").mockReturnValue(true);
    third.announceOwnTmux();
    expect(n3).toHaveBeenCalledTimes(1);
    expect(existsSync(pending(h))).toBe(false);
  });

  it("a home whose notice was already posted owes nothing new", () => {
    const h = home(false);
    agent(h, "dev", ["output.log", "session-id"]);
    mkdirSync(join(h, "tmux"), { recursive: true }); writeFileSync(marker(h), "x");
    start(h, null);
    expect(existsSync(pending(h))).toBe(false);
  });
});
