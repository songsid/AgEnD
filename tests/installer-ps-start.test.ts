import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallerPsStartGate, installerPsStartSlots } from "./support/installer-ps-start.js";
const dirs: string[] = [];
const root = () => { const p = mkdtempSync(join(tmpdir(), "agend-start-gate-")); dirs.push(p); return p; };
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("PowerShell START reservations", () => {
  it("limits independent gate objects in the same run and leaves other runs independent", () => {
    const r = root(), a = new InstallerPsStartGate(r, 1), b = new InstallerPsStartGate(r, 1);
    const first = a.tryAcquire()!; expect(first).toBeDefined(); expect(b.tryAcquire()).toBeUndefined();
    const other = new InstallerPsStartGate(root(), 1).tryAcquire()!; expect(other).toBeDefined(); other.release();
    expect(JSON.parse(readFileSync(join(r, "slot-0"), "utf8")).pid).toBe(process.pid);
    first.release(); const next = b.tryAcquire()!; expect(next).toBeDefined();
    first.release(); expect(a.tryAcquire()).toBeUndefined(); next.release();
  });
  it("enforces the same reservation in a separate Node worker", () => {
    const r = root(), gate = new InstallerPsStartGate(r, 1), held = gate.tryAcquire()!;
    const code = `import {InstallerPsStartGate} from ${JSON.stringify(new URL("./support/installer-ps-start.ts", import.meta.url).href)};
      const ticket=new InstallerPsStartGate(${JSON.stringify(r)},1).tryAcquire();
      console.log(ticket?'acquired':'blocked');ticket?.release();`;
    const run = () => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], { encoding: "utf8" }).trim();
    expect(run()).toBe("blocked"); held.release(); expect(run()).toBe("acquired");
  });
  it("allows the configured capacity and admits a waiter only after a release", async () => {
    vi.useFakeTimers(); const r = root(); const gate = new InstallerPsStartGate(r, 2);
    const one = gate.tryAcquire()!, two = gate.tryAcquire()!; expect(gate.tryAcquire()).toBeUndefined();
    let granted = false; const waiting = new InstallerPsStartGate(r, 2).acquire().then(t => { granted = true; return t; });
    await vi.advanceTimersByTimeAsync(500); expect(granted).toBe(false);
    one.release(); await vi.advanceTimersByTimeAsync(20);
    const third = await waiting; expect(granted).toBe(true); expect(gate.tryAcquire()).toBeUndefined();
    third.release(); two.release(); expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds queue waiting separately and never steals an uncertain reservation", async () => {
    vi.useFakeTimers(); const r = root(); writeFileSync(join(r, "slot-0"), "interrupted owner write");
    const pending = new InstallerPsStartGate(r, 1).acquire(); void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(29_999); expect(readFileSync(join(r, "slot-0"), "utf8")).toBe("interrupted owner write");
    await vi.advanceTimersByTimeAsync(1); await expect(pending).rejects.toThrow("START queue exceeded 30 s");
    expect(readFileSync(join(r, "slot-0"), "utf8")).toBe("interrupted owner write"); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not turn storage errors into an unbounded queue", () => {
    const file = join(root(), "not-a-directory"); writeFileSync(file, "fixture");
    expect(() => new InstallerPsStartGate(file, 1).tryAcquire()).toThrow();
    expect(() => new InstallerPsStartGate(root(), 0)).toThrow("capacity");
  });
  it.each([[1,1],[2,1],[4,1],[6,2],[8,3]])("reserves test-runner headroom on %i cores", (cores, slots) => {
    expect(installerPsStartSlots(cores)).toBe(slots);
  });
});
