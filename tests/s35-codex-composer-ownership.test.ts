/** S-35: the Enter gate proves a Codex composer owns its pasted envelope, however many rows it wraps to. No CLI is started. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Daemon } from "../src/daemon.js";
import { CodexBackend, CodexPaneDetectors } from "../src/backend/codex.js";
import { createNativePaneBackend } from "../src/backend/native-pane.js";

const fixture = (name: string): string => JSON.parse(readFileSync(join(__dirname, `fixtures/${name}`), "utf8")).text as string;
const postTurn = fixture("s35-codex-post-turn-unsent-composer.json");
const rowsOf = (screen: string): string[] => screen.split("\n");
const CONTEXT = { statusLineItems: () => ["context-remaining"], launchMayResume: () => false };
const conpty = new CodexPaneDetectors({ ...CONTEXT, windowsConpty: true });
const unix = new CodexPaneDetectors(CONTEXT);
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The real post-turn screen with `count` more wrapped rows in the pasted envelope, directly under its `›` row (row 32). */
function longerEnvelope(count: number): string {
  const rows = rowsOf(postTurn);
  const wrapped = Array.from({ length: count }, (_, i) => `  wrapped envelope line ${i + 1} of the pasted message body`);
  return [...rows.slice(0, 33), ...wrapped, ...rows.slice(33)].join("\n");
}

/** A 40-row pane: the given rows, then blank rows. */
function screenWith(rows: string[]): string {
  return [...rows, ...Array(Math.max(0, 40 - rows.length)).fill(""), ""].join("\n");
}
const HISTORY_ROWS = rowsOf(postTurn).slice(0, 16);
const FOOTER = "  Context 95% left";

function gateDaemon(screen: string, mode: "codex" | "native") {
  const root = mkdtempSync(join(tmpdir(), "s35-composer-"));
  roots.push(root);
  const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
  const backend: any = mode === "codex" ? new CodexBackend(root)
    : createNativePaneBackend("codex", () => ({ sessionId: null, contextPercentage: null, statusLineItems: ["context-remaining"], resumes: false }));
  const daemon: any = new Daemon("s35", { working_directory: root, backend: "codex", log_level: "silent" } as never, root, true, backend, undefined, logger as never);
  daemon.tmux = { getWindowId: () => "@owned", capturePane: vi.fn(async () => screen), sendSpecialKey: vi.fn(async () => true), getLastSendSpecialKeyError: () => null };
  daemon.deliveryOutbox = { markEnterStarted: () => true };
  return daemon;
}
const enter = async (screen: string, mode: "codex" | "native") => {
  const daemon = gateDaemon(screen, mode);
  const sent = await daemon.sendDeliveryEnter("initial-submit", undefined, { deliveryId: "s35-delivery", attemptNo: 1 });
  return { sent, keys: daemon.tmux.sendSpecialKey.mock.calls.length };
};

describe("S-35 real Windows Codex screen", () => {
  it.each(["codex", "native"] as const)("the post-turn unsent composer receives Enter exactly once (%s)", async mode => {
    expect(conpty.isDeliveryInputReadyPane(postTurn)).toBe(true);
    expect(conpty.ownsComposerRows(postTurn)).toBe(true);
    expect(await enter(postTurn, mode)).toEqual({ sent: true, keys: 1 });
  });
  it("a pasted envelope wrapped past the fixed tail window is owned row by row, under ConPTY and Unix", async () => {
    const long = longerEnvelope(6);
    for (const detector of [conpty, unix]) expect(detector.ownsComposerRows(long)).toBe(true);
    expect(await enter(long, "native")).toEqual({ sent: true, keys: 1 });
    expect(await enter(long, "codex")).toEqual({ sent: true, keys: 1 });
  });
});

describe("S-35 negatives stay refused", () => {
  const historyAboveOutput = screenWith([...HISTORY_ROWS, "› old echoed prompt", "  wrapped history", "• Called agend.reply",
    "  └ {\"messageId\":\"1\"}", "", FOOTER]);
  const selectionCard = screenWith([...HISTORY_ROWS, "  Would you like to switch the model?", "› 1. Yes, switch now",
    "  2. No, keep current", "", "  Press enter to confirm or esc to go back"]);
  const busyRow = screenWith([...rowsOf(postTurn).slice(0, 33), "• Planning the edit (12s • esc to interrupt)", "", FOOTER]);
  const numberedCardAboveFooter = screenWith([...HISTORY_ROWS, "› 1. Yes, switch now", "  2. No, keep current", "", FOOTER]);

  it.each([
    ["a transcript prompt above a • output row", historyAboveOutput],
    ["a selection card", selectionCard],
    ["a numbered selection card above a real footer", numberedCardAboveFooter],
    ["a busy working row", busyRow],
  ])("%s is never owned, for Enter or delivery readiness", async (_name, screen) => {
    expect(conpty.ownsComposerRows(screen)).toBe(false);
    expect(unix.ownsComposerRows(screen)).toBe(false);
    expect(await enter(screen, "codex")).toEqual({ sent: false, keys: 0 });
    expect(await enter(screen, "native")).toEqual({ sent: false, keys: 0 });
  });

  it.each(["codex", "native"] as const)("no runtime dialog matches the real S-35 screens, so stale /status or tool-call text cannot veto Enter (%s)", mode => {
    for (const screen of [postTurn, fixture("s35-codex-first-turn-composer.json")]) {
      const daemon = gateDaemon(screen, mode);
      const hits = daemon.runtimeDialogs().filter((dialog: any) => (Daemon as any).dialogMatches(dialog, screen)).map((dialog: any) => dialog.description);
      expect(hits).toEqual([]);
    }
  });
  it("a live dialog vetoes Enter even over a real composer", async () => {
    const daemon = gateDaemon(postTurn, "codex");
    vi.spyOn(daemon, "runtimeDialogs").mockReturnValue([{ pattern: /Pane check 2/, keys: [], description: "fixture dialog", holdOnly: true, blocksDelivery: true }]);
    expect(await daemon.sendDeliveryEnter("initial-submit", undefined, { deliveryId: "s35-delivery", attemptNo: 1 })).toBe(false);
    expect(daemon.tmux.sendSpecialKey).not.toHaveBeenCalled();
  });
});
