/**
 * #1328, from a signed-in agy 1.3.1 (the user approved a read-only capture: one sign-in from a scratch copy of the
 * token, two trivial prompts; scratch HOME, private tmux; email and paths redacted in the fixtures).
 *
 * - Busy: the working row is a braille spinner frame + text + "..." (`⣯  Generating...`, or the model's rolled-up
 *   thought: `⣟  The request is to … "no other text...`). No timer, no `(esc to cancel)` on it — the old anchor never
 *   matched, so agy was always idle to AgEnD. Under AgEnD's statusLine the footer is blank while working.
 * - Trust: "Do you trust the contents of this project?" / "> Yes, I trust this folder" / "  No, exit". Enter confirms
 *   the row under the cursor, so it is sent once, only on a verified "Yes" cursor; anything else is held, also at runtime.
 *
 * No CLI, fleet or tmux runs here (bd0c88aa).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityBackend, agyTrustDialogState } from "../src/backend/antigravity.js";
import type { RuntimeDialog } from "../src/backend/types.js";
import { Daemon } from "../src/daemon.js";
import type { InstanceConfig } from "../src/types.js";

const FIX = join(import.meta.dirname, "fixtures");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf-8");
const backend = () => new AntigravityBackend("/nonexistent-agy-1328", "/nonexistent-home", "/nonexistent-agend");

describe("busy: the braille working row", () => {
  const busy = () => backend().getBusyPattern();
  it.each([
    ["Generating, footer hint (no statusLine)", "agy-1.3.1-busy-generating.pane.txt"],
    ["Generating, AgEnD's statusLine (blank footer)", "agy-1.3.1-busy-generating-blank-footer.pane.txt"],
  ])("%s → busy", (_label, name) => {
    expect(busy().test(fixture(name))).toBe(true);
  });

  it.each([
    "agy-1.3.1-idle-after-reply.pane.txt",
    "agy-1.3.1-idle-after-reply-blank-footer.pane.txt",
    "agy-1.3.1-trust-dialog.pane.txt",
    "agy-1.3.1-logged-out.pane.txt",
  ])("%s → not busy", name => {
    expect(busy().test(fixture(name))).toBe(false);
  });

  it("every spinner frame and the rolled-up thought; the shape only, never prose", () => {
    for (const glyph of ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷", "⠋", "⠙"]) {
      expect(busy().test(`> ask\n${glyph}  Generating...\n`), glyph).toBe(true);
    }
    expect(busy().test('⣟  The request is to print numbers 1 through 40. The constraint "no other text...\n')).toBe(true);
    expect(busy().test("⣯  Generating… 12s\n")).toBe(true);
    // not the working row: no ellipsis, quoted mid-line, ellipsis not at the end, braille art, ordinary prose
    expect(busy().test("⣯  Generating the report now\n")).toBe(false);
    expect(busy().test("The spinner shows ⣯  Generating... while it works\n")).toBe(false);
    expect(busy().test("The spinner reads ⣯  Generating...\n")).toBe(false);
    expect(busy().test("⣟  Step one... then step two\n")).toBe(false);
    expect(busy().test("⣿⣿⣿⣿⣿⣿⣿⣿\n")).toBe(false);
    expect(busy().test("Done... the numbers are below\n")).toBe(false);
  });
});

describe("trust: one Enter, only on a verified 'Yes' cursor; otherwise held", () => {
  const TRUST = fixture("agy-1.3.1-trust-dialog.pane.txt");
  const matches = (d: RuntimeDialog, pane: string) => (d.isActive ? d.isActive(pane) : d.pattern.test(pane));
  // The startup scan answers the FIRST match in table order, and skips a one-shot entry it already answered.
  const startup = (pane: string, answered = new Set<string>()) => backend().getStartupDialogs()
    .find(d => matches(d, pane) && !(d.autoResolutionKey && answered.has(d.autoResolutionKey)));
  const runtime = (pane: string) => backend().getRuntimeDialogs().filter(d => matches(d, pane));
  const shape = (d: RuntimeDialog | undefined) => d && { keys: d.keys, hold: d.holdOnly === true, blocks: d.blocksDelivery === true };
  const HOLD = { keys: [], hold: true, blocks: true };

  it("the captured prompt (cursor on Yes) → Enter, once; still up after it → held", () => {
    expect(agyTrustDialogState(TRUST)).toBe("yes");
    const first = startup(TRUST);
    expect(shape(first)).toEqual({ keys: ["Enter"], hold: false, blocks: true });
    expect(first!.autoResolutionKey).toBeTruthy();
    expect(shape(startup(TRUST, new Set([first!.autoResolutionKey!])))).toEqual(HOLD);
  });

  it("cursor on 'No, exit', or none, or two → held, no key", () => {
    const onNo = TRUST.replace("> Yes, I trust this folder", "  Yes, I trust this folder").replace("  No, exit", "> No, exit");
    const none = TRUST.replace("> Yes, I trust this folder", "  Yes, I trust this folder");
    const two = TRUST.replace("  No, exit", "> No, exit");
    for (const pane of [onNo, none, two]) {
      expect(agyTrustDialogState(pane)).toBe("other");
      expect(shape(startup(pane))).toEqual(HOLD);
    }
  });

  it("a trust prompt still up after the startup scan holds deliveries (runtime table), whatever the cursor", () => {
    const onNo = TRUST.replace("> Yes, I trust this folder", "  Yes, I trust this folder").replace("  No, exit", "> No, exit");
    for (const pane of [TRUST, onNo]) expect(runtime(pane).map(shape)).toEqual([HOLD]);
  });

  it("not a live prompt: quoted with conversation below, or absent → nothing matches", () => {
    const quoted = `${TRUST.trimEnd()}\n● the trust prompt again\n> `;
    expect(agyTrustDialogState(quoted)).toBeNull();
    expect(startup(quoted)).toBeUndefined();
    expect(runtime(quoted)).toEqual([]);
    const idle = fixture("agy-1.3.1-idle-after-reply.pane.txt");
    expect(agyTrustDialogState(idle)).toBeNull();
    expect(startup(idle)).toBeUndefined();
    expect(runtime(idle)).toEqual([]);
  });
});

describe("trust on the real startup scan (tmux stubbed, no CLI)", () => {
  const TRUST = fixture("agy-1.3.1-trust-dialog.pane.txt");
  const IDLE = fixture("agy-1.3.1-idle-after-reply.pane.txt");
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  // Each capture returns the next pane; the last one repeats. Keys sent are recorded.
  const scan = async (panes: string[], budgetMs = 800) => {
    const dir = mkdtempSync(join(tmpdir(), "agy-1328-scan-"));
    dirs.push(dir);
    writeFileSync(join(dir, "window-id"), "@1");
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), level: "info" };
    const daemon = new Daemon("agy-1328", {
      working_directory: "/tmp", backend: "antigravity",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, log_level: "silent",
    } as unknown as InstanceConfig, dir, false, new AntigravityBackend(dir, dir, dir), undefined, { child: () => logger } as never) as any;
    const keys: string[] = [];
    let i = 0;
    daemon.tmux = {
      capturePane: vi.fn(async () => panes[Math.min(i++, panes.length - 1)]),
      isWindowAlive: async () => true,
      sendSpecialKey: vi.fn(async (k: string) => { keys.push(k); return true; }),
      sendKeys: vi.fn(async (k: string) => { keys.push(k); return true; }),
    };
    daemon.controlClient = { waitForIdle: async () => {} };
    await daemon.dismissDialogsUntilReady(budgetMs, 0);
    return { keys, daemon };
  };
  // A conversation that quotes the title (or the whole prompt) above agy's ready composer, with or without a draft.
  const [head, composer] = [IDLE.slice(0, IDLE.indexOf("────")), IDLE.slice(IDLE.indexOf("────"))];
  const quoting = (quote: string, draft = "") => `${head.trimEnd()}\n${quote}\n${draft ? composer.replace(/^>[ \t]*$/m, `> ${draft}`) : composer}`;

  it.each([
    ["the title quoted, ready composer", quoting("Do you trust the contents of this project?")],
    ["the title quoted, a draft in the composer", quoting("Do you trust the contents of this project?", "hello from the queue")],
    ["the whole prompt quoted, ready composer", quoting(TRUST.trim())],
    ["the whole prompt quoted, a draft in the composer", quoting(TRUST.trim(), "hello from the queue")],
  ])("%s → zero keys", async (_label, pane) => {
    expect(pane).toMatch(/Do you trust the contents of this project\?/);
    expect((await scan([pane])).keys).toEqual([]);
  });

  it("the live prompt, then the ready screen → exactly one Enter", async () => {
    expect((await scan([TRUST, TRUST, IDLE])).keys).toEqual(["Enter"]);
  });

  it("the live prompt that stays up → one Enter, then held: no second key, deliveries blocked", async () => {
    const { keys, daemon } = await scan([TRUST]);
    expect(keys).toEqual(["Enter"]);
    const probed = await daemon.probeBlockingDialog();
    expect(probed.state).toBe("dialog");
    expect(probed.dialog.holdOnly).toBe(true);
  });

  it("the cursor on 'No, exit' → zero keys, held", async () => {
    const onNo = TRUST.replace("> Yes, I trust this folder", "  Yes, I trust this folder").replace("  No, exit", "> No, exit");
    const { keys, daemon } = await scan([onNo]);
    expect(keys).toEqual([]);
    expect((await daemon.probeBlockingDialog()).state).toBe("dialog");
  });

  it("the cursor moves off 'Yes' between the scan and the key (write-lock re-check) → zero keys", async () => {
    const onNo = TRUST.replace("> Yes, I trust this folder", "  Yes, I trust this folder").replace("  No, exit", "> No, exit");
    expect((await scan([TRUST, onNo])).keys).toEqual([]);
  });
});
