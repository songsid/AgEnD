import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";

/**
 * A computer that joins with an install-command token is approved by the token alone, so the owner's out-of-band notice is the control that says it happened. These tests
 * drive the real audit hook of the real fleet's Runtime coordinator and the real notice routing: a chat-connected fleet with no General instance and no primary notice
 * target has nowhere to send it, and the notice must then be kept and delivered later, not dropped.
 */
const roots: string[] = [];
beforeEach(() => { vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const dir of roots.splice(0)) { if (!resolve(dir).startsWith(resolve(tmpdir()))) throw Error("Unsafe scratch path"); rmSync(dir, { recursive: true, force: true }); } });

function fleet(general: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "agend-owner-notice-")); roots.push(dir);
  writeFileSync(join(dir, "fleet.yaml"), ["health_port: 0", "instances:", `  dev:\n    working_directory: ${dir}\n    backend: claude-code${general ? `\n  general:\n    working_directory: ${dir}\n    backend: claude-code\n    general_topic: true` : ""}`].join("\n") + "\n");
  const fm = new FleetManager(dir) as any, quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  fm.loadConfig(join(dir, "fleet.yaml"));
  return { dir, fm };
}
const join_ = (hub: any, name = "Desk"): void => {
  const issued = hub.createEnrollment("admin:0123456789abcdef");
  hub.enroll({ token: issued.token, fingerprint: hub.serverFingerprint(), name, platform: "win32", hostname: "DESK-01" });
};
const pendingFile = (dir: string): string => join(dir, "pending-owner-notices.json");

describe("the notice that a computer joined with an install-command token", () => {
  it("is kept when the fleet has no place to send it, survives a restart, and is delivered once a destination exists", () => {
    vi.useFakeTimers();
    const { dir, fm } = fleet(false);
    const sent: string[] = []; let destination = false;
    // The real routing, down to its answer: nothing is dispatched until a chat destination exists (a chat-connected fleet has no web Notices to fall back to).
    fm.webOnlyPromptPlace = () => null; fm.adapter = null;
    const real = fm.notifyFleetError.bind(fm);
    fm.notifyFleetError = (text: string, opts: { throttle?: boolean }) => { if (!destination) return real(text, opts); sent.push(text); return true; };
    expect(real("probe", { throttle: false }), "no General, no primary target, no web Notices: nowhere to go").toBe(false);
    join_(fm.runtimeCoordinator());
    expect(sent).toEqual([]); expect(existsSync(pendingFile(dir))).toBe(true);
    const kept = JSON.parse(readFileSync(pendingFile(dir), "utf8")) as string[]; expect(kept).toHaveLength(1); expect(kept[0]).toMatch(/joined AgEnD with a one-time install-command token/); expect(kept[0]).not.toMatch(/agend_enroll_/);
    vi.advanceTimersByTime(60_000); expect(sent, "still nowhere to go: tried again, kept").toEqual([]); expect(existsSync(pendingFile(dir))).toBe(true);
    // A restart: a new fleet over the same folder finds what was kept and tries it.
    const second = new FleetManager(dir) as any; second.logger = fm.logger; second.loadConfig(join(dir, "fleet.yaml"));
    destination = true; second.notifyFleetError = (text: string) => { sent.push(text); return true; };
    second.runtimeCoordinator(); vi.advanceTimersByTime(30_000);
    expect(sent).toHaveLength(1); expect(sent[0]).toBe(kept[0]); expect(existsSync(pendingFile(dir))).toBe(false);
    second.runtimeHub?.close(); fm.runtimeHub?.close();
  });
  it("is not kept when it was delivered at once", () => {
    const { dir, fm } = fleet(true); const sent: string[] = [];
    fm.notifyFleetError = (text: string) => { sent.push(text); return true; };
    join_(fm.runtimeCoordinator());
    expect(sent).toHaveLength(1); expect(existsSync(pendingFile(dir))).toBe(false);
    fm.runtimeHub?.close();
  });
  it("flushes oldest first and stops at the first one that still has nowhere to go; a damaged or oversized file keeps nothing it cannot read", () => {
    const { dir, fm } = fleet(false); const order: string[] = []; let open = 1;
    fm.notifyFleetError = (text: string) => { if (open-- > 0) { order.push(text); return true; } return false; };
    writeFileSync(pendingFile(dir), JSON.stringify(["one", "two", "three", 4, "", "x".repeat(5000)]));
    expect(fm.flushOwnerNotices()).toBe(2); expect(order).toEqual(["one"]);
    expect(JSON.parse(readFileSync(pendingFile(dir), "utf8"))).toEqual(["two", "three"]);
    writeFileSync(pendingFile(dir), "{not json"); expect(fm.flushOwnerNotices()).toBe(0);
  });
});
