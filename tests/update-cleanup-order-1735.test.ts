/**
 * #1735 (beta.5 rehearsal): chat /update must show the nvm route's cleanup warning in EITHER order of events.
 *
 * - Detached fleet / launchd: `agend restart` returns at once (`launchctl kickstart -k`, "Fleet restarting in
 *   background"), so the updater retires — and records `cleanup: "done"` with the warning — BEFORE the new fleet
 *   boots, or at any point while it boots. The rehearsal's marker timeline showed exactly that; the summary had no line.
 * - systemd: `systemctl restart` of the Type=notify unit returns only after READY=1, which the new fleet sends after
 *   its completion and finishStartup — so the outcome is still owed (`cleanup: "pending"`) when the completion posts.
 *
 * The real FleetManager decisions on a real marker in a scratch dir; the adapter is a stub that records edits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FleetManager } from "../src/fleet-manager.js";
import { retireSystemCopy } from "../src/update-install.js";
import {
  beginFullRestartProgress,
  beginUpdateProgress,
  clearUpdateMarker,
  markCleanupPending,
  readUpdateProgress,
  setUpdateProgressStage,
  updateMarkerIdentity,
  writeCleanupOutcome,
} from "../src/update-marker.js";
import { formatRestartProgressCompletion } from "../src/restart-progress.js";
import { setLocale } from "../src/locale.js";

const roots: string[] = [];
beforeEach(() => { setLocale("en"); });
afterEach(() => {
  vi.useRealTimers();
  setLocale("en");
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const target = { adapterId: "a", chatId: "c", messageId: "m-1" };
const summary = { running: 1, total: 1, version: "2.2.0-beta.6", pausedNames: [] as string[] };
const WARNING = "Old system install at /usr/local/lib/node_modules/@songsid/agend was not removed (sudo refused); remove it by hand.";
const COMMAND = "sudo '/home/u/.nvm/versions/node/v22.23.3/bin/npm' uninstall -g @songsid/agend";

/** The new fleet, booting on the marker its update left: `pending` is the boot snapshot (the updater wrote it). */
function boot(setup: (dir: string) => void) {
  const dir = fs.mkdtempSync(join(tmpdir(), "agend-1735-")); roots.push(dir);
  setup(dir);
  const pending = readUpdateProgress(dir);
  const bootMarker = updateMarkerIdentity(dir);           // what the boot adopts (#1737 review fence)
  const fm = new FleetManager(dir) as any;
  const edits: string[] = [];
  fm.adapters = new Map([["a", { editMessage: async (_c: string, _m: string, text: string) => { edits.push(text); } }]]);
  return { dir, fm, edits, pending, bootMarker };
}
/** The updater's side: the receipt marked pending before the restart, the outcome written after the retire. */
const updaterPending = (dir: string) => { beginUpdateProgress(dir, target); setUpdateProgressStage(dir, "stopping", { version: "2.2.0-beta.6" }); return markCleanupPending(dir); };
const updaterRetired = (dir: string) => writeCleanupOutcome(dir, markCleanupPendingReceipt(dir), { warning: WARNING, cleanupCommand: COMMAND });
/** The receipt of the update marker in `dir`, as the updater captured it. */
function markCleanupPendingReceipt(dir: string) {
  const m = readUpdateProgress(dir)!;
  return { startedAt: m.startedAt, messageId: m.progress.target.messageId, operation: "update" as const };
}

describe("#1735: what the completion does about the retire outcome, read when it posts", () => {
  it("detached / launchd order — already landed with a warning: rendered in the completion", () => {
    const { fm, pending } = boot(dir => { const r = updaterPending(dir); writeCleanupOutcome(dir, r, { warning: WARNING, cleanupCommand: COMMAND }); });
    expect(fm.updateCleanupAtCompletion(pending, "update")).toEqual({ render: { warning: WARNING, cleanupCommand: COMMAND } });
  });

  it("the outcome landed during the boot (after the boot snapshot, before the completion): still rendered", () => {
    const b = boot(dir => { updaterPending(dir); });
    expect(b.pending!.progress.cleanup).toBe("pending");                 // the snapshot said pending…
    updaterRetired(b.dir);                                               // …then the updater's retire landed
    expect(b.fm.updateCleanupAtCompletion(b.pending, "update")).toEqual({ render: { warning: WARNING, cleanupCommand: COMMAND } });
  });

  it("systemd order — still owed: watch this receipt (nothing rendered yet)", () => {
    const { fm, pending } = boot(dir => { updaterPending(dir); });
    expect(fm.updateCleanupAtCompletion(pending, "update")).toEqual({ watch: markCleanupPendingReceipt(fm.dataDir) });
  });

  it.each([
    ["an ordinary update (no retire on it)", (dir: string) => { beginUpdateProgress(dir, target); }],
    ["done silently (the old copy was removed)", (dir: string) => { const r = updaterPending(dir); writeCleanupOutcome(dir, r, null); }],
  ])("%s → nothing: no line, no watch", (_label, setup) => {
    const { fm, pending } = boot(setup);
    expect(fm.updateCleanupAtCompletion(pending, "update")).toBeNull();
  });

  it("another receipt, a full restart, or no marker → nothing", () => {
    const replaced = boot(dir => { const r = updaterPending(dir); writeCleanupOutcome(dir, r, { warning: WARNING }); });
    clearUpdateMarker(replaced.dir); beginFullRestartProgress(replaced.dir, { ...target, messageId: "m-B" });
    expect(replaced.fm.updateCleanupAtCompletion(replaced.pending, "update")).toBeNull();
    const full = boot(dir => { beginFullRestartProgress(dir, target); });
    expect(full.fm.updateCleanupAtCompletion(full.pending, "full-restart")).toBeNull();
    const gone = boot(dir => { const r = updaterPending(dir); writeCleanupOutcome(dir, r, { warning: WARNING }); });
    clearUpdateMarker(gone.dir);
    expect(gone.fm.updateCleanupAtCompletion(gone.pending, "update")).toBeNull();
    expect(gone.fm.updateCleanupAtCompletion(null, null)).toBeNull();
  });
});

describe("#1735: the post-update marker clear never takes an owed or watched outcome", () => {
  it("an ordinary update's marker, and one whose outcome was rendered: cleared", () => {
    const plain = boot(dir => { beginUpdateProgress(dir, target); });
    plain.fm.clearSettledUpdateMarker(plain.bootMarker);
    expect(readUpdateProgress(plain.dir)).toBeNull();
    const rendered = boot(dir => { const r = updaterPending(dir); writeCleanupOutcome(dir, r, { warning: WARNING }); });
    rendered.fm.clearSettledUpdateMarker(rendered.bootMarker);
    expect(readUpdateProgress(rendered.dir)).toBeNull();
  });

  it("still owed and unwatched: kept (as #1660)", () => {
    const b = boot(dir => { updaterPending(dir); });
    b.fm.clearSettledUpdateMarker(b.bootMarker);
    expect(readUpdateProgress(b.dir)?.progress.cleanup).toBe("pending");
  });

  it("watched, and the outcome landed after the completion posted: kept for the watch", () => {
    const b = boot(dir => { updaterPending(dir); });
    b.fm.updateCleanupWatch = { receipt: markCleanupPendingReceipt(b.dir), summary };
    updaterRetired(b.dir);
    b.fm.clearSettledUpdateMarker(b.bootMarker);
    expect(readUpdateProgress(b.dir)?.progress).toMatchObject({ cleanup: "done", warning: WARNING });
    b.fm.updateCleanupWatch = null;
  });

  it("a failed update is cleared even if it was marked pending", () => {
    const b = boot(dir => { updaterPending(dir); setUpdateProgressStage(dir, "failed", { error: "x" }); });
    b.fm.clearSettledUpdateMarker(b.bootMarker);
    expect(readUpdateProgress(b.dir)).toBeNull();
  });
});

describe("#1735: the /update message ends with the cleanup lines in both orders", () => {
  it("detached / launchd: the completion itself carries them; the marker is then cleared; no watch", () => {
    const b = boot(dir => { const r = updaterPending(dir); writeCleanupOutcome(dir, r, { warning: WARNING, cleanupCommand: COMMAND }); });
    const outcome = b.fm.updateCleanupAtCompletion(b.pending, "update");
    const text = formatRestartProgressCompletion("update", { ...summary, warningText: outcome.render.warning, warningCommand: outcome.render.cleanupCommand }, b.pending!.startedAt);
    expect(text).toContain("✅ AgEnD updated");
    expect(text).toContain(`⚠️ ${WARNING}`);
    expect(text).toContain(`\`$ ${COMMAND}\``);
    b.fm.clearSettledUpdateMarker(b.bootMarker);
    expect(readUpdateProgress(b.dir)).toBeNull();
    expect(b.fm.updateCleanupWatch).toBeNull();
  });

  it.each([
    ["systemd: the outcome lands after finishStartup", false],
    ["race: the outcome lands between the completion and finishStartup", true],
  ])("%s → the watch appends them to the same message, then clears", async (_label, beforeClear) => {
    vi.useFakeTimers();
    const b = boot(dir => { updaterPending(dir); });
    const outcome = b.fm.updateCleanupAtCompletion(b.pending, "update");
    b.fm.armCleanupWatch(outcome.watch, summary);
    if (beforeClear) updaterRetired(b.dir);
    b.fm.clearSettledUpdateMarker(b.bootMarker);
    expect(readUpdateProgress(b.dir), "the watch's marker survives the startup clear").not.toBeNull();
    if (!beforeClear) updaterRetired(b.dir);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(b.edits).toHaveLength(1);
    expect(b.edits[0]).toContain("✅ AgEnD updated");
    expect(b.edits[0]).toContain(`⚠️ ${WARNING}`);
    expect(b.edits[0]).toContain(`\`$ ${COMMAND}\``);
    expect(readUpdateProgress(b.dir)).toBeNull();
    expect(b.fm.updateCleanupWatch).toBeNull();
    if (b.fm.updateProgressTimer) clearInterval(b.fm.updateProgressTimer);
  });
});

describe("#1735: the boot wires it — the completion renders a landed outcome, the watch is armed after it posts", () => {
  const src = fs.readFileSync(join(process.cwd(), "src", "fleet-manager.ts"), "utf8");
  const body = src.slice(src.indexOf("const cleanupOutcome = this.updateCleanupAtCompletion(pendingUpdateProgress, pendingProgressOperation);"));
  it("summary spread → finish → arm; the fallback message carries it too", () => {
    expect(body.length).toBeGreaterThan(0);
    const spread = body.indexOf("warningText: cleanupOutcome.render.warning, warningCommand: cleanupOutcome.render.cleanupCommand");
    const finish = body.indexOf("await startupProgress.finish(completionSummary)");
    const arm = body.indexOf("this.armCleanupWatch(cleanupOutcome.watch, completionSummary)");
    const fallback = body.indexOf("text += `\\n\\n⚠️ ${cleanupOutcome.render.warning}`");
    const send = body.indexOf("await this.sendFleetStartCompletionFallback(");
    expect([spread > 0, finish > spread, arm > finish, fallback > arm, send > fallback]).toEqual([true, true, true, true, true]);
    expect(src).toContain("    this.clearSettledUpdateMarker(bootUpdateMarker);\n    if (this.reloadPending)");
    expect(src).toContain("    this.finishStartup(bootUpdateMarker);");
  });
});

describe("#1735: the warning names the old copy's directory when it is plain", () => {
  const refused = { run: (command: string, args: string[]) => ({ status: command === "sudo" && args[0] === "-n" ? 1 : 99, signal: null, stdout: "", stderr: "" }), log: () => {} };
  const NPM = "/home/u/.nvm/versions/node/v22.23.3/bin/npm";
  it("a plain …/node_modules/@songsid/agend path is named; the command is unchanged", () => {
    const r = retireSystemCopy(refused, NPM, "/usr/local/lib/node_modules/@songsid/agend");
    expect(r).toEqual({ ok: true, warning: WARNING, cleanupCommand: `sudo '${NPM}' uninstall -g @songsid/agend` });
  });
  it.each([
    ["absent", undefined],
    ["relative", "lib/node_modules/@songsid/agend"],
    ["with a space", "/opt/my node/lib/node_modules/@songsid/agend"],
    ["with a newline", "/opt/x\n/lib/node_modules/@songsid/agend"],
    ["another package", "/usr/local/lib/node_modules/@songsid/other"],
    ["too long", "/" + "a".repeat(200) + "/node_modules/@songsid/agend"],
  ])("%s → not named", (_label, dir) => {
    const r = retireSystemCopy(refused, NPM, dir);
    expect(r).toMatchObject({ ok: true, warning: "Old system install was not removed (sudo refused); remove it by hand." });
  });
});
