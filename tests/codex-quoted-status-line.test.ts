/**
 * Tests for #931: codex with a quoted-key status_line config gets
 * context-remaining injected correctly (Layer 1 fix only).
 *
 * Layer 2 (loosening isDeliveryInputReadyPane for custom footers) was
 * evaluated and found to have unacceptable false-ready risk under adversarial
 * review (deny-list approach fails on unlisted dialog screens). It is
 * explicitly NOT included here; see the #931 issue for the follow-up design.
 *
 * Layer 1 mutation guards:
 *  G8a — Rule 2b quoted array key: injecting under "status_line" = [...]
 *  G8b — Rule 2a quoted [tui] section header
 *  G8c — Rule 1 recognises existing context item under quoted key
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexBackend } from "../src/backend/codex.js";

function writeAndRead(initialContent: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-codex-931-"));
  const configPath = join(dir, "config.toml");
  if (initialContent) writeFileSync(configPath, initialContent);
  const b = new CodexBackend(dir);
  (b as any).isolatedCodexHome = dir;
  (b as any).enableContextStatusLine();
  try { return readFileSync(configPath, "utf-8"); } catch { return ""; }
}

describe("enableContextStatusLine — quoted TOML keys (#931, Layer 1)", () => {
  it("injects context-remaining when status_line key is double-quoted (G8a)", () => {
    // to Rule 2a which appends a SECOND status_line key → invalid TOML (duplicate
    // key). This test verifies injection happened correctly AND user items kept.
    const out = writeAndRead(`[tui]\n"status_line" = ["model-current", "effort-current"]\n`);
    expect(out).toContain("context-remaining");
    // User's items must be preserved.
    expect(out).toContain("model-current");
    expect(out).toContain("effort-current");
    // Must not produce a duplicate status_line key (invalid TOML).
    const matches = [...out.matchAll(/"?status_line"?\s*=/g)];
    expect(matches).toHaveLength(1);
  });

  it("injects context-remaining when status_line key is single-quoted", () => {
    // Single-quoted TOML keys are legal: `'status_line' = [...]`.
    // The ['"']? optional-quote regex covers both single and double.
    const out = writeAndRead(`[tui]\n'status_line' = ["model-current"]\n`);
    expect(out).toContain("context-remaining");
    expect(out).toContain("model-current");
    const matches = [...out.matchAll(/["']?status_line["']?\s*=/g)];
    expect(matches).toHaveLength(1);
  });

  it("injects context-remaining under ['tui'] section header (G8b)", () => {
    // Mutation guard G8b: if Rule 2a doesn't recognise ["tui"], it adds a new
    // unquoted [tui] section → duplicate table header → invalid TOML.
    const out = writeAndRead(`["tui"]\n# existing config\n`);
    expect(out).toContain("context-remaining");
    // Must not create a second tui section.
    const tuiCount = (out.match(/^\[["']?tui["']?\]/gm) ?? []).length;
    expect(tuiCount).toBe(1);
  });

  it("injects under ['tui'] and preserves existing quoted status_line items", () => {
    // Combines G8a + G8b: quoted section header AND quoted key.
    const out = writeAndRead(`["tui"]\n"status_line" = ["model-current"]\n`);
    expect(out).toContain("context-remaining");
    expect(out).toContain("model-current");
    const matches = [...out.matchAll(/"?status_line"?\s*=/g)];
    expect(matches).toHaveLength(1);
  });

  it("does not inject when context item already present under quoted key (G8c)", () => {
    // Mutation guard G8c: Rule 1 must recognise "context-remaining" inside a
    // quoted key's value. Without it the rule exits early incorrectly.
    const original = `[tui]\n"status_line" = ["context-remaining", "model-current"]\n`;
    const out = writeAndRead(original);
    // Nothing should change.
    expect(out).toBe(original);
  });

  it("still injects for unquoted keys (no regression)", () => {
    const out = writeAndRead(`[tui]\nstatus_line = ["model-current"]\n`);
    expect(out).toContain("context-remaining");
    expect(out).toContain("model-current");
    const matches = [...out.matchAll(/"?status_line"?\s*=/g)];
    expect(matches).toHaveLength(1);
  });

  it("adds new [tui] section when none exists", () => {
    const out = writeAndRead(`[appearance]\ntheme = "dark"\n`);
    expect(out).toContain("context-remaining");
    expect(out).toContain("[tui]");
  });

  it("injects under [\"tui\"] section, not as a duplicate [tui] section", () => {
    // Regression: before the fix, Rule 2a would look for /^[tui]/ and fail
    // on ["tui"], then append a NEW [tui] section → two table headers.
    const out = writeAndRead(`["tui"]\nsome_setting = true\n`);
    const tuiCount = (out.match(/^\[["']?tui["']?\]/gm) ?? []).length;
    expect(tuiCount).toBe(1);
  });
});
