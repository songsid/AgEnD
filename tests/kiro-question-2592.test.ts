/**
 * #2592: kiro's V3 shows the agent's question to the user as a card in place of the composer, and main read that pane as
 * an idle composer. A delivered message's paste turned the card into a free answer and its Enter submitted it: the agent
 * got the person's message as the answer to a question nobody read (tests/fixtures/kiro-question-2592, captured live
 * from 2.34.0 at 120 and 80 columns and from 2.33.1 at 120; the card is unchanged between them). The user decided to
 * hold it: no delivery and no key until the person answers it in the pane. The daemon-level checks below cover this hold
 * and #2587's MCP input card the same way — held, never keyed, reported after a minute, and clear once answered.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeDialog } from "../src/backend/types.js";
import { KiroBackend, kiroMcpInputRequestActive, kiroQuestionCardActive, probeKiroCliCompatibility } from "../src/backend/kiro.js";
import { Daemon } from "../src/daemon.js";

const DIR = join(import.meta.dirname, "fixtures", "kiro-question-2592");
const MCP_DIR = join(import.meta.dirname, "fixtures", "kiro-2.34.0-audit");
const pane = (name: string) => readFileSync(join(DIR, `${name}.pane.txt`), "utf-8");
const mcpPane = (name: string) => readFileSync(join(MCP_DIR, `${name}.pane.txt`), "utf-8");
const HELP_234 = readFileSync(join(import.meta.dirname, "fixtures", "kiro-help", "chat-help-2.34.0.txt"), "utf-8");
const compat = () => probeKiroCliCompatibility("/fake/kiro-cli", (_bin, args) => (args[0] === "--version" ? "kiro-cli 2.34.0\n" : HELP_234));
const backend = () => {
  const b = new KiroBackend("/tmp/kiro-2592", compat());
  (b as unknown as { activeTrustAll: boolean }).activeTrustAll = true;
  return b;
};
const active = (dialogs: RuntimeDialog[], screen: string) =>
  dialogs.filter(d => (d.isActive ? d.isActive(screen) : (d.pattern.lastIndex = 0, d.pattern.test(screen))));
const QUESTION_HOLD = "Kiro agent is asking a question — answer it in the instance pane";
const MCP_HOLD = "Kiro MCP server is asking for input — answer it in the instance pane";
const CAPTURES = [["2.34.0", "120"], ["2.34.0", "80"], ["2.33.1", "120"]] as const;
const CARDS = ["40-question", "41-question-paste", "50-question-rich", "51-question-suboptions", "52-question-suboptions-back"];
const GONE = ["42-question-paste-enter", "43-after-turn", "53-question-esc", "59-end"];

describe("#2592 kiro V3's Question card is held for the person", () => {
  it.each(CAPTURES.flatMap(([version, width]) => CARDS.map(step => [version, width, step])))("%s at %s columns, %s: held — no key, no delivery", (version, width, step) => {
    const screen = pane(`${version}-${width}-${step}`);
    expect(kiroQuestionCardActive(screen)).toBe(true);
    expect(kiroMcpInputRequestActive(screen)).toBe(false);
    const holds = active(backend().getRuntimeDialogs(), screen);
    expect(holds.map(d => d.description)).toEqual([QUESTION_HOLD]);
    expect(holds[0]!.keys).toEqual([]);
    expect([holds[0]!.holdOnly, holds[0]!.blocksDelivery, holds[0]!.inputBlocked]).toEqual([true, true, true]);
    expect(active(backend().getStartupDialogs(), screen).map(d => d.description)).not.toContain(QUESTION_HOLD);
  });

  it.each(CAPTURES.flatMap(([version, width]) => GONE.map(step => [version, width, step])))("%s at %s columns, %s: answered or cancelled — nothing held", (version, width, step) => {
    const screen = pane(`${version}-${width}-${step}`);
    expect(kiroQuestionCardActive(screen)).toBe(false);
    expect(active(backend().getRuntimeDialogs(), screen)).toEqual([]);
  });

  it("the two cards are told apart: the MCP input card is not a question, the question is not an MCP request", () => {
    for (const step of ["10-form", "20-url"]) expect(kiroQuestionCardActive(mcpPane(`mcp-120-${step}-2.34.0`)), step).toBe(false);
    expect(kiroQuestionCardActive(mcpPane("mcp-120-30-question-2.34.0"))).toBe(true);
    expect(kiroMcpInputRequestActive(mcpPane("mcp-120-30-question-2.34.0"))).toBe(false);
  });

  it("without the hold, main read the card as idle — and a delivery became the answer", () => {
    const card = pane("2.34.0-120-40-question");
    expect(backend().getReadyPattern().test(card)).toBe(true);
    expect(backend().getBusyPattern().test(card)).toBe(false);
    expect(card).toMatch(/^ ❯ 1\. main\n {3}2\. release\n {3}Type a different answer…$/m);
    // The paste turned the card into a free answer…
    expect(pane("2.34.0-120-41-question-paste")).toMatch(/^ {3}1\. main\n {3}2\. release\n ❯ hello from agend$/m);
    // …and its Enter submitted it: the question closed, with the message as the user's answer.
    const answered = pane("2.34.0-120-42-question-paste-enter");
    expect(answered).toMatch(/^• Which branch should I use\?$/m);
    expect(answered).toMatch(/^ {2}› hello from agend$/m);
  });

  it("the card is unchanged from 2.33.1 (only the session's own rows differ)", () => {
    for (const step of ["40-question", "50-question-rich", "51-question-suboptions"]) {
      const tail = (version: string) => pane(`${version}-120-${step}`).replace(/\n+$/, "").split("\n").slice(-9).join("\n");
      expect(tail("2.34.0"), step).toBe(tail("2.33.1"));
    }
  });

  describe("only the captured shape is the card", () => {
    const card = pane("2.34.0-120-40-question");
    const rows = card.replace(/\n+$/, "").split("\n");
    const footer = rows.length - 1, header = rows.findIndex(row => row === " Question");
    const edit = (index: number, row: string) => rows.map((r, i) => (i === index ? row : r)).join("\n");
    it("the captured card, and a titled one (`<name> > Question`, as a subagent's or a spec run's)", () => {
      expect(kiroQuestionCardActive(card)).toBe(true);
      expect(kiroQuestionCardActive(edit(header, " planner > Question"))).toBe(true);
    });
    it("text after the key hints, or a composer row inside: history, not a live card", () => {
      expect(kiroQuestionCardActive(`${card.replace(/\n+$/, "")}\n  something else`)).toBe(false);
      // The question, a blank row, then the options: a composer in place of "2. release" (one cursor row kept).
      expect(rows[header + 4]).toBe("   2. release");
      expect(kiroQuestionCardActive(edit(header + 4, "› typed"))).toBe(false);
    });
    it("another key-hint row or header", () => {
      expect(kiroQuestionCardActive(edit(footer, " esc to cancel · ↑↓ to navigate · enter to select · ctrl+s to submit"))).toBe(false);
      expect(kiroQuestionCardActive(edit(header, " Questions"))).toBe(false);
      expect(kiroQuestionCardActive(edit(header, " Input requested · MCP server"))).toBe(false);
    });
    it("the header not right under the divider, or no divider above the key hints", () => {
      expect(kiroQuestionCardActive(edit(header - 1, " stray"))).toBe(false);
      expect(kiroQuestionCardActive(edit(footer - 1, ""))).toBe(false);
    });
    it("no cursor row, two, or an empty card (the header right over the key hints' divider)", () => {
      expect(kiroQuestionCardActive(card.replace(" ❯ 1. main", "   1. main"))).toBe(false);
      expect(kiroQuestionCardActive(card.replace("   2. release", " ❯ 2. release"))).toBe(false);
      expect(kiroQuestionCardActive([...rows.slice(0, header + 1), ...rows.slice(footer - 1)].join("\n"))).toBe(false);
      expect(kiroQuestionCardActive([...rows.slice(0, header + 1), " ❯ 1. main", ...rows.slice(footer - 1)].join("\n"))).toBe(false);
    });
  });
});

describe("#2592 / #2587 in the daemon: held, never keyed, reported after a minute, clear once answered", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const daemonFor = (screen: () => string, keys: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "agend-kiro-2592-")); dirs.push(dir);
    const instance = join(dir, "instance"), cwd = join(dir, "work");
    mkdirSync(instance); mkdirSync(cwd);
    const b = new KiroBackend(instance, compat());
    (b as unknown as { activeTrustAll: boolean; activeUi: string }).activeTrustAll = true;
    (b as unknown as { activeUi: string }).activeUi = "v3";
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("kiro-test", {
      working_directory: cwd, backend: "kiro-cli", restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "silent",
    } as never, instance, false, b, undefined, { child: () => logger } as never) as unknown as {
      tmux: unknown; probeBlockingDialog(): Promise<{ state: string; dialog?: RuntimeDialog }>; on(e: string, f: (x: unknown) => void): void;
    };
    daemon.tmux = {
      capturePane: vi.fn(async () => screen()),
      isWindowAlive: async () => true,
      sendSpecialKey: vi.fn(async (key: string) => { keys.push(key); return true; }),
      sendKeys: vi.fn(async (text: string) => { keys.push(`text:${text}`); return true; }),
      pasteText: vi.fn(async (text: string) => { keys.push(`paste:${text}`); return true; }),
    };
    return daemon;
  };

  it.each([
    ["the Question card (#2592)", () => pane("2.34.0-120-40-question"), () => pane("2.34.0-120-43-after-turn"), QUESTION_HOLD],
    ["the MCP input card (#2587)", () => mcpPane("mcp-120-10-form-2.34.0"), () => mcpPane("mcp-120-19-after-turn-2.34.0"), MCP_HOLD],
  ] as const)("%s", async (_name, card, answered, description) => {
    let screen = card();
    const keys: string[] = [];
    const daemon = daemonFor(() => screen, keys);
    const parked: Array<{ description: string; holdOnly: boolean }> = [];
    daemon.on("dialog_parked", (event) => parked.push(event as { description: string; holdOnly: boolean }));
    const started = Date.now();
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(started);
      const first = await daemon.probeBlockingDialog();
      expect(first.state).toBe("dialog");
      expect(first.dialog!.description).toBe(description);
      // A minute on screen: reported once for a person (instance topic + General), still nothing pressed.
      clock.mockReturnValue(started + 61_000);
      await daemon.probeBlockingDialog();
      clock.mockReturnValue(started + 122_000);
      await daemon.probeBlockingDialog();
      expect(parked).toEqual([expect.objectContaining({ description, holdOnly: true })]);
      // Answered in the pane: clear, so a held delivery goes ahead.
      screen = answered();
      expect((await daemon.probeBlockingDialog()).state).toBe("clear");
    } finally { clock.mockRestore(); }
    expect(keys).toEqual([]);
  });
});
