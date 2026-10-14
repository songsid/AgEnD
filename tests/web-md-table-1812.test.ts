/**
 * #1812: Markdown tables in the web chat — the .md attachment preview and chat bubbles (one renderer), and the csv
 * preview. The table sat against the preview's scrollbar (the scroller had no padding of its own, inside the card's) and
 * split words mid-word: every cell inherited the message's `overflow-wrap: anywhere`, which also shrinks a cell's
 * minimum, so auto table layout squeezed the columns instead of letting the `.tbl` wrapper scroll. The layout is checked
 * in a real browser (the PR's smoke: classic and overlay scrollbars, 1366 and 390 px); here, the rules that make it,
 * and the renderer's path break points.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selectors: m[1]!.split(",").map(s => s.trim()), decl: m[2]! }));
const prop = (sel: string, name: string) => {
  const all = rules.filter(r => r.selectors.includes(sel)).flatMap(r => [...r.decl.matchAll(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "g"))].map(m => m[1]!.trim()));
  return all.at(-1) ?? null;
};

describe("#1812: the preview scroller insets its own content, the same on both sides", () => {
  it("it spans the card's padding box and pads itself by the card's 12px; a classic scrollbar keeps its gutter", () => {
    expect(prop(".text-card", "padding")).toBe("var(--s-2) var(--s-3)");
    expect(prop(".text-card .tc-body", "margin")).toBe("var(--s-2) calc(-1 * var(--s-3)) 0");
    expect(prop(".text-card .tc-body", "padding")).toBe("0 var(--s-3)");
    expect(prop(".text-card .tc-body", "scrollbar-gutter")).toBe("stable");
    expect(prop(".text-card .tc-body", "overflow")).toBe("auto");
  });
});

describe("#1812: table cells keep words whole; a wide table scrolls in its wrapper", () => {
  const cells = [".msg .md th", ".msg .md td", ".text-card .tc-table th", ".text-card .tc-table td"];
  it.each(cells)("%s: break-word (never anywhere / break-all), and a minimum column", sel => {
    expect(prop(sel, "overflow-wrap")).toBe("break-word");
    expect(prop(sel, "word-break")).toBe("normal");
    expect(prop(sel, "min-width")).toBe("5em");
  });
  it("the message itself still wraps anywhere (prose, long URLs): only cells opt out", () => {
    expect(prop(".msg", "overflow-wrap")).toBe("anywhere");
  });
  it.each([".msg .md .tbl", ".text-card .tc-table-wrap"])("%s scrolls sideways, with room under the last row for an overlay scrollbar", sel => {
    expect(prop(sel, "overflow-x")).toBe("auto");
    expect(prop(sel, "padding-bottom")).toBe("var(--s-3)");
  });
});

interface Render { renderMarkdown(text: unknown): string }
const SRC = readFileSync(join(process.cwd(), "src", "ui", "chat-render.js"), "utf8");
const md = (() => { const c = vm.createContext({}); vm.runInContext(SRC, c); return (c as unknown as { AgendChatRender: Render }).AgendChatRender.renderMarkdown; })();

describe("#1812: a path in a table cell may wrap after its separators", () => {
  const table = "| a | b |\n|---|---|\n| `app/sr4/update.go:22` | x `m/../d.go` y |";
  it("code in a cell gets a break opportunity after each /", () => {
    const html = md(table);
    expect(html).toContain("<td><code>app/<wbr>sr4/<wbr>update.go:22</code></td>");
    expect(html).toContain("<td>x <code>m/<wbr>../<wbr>d.go</code> y</td>");
  });
  it("only in cells: prose, headers' plain text and code outside tables are unchanged", () => {
    expect(md("see `src/foo.ts` here")).toBe("<p>see <code>src/foo.ts</code> here</p>");
    expect(md("| a/b | `c/d` |\n|---|---|\n| 1 | 2 |")).toContain("<th>a/b</th><th><code>c/<wbr>d</code></th>");
    expect(md(table + "\n\nafter `x/y`")).toContain("<p>after <code>x/y</code></p>");
  });
  it("the cell flag is reset even when a cell is the last thing rendered", () => {
    expect(md("| `a/b` |\n|---|\n| `c/d` |\n\n`e/f`")).toContain("<p><code>e/f</code></p>");
  });
});
