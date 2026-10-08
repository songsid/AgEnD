/**
 * Codex's Luna Reserve picker lists the SERVER's call-to-action buttons above its own "Continue with Luna Reserve"
 * row (`rateLimitUpsell.ctas`, rendered by codex-rs/tui chatwidget/backend_banners.rs — identical in 0.160.0 and
 * 0.162.0). On 2026-10-08 codex 0.160.0 showed "1. Upgrade / 2. Reset usage / 3. Continue with Luna Reserve"; the
 * rule then required "1. Reset usage" (the 0.156.1 capture), missed it, and the instance parked on the generic
 * unknown-selection hold until a human pressed Escape.
 *
 * Fixtures: codex-0160-luna-reserve-{server-ctas,after-escape} are that night's output.log replayed into a 120x36
 * private tmux pane (the instance's size) up to the end of each synchronized update; the transcript rows above
 * "Worked for …" are blanked (private conversation), nothing else is changed.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.pane.txt`, import.meta.url), "utf8");
const LIVE_0160 = fixture("codex-0160-luna-reserve-server-ctas");
const AFTER_ESCAPE = fixture("codex-0160-luna-reserve-after-escape");
const LIVE_0156 = fixture("codex-usage-limit-menu");

const backend = new CodexBackend(mkdtempSync(join(tmpdir(), "agend-luna-ctas-")));
const dialogs = backend.getRuntimeDialogs();
const hit = (pane: string) => dialogs.filter(d => (d.isActive ? d.isActive(pane) : d.pattern.test(pane)));
const LUNA = "Codex usage limit — pressing Escape to continue with Luna Reserve";
const UNKNOWN = "Codex interactive selection needs human input";
/** The dialog the daemon acts on: the first active one in table order. */
const first = (pane: string) => hit(pane)[0];

describe("the Luna Reserve picker, whatever the server offers above 'Continue'", () => {
  it("the live 0.160.0 picker (Upgrade first) is answered with Escape alone — not parked on the unknown hold", () => {
    expect(first(LIVE_0160)?.description).toBe(LUNA);
    expect(first(LIVE_0160)?.keys).toEqual(["Escape"]);
  });

  it("the 0.156.1 capture (Reset usage first) still is", () => {
    expect(first(LIVE_0156)?.description).toBe(LUNA);
  });

  it("after Escape the composer is back and no dialog is active", () => {
    expect(hit(AFTER_ESCAPE)).toEqual([]);
    expect(backend.getReadyPattern().test(AFTER_ESCAPE)).toBe(true);
  });

  it("any server labels, any count, as long as codex's own 'Continue with Luna Reserve' is the last row", () => {
    const options = (labels: string[]) => LIVE_0160.replace(
      "› 1. Upgrade\n  2. Reset usage\n  3. Continue with Luna Reserve",
      labels.map((label, i) => `${i === 0 ? "›" : " "} ${i + 1}. ${label}`).join("\n"),
    );
    expect(LIVE_0160).toContain("› 1. Upgrade\n  2. Reset usage\n  3. Continue with Luna Reserve");
    for (const labels of [
      ["Add credits", "Upgrade", "Continue with Luna Reserve"],
      ["Upgrade", "Continue with Luna Reserve"],
      ["Reset usage", "Add Credits", "Upgrade", "Continue with Luna Reserve"],
      ["Continue with Luna Reserve"],
    ]) expect(first(options(labels))?.description, labels.join(" / ")).toBe(LUNA);
  });

  it.each([
    ["'Continue' replaced by another label", "  3. Continue with Luna Reserve", "  3. Keep using GPT-6.1 Sol"],
    ["'Continue' not the last row", "› 1. Upgrade\n  2. Reset usage\n  3. Continue with Luna Reserve", "› 1. Continue with Luna Reserve\n  2. Upgrade"],
    ["a gap in the numbers", "  3. Continue with Luna Reserve", "  4. Continue with Luna Reserve"],
    ["numbering that does not start at 1", "› 1. Upgrade\n  2. Reset usage\n  3. Continue with Luna Reserve", "› 2. Upgrade\n  3. Reset usage\n  4. Continue with Luna Reserve"],
    ["a row between two options", "  2. Reset usage\n", "  2. Reset usage\n     resets your 5h limit once\n"],
    ["a row between the options and the footer", "  3. Continue with Luna Reserve\n", "  3. Continue with Luna Reserve\n  something else\n"],
    ["more text on the 'Continue' row", "  3. Continue with Luna Reserve", "  3. Continue with Luna Reserve (recommended)"],
  ])("not this picker, held for a human: %s", (_name, from, to) => {
    expect(LIVE_0160).toContain(from);
    const pane = LIVE_0160.replace(from, to);
    expect(first(pane)?.description).toBe(UNKNOWN);
    expect(first(pane)?.holdOnly).toBe(true);
  });

  it("a copy in the transcript with the composer below it is not the live picker", () => {
    const copy = LIVE_0160.trimEnd() + "\n\n› Ask Codex to do anything\n\n  Context 23% left";
    expect(hit(copy).map(d => d.description)).not.toContain(LUNA);
  });
});
