import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebNotices, NOTICES_MAX } from "../src/web-notices.js";
import type { HubSharingNotice } from "../src/hub-sharing-notice.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const notice = (key = "a".repeat(64), at = 1_800_000_000_000): HubSharingNotice => ({ key, at, undoUntil: at + 86_400_000,
  byName: "Owner", hubName: "Demo Hub", state: "pending", version: 1, rows: [{ name: "Documents", kind: "agent", action: "share", state: "pending" }] });
it("upserts one durable notice, preserves the deadline across restart, and does not repeat an uncertain external chat send", () => {
  const root = mkdtempSync(join(tmpdir(), "agend-share-notices-")); roots.push(root);
  const file = join(root, "notices.json"), value = notice(), log = { warn() {} }, now = () => value.at;
  let store = new WebNotices(file, log, now);
  const waiting = store.upsertSharing(value, "Pending")!;
  expect(store.startSharingChat(value.key)).toBe(true);
  const complete: HubSharingNotice = { ...value, version: 2, state: "complete", rows: [{ ...value.rows[0], state: "shared" }] };
  const done = store.upsertSharing(complete, "Shared")!;
  expect(done.id).toBe(waiting.id); expect(done.at).toBe(waiting.at); expect(store.view().items).toHaveLength(1);
  store = new WebNotices(file, log, now);
  expect(store.view().items[0].hubSharing).toEqual(complete); expect(store.startSharingChat(value.key)).toBe(false);
  expect(store.upsertSharing({ ...complete, at: value.at + 1, undoUntil: value.undoUntil + 1 }, "Changed")).toBeNull();
  expect(store.upsertSharing(value, "Stale")!.text).toBe("Shared");
});
it("keeps live Undo notices beyond the routine notice window, then trims them after their exact expiry", () => {
  const root = mkdtempSync(join(tmpdir(), "agend-share-window-")); roots.push(root);
  const file = join(root, "notices.json"), value = notice(); let now = value.at;
  let store = new WebNotices(file, { warn() {} }, () => now);
  const saved = store.upsertSharing(value, "Pending")!;
  for (let i = 0; i < NOTICES_MAX + 1; i++) store.add({ kind: "fleet", text: `Routine ${i}` });
  expect(store.view().items.some(row => row.id === saved.id)).toBe(true);
  store = new WebNotices(file, { warn() {} }, () => now);
  expect(store.view().items.some(row => row.id === saved.id)).toBe(true);
  now = value.undoUntil; store.add({ kind: "fleet", text: "Next" });
  expect(store.view().items.some(row => row.id === saved.id)).toBe(false); expect(store.view().items).toHaveLength(NOTICES_MAX);
});
it("refuses before effects when the notice cannot be persisted", () => {
  const root = mkdtempSync(join(tmpdir(), "agend-share-write-")); roots.push(root);
  const store = new WebNotices(join(root, "missing", "notices.json"), { warn() {} });
  expect(store.upsertSharing(notice(), "Pending")).toBeNull(); expect(store.view().items).toEqual([]);
});
