import { describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";

/**
 * #1190: Codex 0.159.2 paints its native Goal status between the context item and the warnings —
 *   `  Context 32% left    Goal achieved (1h 6m)    ⚠ 1 warning · f2 to view`
 * — and the legacy "Context first" footer grammar had no place for it, so the footer was "not recognised", the idle
 * composer could not be proved, stranded-input recovery ran out and the delivery failed. A UUID-prefixed footer with
 * the same field passed (that is the reporter's workaround). The native fields after the context item are now footer
 * chrome whatever they say; a draft or a transcript line that merely starts with the words is still not a footer.
 *
 * The footer strings below are the ones from the report; the production backend judges them.
 */
const b = new CodexBackend("/tmp/codex-1190-probe");
const UUID = "00000000-0000-0000-0000-000000000000";
const pane = (footer: string, composer = "› Ask Codex to do anything") =>
  ["• Earlier answer.", "", composer, "", footer].join("\n");

const FOOTERS: Array<[string, string]> = [
  ["Context-first with Goal achieved and a warning (the report)", "  Context 32% left    Goal achieved (1h 6m)    ⚠ 1 warning · f2 to view"],
  ["Context-first with Goal achieved only", "  Context 32% left    Goal achieved (1h 6m)"],
  ["Context-first with Goal stalled", "  Context 32% left    Goal stalled"],
  ["Context-first with another Goal state", "  Context 32% left    Goal paused (2m)"],
  ["Goal usage wording", "  Context 32% left    Goal usage: 90 seconds."],
  ["Goal complete wording with a semicolon", "  Context 32% left    Goal complete; time used: 90 seconds."],
  ["Goal wording in Korean (follows the prompt language)", "  Context 32% left    Goal 사용량: 45초."],
  ["Goal wording with a warning after it", "  Context 32% left    Goal usage: 90 seconds.    ⚠ 1 warning · f2 to view"],
  ["Goal set off by a single space", "  Context 32% left Goal achieved (1h 6m)"],
  ["UUID-prefixed with the Korean wording", `  ${UUID} · Context 49% left    Goal 사용량: 45초.`],
  ["Context used with Goal", "  Context 68% used    Goal achieved (1h 6m)"],
  ["a native field Codex has not shipped yet", "  Context 32% left    Cache warm (12k)    ⚠ 2 warnings · f2 to view"],
  ["UUID-prefixed with Goal (the reporter's workaround)", `  ${UUID} · Context 49% left    Goal achieved (1h 6m)    ⚠ 2 warnings · f2 to view`],
  ["the old shape: context only", "  Context 32% left"],
  ["the old shape: context and warnings", "  Context 32% left ⚠ 2 warnings · f2 to view"],
  ["the old shape: context and a configured suffix", "  Context 46% left · gpt-5.6-sol medium"],
];

describe("a Context footer with Codex's native Goal status is a footer", () => {
  it.each(FOOTERS)("%s: the idle composer is proved", (_name, footer) => {
    expect(b.isDeliveryInputReadyPane(pane(footer))).toBe(true);
    expect(b.isProxyReplyChromeLine(footer)).toBe(true);
  });

  it.each(FOOTERS)("%s: a drafted composer under it is still the composer the footer owns", (_name, footer) => {
    expect(b.isDeliveryInputReadyPane(pane(footer, "› half a draft"))).toBe(true);
  });

  it.each(FOOTERS)("%s: the broad ready pattern is unchanged", (_name, footer) => {
    expect(b.getReadyPattern().test(pane(footer))).toBe(true);
  });
});

describe("what still is NOT a footer", () => {
  const NOT: Array<[string, string]> = [
    ["prose that starts with the words", "Context 32% left, so I will stop here"],
    ["prose with a single space before words that are not the Goal field", "Context 32% left so Goal achieved"],
    ["a single space and a lower-case word that merely starts with goal", "Context 32% left goalkeeper stats"],
    ["a composer draft that quotes a footer", "› Context 32% left    Goal achieved (1h 6m)"],
    ["a bullet in the transcript", "• Context 32% left    Goal achieved (1h 6m)"],
    ["a gap followed by a prompt marker", "  Context 32% left    › Ask Codex to do anything"],
    ["a gap followed by a bullet", "  Context 32% left    • Working (3s • esc to interrupt)"],
    ["a gap followed by a selection marker", "  Context 32% left    ❯ 1. Yes"],
    ["a gap followed by an ASCII prompt marker", "  Context 32% left    > Ask Codex to do anything"],
    ["a gap followed by an error marker", "  Context 32% left    ■ stream disconnected"],
    ["no percentage", "  Context left    Goal achieved"],
    ["the words later in the row", "  note: Context 32% left    Goal achieved"],
  ];
  it.each(NOT)("%s", (_name, row) => {
    expect(b.isProxyReplyChromeLine(row)).toBe(false);
    expect(b.isDeliveryInputReadyPane(pane(row))).toBe(false);
  });

  it("a footer-shaped line in the transcript does not make a pane ready when the LAST row is something else", () => {
    const working = ["• Earlier answer.", "  Context 32% left    Goal achieved (1h 6m)", "", "• Working (3s • esc to interrupt)"].join("\n");
    expect(b.isDeliveryInputReadyPane(working)).toBe(false);
    const noComposer = ["• Earlier answer.", "", "  Context 32% left    Goal achieved (1h 6m)"].join("\n");
    expect(b.isDeliveryInputReadyPane(noComposer)).toBe(false);
  });

  it("a footer under a numbered selection (a picker, not the composer) is still refused", () => {
    expect(b.isDeliveryInputReadyPane(pane("  Context 32% left    Goal achieved (1h 6m)", "› 1. Switch to the other model"))).toBe(false);
  });
});
