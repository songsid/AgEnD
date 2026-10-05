/**
 * #829: cancelling a muse turn (Escape) puts the interrupted prompt back into
 * muse's input box, and the next AgEnD delivery was pasted after it — the two
 * were submitted as one message, re-running the cancelled one.
 *
 * Every pane under tests/fixtures/muse-input-829/ is a real capture from muse
 * 1.4.2 (2026-10-05, a scratch muse on a private tmux socket; only the status
 * bar's scratch path was replaced). Live, `C-u C-k BSpace DC` removed one input
 * line per round (all of its rows when it wraps) with the cursor at either end,
 * did nothing on an empty box, and cleared a collapsed `[Pasted Content N
 * chars]` in one round. The restored prompt is on screen in the same frame the
 * busy line disappears. The wrap-* frames are long pastes at 80 columns, with
 * the exact text pasted beside each (`*.payload.txt`).
 *
 * Nothing here starts muse, tmux or a fleet: the pane is a simulated input box
 * rendered into the captured frame, and keys act on it the way they did live.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import { MuseBackend, museDraftShows, museInputBox } from "../src/backend/muse.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { CodexBackend } from "../src/backend/codex.js";
import { KiroBackend } from "../src/backend/kiro.js";

const pane = (name: string) => readFileSync(join(__dirname, "fixtures", "muse-input-829", `${name}.pane.txt`), "utf8");
const muse = new MuseBackend(mkdtempSync(join(tmpdir(), "agend-muse-829-")));
/** The box's rows as text: "" when empty, null when the screen is not muse's layout. */
const draftText = (p: string) => { const d = muse.inputDraft(p); return d === null ? null : d.rows.join("\n"); };

describe("reading muse's input box (real 1.4.2 frames)", () => {
  it.each([
    ["empty", ""],
    ["cleared-after-escape", ""],
    ["busy", ""],                                   // the cancelled prompt's transcript echo is not the box
    ["single-line-human", "a single line draft"],
    ["multi-line-agend", "[user:probe via telegram, id:1] line one of the draft\nline two of the draft\nline three of the draft\nline four ends here"],
    ["restored-after-escape", "[user:probe via telegram, id:1] Count from 1 to 300, one number per line.\nDo not use any tools."],
    ["long-paste-placeholder", "[Pasted Content 3000 chars]"],
  ])("%s", (name, text) => {
    expect(draftText(pane(name))).toBe(text);
  });

  it("a screen that is not muse's layout is unrecognised, never empty", () => {
    for (const other of ["muse-api-key-rejected.pane.txt", "codex-update-picker.pane.txt"]) {
      expect(draftText(readFileSync(join(__dirname, "fixtures", other), "utf8")), other).toBeNull();
    }
    expect(draftText("")).toBeNull();
    // No status bar under the box: the bottom is not the live input.
    const lines = pane("restored-after-escape").trimEnd().split("\n");
    expect(draftText(lines.slice(0, -1).join("\n"))).toBeNull();
    // Something other than the status bar under the bottom separator (a dialog's hint row).
    expect(draftText([...lines.slice(0, -1), "  Enter to confirm, Esc to cancel"].join("\n"))).toBeNull();
  });

  it("everything under the box must be the status bar: an old box above a chooser is not the live input (#1192 review)", () => {
    const lines = pane("empty").trimEnd().split("\n");
    const prompt = lines.findIndex(l => /^❯\s*$/.test(l));
    lines[prompt] = "❯ [from:quoted] an old box";
    const chooser = [...lines, "  1 Allow this command", "  Enter to choose"].join("\n");
    expect(museInputBox(lines.join("\n"))?.rows, "control: the same box over a plain status bar is read").toEqual(["[from:quoted] an old box"]);
    expect(draftText(chooser)).toBeNull();
    expect(draftText([...lines, "  2. Deny"].join("\n"))).toBeNull();
    expect(draftText([...lines, "  ◇ Thinking (2s · esc to interrupt)"].join("\n"))).toBeNull();
    // A long cwd wrapping onto a second status row is still the bar.
    expect(draftText([...lines, "  rest/of/a/long/working/directory"].join("\n"))).toBe("[from:quoted] an old box");
  });

  it("the box must open with a separator directly above its ❯ row", () => {
    const lines = pane("restored-after-escape").split("\n");
    const first = lines.findIndex(l => l.startsWith("❯ [user:"));
    expect(museInputBox(lines.join("\n"))).not.toBeNull();
    lines[first - 1] = "  (transcript text)";
    expect(museInputBox(lines.join("\n"))).toBeNull();
  });

  it("a row that is not indented ends the box: transcript above is never read as input", () => {
    const broken = pane("restored-after-escape").replace("  Do not use any tools.", "Do not use any tools.");
    expect(museInputBox(broken)).toBeNull();
  });

  it("a long paste wraps the way muse wraps it, and only that way proves it is the paste (live 80 columns)", () => {
    for (const name of ["wrap-words", "wrap-long-word", "wrap-double-space", "wrap-multiline"]) {
      const draft = muse.inputDraft(pane(name))!;
      const text = readFileSync(join(__dirname, "fixtures", "muse-input-829", `${name}.payload.txt`), "utf8");
      expect(draft.width, name).toBe(80);
      expect(draft.rows.length, name).toBeGreaterThan(1);
      expect(muse.inputDraftShows(draft, text), name).toBe(true);
      // One space more or less, or a line break for a space, is different
      // text — anywhere but where muse broke the row: it drops the spaces
      // there, so no capture can show what was typed at that point.
      const breaks = new Set<number>();
      let pos = 0;
      for (const row of draft.rows) {
        pos = text.indexOf(row, pos) + row.length;
        for (let k = pos; text[k] === " "; k++) breaks.add(k);
      }
      for (const [k, ch] of [...text].entries()) {
        if (ch !== " " || breaks.has(k)) continue;
        expect(muse.inputDraftShows(draft, text.slice(0, k) + text.slice(k + 1)), `${name} without the space at ${k}`).toBe(false);
        expect(muse.inputDraftShows(draft, text.slice(0, k) + "  " + text.slice(k + 1)), `${name} with two at ${k}`).toBe(false);
        expect(muse.inputDraftShows(draft, text.slice(0, k) + "\n" + text.slice(k + 1)), `${name} with a newline at ${k}`).toBe(false);
      }
      // The same rows at another width would not have wrapped there.
      if (name !== "wrap-multiline") expect(muse.inputDraftShows({ ...draft, width: 120 }, text), `${name} at 120`).toBe(false);
      // A row more or less is a different box.
      expect(muse.inputDraftShows({ ...draft, rows: [...draft.rows, "x"] }, text)).toBe(false);
      expect(muse.inputDraftShows({ ...draft, rows: draft.rows.slice(0, -1) }, text)).toBe(false);
    }
  });

  it("a wrap is judged only for text whose width is its length; anything else must fit one row", () => {
    expect(museDraftShows(["[from:leader] 中文"], 80, "[from:leader] 中文")).toBe(true);
    expect(museDraftShows(["[from:leader] 中文 one", "two"], 80, "[from:leader] 中文 one two")).toBe(false);
    // By length this row is full enough to wrap; on screen it is wider, so where muse broke it cannot be proven.
    const wide = `[from:leader] ${"中".repeat(30)} ${"a".repeat(25)}`;
    expect(wide.length + 1 + 6).toBeGreaterThan(76);
    expect(museDraftShows([wide, "bbbbbb"], 80, `${wide} bbbbbb`)).toBe(false);
    expect(museDraftShows(["[Pasted Content 3000 chars]"], 80, "y".repeat(3000))).toBe(false);
    expect(museDraftShows([], 80, "")).toBe(false);
  });

  it.each([["U+00A0", "\u00a0"], ["U+202F", "\u202f"], ["U+3000", "\u3000"]])("a %s the capture shows is part of the draft, not padding (r3 review)", (_name, space) => {
    const lines = pane("empty").trimEnd().split("\n");
    const prompt = lines.findIndex(l => /^❯\s*$/.test(l));
    const ours = "[from:leader] use /tmp/foobar";
    lines[prompt] = `❯ ${ours}${space}`;
    const draft = muse.inputDraft(lines.join("\n"))!;
    expect(draft.rows).toEqual([`${ours}${space}`]);
    expect(muse.inputDraftShows(draft, ours)).toBe(false);
    expect(muse.inputDraftShows(draft, `${ours}${space}`)).toBe(true);
    // The same on a continuation row.
    lines[prompt] = `❯ ${ours}\n  second row${space}`;
    const two = muse.inputDraft(lines.join("\n"))!;
    expect(two.rows).toEqual([ours, `second row${space}`]);
    expect(muse.inputDraftShows(two, `${ours}\nsecond row`)).toBe(false);
    // A box holding only that character is not empty.
    lines[prompt] = `❯ ${space}`;
    expect(muse.inputDraft(lines.join("\n"))!.rows).toEqual([space]);
    // Trailing ASCII spaces are muse's padding, and a box of them is empty.
    lines[prompt] = `❯ ${ours}   `;
    expect(muse.inputDraftShows(muse.inputDraft(lines.join("\n"))!, ours)).toBe(true);
    lines[prompt] = "❯    ";
    expect(muse.inputDraft(lines.join("\n"))!.rows).toEqual([]);
  });

  it("a round removes a whole line, all its rows: what is left is the first rows, unchanged (live)", () => {
    const one = muse.inputDraft(pane("wrap-after-one-round"))!.rows;
    const two = muse.inputDraft(pane("wrap-after-two-rounds"))!.rows;
    expect(one).toEqual(["[from:leader] line one", "second line is long enough that it has to wrap onto another row in the box ok"]);
    expect(two).toEqual(["[from:leader] line one"]);
  });

  it("clear keys are muse's own delete bindings, never Ctrl+C (which arms quit)", () => {
    expect(muse.getClearInputKeys()).toEqual(["C-u", "C-k", "BSpace", "DC"]);
  });
});

/** Muse's input box as it behaved live, rendered into a real frame. */
class FakeMuseBox {
  rows: string[] = [];
  cursorAtStart = false;
  /** Rounds the next clears ignore (a CLI that swallowed the keys). */
  deaf = 0;
  pastes: Array<{ before: string[]; text: string }> = [];
  submitted: string[] = [];
  keyRounds = 0;
  /** How long muse takes to apply a round of keys. */
  lagMs = 0;
  pendingPaste = "";

  render(): string {
    const frame = pane("empty");
    if (this.rows.length === 0) return frame;
    const box = this.rows.map((r, i) => (i === 0 ? `❯ ${r}` : `  ${r}`)).join("\n");
    return frame.replace(/^❯ ?$/m, box);
  }

  keys(keys: readonly string[]) {
    expect(keys).toEqual(["C-u", "C-k", "BSpace", "DC"]);
    this.keyRounds++;
    if (this.deaf > 0) { this.deaf--; return; }
    const apply = () => {
      if (this.rows.length === 0) return;
      if (this.cursorAtStart) this.rows.shift(); else this.rows.pop();
    };
    if (this.lagMs > 0) setTimeout(apply, this.lagMs); else apply();
  }

  paste(text: string) {
    this.pastes.push({ before: [...this.rows], text });
    this.pendingPaste = text;
    const lines = text.split("\n");
    if (this.rows.length === 0) this.rows = lines;
    else { this.rows[this.rows.length - 1] += lines[0]; this.rows.push(...lines.slice(1)); }
  }

  enter() {
    this.submitted.push(this.rows.join("\n"));
    this.rows = [];
  }
}

const dirs: string[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeDaemon(backend: unknown = muse) {
  const dir = mkdtempSync(join(tmpdir(), "agend-muse-829-daemon-")); dirs.push(dir);
  writeFileSync(join(dir, "window-id"), "@9");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("muse-829", {
    working_directory: "/tmp",
    backend: "muse",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, backend as any, undefined, { child: () => logger } as any) as any;
  const box = new FakeMuseBox();
  const specialKeys: string[] = [];
  daemon.tmux = {
    capturePane: vi.fn(async () => box.render()),
    isWindowAlive: async () => true,
    sendKeySequence: vi.fn(async (keys: readonly string[]) => { box.keys(keys); return true; }),
    sendSpecialKey: vi.fn(async (k: string) => { specialKeys.push(k); if (k === "Enter") box.enter(); return true; }),
    sendKeys: vi.fn(async () => true),
    pasteBuffer: vi.fn(async (text: string) => { box.paste(text); return true; }),
    getWindowId: () => "@9",
    getLastPasteError: () => null,
    isLastPasteFailureRecoverable: () => true,
    getLastSendSpecialKeyError: () => null,
  };
  daemon.controlClient = {
    isIdle: () => true,
    waitUntilIdle: async () => true,
    waitForIdle: async () => true,
    hasOutputSince: () => true,
    getLastOutputAt: () => 0,
    getObservationResetAt: () => 0,
  };
  const events: string[] = [];
  for (const e of ["message_queued", "message_delivered", "message_failed"]) daemon.on(e, () => events.push(e));
  return { daemon, box, logger, events, specialKeys };
}

async function settle<T>(promise: Promise<T>, maxMs = 120_000, stepMs = 100): Promise<T> {
  let done = false; let result!: T;
  void promise.then(v => { result = v; done = true; });
  for (let t = 0; !done && t <= maxMs; t += stepMs) await vi.advanceTimersByTimeAsync(stepMs);
  if (!done) throw new Error("did not settle");
  return result;
}

const RESTORED = ["[user:alice via telegram, id:1] Count from 1 to 300, one number per line.", "Do not use any tools."];
const NEXT = "[from:leader] the next message";
const deliverText = (daemon: any, text: string) => settle(daemon.deliverMessage(text, { chatId: "c", messageId: "m" }, {}) as Promise<boolean>);
const deliver = (daemon: any) => deliverText(daemon, NEXT);

/**
 * The real sequence: AgEnD delivers a prompt, the turn is cancelled, and muse
 * puts that prompt back in the box (`shown`, by default the prompt itself).
 */
async function cancelledAfter(daemon: any, box: FakeMuseBox, prompt: string, shown: string[] = prompt.split("\n")) {
  await deliverText(daemon, prompt);
  expect(box.submitted[0]).toBe(prompt);
  box.pastes = []; box.submitted = [];
  daemon.tmux.pasteBuffer.mockClear();
  box.rows = [...shown];
}
const lastPaste = (box: FakeMuseBox) => box.pastes[box.pastes.length - 1];

describe("a delivery after a cancel (muse)", () => {
  it.each([["end", false], ["start", true]])("clears the restored prompt first, then pastes alone (cursor at the %s)", async (_where, atStart) => {
    const { daemon, box } = makeDaemon();
    await cancelledAfter(daemon, box, RESTORED.join("\n"));
    box.cursorAtStart = atStart;
    await deliver(daemon);
    expect(box.pastes).toHaveLength(1);
    expect(box.pastes[0].before, "pasted onto the cancelled prompt").toEqual([]);
    expect(box.submitted[0]).toBe(NEXT);
  });


  it("an empty box gets no keys at all", async () => {
    const { daemon, box } = makeDaemon();
    await deliver(daemon);
    expect(box.keyRounds).toBe(0);
    expect(box.pastes).toHaveLength(1);
  });

  it("each round waits for the box to change: one round per row, no blind volley", async () => {
    const { daemon, box } = makeDaemon();
    await cancelledAfter(daemon, box, "[from:leader] a\nb\nc\nd\ne");
    await deliver(daemon);
    expect(box.keyRounds).toBe(5);
    expect(lastPaste(box).before).toEqual([]);
  });

  it("a muse that applies keys late is waited for, not sent extra rounds", async () => {
    const { daemon, box } = makeDaemon();
    await cancelledAfter(daemon, box, RESTORED.join("\n"));
    box.lagMs = 300;
    await deliver(daemon);
    expect(lastPaste(box).before).toEqual([]);
    expect(box.keyRounds).toBe(RESTORED.length);
  });

  it("a box that does not empty fails the delivery and writes nothing", async () => {
    const { daemon, box, logger, events } = makeDaemon();
    await cancelledAfter(daemon, box, RESTORED.join("\n"));
    box.deaf = 1_000;
    const ok = await deliver(daemon);
    expect(ok).toBe(false);
    expect(box.pastes).toEqual([]);
    expect(box.submitted).toEqual([]);
    expect(events).toContain("message_failed");
    expect(box.keyRounds, "bounded by the rows it saw").toBeLessThanOrEqual(RESTORED.length + 3);
    expect(JSON.stringify(logger.error.mock.calls)).toContain("did not empty");
  });

  it("keys that cannot be sent fail the delivery and write nothing", async () => {
    const { daemon, box } = makeDaemon();
    await cancelledAfter(daemon, box, RESTORED.join("\n"));
    daemon.tmux.sendKeySequence = vi.fn(async () => false);
    expect(await deliver(daemon)).toBe(false);
    expect(box.pastes).toEqual([]);
    expect(daemon.tmux.sendKeySequence, "stops at the first refusal").toHaveBeenCalledTimes(1);
  });

  it("an unreadable screen mid-clear fails rather than pastes", async () => {
    const { daemon, box } = makeDaemon();
    await cancelledAfter(daemon, box, RESTORED.join("\n"));
    const real = daemon.tmux.capturePane;
    daemon.tmux.capturePane = vi.fn(async () => (box.keyRounds > 0 ? "garbage" : real()));
    expect(await deliver(daemon)).toBe(false);
    expect(box.pastes).toEqual([]);
    expect(box.keyRounds, "no more keys into a screen it cannot read").toBe(1);
  });

  it("a capture that fails before anything is read fails closed: no keys, no paste (#1192 review)", async () => {
    const { daemon, box, events } = makeDaemon();
    await cancelledAfter(daemon, box, RESTORED.join("\n"));
    const real = daemon.tmux.capturePane;
    let failNext = false;
    // Readiness reads succeed; the box read is the one that throws.
    daemon.clearRestoredInputDraft = new Proxy(daemon.clearRestoredInputDraft, {
      apply: (fn, self, args) => { failNext = true; return Reflect.apply(fn, self, args); },
    });
    daemon.tmux.capturePane = vi.fn(async () => { if (failNext) { failNext = false; throw new Error("tmux: no server"); } return real(); });
    expect(await deliver(daemon)).toBe(false);
    expect(box.keyRounds).toBe(0);
    expect(box.pastes).toEqual([]);
    expect(box.rows).toEqual(RESTORED);
    expect(events).toContain("message_failed");
  });
});

describe("only AgEnD's own paste is cleared — ownership is the payload, not its look (#1192 review)", () => {
  async function refused(rows: string[], setup?: (daemon: any, box: FakeMuseBox) => Promise<void>) {
    const { daemon, box, logger, events } = makeDaemon();
    if (setup) await setup(daemon, box);
    box.rows = [...rows];
    const ok = await deliver(daemon);
    expect(ok).toBe(false);
    expect(box.keyRounds).toBe(0);
    expect(box.rows).toEqual(rows);
    expect(box.pastes).toEqual([]);
    expect(events).toContain("message_failed");
    expect(JSON.stringify(logger.warn.mock.calls)).toContain("did not put there");
  }

  it("a plain draft somebody typed", () => refused(["a single line draft"]));

  it("typed text that quotes AgEnD's marker", () => refused(["Explain this literal [from:leader] marker"]));

  it("a message that looks exactly like a delivery AgEnD never made", () => refused([...RESTORED]));

  it("a collapsed paste AgEnD did not make", () =>
    refused(["[Pasted Content 3000 chars]"]));

  it("a collapsed paste with the very length of AgEnD's own: its content cannot be seen, so it is not proof (r2 review)", () =>
    refused(["[Pasted Content 3000 chars]"], async (daemon, box) => {
      await deliverText(daemon, "y".repeat(3000)); box.pastes = []; box.submitted = [];
    }));

  it("AgEnD's restored placeholder with somebody's typing after it", () =>
    refused(["[Pasted Content 3000 chars] and one more thing"], async (daemon, box) => {
      await deliverText(daemon, "y".repeat(3000)); box.pastes = []; box.submitted = [];
    }));

  it("text that differs from AgEnD's only in a space is somebody else's (r2 review)", () =>
    refused(["[from:leader] use /tmp/foo bar"], async (daemon, box) => {
      await deliverText(daemon, "[from:leader] use /tmp/foobar"); box.pastes = []; box.submitted = [];
    }));

  it.each(["\u00a0", "\u202f", "\u3000"])("AgEnD's text plus a trailing %j somebody typed is somebody else's (r3 review)", space =>
    refused([`[from:leader] use /tmp/foobar${space}`], async (daemon, box) => {
      await deliverText(daemon, "[from:leader] use /tmp/foobar"); box.pastes = []; box.submitted = [];
    }));

  it("a line break where AgEnD's text had none is somebody else's", () =>
    refused(["[from:leader] use", "/tmp/foobar"], async (daemon, box) => {
      await deliverText(daemon, "[from:leader] use /tmp/foobar"); box.pastes = []; box.submitted = [];
    }));

  it("a paste that lands while the CLI is replaced belongs to the old CLI, not the new one (r2 review)", () =>
    refused([...RESTORED], async (daemon, box) => {
      const paste = daemon.tmux.pasteBuffer;
      daemon.tmux.pasteBuffer = vi.fn(async (text: string) => { daemon.spawnGeneration++; return paste(text); });
      await deliverText(daemon, RESTORED.join("\n")).catch(() => false);
      daemon.tmux.pasteBuffer = paste;
      box.pastes = []; box.submitted = [];
      daemon.tmux.pasteBuffer.mockClear();
    }));

  it("a system paste that lands while the CLI is replaced is not the new CLI's either", () =>
    refused(["[system:notice] check in"], async (daemon, box) => {
      const paste = daemon.tmux.pasteBuffer;
      daemon.tmux.pasteBuffer = vi.fn(async (text: string) => { daemon.spawnGeneration++; return paste(text); });
      await settle(daemon.submitSystemPaste("[system:notice] check in", "test") as Promise<boolean>);
      daemon.tmux.pasteBuffer = paste;
      box.pastes = []; box.submitted = [];
      daemon.tmux.pasteBuffer.mockClear();
    }));

  it("AgEnD's restored prompt with somebody's typing after it", () =>
    refused([...RESTORED, "please also check the logs"], async (daemon, box) => {
      await deliverText(daemon, RESTORED.join("\n")); box.pastes = []; box.submitted = [];
    }));

  it("a paste from before the CLI was respawned is not this pane's", async () => {
    await refused([...RESTORED], async (daemon, box) => {
      await deliverText(daemon, RESTORED.join("\n")); box.pastes = []; box.submitted = [];
      daemon.spawnGeneration++;
    });
  });

  it("a round must leave the first or last lines as they were — a middle line left over is not a clearing round", async () => {
    const { daemon, box, events } = makeDaemon();
    await cancelledAfter(daemon, box, "[from:leader] a\nb\nc");
    daemon.tmux.sendKeySequence = vi.fn(async (keys: readonly string[]) => { box.keys(keys); box.rows = ["b"]; return true; });
    expect(await deliver(daemon)).toBe(false);
    expect(daemon.tmux.sendKeySequence).toHaveBeenCalledTimes(1);
    expect(box.rows).toEqual(["b"]);
    expect(events).toContain("message_failed");
  });

  it("clearing stops the moment the box holds anything else, and leaves it", async () => {
    const { daemon, box, events } = makeDaemon();
    await cancelledAfter(daemon, box, "[from:leader] a\nb\nc");
    // Somebody types over it right after the first round.
    daemon.tmux.sendKeySequence = vi.fn(async (keys: readonly string[]) => { box.keys(keys); box.rows = ["new human text"]; return true; });
    expect(await deliver(daemon)).toBe(false);
    expect(daemon.tmux.sendKeySequence).toHaveBeenCalledTimes(1);
    expect(box.rows).toEqual(["new human text"]);
    expect(box.pastes).toEqual([]);
    expect(events).toContain("message_failed");
  });
});

describe("the lifecycle fence holds across every new wait (#1192 review)", () => {
  /** Run `during` while the first capture after the given number of key rounds is in flight. */
  function hookCapture(daemon: any, box: FakeMuseBox, afterRounds: number, during: () => void) {
    const real = daemon.tmux.capturePane;
    let fired = false;
    daemon.tmux.capturePane = vi.fn(async () => {
      const frame = await real();
      if (!fired && box.keyRounds === afterRounds && box.pastes.length === 0 && daemon.clearing) { fired = true; during(); }
      return frame;
    });
  }
  function markClearing(daemon: any) {
    const original = daemon.clearRestoredInputDraft.bind(daemon);
    daemon.clearRestoredInputDraft = async (...args: unknown[]) => {
      daemon.clearing = true;
      try { return await original(...args); } finally { daemon.clearing = false; }
    };
  }

  it.each([
    ["the fleet stops it", (d: any) => d.fenceDeliveryWritesForStop()],
    ["its monitors freeze", (d: any) => { d.runtimeMonitorsFrozen = true; }],
  ])("%s before the first key: no key, no paste, no ❌", async (_name, fence) => {
    const { daemon, box, events } = makeDaemon();
    await cancelledAfter(daemon, box, RESTORED.join("\n"));
    markClearing(daemon);
    hookCapture(daemon, box, 0, () => fence(daemon));
    expect(await deliver(daemon)).toBe(false);
    expect(box.keyRounds).toBe(0);
    expect(box.pastes).toEqual([]);
    expect(events).not.toContain("message_failed");
  });

  it("the fleet stops it during the last verification: the emptied box is not written", async () => {
    const { daemon, box, events } = makeDaemon();
    await cancelledAfter(daemon, box, RESTORED.join("\n"));
    markClearing(daemon);
    hookCapture(daemon, box, RESTORED.length, () => daemon.fenceDeliveryWritesForStop());
    expect(await deliver(daemon)).toBe(false);
    expect(box.rows).toEqual([]);
    expect(box.pastes).toEqual([]);
    expect(daemon.tmux.pasteBuffer).not.toHaveBeenCalled();
    expect(events).not.toContain("message_failed");
  });

  it("the fleet stops it after the box is clear, during the write's own baseline read: nothing is pasted", async () => {
    const { daemon, box, events } = makeDaemon();
    await cancelledAfter(daemon, box, RESTORED.join("\n"));
    markClearing(daemon);
    const real = daemon.tmux.capturePane;
    let fired = false;
    daemon.tmux.capturePane = vi.fn(async () => {
      const frame = await real();
      if (!fired && !daemon.clearing && box.keyRounds === RESTORED.length && box.rows.length === 0) { fired = true; daemon.fenceDeliveryWritesForStop(); }
      return frame;
    });
    expect(await deliver(daemon)).toBe(false);
    expect(fired).toBe(true);
    expect(daemon.tmux.pasteBuffer).not.toHaveBeenCalled();
    expect(events).not.toContain("message_failed");
  });

  it("a stop during the first read, with somebody's draft on screen: not attempted — no ❌, no key", async () => {
    const { daemon, box, events } = makeDaemon();
    markClearing(daemon);
    box.rows = ["a draft somebody is typing"];
    hookCapture(daemon, box, 0, () => daemon.fenceDeliveryWritesForStop());
    expect(await deliver(daemon)).toBe(false);
    expect(box.keyRounds).toBe(0);
    expect(events).not.toContain("message_failed");
  });

  it("a stop during a round's read, as somebody types: not attempted — no ❌, nothing more sent", async () => {
    const { daemon, box, events } = makeDaemon();
    await cancelledAfter(daemon, box, RESTORED.join("\n"));
    markClearing(daemon);
    hookCapture(daemon, box, 1, () => daemon.fenceDeliveryWritesForStop());
    daemon.tmux.sendKeySequence = vi.fn(async (keys: readonly string[]) => { box.keys(keys); box.rows = ["somebody typed this"]; return true; });
    expect(await deliver(daemon)).toBe(false);
    expect(daemon.tmux.sendKeySequence).toHaveBeenCalledTimes(1);
    expect(events).not.toContain("message_failed");
  });

  it("a stop while the keys are being sent (and they fail): not attempted — no ❌", async () => {
    const { daemon, box, events } = makeDaemon();
    await cancelledAfter(daemon, box, RESTORED.join("\n"));
    daemon.tmux.sendKeySequence = vi.fn(async () => { daemon.fenceDeliveryWritesForStop(); return false; });
    expect(await deliver(daemon)).toBe(false);
    expect(box.pastes).toEqual([]);
    expect(events).not.toContain("message_failed");
  });

  it("a respawn during the write's own baseline read redoes the delivery into the new CLI", async () => {
    const { daemon, box } = makeDaemon();
    await cancelledAfter(daemon, box, RESTORED.join("\n"));
    markClearing(daemon);
    const real = daemon.tmux.capturePane;
    let generationAtPaste = -1;
    const paste = daemon.tmux.pasteBuffer;
    daemon.tmux.pasteBuffer = vi.fn(async (text: string) => { generationAtPaste = daemon.spawnGeneration; return paste(text); });
    let fired = false;
    daemon.tmux.capturePane = vi.fn(async () => {
      const frame = await real();
      if (!fired && !daemon.clearing && box.keyRounds === RESTORED.length && box.rows.length === 0) { fired = true; daemon.spawnGeneration++; }
      return frame;
    });
    await deliver(daemon);
    expect(fired).toBe(true);
    expect(daemon.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(generationAtPaste, "written only after the redo, into the new generation").toBe(daemon.spawnGeneration);
    expect(box.submitted[0]).toBe(NEXT);
  });

  it("a pause whose quit failed resumes the monitors — the attempt is still stale, nothing is sent (r2 review)", async () => {
    const { daemon, box, events } = makeDaemon();
    await cancelledAfter(daemon, box, RESTORED.join("\n"));
    markClearing(daemon);
    // What pause() does when its quit fails: freeze (epoch moves), then resume (frozen=false again).
    hookCapture(daemon, box, 0, () => { daemon.freezeRuntimeMonitors(); daemon.runtimeMonitorsFrozen = false; });
    expect(await deliver(daemon)).toBe(false);
    expect(box.keyRounds).toBe(0);
    expect(box.rows).toEqual(RESTORED);
    expect(box.pastes).toEqual([]);
    expect(events).not.toContain("message_failed");
  });

  it("a stop during a paste retry's recovery wait: the retry does not paste (r2 review)", async () => {
    const { daemon, box, events } = makeDaemon();
    const paste = daemon.tmux.pasteBuffer;
    let calls = 0;
    daemon.tmux.pasteBuffer = vi.fn(async (text: string) => (++calls === 1 ? false : paste(text)));
    daemon.recoverWindow = vi.fn(async () => { daemon.fenceDeliveryWritesForStop(); return "@9"; });
    expect(await deliver(daemon)).toBe(false);
    expect(daemon.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(box.pastes).toEqual([]);
    expect(events).not.toContain("message_failed");
  });

  it("a respawn mid-clear: no key reaches the replacement, whose draft is somebody's", async () => {
    const { daemon, box } = makeDaemon();
    await cancelledAfter(daemon, box, RESTORED.join("\n"));
    markClearing(daemon);
    // The replacement CLI comes up with a person's draft; the in-flight capture
    // still returns the old pane's frame.
    hookCapture(daemon, box, 1, () => {
      daemon.spawnGeneration++;
      box.rows = ["somebody's draft in the new CLI"];
    });
    await deliver(daemon);
    expect(box.keyRounds, "the stale round only").toBe(1);
    expect(box.rows).toEqual(["somebody's draft in the new CLI"]);
    expect(box.pastes).toEqual([]);
  });
});

describe("an unrecognised screen keeps today's behaviour (muse)", () => {
  it("no keys are sent, and the delivery proceeds as before", async () => {
    const { daemon, box } = makeDaemon();
    expect(await daemon.clearRestoredInputDraft(false, () => true)).toBe("clear");
    daemon.tmux.capturePane = vi.fn(async () => readFileSync(join(__dirname, "fixtures", "muse-api-key-rejected.pane.txt"), "utf8"));
    expect(await daemon.clearRestoredInputDraft(false, () => true)).toBe("clear");
    expect(box.keyRounds).toBe(0);
  });

  it("a native-queue hand-off is not touched", async () => {
    const { daemon, box } = makeDaemon();
    await cancelledAfter(daemon, box, RESTORED.join("\n"));
    expect(await daemon.clearRestoredInputDraft(true, () => true)).toBe("clear");
    expect(box.keyRounds).toBe(0);
  });
});

describe("other backends send no extra keys", () => {
  const dir = () => { const d = mkdtempSync(join(tmpdir(), "agend-829-other-")); dirs.push(d); return d; };
  it.each([
    ["claude-code", () => new ClaudeCodeBackend(dir())],
    ["codex", () => new CodexBackend(dir())],
    ["kiro-cli", () => new KiroBackend(dir())],
  ])("%s", async (_name, make) => {
    const backend = make() as any;
    expect(backend.getClearInputKeys).toBeUndefined();
    expect(backend.inputDraftText).toBeUndefined();
    const { daemon, box } = makeDaemon(backend);
    box.rows = [...RESTORED];
    expect(await daemon.clearRestoredInputDraft(false, () => true)).toBe("clear");
    expect(daemon.tmux.sendKeySequence).not.toHaveBeenCalled();
    expect(daemon.tmux.capturePane).not.toHaveBeenCalled();
  });
});
