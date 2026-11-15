import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HubRuntime } from "../src/hub/runtime.js";
const homes: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function world() {
 const home = mkdtempSync(join(tmpdir(), "agend-hub-hotpath-")); homes.push(home);
 const runtime: any = new HubRuntime({ home, log() {}, readConfig: () => ({ hub: { enabled: false } }), createServer: async () => { throw Error("not a mount test"); } });
 runtime.running = new Promise<void>(() => {});
 return runtime;
}
it.each(["directory", "web-address", "member-address"])("%s settings refuse a pending shared mount without waiting or cancelling it", async kind => {
 vi.useFakeTimers(); const runtime = world(), mount = runtime.running, work = vi.fn(); let outcome = "pending";
 const pending = kind === "directory" ? runtime.acquireDirectorySettings() : kind === "web-address" ? runtime.withWebAddressDecision(work, () => true) : runtime.withMemberAddressDecision(work, () => true);
 void pending.then(() => { outcome = "resolved"; }, () => { outcome = "refused"; });
 await vi.advanceTimersByTimeAsync(0);
 expect(outcome).toBe("refused"); expect(work).not.toHaveBeenCalled(); expect(runtime.running).toBe(mount);
});
it("a current mounted directory remains readable during independent member work", async () => {
 const runtime = world(), mounted = { current: () => true };
 runtime.mountedDirectory = mounted;
 expect(await runtime.acquireDirectorySettings()).toBe(mounted);
});
