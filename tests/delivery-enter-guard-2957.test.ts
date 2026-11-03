/** The last delivery Enter gate; no account, CLI, fleet or service is started. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Daemon } from "../src/daemon.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";

const pane = (name: string) => readFileSync(join(__dirname, `fixtures/${name}.pane.txt`), "utf8");
const idle = pane("claude-2.1.293-idle-empty");
const pasted = pane("claude-2.1.293-idle-paste-long");
const permission = pane("claude-2.1.316-bash-permission-prompt");
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(screen = permission) {
  const root = mkdtempSync(join(tmpdir(), "agend-enter-guard-"));
  roots.push(root);
  const backend = new ClaudeCodeBackend(root);
  const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
  const daemon: any = new Daemon("private-proof", {
    working_directory: root, backend: "claude-code", log_level: "silent",
  } as never, root, true, backend, undefined, logger as never);
  const order: string[] = [];
  const tmux = {
    getWindowId: () => "@owned",
    capturePane: vi.fn(async () => { order.push("capture"); return screen; }),
    sendSpecialKey: vi.fn(async (_key?: string) => { order.push("Enter"); return true; }),
    getLastSendSpecialKeyError: () => null,
  };
  daemon.tmux = tmux;
  const mark = vi.fn(() => { order.push("durable"); return true; });
  daemon.deliveryOutbox = { markEnterStarted: mark };
  const attempt = { deliveryId: "private-delivery", attemptNo: 1 };
  return { daemon, backend, tmux, mark, attempt, order };
}

it.each(["initial-submit", "idle-to-busy-retry", "stranded-text-retry"])(
  "%s cannot turn a permission card into an approval", async phase => {
    const f = fixture();
    expect(f.backend.readInputRow(permission)).toBeNull();
    expect(f.daemon.inputTransientGuardGeneration).toBeNull();
    expect(await f.daemon.sendDeliveryEnter(phase, undefined, f.attempt)).toBe(false);
    expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(f.mark).not.toHaveBeenCalled();
  },
);
it.each(["", "CLI still painting its input"])("unknown input %j never receives Enter", async screen => {
  const f = fixture(screen);
  expect(await f.daemon.sendDeliveryEnter("initial-submit", undefined, f.attempt)).toBe(false);
  expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
  expect(f.mark).not.toHaveBeenCalled();
});
it("a failed last capture is held before the durable Enter boundary", async () => {
  const f = fixture(pasted);
  f.tmux.capturePane.mockRejectedValueOnce(Error("unreadable"));
  expect(await f.daemon.sendDeliveryEnter("initial-submit", undefined, f.attempt)).toBe(false);
  expect(f.mark).not.toHaveBeenCalled();
  expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
});
it("the real visible composer sends exactly one key, after capture and durable commit", async () => {
  const f = fixture(pasted);
  expect(f.backend.readInputRow(pasted)).not.toBeNull();
  expect(await f.daemon.sendDeliveryEnter("initial-submit", undefined, f.attempt)).toBe(true);
  expect(f.order).toEqual(["capture", "durable", "Enter"]);
  expect(f.tmux.sendSpecialKey).toHaveBeenCalledExactlyOnceWith("Enter");
});
it("a readable busy composer remains usable; this gate does not require idle", async () => {
  const f = fixture(pasted);
  vi.spyOn(f.backend, "getBusyPattern").mockReturnValue(/./);
  expect(await f.daemon.sendDeliveryEnter("queue-submit")).toBe(true);
  expect(f.tmux.sendSpecialKey).toHaveBeenCalledOnce();
});
it("a broken structural reader never falls back to a loose ready glyph", async () => {
  const f = fixture(pasted);
  vi.spyOn(f.backend, "readInputRow").mockImplementation(() => { throw Error("reader failure"); });
  expect(await f.daemon.sendDeliveryEnter("initial-submit")).toBe(false);
  expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
});
it.each(["pane", "window", "spawn", "fence", "stop", "caller"])(
  "a %s change during the final capture retires the Enter", async kind => {
    const f = fixture(pasted);
    const replacement = { ...f.tmux, sendSpecialKey: vi.fn() };
    let allowed = true;
    f.tmux.capturePane.mockImplementationOnce(async () => {
      if (kind === "pane") f.daemon.tmux = replacement;
      else if (kind === "window") f.tmux.getWindowId = () => "@replacement";
      else if (kind === "spawn") f.daemon.spawnGeneration++;
      else if (kind === "fence") f.daemon.launchFenceEpoch++;
      else if (kind === "stop") f.daemon.deliveryWritesStopping = true;
      else allowed = false;
      return pasted;
    });
    expect(await f.daemon.sendDeliveryEnter("initial-submit", () => allowed, f.attempt)).toBe(false);
    expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(replacement.sendSpecialKey).not.toHaveBeenCalled();
    expect(f.mark).not.toHaveBeenCalled();
  },
);
it("a daemon without a concrete pane cannot authorize Enter", async () => {
  const f = fixture(pasted);
  f.tmux.getWindowId = () => "";
  expect(await f.daemon.sendDeliveryEnter("initial-submit")).toBe(false);
  expect(f.tmux.capturePane).not.toHaveBeenCalled();
  expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
});
it("legacy ready glyphs cannot identify the cursor on a numbered card as a composer", async () => {
  const f = fixture();
  f.daemon.backend = { getRuntimeDialogs: () => [], getReadyPattern: () => /❯/ };
  expect(await f.daemon.sendDeliveryEnter("initial-submit")).toBe(false);
  expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
});
it("explicit human card answers still walk the verified cursor and confirm the chosen option", async () => {
  const f = fixture();
  let cursor = 0, answered = false;
  const card = f.backend.getRuntimeDialogs().map(dialog => dialog.remoteCard?.(permission)).find(Boolean)!;
  expect(card).toBeTruthy();
  f.tmux.capturePane.mockImplementation(async () => answered ? idle : permission
    .replace(/ ❯ 1\. Yes/, "   1. Yes").replace(new RegExp(`   ${cursor + 1}\\.`), ` ❯ ${cursor + 1}.`));
  f.tmux.sendSpecialKey.mockImplementation(async (key?: string) => {
    if (key === "Down") cursor++;
    else if (key === "Enter") answered = true;
    else throw Error("Unexpected key");
    return true;
  });
  expect(await f.daemon.answerRemoteCard(card.identity, { kind: "option", n: 4 })).toEqual({ outcome: "answered" });
  expect(cursor).toBe(3);
  expect(answered).toBe(true);
  expect(f.mark).not.toHaveBeenCalled();
});

it("a pane replaced during paste settle cannot receive the old delivery's Enter", async () => {
  const f = fixture(pasted);
  const replacement = { ...f.tmux, sendSpecialKey: vi.fn(async () => true) };
  Object.assign(f.tmux, {
    pasteBuffer: vi.fn(async () => { f.daemon.tmux = replacement; return true; }),
  });
  expect(await f.daemon.writeMessageToPane("[from:private-proof] old pane only", "@owned", false)).toBe(false);
  expect(f.tmux.sendSpecialKey).not.toHaveBeenCalled();
  expect(replacement.sendSpecialKey).not.toHaveBeenCalled();
});
