// M-3247: after the beta.8 restart the fleet's startup sweep killed the named link this same fleet had opened 10 s
// earlier. auto_open reopened the link at 21:06:55, but finishStartup only ran at 21:07:04. Its sweep reaps
// any lease whose owner pid is this process, because that check exists for ManagedTunnel's own leftovers.
// So it SIGTERMed the live cloudflared (21:07:05 "closed", 21:07:09 "Reaped a leftover tunnel" killed).
// The preview lease was mid-spawn (providerPid null), and the sweep raised a false "cannot be identified" alarm on it.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { leasePath, readLease, reapLeftoverTunnels, reapStaleTunnel, writeLease, type TunnelLease } from "../src/tunnel/lease.js";

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "agend-m3247-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const SELF = "linux:this-run";
const lease = (over: Partial<TunnelLease> = {}): TunnelLease => ({
  sid: "s", provider: "cloudflared", originPort: 19282, providerPid: 2063505, strongIdentity: "linux:tunnel",
  expiresAt: Number.MAX_SAFE_INTEGER, ownerPid: process.pid, ownerIdentity: SELF, ...over,
});
/** This process is SELF, the tunnel is alive as itself. */
const probe = (pid: number) => pid === process.pid ? { kind: "identified" as const, identity: SELF, comm: "node" }
  : { kind: "identified" as const, identity: "linux:tunnel", comm: "cloudflared" };

describe("M-3247: the startup sweep never reaps this run's own live tunnel", () => {
  it("a lease this very process wrote (same pid, same fingerprint) is held: no signal, lease kept", async () => {
    const named = tempDir(), preview = tempDir();
    await writeLease(named, lease());
    await writeLease(preview, lease({ providerPid: null, strongIdentity: null }));   // mid-spawn
    const kills: Array<[number, string]> = [], logs: Array<[string, unknown]> = [];
    await reapLeftoverTunnels([named, preview], {
      probe, kill: (pid, sig) => { kills.push([pid, sig]); }, wait: async () => {},
      log: (level, msg, detail) => { logs.push([`${level}: ${msg}`, detail]); },
    });
    expect(kills).toEqual([]);
    expect(existsSync(leasePath(named)) && existsSync(leasePath(preview))).toBe(true);
    expect(logs).toEqual([]);                                     // no "could not be confirmed closed" false alarm
  });

  it("a previous run's lease that reused this pid (other fingerprint) is still reaped", async () => {
    const dir = tempDir();
    await writeLease(dir, lease({ ownerIdentity: "linux:previous-run" }));
    let alive = true;
    const kills: string[] = [], logs: Array<[string, unknown]> = [];
    await reapLeftoverTunnels([dir], {
      probe: pid => pid === process.pid ? probe(pid) : alive ? probe(pid) : { kind: "gone" },
      kill: (_pid, sig) => { kills.push(sig); alive = false; }, wait: async () => {},
      log: (level, msg, detail) => { logs.push([`${level}: ${msg}`, detail]); },
    });
    expect(kills).toEqual(["SIGTERM"]);
    expect(await readLease(dir)).toBeNull();
    expect(logs).toEqual([["info: Reaped a leftover tunnel", { how: "killed", tunnelPid: 2063505 }]]);
  });

  it("ManagedTunnel's own reap (no spareThisProcess) still clears this process's leftover", async () => {
    const dir = tempDir();
    await writeLease(dir, lease());
    const outcome = await reapStaleTunnel(dir, { probe: pid => pid === process.pid ? probe(pid) : { kind: "gone" } });
    expect(outcome).toMatchObject({ kind: "reaped", how: "already-gone" });
  });
});
