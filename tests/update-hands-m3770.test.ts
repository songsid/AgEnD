// M-3770 slice 2.5, wiring part 5 (design update-wiring-m3770.md §3, §10.1): the updater's install hand — the target's
// own installer in install-only mode with this update's prefix-lock token, from the filesystem root, then the installed
// package.json read again: its exact version, and its own agend.updateTx (below 1 → roll back, never trial).
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barrierHand, commitHands, installHand, proveHand, refreshServiceDefinition, type InstallHandEnv, type RefreshEnv } from "../src/update-hands.js";
import { serveControl, type ControlResult } from "../src/update-control.js";
import { ackGeneration, advance, newAttemptId, openAttempt, planGeneration, type AttemptRecord } from "../src/update-journal.js";

const PKG = "/p/lib/node_modules/@songsid/agend";
const input = { name: "@songsid/agend", version: "2.5.1", packagePath: PKG, prefixToken: "f".repeat(32) };
function env(o: { status?: number | null; pkg?: unknown } = {}) {
  const calls: { command: string; args: string[]; token?: string; cwd: string }[] = [];
  const x: InstallHandEnv = {
    env: { PATH: "/bin", AGEND_INSTALL_TOKEN: "stale" }, cwd: "/home/u/project",
    run: (command, args, opts) => { calls.push({ command, args, token: opts.env.AGEND_INSTALL_TOKEN, cwd: opts.cwd }); return { status: o.status === undefined ? 0 : o.status }; },
    readFile: path => (path === `${PKG}/package.json` ? JSON.stringify(o.pkg === undefined ? { name: "@songsid/agend", version: "2.5.1", agend: { updateTx: 1 } } : o.pkg) : null),
  };
  return { x, calls };
}

describe("M-3770 2.5 wiring part 5: the install hand", () => {
  it("runs the target's own installer, install-only, pinned, with this update's token, from the filesystem root; ok when the installed package is the target and speaks the transaction", () => {
    const e = env();
    expect(installHand(input, e.x)).toEqual({ ok: true });
    expect(e.calls).toEqual([{ command: "npm", args: ["exec", "--yes", "--package", "@songsid/agend@2.5.1", "--", "agend-install", "--install-only", "--target", "2.5.1"],
      token: "f".repeat(32), cwd: "/" }]);
  });

  it("an installed release whose own package.json doesn't speak the transaction is refused (the update rolls back)", () => {
    for (const agend of [undefined, { updateTx: 0 }, { updateTx: "1" }]) {
      const e = env({ pkg: { name: "@songsid/agend", version: "2.5.1", ...(agend ? { agend } : {}) } });
      expect(installHand(input, e.x)).toEqual({ ok: false, reason: `the installed @songsid/agend@2.5.1 doesn't speak the update transaction (agend.updateTx 0)` });
    }
  });

  it("another version, another package or no package.json after the install is refused", () => {
    for (const pkg of [{ name: "@songsid/agend", version: "2.5.0", agend: { updateTx: 1 } }, { name: "other", version: "2.5.1" }, null]) {
      expect(installHand(input, env({ pkg }).x)).toEqual({ ok: false, reason: `after the install, ${PKG} isn't @songsid/agend@2.5.1` });
    }
  });

  it("the installer's own refusals: not admitted (75), failed (1), or never ran", () => {
    expect(installHand(input, env({ status: 75 }).x)).toEqual({ ok: false, reason: "the installer of @songsid/agend@2.5.1 wasn't admitted under this update's prefix lock" });
    expect(installHand(input, env({ status: 1 }).x)).toEqual({ ok: false, reason: "the installer of @songsid/agend@2.5.1 failed (exit 1)" });
    expect(installHand(input, env({ status: null }).x)).toEqual({ ok: false, reason: "the installer of @songsid/agend@2.5.1 failed (exit unknown)" });
  });

  it("only an exact version: a tag never reaches npm", () => {
    const e = env();
    expect(installHand({ ...input, version: "beta" }, e.x)).toEqual({ ok: false, reason: "the target beta isn't an exact version" });
    expect(e.calls).toEqual([]);
  });
});

// ── The mailbox hands ──
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ID = newAttemptId(new Date("2026-11-27T17:00:00Z"), "abababab");
const OLDG = { nonce: "a".repeat(32), pid: 5100 }, TRIALG = { nonce: "b".repeat(32), pid: 6100 };
const DRIVER = { pid: 4343, token: "t".repeat(32) };
function opened() {
  const home = mkdtempSync(join(tmpdir(), "hands-")); dirs.push(home);
  const r = openAttempt(home, { id: ID, kind: "update", updater: { pid: DRIVER.pid, start: { processStart: "x" } },
    from: { name: "@songsid/agend", version: "2.5.0", integrity: null }, to: { name: "@songsid/agend", version: "2.5.1", integrity: null } });
  if (!r.ok) throw new Error(r.reason);
  return { home, attempt: r.attempt };
}
/** A fleet (its nonce and pid) answering its mailbox with `handlers`, during the driver's sleep. */
function serving(home: string, self: { nonce: string; pid: number }, handlers: Record<string, (req: unknown, a: AttemptRecord) => ControlResult>) {
  let t = 0;
  return { from: DRIVER, pollMs: 250, now: () => t, sleep: (ms: number) => { t += ms; serveControl(home, { self, senderLive: () => true, handlers }); } };
}

describe("M-3770 2.5 wiring part 5: the mailbox hands", () => {
  it("barrier: only `held` from the old fleet is ok; busy, refused, another pid or no answer abandon; no old fleet is nothing to fence", () => {
    const { home, attempt } = opened();
    const answer = (value: string) => serving(home, OLDG, { "barrier.arm": () => ({ status: "ok", value }) });
    expect(barrierHand(home, OLDG, answer("held"))(attempt)).toEqual({ ok: true });
    expect(barrierHand(home, OLDG, answer("busy"))(attempt)).toEqual({ ok: false, reason: "the fleet isn't idle" });
    expect(barrierHand(home, OLDG, answer("refused"))(attempt)).toEqual({ ok: false, reason: "the fleet can't hold for the update (refused)" });
    expect(barrierHand(home, OLDG, serving(home, { nonce: OLDG.nonce, pid: 9999 }, { "barrier.arm": () => ({ status: "ok", value: "held" }) }))(attempt))
      .toEqual({ ok: false, reason: `the barrier's answer came from pid 9999, not the running fleet's ${OLDG.pid}` });
    const silent = serving(home, { nonce: "c".repeat(32), pid: 1 }, {});
    expect(barrierHand(home, OLDG, { ...silent, timeoutMs: 1000 })(attempt)).toMatchObject({ ok: false, reason: expect.stringMatching(/^the running fleet didn't answer request \d+ \(barrier\.arm\) in time$/) });
    expect(barrierHand(home, null, silent)(attempt)).toEqual({ ok: true });
  });

  it("prove and commit go to the trial generation the journal acknowledged; none acknowledged (or another pid) fails without asking", () => {
    let { home, attempt: a } = opened();
    for (const s of ["barrier", "stopping", "snapshotted", "installing", "trial"] as const) a = advance(home, a, s);
    const x0 = serving(home, TRIALG, {});
    expect(proveHand(home, ID, x0)(TRIALG.pid)).toEqual({ ok: false, reason: `the journal has no acknowledged trial with pid ${TRIALG.pid}` });
    a = planGeneration(home, a, "trial", TRIALG.nonce); a = ackGeneration(home, a, TRIALG.nonce, TRIALG.pid);
    a = advance(home, a, "proving");
    const proof = { nonce: TRIALG.nonce, pid: TRIALG.pid, healthy: true, problems: [], adapters: { total: 0, connected: 0 } };
    expect(proveHand(home, ID, serving(home, TRIALG, { "trial.prove": () => ({ status: "ok", value: proof }) }))(TRIALG.pid)).toEqual({ ok: true });
    expect(proveHand(home, ID, x0)(7777)).toEqual({ ok: false, reason: "the journal has no acknowledged trial with pid 7777" });
    a = advance(home, a, "committing");
    const asked: string[] = [];
    const done = (op: string) => () => { asked.push(op); return { status: "ok", value: "done" } as ControlResult; };
    const hands = commitHands(home, ID, serving(home, TRIALG, { "commit.leaveTrial": done("leave"), "commit.startAgents": done("agents"), "commit.deliverInbox": done("inbox"), "commit.runDeferred": done("deferred") }));
    expect([hands.leaveTrial(), hands.startAgents(), hands.deliverInbox(), hands.runDeferred()]).toEqual([true, true, true, true]);
    expect(asked).toEqual(["leave", "agents", "inbox", "deferred"]);
  });
});

describe("M-3770 2.5 wiring part 5: the service definition refreshed after the commit", () => {
  const BIN = "/p/bin/agend", UNIT = "/home/u/.config/systemd/user/com.agend.fleet.service";
  const service = { kind: "systemd" as const, unit: "com.agend.fleet.service", fragmentPath: UNIT };
  function host(o: { version?: string; changes?: boolean; needReload?: "yes" | "no"; installFails?: boolean; reloadFails?: boolean } = {}) {
    let unit = "[Service]\nExecStart=old\n";
    const calls: string[] = [];
    const x: RefreshEnv = {
      uid: () => 1000, readFile: path => (path === UNIT ? unit : null),
      run: (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === BIN && args[0] === "--version") return { status: 0, stdout: `${o.version ?? "2.5.1"}\n` };
        if (command === BIN && args[0] === "install") { if (o.installFails) return { status: 1, stdout: "" }; if (o.changes !== false) unit = "[Service]\nExecStart=new\nOOMPolicy=continue\n"; return { status: 0, stdout: "" }; }
        if (args.includes("show")) return { status: 0, stdout: `${o.needReload ?? "yes"}\n` };
        if (args.includes("daemon-reload")) return { status: o.reloadFails ? 1 : 0, stdout: "" };
        return { status: 0, stdout: "" };
      },
    };
    return { x, calls };
  }
  const run = (h: ReturnType<typeof host>) => refreshServiceDefinition({ bin: BIN, version: "2.5.1", service }, h.x);

  it("a changed unit that systemd says needs it is reloaded; the fleet isn't restarted (it applies at the next restart)", () => {
    const h = host();
    expect(run(h)).toEqual({ kind: "refreshed", reloaded: true, note: "the service definition was refreshed; it applies at the next restart" });
    expect(h.calls).toEqual([`${BIN} --version`, `${BIN} install --no-activate`, "systemctl --user show -p NeedDaemonReload --value com.agend.fleet.service", "systemctl --user daemon-reload"]);
    expect(h.calls.some(c => /restart|start /.test(c))).toBe(false);
  });

  it("changed but no reload needed: none; unchanged: no systemctl at all", () => {
    const h = host({ needReload: "no" });
    expect(run(h)).toMatchObject({ kind: "refreshed", reloaded: false });
    expect(h.calls).not.toContain("systemctl --user daemon-reload");
    const u = host({ changes: false });
    expect(run(u)).toEqual({ kind: "unchanged", note: "the service definition is already current" });
    expect(u.calls.some(c => c.startsWith("systemctl"))).toBe(false);
  });

  it("failures are warnings naming the command, never a rollback; a bin that isn't the committed version is skipped", () => {
    expect(run(host({ installFails: true }))).toEqual({ kind: "failed", warning: "the service definition couldn't be refreshed (exit 1)", command: `${BIN} install --no-activate` });
    expect(run(host({ reloadFails: true }))).toEqual({ kind: "failed", warning: "the service definition was refreshed, but systemd couldn't reload it", command: "systemctl --user daemon-reload" });
    const v = host({ version: "2.5.0" });
    expect(run(v)).toEqual({ kind: "skipped", warning: `${BIN} reports 2.5.0, not v2.5.1; the service definition wasn't refreshed`, command: `${BIN} install --no-activate` });
    expect(v.calls).toEqual([`${BIN} --version`]);
  });

  it("no service: nothing to refresh; launchd: not this updater's (S-260)", () => {
    expect(refreshServiceDefinition({ bin: BIN, version: "2.5.1", service: null }, host().x)).toMatchObject({ kind: "unchanged" });
    expect(refreshServiceDefinition({ bin: BIN, version: "2.5.1", service: { ...service, kind: "launchd" } }, host().x)).toMatchObject({ kind: "skipped" });
  });
});
