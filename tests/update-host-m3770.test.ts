// M-3770 slice 2.5, wiring part 5 (design update-wiring-m3770.md §14): the updater's host hands — the install's Node
// proven from the service's own start command (never the package's files), a detached fleet's stop and handoff start,
// the takeover wait, the drain and the kit's sources. Process effects are an injected HostEnv: no systemd, no fleet.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Ownership } from "../src/install-ownership.js";
import { drainHand, interpreterOf, kitSources, updaterManager, waitTakeover, type HostEnv } from "../src/update-host.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const PKG = "/p/lib/node_modules/@songsid/agend", NODE = "/opt/node22/bin/node";
const plist = (argv: string[]) => `<plist><dict><key>ProgramArguments</key><array>${argv.map(a => `<string>${a}</string>`).join("")}</array></dict></plist>`;
function host(o: { plist?: string; alive?: Set<number>; killOk?: boolean; diesOnTerm?: boolean } = {}) {
  let t = 0;
  const alive = o.alive ?? new Set<number>();
  const calls: string[] = [];
  const x: HostEnv = {
    run: () => ({ status: 1, stdout: "" }), uid: () => 501, sleep: ms => { t += ms; }, now: () => t,
    realpath: p => (p.startsWith("/missing") ? null : p),
    readFile: p => { if (p === "/la/com.agend.fleet.plist") return o.plist ?? null; try { return readFileSync(p, "utf8"); } catch { return null; } },
    exists: pid => alive.has(pid),
    kill: (pid, sig) => { calls.push(`kill ${pid} ${sig}`); if (o.killOk === false) return false; if (o.diesOnTerm !== false) alive.delete(pid); return true; },
    spawnDetached: (command, args, env) => { calls.push(`${command} ${args.join(" ")} ${JSON.stringify(env)}`); return true; },
    execPath: "/usr/local/bin/node",
    unlink: p => { calls.push(`unlink ${p}`); try { rmSync(p); return true; } catch { return false; } },
  };
  return { x, calls, alive, clock: () => t };
}
const owned = (service: Ownership["service"]): Ownership => ({ uid: 501, home: "/h", prefix: "/p", packagePath: PKG, service,
  binLinks: { agend: "/p/bin/agend", "agend-agent": "/p/bin/agend-agent" } });
const launchd = { kind: "launchd" as const, unit: "com.agend.fleet", fragmentPath: "/la/com.agend.fleet.plist" };

describe("M-3770 2.5 wiring part 5: the install's Node is proven from the service's start command", () => {
  it("`<node> <package>/dist/cli.js fleet start` names it; a detached fleet runs on this updater's Node", () => {
    expect(interpreterOf(owned(launchd), host({ plist: plist([NODE, `${PKG}/dist/cli.js`, "fleet", "start"]) }).x)).toBe(NODE);
    expect(interpreterOf(owned(null), host().x)).toBe("/usr/local/bin/node");
  });

  it("anything else isn't proven (null): the script form, an entry outside the package, another program, other arguments, an unreadable definition", () => {
    for (const argv of [[`${PKG}/dist/cli.js`, "fleet", "start"], [NODE, "/elsewhere/dist/cli.js", "fleet", "start"], ["/usr/bin/python3", `${PKG}/dist/cli.js`, "fleet", "start"],
      [NODE, `${PKG}/dist/cli.js`, "fleet"], ["/missing/node", `${PKG}/dist/cli.js`, "fleet", "start"]]) {
      expect(interpreterOf(owned(launchd), host({ plist: plist(argv) }).x), argv.join(" ")).toBeNull();
    }
    expect(interpreterOf(owned(launchd), host().x)).toBeNull();
  });
});

describe("M-3770 2.5 wiring part 5: a detached fleet's manager", () => {
  function home(rec?: { pid: number; nonce: string }) {
    const h = mkdtempSync(join(tmpdir(), "host-")); dirs.push(h);
    if (rec) writeFileSync(join(h, "fleet.lock"), JSON.stringify({ ...rec, createdAt: new Date().toISOString(), role: "fleet" }) + "\n");
    return h;
  }
  const TUPLE = () => [NODE, `${PKG}/dist/cli.js`];
  it("stops the fleet.lock holder (SIGTERM, waits until it is gone); starts as the transaction proved it — the tuple's Node and entry, never a bin link — with the handoff, the dead owner's fleet.pid removed first", () => {
    const h = host({ alive: new Set([7100]) });
    const dir = home({ pid: 7100, nonce: "a".repeat(32) });
    writeFileSync(join(dir, "fleet.pid"), "7100\n");
    const m = updaterManager(dir, null, TUPLE, h.x);
    expect(m.mainPid()).toBeNull();                                                               // no service manager: no MainPID
    expect(m.stop()).toBe(true);
    expect(h.calls).toEqual(["kill 7100 SIGTERM"]);
    expect(m.reload()).toBe(true);
    expect(m.start({ nonce: "b".repeat(32), gen: "trial" })).toBe(true);
    expect(h.calls.slice(1)).toEqual([`unlink ${join(dir, "fleet.pid")}`,
      `${NODE} ${PKG}/dist/cli.js fleet start ${JSON.stringify({ AGEND_UPDATE_HANDOFF: "b".repeat(32), AGEND_FLEET_START_DIRECT: "1" })}`]);
    expect(existsSync(join(dir, "fleet.pid"))).toBe(false);
  });

  it("never starts over a live fleet.pid owner, nor without a proven tuple", () => {
    const h = host({ alive: new Set([7300]) });
    const dir = home();
    writeFileSync(join(dir, "fleet.pid"), "7300\n");
    expect(updaterManager(dir, null, TUPLE, h.x).start({ nonce: "b".repeat(32), gen: "trial" })).toBe(false);
    expect(updaterManager(home(), null, () => null, h.x).start({ nonce: "b".repeat(32), gen: "trial" })).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("a fleet that doesn't stop within the bound: false; no fleet: stopped already", () => {
    const h = host({ alive: new Set([7100]), diesOnTerm: false });
    expect(updaterManager(home({ pid: 7100, nonce: "a".repeat(32) }), null, TUPLE, h.x).stop()).toBe(false);
    expect(h.clock()).toBeGreaterThanOrEqual(5 * 60_000);                                           // the fleet's own stop budget
    expect(updaterManager(home(), null, TUPLE, host().x).stop()).toBe(true);
  });

  it("the takeover: the fleet record with that nonce, its pid; none within the bound: null", () => {
    const h = home({ pid: 7200, nonce: "c".repeat(32) });
    const x = host().x;
    expect(waitTakeover(h, x)("c".repeat(32))).toBe(7200);
    expect(waitTakeover(h, x, 1000)("d".repeat(32))).toBeNull();
  });
});

describe("M-3770 2.5 wiring part 5: the drain and the kit", () => {
  it("the exclusive lease is handed to the caller to keep; a refusal is the reason", () => {
    const kept: unknown[] = [];
    const lease = { release: () => {} };
    expect(drainHand("/h", l => kept.push(l), () => ({ ok: true, lease }))()).toEqual({ ok: true });
    expect(kept).toEqual([lease]);
    expect(drainHand("/h", l => kept.push(l), () => ({ ok: false, reason: "busy" }))()).toEqual({ ok: false, reason: "busy" });
  });

  it("the kit: this install's Node and the runner bundled beside its CLI", () => {
    expect(kitSources(`${PKG}/dist/cli.js`, host().x)).toEqual({ nodePath: "/usr/local/bin/node", bundlePath: `${PKG}/dist/recover.cjs` });
  });
});
