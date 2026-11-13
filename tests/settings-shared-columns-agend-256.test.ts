import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * AGEND-256: on a wide Settings page the Agents, ClassicBot and connection lists are tables, and every row lines up
 * with the header. Each row used to be a grid of its own whose last column was "auto": a paused agent (Wake, no Stop)
 * or a connection with a longer bot name sized that column differently, and the fr columns before it moved 8–24px.
 * The list now holds the columns and its header, groups and rows take them as a subgrid. Checked in a real browser by
 * scripts/manual/smoke/smoke-agend-256-settings-columns.mts (every column's left edge, per row); these pin the rules.
 */
const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");
const panel = readFileSync(join(process.cwd(), "src", "ui", "panel-settings.js"), "utf8");
const wide = css.slice(css.indexOf("@container settings-page (min-width: 900px) {"));
const block = wide.slice(0, wide.indexOf("\n}\n"));
const line = (start: string): string => {
  const at = block.indexOf(`\n  ${start}`);
  expect(at, start).toBeGreaterThan(-1);
  return block.slice(at + 1, block.indexOf("\n", at + 1));
};

describe("AGEND-256 Settings lists share one set of columns", () => {
  it("the list holds the tracks; header, groups and rows take them as a subgrid", () => {
    expect(line(".p-settings :is(.s-agents-list, .s-classic-list, .s-connections-list) {")).toContain("grid-template-columns: var(--s-cols)");
    expect(line(".p-settings .s-agents-list > .s-group {")).toContain("grid-template-columns: subgrid");
    const rows = block.slice(block.indexOf(".p-settings :is(.s-agent-columns, .s-agent-row, .s-classic-columns, .s-classic-row, .s-connection-columns),"));
    expect(rows.slice(0, rows.indexOf("}"))).toMatch(/grid-template-columns: var\(--s-cols\); grid-template-columns: subgrid;/);
  });

  it("no row carries its own template any more (that is what let a paused row drift)", () => {
    expect(block).not.toMatch(/\.s-agent-row \{ display: grid; grid-template-columns: minmax/);
    expect(block).not.toMatch(/\.s-conn \{ display: grid; grid-template-columns: minmax/);
  });

  it("a connection's actions are token | state | buttons columns, Retry and Settings kept together", () => {
    expect(line(".p-settings .s-connections-list {")).toContain("auto auto auto");
    expect(line(".p-settings .s-connections-list > .s-conn > .s-actions {")).toContain("grid-template-columns: subgrid");
    expect(line(".p-settings .s-connection-columns > span:last-child {")).toContain("grid-column: 3 / -1");
    expect(line(".p-settings .s-connections-list .s-facts {")).toContain("text-align: left");
    expect(panel).toMatch(/<span class="s-conn-buttons">\$\{!overPublicLink[\s\S]*?settingsButton[\s\S]*?<\/span><\/span>/);
  });
});
