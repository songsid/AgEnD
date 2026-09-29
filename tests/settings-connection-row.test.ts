import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The "Connections & Bots" row carries up to ten short facts. On v2.1.7 it was a plain
 * non-wrapping flex row, so each fact shrank and wrapped inside its own box ("存取模式:" and
 * "設定" broke mid-word) and the tail was clipped by the card. The layout itself was checked in a
 * real browser at nine widths in two languages; these pin the rules that make it hold.
 */
describe("Settings › Connections & Bots row layout", () => {
  const html = readFileSync(join(process.cwd(), "src", "ui", "settings.html"), "utf8");
  const rule = (selector: string): string => {
    const start = html.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf("}", start));
  };

  it("wraps between facts, not inside them", () => {
    expect(rule(".conn-row")).toContain("flex-wrap: wrap");
    expect(rule(".conn-row > *")).toContain("flex: 0 0 auto");
    const nowrap = rule(".conn-row .name, .conn-row .tag, .conn-row button, .conn-row .row-end > *");
    expect(nowrap).toContain("white-space: nowrap");
  });

  it("lets long values break anywhere instead of widening the row past its card", () => {
    expect(rule(".conn-row .sub")).toContain("overflow-wrap: anywhere");
    expect(rule(".conn-row .sub")).toContain("min-width: 0");
    expect(rule(".conn-row > *")).toContain("max-width: 100%");
  });

  it("keeps the status pill, the connection state and the Settings button together at the end", () => {
    expect(rule(".conn-row .row-end")).toContain("margin-left: auto");
    const render = html.slice(html.indexOf("function renderBots()"), html.indexOf("function providerSecretInputAllowed"));
    expect(render).toContain('class: "item-row conn-row"');
    const end = render.indexOf('class: "row-end"');
    expect(end).toBeGreaterThan(-1);
    const tail = render.slice(end);
    for (const part of ["Token configured", "Connected", "settingsButton"]) expect(tail, part).toContain(part);
    // The ten facts before it are not in the cluster.
    const head = render.slice(0, end);
    for (const part of ["accessMode", "bot_token_env", "allowed_users"]) expect(head, part).toContain(part);
    expect(tail).not.toContain("accessMode");
  });

  it("does not touch the other rows that share .item-row", () => {
    expect(rule(".item-row")).not.toContain("flex-wrap");
    expect(html.match(/class: "item-row conn-row"/g)).toHaveLength(1);
  });
});
