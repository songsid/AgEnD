/**
 * AGEND-133 (upstream #3521): the dashboard's Install button — what the page sees (src/web-host-install.ts).
 * - Only a local admin starts one; the CLI must be one the registry installs; a refusal leaves what was shown before as it was.
 * - Progress is the installer's last lines (ANSI stripped, secrets masked, tmux's dead-pane line gone); the verdict is the phase, the exit code of a failed
 *   installer, and the version of a verified one. A cancel and a timeout are their own phases.
 * - An ended run is kept ten minutes.
 */
import { describe, expect, it, vi } from "vitest";
import { WEB_INSTALL_KEEP_ENDED_MS, WebHostInstalls, exitCodeOf, installLines, type HostInstallReporter, type HostInstallStart } from "../src/web-host-install.js";

const WHO = { handle: "aaaaaaaaaaaaaaaa", label: "Firefox on Linux" };
function make(over: { start?: (backend: string, r: HostInstallReporter, mode?: string) => Promise<HostInstallStart>; admin?: boolean; installable?: (b: string) => boolean } = {}) {
  let clock = 1_000;
  const reporters: HostInstallReporter[] = [];
  const changed = vi.fn();
  const cancel = vi.fn(async () => true);
  const start = vi.fn(over.start ?? (async (_b: string, r: HostInstallReporter) => { reporters.push(r); return { started: true } as const; }));
  const installs = new WebHostInstalls({
    isLocalAdmin: () => over.admin !== false, installable: over.installable ?? (b => ["codex", "grok", "claude-code"].includes(b)),
    start, cancel, changed, now: () => clock,
  });
  return { installs, reporters, changed, cancel, start, tick: (ms: number) => { clock += ms; } };
}

describe("who and what", () => {
  it("a session that is not a local admin starts nothing (the route checks too; this is the second look)", async () => {
    const t = make({ admin: false });
    expect(await t.installs.begin(WHO, "codex")).toEqual({ error: "not_allowed" });
    expect(t.start).not.toHaveBeenCalled();
    expect(t.installs.view()).toBeNull();
  });
  it("a CLI the registry has no install for is refused before anything runs", async () => {
    const t = make();
    expect(await t.installs.begin(WHO, "opencode")).toEqual({ error: "unsupported" });
    expect(await t.installs.begin(WHO, "rm -rf /")).toEqual({ error: "unsupported" });
    expect(t.start).not.toHaveBeenCalled();
  });
  it("only the CLI's id reaches the fleet: the start is given the id and a reporter, nothing else", async () => {
    const t = make();
    await t.installs.begin(WHO, "codex");
    expect(t.start).toHaveBeenCalledTimes(1);
    // The id, the reporter and the mode (AGEND-136: "install" here); nothing the browser could have sent.
    expect(t.start.mock.calls[0]!.length).toBe(3);
    expect(t.start.mock.calls[0]![0]).toBe("codex");
    expect(t.start.mock.calls[0]![2]).toBe("install");
  });
});

describe("start and refusals", () => {
  it("started: the run is shown as running, with who started it, and the pages are told", async () => {
    const t = make();
    const r = await t.installs.begin(WHO, "codex");
    expect(r).toMatchObject({ install: { backend: "codex", phase: "running", startedOn: "Firefox on Linux", lines: [], exitCode: null, verified: null, version: null, endedAt: null } });
    expect(t.installs.view()).toMatchObject({ backend: "codex", phase: "running" });
    expect(t.changed).toHaveBeenCalledWith("running");
  });
  it.each(["busy", "already", "shutting_down", "failed"] as const)("%s: the code comes back, and what was shown before is shown still", async code => {
    const t = make();
    await t.installs.begin(WHO, "codex");
    t.reporters[0]!.done({ ok: true, detail: "clean exit", verified: true, version: "1.2.3", signIn: true });
    const before = t.installs.view();
    t.start.mockResolvedValueOnce({ refused: code, ...(code === "failed" ? { message: "tmux: no server" } : {}) });
    expect(await t.installs.begin(WHO, "grok")).toEqual({ error: code, ...(code === "failed" ? { message: "tmux: no server" } : {}) });
    expect(t.installs.view()).toEqual(before);
  });
  it("a start that throws is a failed start, not a crash", async () => {
    const t = make({ start: async () => { throw new Error("boom"); } });
    expect(await t.installs.begin(WHO, "codex")).toEqual({ error: "failed", message: "boom" });
    expect(t.installs.view()).toBeNull();
  });
  it("an installer that ended before the start answered is already over in the answer", async () => {
    const t = make({ start: async (_b, r) => { r.done({ ok: false, detail: "CLI exited with code 2 — nope", verified: false, version: null, signIn: false }); return { started: true }; } });
    expect(await t.installs.begin(WHO, "codex")).toMatchObject({ install: { phase: "failed", exitCode: 2 } });
  });
});

describe("progress and the verdict", () => {
  it("the installer's last lines, as plain text: ANSI stripped, tmux's dead-pane line and blank runs gone, secrets masked", async () => {
    const t = make();
    await t.installs.begin(WHO, "codex");
    t.reporters[0]!.progress("\u001b[32mDownloading codex\u001b[0m\n\n\n\nunpacking\nAuthorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\nPane is dead (status 0, Mon Nov  9 12:00:00 2026)\n");
    const lines = t.installs.view()!.lines;
    expect(lines.join("\n")).toContain("Downloading codex");
    expect(lines.join("\n")).toContain("unpacking");
    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines.join("\n")).not.toContain("Pane is dead");
    expect(lines.join("\n")).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
  });
  it("only the last lines are kept", () => {
    const pane = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    const lines = installLines(pane);
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.at(-1)).toBe("line 79");
  });
  it("success: ok, with the version the probe read and whether the binary was found; the connect step is offered only for a verified CLI that has one", async () => {
    const t = make();
    await t.installs.begin(WHO, "codex");
    t.reporters[0]!.done({ ok: true, detail: "clean exit", verified: true, version: "0.166.0", signIn: true });
    expect(t.installs.view()).toMatchObject({ phase: "ok", verified: true, version: "0.166.0", signIn: true, exitCode: null });
    expect(t.changed).toHaveBeenLastCalledWith("ended");
    const u = make();
    await u.installs.begin(WHO, "grok");
    u.reporters[0]!.done({ ok: true, detail: "clean exit", verified: false, version: null, signIn: true });
    expect(u.installs.view()).toMatchObject({ phase: "ok", verified: false, version: null, signIn: false });   // the installer said 0 but nothing was found
  });
  it("failure: the installer's own exit code", async () => {
    const t = make();
    await t.installs.begin(WHO, "codex");
    t.reporters[0]!.progress("curl: (22) The requested URL returned error: 404\n");
    t.reporters[0]!.done({ ok: false, detail: "CLI exited with code 22 — curl: (22) The requested URL returned error: 404", verified: false, version: null, signIn: false });
    const v = t.installs.view()!;
    expect(v).toMatchObject({ phase: "failed", exitCode: 22 });
    expect(v.lines.join("\n")).toContain("404");
  });
  it("cancelled and timeout are phases of their own, with no exit code", async () => {
    for (const [detail, phase] of [["cancelled", "cancelled"], ["timeout", "timeout"]] as const) {
      const t = make();
      await t.installs.begin(WHO, "codex");
      t.reporters[0]!.done({ ok: false, detail, verified: false, version: null, signIn: false });
      expect(t.installs.view(), detail).toMatchObject({ phase, exitCode: null });
    }
  });
  it("the window that could not be confirmed closed is said", async () => {
    const t = make();
    await t.installs.begin(WHO, "codex");
    t.reporters[0]!.done({ ok: false, detail: "cancelled", cleanupFailed: true, verified: false, version: null, signIn: false });
    expect(t.installs.view()!.cleanupFailed).toBe(true);
  });
  it("a second verdict, or output after the end, changes nothing", async () => {
    const t = make();
    await t.installs.begin(WHO, "codex");
    t.reporters[0]!.done({ ok: true, detail: "clean exit", verified: true, version: "1", signIn: false });
    t.reporters[0]!.done({ ok: false, detail: "timeout", verified: false, version: null, signIn: false });
    t.reporters[0]!.progress("late output\n");
    expect(t.installs.view()).toMatchObject({ phase: "ok", lines: [] });
  });
  it("an ended run is kept ten minutes, then it is gone; a running one is never dropped", async () => {
    const t = make();
    await t.installs.begin(WHO, "codex");
    t.tick(WEB_INSTALL_KEEP_ENDED_MS * 3);
    expect(t.installs.view()).not.toBeNull();
    t.reporters[0]!.done({ ok: true, detail: "clean exit", verified: true, version: null, signIn: false });
    t.tick(WEB_INSTALL_KEEP_ENDED_MS - 1);
    expect(t.installs.view()).not.toBeNull();
    t.tick(2);
    expect(t.installs.view()).toBeNull();
  });
  it("a newer install replaces the shown one; the old one's late report lands on the old run only", async () => {
    const t = make();
    await t.installs.begin(WHO, "codex");
    t.reporters[0]!.done({ ok: true, detail: "clean exit", verified: true, version: "1", signIn: false });
    await t.installs.begin(WHO, "grok");
    expect(t.installs.view()).toMatchObject({ backend: "grok", phase: "running" });
    t.reporters[0]!.progress("stale\n");
    expect(t.installs.view()!.lines).toEqual([]);
  });
  it("cancel asks the fleet to stop the one running install", async () => {
    const t = make();
    expect(await t.installs.cancel()).toBe(true);
    expect(t.cancel).toHaveBeenCalledTimes(1);
  });
});

describe("exitCodeOf", () => {
  it("reads login-manager's verdict text", () => {
    expect(exitCodeOf("CLI exited with code 7 — boom")).toBe(7);
    expect(exitCodeOf("CLI exited with code 127")).toBe(127);
    for (const d of ["timeout", "cancelled", "clean exit", "", "exited with code abc"]) expect(exitCodeOf(d), d).toBeNull();
  });
});
