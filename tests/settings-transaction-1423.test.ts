import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { SettingsExecution, SETTINGS_OPERATION_MS, settingsRevision, noteSettingsWrite, settingsUndo, undoSettingsPaths,
  settingsFileResource, trySettingsLease, assertSettingsLease, settingsFingerprint } from "../src/settings-transaction.js";
import { settingsChangeDiff, settingsDisplay } from "../src/settings-change.js";

const path = () => `/agend-test-${randomUUID()}/fleet.yaml`;
afterEach(() => vi.useRealTimers());
describe("settings execution ownership (#1423)", () => {
  it("reserves multiple resources atomically and retains the exact owner until release", () => {
    const a = path(), b = path(), held = trySettingsLease([a])!;
    expect(trySettingsLease([a, b])).toBeNull();
    const other = trySettingsLease([b])!;
    expect(() => assertSettingsLease(a)).toThrow("settings_resource_busy");
    expect(() => assertSettingsLease(a, held.owner)).not.toThrow();
    held.release(); const replacement = trySettingsLease([a])!;
    held.release(); expect(trySettingsLease([a])).toBeNull();
    replacement.release(); other.release();
  });
  it("uses one canonical resource for a future file", () => {
    expect(settingsFileResource("./test/future.env")).toBe(settingsFileResource("test/../test/future.env"));
  });
  it("retains newer unrelated paths while undoing only owned fields", () => {
    const file = path(), before = { channel: { group_id: "a", display_name: "old" } }, written = { channel: { group_id: "b", display_name: "old" } };
    noteSettingsWrite(file, before, written);
    const undo = settingsUndo(file, before, written, [["channel", "group_id"]]);
    const latest = { channel: { group_id: "b", display_name: "new" } };
    noteSettingsWrite(file, written, latest);
    expect(undoSettingsPaths(file, latest, undo)).toEqual({ value: { channel: { group_id: "a", display_name: "new" } }, conflicts: false });
  });
  it("rejects a newer owned path even after an ABA value change", () => {
    const file = path(), before = { x: "a" }, written = { x: "b" };
    noteSettingsWrite(file, before, written); const undo = settingsUndo(file, before, written, [["x"]]);
    noteSettingsWrite(file, written, { x: "c" }); noteSettingsWrite(file, { x: "c" }, written);
    expect(undoSettingsPaths(file, written, undo)).toEqual({ value: written, conflicts: true });
  });
  it("checks runtime and authority at every forward effect and permits owned synchronous updates", () => {
    let current = true, snapshot = 1; const execution = new SettingsExecution({ current: () => current, snapshot: () => snapshot });
    execution.mutate(() => snapshot++); expect(execution.current()).toBe(true);
    snapshot++; expect(() => execution.mutate(() => snapshot++)).toThrow("settings_execution_stale");
    current = false; expect(execution.current()).toBe(false); execution.close();
  });
  it("cannot rearm a cancelled old generation when the fleet boolean becomes active again", () => {
    let running = true; const execution = new SettingsExecution({ current: () => running, snapshot: () => null });
    execution.cancel(); running = false; running = true;
    expect(() => execution.mutate(() => undefined)).toThrow("settings_execution_stale"); execution.close();
  });
  it("bounds admission by monotonic receipt time even if its timer is delayed", () => {
    let now = 0; const effect = vi.fn(); const execution = new SettingsExecution({ current: () => true, snapshot: () => null, now: () => now });
    now = SETTINGS_OPERATION_MS; expect(() => execution.mutate(effect)).toThrow(); expect(effect).not.toHaveBeenCalled(); execution.close();
  });
  it("retains the successful receipt of an intentionally self-revoking final effect", () => {
    let authorized = true; const execution = new SettingsExecution({ current: () => authorized, snapshot: () => null });
    execution.commit(() => { authorized = false; });
    expect(execution.completed).toBe(true); expect(() => execution.mutate(() => undefined)).toThrow(); execution.close();
  });
  it("records ordinary same-process writes and ignores object key ordering", () => {
    const file = path(); const old = settingsRevision(file); noteSettingsWrite(file, {}, { model: "new" });
    expect(settingsRevision(file)).toBeGreaterThan(old);
    expect(settingsFingerprint({ a: 1, b: 2 })).toBe(settingsFingerprint({ b: 2, a: 1 }));
  });
});
describe("authoritative normalized diff (#1423)", () => {
  it("shows the actual equal-count user swap and F/C role rather than counts", () => {
    const diff = settingsChangeDiff({ classic: { admin_users: ["a"], allowed_users: ["c"] } },
      { classic: { admin_users: ["b"], allowed_users: ["d"] } }, { operation: "Classic access" })!;
    expect(diff.summary).toContain("classic.admin\\_users: remove Classic admin (C) ID a");
    expect(diff.summary).toContain("classic.admin\\_users: add Classic admin (C) ID b");
    expect(diff.summary.join("\n")).toContain("remove user ID c");
    expect(diff.summary.join("\n")).toContain("add user ID d");
  });
  it("includes omitted destinations and new primary/order even when membership is unchanged", () => {
    const a = { id: "a", type: "discord", group_id: "100", options: { general_channel_id: "200" } }, b = { id: "b", type: "telegram", group_id: "300" };
    const diff = settingsChangeDiff({ channels: [a, b] }, { channels: [b, { ...a, options: {} }] }, { operation: "channels" })!;
    expect(diff.summary.join("\n")).toContain("ordered connections / primary");
    expect(diff.summary.join("\n")).toContain("200 → absent");
    expect(diff.affectedConnections).toContain("a");
  });
  it("does not confuse dynamic channel/instance IDs with immediate property names", () => {
    const diff = settingsChangeDiff({ channels: [{ id: "model", group_id: "a" }] }, { channels: [{ id: "model", group_id: "b" }] }, { operation: "rebind" })!;
    expect(diff.summary.join("\n")).toContain("a → b");
  });
  it("leaves models and display immediate only when the complete sensitive effect is equal", () => {
    expect(settingsChangeDiff({ defaults: { model: "a" } }, { defaults: { model: "b" } }, { operation: "model" })).toBeNull();
    expect(settingsChangeDiff({ channels: [{ id: "a", access: { allowed_users: ["1"] }, name: "old" }] },
      { channels: [{ id: "a", name: "new" }] }, { operation: "replace" })!.summary.join("\n")).toContain("remove fleet admin (F) ID 1");
  });
  it("redacts only secrets and escapes control, mentions and display markup", () => {
    const secret = "SENSITIVE-SECRET-SENTINEL";
    const diff = settingsChangeDiff({ channel: { token: "old" } }, { channel: { token: secret, group_id: "100" } }, { operation: "secret" })!;
    expect(JSON.stringify(diff)).not.toContain(secret); expect(diff.summary.join("\n")).toContain("fingerprint");
    expect(settingsDisplay("@everyone\u001b[2J\n")).not.toContain("@everyone");
    expect(settingsDisplay("@everyone\u001b[2J\n")).not.toContain("\u001b");
  });
  it("refuses oversized authorization diffs rather than hiding IDs", () => {
    expect(() => settingsChangeDiff({ allowed_users: [] }, { allowed_users: Array.from({ length: 40 }, (_, n) => String(n)) }, { operation: "access" })).toThrow("confirmation_diff_too_large");
  });
  it("fails closed on unsupported nested/list effects instead of treating them as ordinary", () => {
    expect(() => settingsChangeDiff({}, { access: { allowed_users: [{ hidden: "secret" }] } }, { operation: "access" })).toThrow();
    expect(() => settingsChangeDiff({}, { unknown: "potential-secret" }, { operation: "unknown" })).toThrow("unsupported_sensitive_effect");
    expect(() => settingsChangeDiff({}, { unknown: [{ field: "value" }] }, { operation: "unknown" })).toThrow("unsupported_sensitive_effect");
  });
});
