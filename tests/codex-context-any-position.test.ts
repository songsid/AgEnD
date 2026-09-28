/**
 * #978: Codex keeps the user's status_line order, so the Context item can sit
 * anywhere in the footer. The idle/readiness proofs used to accept Context only
 * as the first item, so `model-with-reasoning, context-remaining, current-dir`
 * (a common workaround to stop a long cwd truncating Context) left the instance
 * `working` forever and every delivery queued.
 *
 * All cases call the production CodexBackend readiness methods.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A backend whose private config.toml carries `items`, or none at all. */
function backend(items?: string[]): CodexBackend {
  const dir = mkdtempSync(join(tmpdir(), "agend-codex-978-"));
  dirs.push(dir);
  if (items) writeFileSync(join(dir, "config.toml"), `[tui]\nstatus_line = ${JSON.stringify(items)}\n`);
  const b = new CodexBackend(join(dir, "instance"));
  (b as any).isolatedCodexHome = dir;
  return b;
}

const idle = (footer: string) => ["• Finished the requested work.", "", "› Ask Codex to do anything", "", footer].join("\n");
const readyEverywhere = (b: CodexBackend, pane: string) => ({
  delivery: b.isDeliveryInputReadyPane(pane),
  ready: b.getReadyPattern().test(pane) && !b.getBusyPattern().test(pane),
  redrawIdle: b.isPeriodicRedrawIdlePane(pane),
});

const USER_CONFIG = ["model-with-reasoning", "context-remaining", "current-dir"];

describe("Codex Context item in any status_line position (#978)", () => {
  it.each([
    ["the reporter's layout: model first, Context middle", "  gpt-5.6-sol medium · Context 46% left · ~/x"],
    ["Context last", "  gpt-5.6-sol medium · ~/x · Context 46% left"],
    ["Context used, middle", "  gpt-5.6-sol medium · Context 54% used · ~/x"],
    ["truncated percentage, middle", "  gpt-5.6-sol medium · Context 46… · ~/x"],
    ["truncated to the label, last", "  gpt-5.6-sol medium · Context …"],
    ["Context first (unchanged behaviour)", "  Context 46% left · gpt-5.6-sol medium · ~/x"],
  ])("proves idle with %s", (_label, footer) => {
    expect(readyEverywhere(backend(USER_CONFIG), idle(footer))).toEqual({ delivery: true, ready: true, redrawIdle: true });
  });

  it("accepts a drafted composer above a non-first Context footer, like the Context-first path", () => {
    const pane = ["› half-typed draft", "", "  gpt-5.6-sol medium · Context 46% left · ~/x"].join("\n");
    const b = backend(USER_CONFIG);
    expect(b.isDeliveryInputReadyPane(pane)).toBe(true);
    expect(b.getReadyPattern().test(pane)).toBe(true);
  });

  it("only trusts a non-first Context footer that matches the configured item grammar", () => {
    // Without a config (or a stale one) the order is unknown: the structural
    // proof fails closed, and the daemon's stable-composer escape hatch keeps
    // the instance from latching in working. Context-first needs no config.
    const unconfigured = backend();
    expect(readyEverywhere(unconfigured, idle("  gpt-5.6-sol medium · Context 46% left · ~/x")))
      .toEqual({ delivery: false, ready: false, redrawIdle: false });
    expect(readyEverywhere(unconfigured, idle("  Context 46% left · gpt-5.6-sol medium · ~/x")))
      .toEqual({ delivery: true, ready: true, redrawIdle: true });
  });

  it("does not take an arbitrary indented line containing a Context item for the footer", () => {
    // Prism's #979 probe: plain indented transcript-shaped text in the first
    // segment does not match the configured model-with-reasoning grammar.
    const b = backend(USER_CONFIG);
    for (const footer of [
      "  copied command output · Context 46% left · ~/x",
      "  gpt-5.6-sol medium · notes about Context 46% left · ~/x",
      "  gpt-5.6-sol medium · Context 46% left and more · ~/x",
    ]) {
      expect(readyEverywhere(b, idle(footer)), footer).toEqual({ delivery: false, ready: false, redrawIdle: false });
    }
  });

  it("still sees a working pane as busy whatever the footer order", () => {
    const pane = [
      "• Working (12s • esc to interrupt)",
      "",
      "› Ask Codex to do anything",
      "",
      "  gpt-5.6-sol medium · Context 46% left · ~/x",
    ].join("\n");
    const b = backend(USER_CONFIG);
    expect(b.getReadyPattern().test(pane) && !b.getBusyPattern().test(pane)).toBe(false);
    expect(b.isPeriodicRedrawIdlePane(pane)).toBe(false);
  });

  it("does not take transcript or status rows that merely mention Context for the footer", () => {
    const b = backend();
    for (const last of [
      "• note · Context 5% left",           // bullet: transcript
      "› draft · Context 5% left",          // prompt row
      "⚠ quota · Context 5% left",          // warning status row
      "Context-aware · docs · ~/x",          // no Context item at all
    ]) {
      const pane = ["› Ask Codex to do anything", "", last].join("\n");
      expect(b.isDeliveryInputReadyPane(pane), last).toBe(false);
      expect(b.isPeriodicRedrawIdlePane(pane), last).toBe(false);
    }
  });
});

describe("stable unknown-layout escape hatch (#978)", () => {
  const b = backend();
  it("accepts only the live, empty composer with no busy marker or selection screen", () => {
    expect(b.isStableUnknownLayoutIdlePane(idle("  some-future-item · another"))).toBe(true);
    expect(b.isStableUnknownLayoutIdlePane(idle("  some-future-item · another").replace("Ask Codex to do anything", "draft text"))).toBe(false);
    expect(b.isStableUnknownLayoutIdlePane(`• Working (3s • esc to interrupt)\n${idle("  x · y")}`)).toBe(false);
    // Prism's #979 probe: a retained queued message is pending work.
    const queued = ["• Messages to be submitted after next tool call", "  ↳ run the migration next", "", "› Ask Codex to do anything", "", "  x · y"].join("\n");
    expect(b.isStableUnknownLayoutIdlePane(queued)).toBe(false);
    // A composer only far up in scrollback is not the live one.
    expect(b.isStableUnknownLayoutIdlePane(["› Ask Codex to do anything", ...Array(8).fill("  output line"), "  x · y"].join("\n"))).toBe(false);
  });
});
