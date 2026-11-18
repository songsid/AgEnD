/**
 * M-3326 (the user, 11-18): a chat table's cells are selected as a spreadsheet's (Outline's tables) — press in a cell and
 * drag down: only that column's cells; diagonally: a block — instead of the browser's text selection spanning whole rows.
 * Inside one cell the browser's own text selection stays (and 「引用」 on it). Ctrl/Cmd+C copies the cells as TSV; Esc or a
 * press elsewhere clears. A desk only (a mouse): a phone and a touch or pen press are left alone.
 * chat-table-select.js on the mini DOM; the Fleet chat and every Hub conversation install it (panel-chat.js, panel-hub.js).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fire, installDom, MiniEvent, type MiniPage } from "./helpers/mini-dom.js";

let dom: MiniPage | null = null;
const offs: Array<() => void> = [];
afterEach(() => { for (const f of offs.splice(0)) f(); dom?.restore(); dom = null; });

const TABLE = `<div class="thread"><div class="msg agent" data-key="m1"><div class="body"><div class="md"><p>before</p><div class="tbl"><table>
<thead><tr><th>Name</th><th>Model</th><th>Backend</th></tr></thead>
<tbody><tr><td>Notes</td><td>opus</td><td>claude-code</td></tr><tr><td>Lumen</td><td>fable</td><td>claude-code</td></tr><tr><td>Argon</td><td>gemini 3</td><td>agy</td></tr></tbody>
</table></div></div></div></div><div class="msg user" data-key="m2"><div class="body"><div class="md"><p>outside</p><table class="second"><tbody><tr><td>x1</td><td>y1</td></tr><tr><td>x2</td><td>y2</td></tr></tbody></table></div></div></div><textarea id="box"></textarea></div>`;

async function setup(o: { phone?: boolean } = {}) {
  dom = installDom({});
  const mod = await import("/assets/chat-table-select.js") as any;
  const root = dom.document.createElement("div"); root.innerHTML = TABLE; dom.document.body.appendChild(root);
  const list = root.querySelector(".thread") as any;
  offs.push(mod.installTableSelection(list, { phone: () => !!o.phone }));
  const rows = [...list.querySelector("table").querySelectorAll("tr")].map((tr: any) => [...tr.children]) as any[][];
  const cell = (r: number, c: number) => rows[r]![c]!;
  const table = list.querySelector("table") as any;
  const selected = () => rows.map((row) => row.map((c: any) => (c.classList.contains("cell-sel") ? 1 : 0)).join("")).join("|");
  const down = (el: any, init: Record<string, unknown> = {}) => fire(el, "pointerdown", { button: 0, pointerType: "mouse", ...init });
  const move = (el: any) => fire(el, "pointermove", { pointerType: "mouse" });
  const up = (el: any) => fire(el, "pointerup", { pointerType: "mouse" });
  const copy = () => {
    const data: Record<string, string> = {};
    const e = new MiniEvent("copy", { bubbles: true, cancelable: true, clipboardData: { setData: (t: string, v: string) => { data[t] = v; } } });
    dom!.document.body.dispatchEvent(e);
    return { data, prevented: e.defaultPrevented };
  };
  return { mod, list, cell, table, selected, down, move, up, copy, outside: list.querySelector('[data-key="m2"] p') as any,
    second: list.querySelector("table.second") as any, box: list.querySelector("#box") as any };
}

describe("the grid and its text (pure)", () => {
  it("the rectangle between two cells, either way round; TSV: cells by tabs, rows by line breaks, one line per cell", async () => {
    const { mod, table, cell } = await setup();
    expect(mod.toTsv(mod.rectCells(table, cell(1, 0), cell(3, 0)))).toBe("Notes\nLumen\nArgon");
    expect(mod.toTsv(mod.rectCells(table, cell(3, 2), cell(0, 1)))).toBe("Model\tBackend\nopus\tclaude-code\nfable\tclaude-code\ngemini 3\tagy");
    cell(1, 1).textContent = "a\tb\nc";
    expect(mod.cellText(cell(1, 1))).toBe("a b c");
  });
});

describe("selecting cells with a mouse (a desk)", () => {
  it("press in a cell and drag straight down: only that column's cells; the browser's text selection is kept off the table", async () => {
    const t = await setup();
    t.down(t.cell(1, 1)); t.move(t.cell(2, 1)); t.move(t.cell(3, 1)); t.up(t.cell(3, 1));
    expect(t.selected()).toBe("000|010|010|010");
    expect(t.table.classList.contains("cells-on")).toBe(true);
  });
  it("diagonally: a block; back toward the corner pressed: the block shrinks", async () => {
    const t = await setup();
    t.down(t.cell(0, 0)); t.move(t.cell(2, 1));
    expect(t.selected()).toBe("110|110|110|000");
    t.move(t.cell(1, 0));
    expect(t.selected()).toBe("100|100|000|000");
  });
  it("inside one cell: nothing — the browser's own text selection (and Quote on it) as before", async () => {
    const t = await setup();
    t.down(t.cell(2, 0)); t.move(t.cell(2, 0)); t.up(t.cell(2, 0));
    expect([t.selected(), t.table.classList.contains("cells-on")]).toEqual(["000|000|000|000", false]);
    expect(t.copy().prevented, "no cells: Ctrl/Cmd+C copies the text as always").toBe(false);
  });
  it("Ctrl/Cmd+C copies the cells as TSV (and only then takes the copy over)", async () => {
    const t = await setup();
    t.down(t.cell(0, 2)); t.move(t.cell(3, 2)); t.up(t.cell(3, 2));
    const c = t.copy();
    expect([c.data["text/plain"], c.prevented]).toEqual(["Backend\nclaude-code\nclaude-code\nagy", true]);
  });
  it("Esc clears it; so does a press anywhere else; a new press in a cell starts again", async () => {
    const t = await setup();
    t.down(t.cell(1, 0)); t.move(t.cell(3, 0)); t.up(t.cell(3, 0));
    fire(t.list, "keydown", { key: "Escape" });
    expect([t.selected(), t.table.classList.contains("cells-on")]).toEqual(["000|000|000|000", false]);
    t.down(t.cell(1, 0)); t.move(t.cell(3, 0)); t.up(t.cell(3, 0));
    t.down(t.outside); t.up(t.outside);
    expect(t.selected()).toBe("000|000|000|000");
    t.down(t.cell(1, 0)); t.move(t.cell(3, 0)); t.up(t.cell(3, 0));
    t.down(t.cell(0, 2));
    expect(t.selected(), "a new press clears the old cells").toBe("000|000|000|000");
  });
  it("Shift+click in the same table moves the far corner there", async () => {
    const t = await setup();
    t.down(t.cell(1, 0)); t.move(t.cell(1, 1)); t.up(t.cell(1, 1));
    t.down(t.cell(3, 1), { shiftKey: true }); t.up(t.cell(3, 1));
    expect(t.selected()).toBe("000|110|110|110");
  });
  it("the thread drawing the table again clears it (no copy of cells that are gone)", async () => {
    const t = await setup();
    t.down(t.cell(1, 0)); t.move(t.cell(3, 0)); t.up(t.cell(3, 0));
    t.table.parentNode.removeChild(t.table);
    expect(t.copy().prevented).toBe(false);
  });
});

// M-3326 follow-up (#4172 review: the mutants that survived; the leader's call on formula cells).
describe("hand-offs and edges", () => {
  it("a cell starting with = or @ pastes as text (a leading '); + and - are left alone (numbers stay numbers)", async () => {
    const t = await setup();
    t.cell(1, 1).textContent = "=IMPORTXML(\"x\",\"//a\")"; t.cell(2, 1).textContent = "@sum"; t.cell(3, 1).textContent = "-5";
    t.cell(1, 2).textContent = "+1"; t.cell(2, 2).textContent = "a=b"; t.cell(3, 2).textContent = "  =trimmed";
    t.down(t.cell(1, 1)); t.move(t.cell(3, 2)); t.up(t.cell(3, 2));
    expect(t.copy().data["text/plain"]).toBe("'=IMPORTXML(\"x\",\"//a\")\t+1\n'@sum\ta=b\n-5\t'=trimmed");
  });
  it.each([
    ["-5", "-5"], ["+1", "+1"], ["-3.5", "-3.5"], ["+12%", "+12%"], ["-1,234", "-1,234"], ["-.5", "-.5"], ["-", "-"], ["a-b", "a-b"],
    ["+HYPERLINK(\"http://x\",\"y\")", "'+HYPERLINK(\"http://x\",\"y\")"], ["-1+IMPORTXML(\"x\",\"//a\")", "'-1+IMPORTXML(\"x\",\"//a\")"],
    ["-5 apples", "'-5 apples"], ["=1", "'=1"], ["@x", "'@x"],
  ])("+ and - (#4175 review): %s → %s — a plain number stays a number; anything else after the sign pastes as text", async (cellValue, tsv) => {
    const t = await setup();
    t.cell(1, 1).textContent = cellValue;
    expect(t.mod.tsvCell(t.cell(1, 1))).toBe(tsv);
  });
  it("a text selection made since (Ctrl+A, Shift+arrows): Ctrl/Cmd+C copies that text, not the cells", async () => {
    const t = await setup();
    t.down(t.cell(1, 0)); t.move(t.cell(3, 0)); t.up(t.cell(3, 0));
    (dom!.document as any).getSelection = () => ({ isCollapsed: false, toString: () => "some text", removeAllRanges() {} });
    expect(t.copy().prevented).toBe(false);
    (dom!.document as any).getSelection = () => ({ isCollapsed: true, toString: () => "", removeAllRanges() {} });
    expect(t.copy().prevented, "the cells again once that selection is gone").toBe(true);
  });
  it("a field with its own selection (Tab into the composer, Shift+arrows): it copies its own text", async () => {
    const t = await setup();
    t.down(t.cell(1, 0)); t.move(t.cell(3, 0)); t.up(t.cell(3, 0));
    t.box.value = "draft"; t.box.selectionStart = 0; t.box.selectionEnd = 3; t.box.focus();
    expect(t.copy().prevented).toBe(false);
    t.box.selectionEnd = 0;
    expect(t.copy().prevented, "a caret only: the cells").toBe(true);
  });
  it("Shift+click in another table does not stretch the selection there: it starts again", async () => {
    const t = await setup();
    t.down(t.cell(1, 0)); t.move(t.cell(2, 1)); t.up(t.cell(2, 1));
    const other = t.second.querySelectorAll("td")[3];
    t.down(other, { shiftKey: true }); t.up(other);
    expect([t.selected(), t.second.querySelectorAll(".cell-sel").length, t.table.classList.contains("cells-on")]).toEqual(["000|000|000|000", 0, false]);
  });
  it("while cells are being dragged the browser does not start its own selection; inside one cell it does", async () => {
    const t = await setup();
    const start = (el: any) => { const e = new MiniEvent("selectstart", { bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; };
    t.down(t.cell(1, 0));
    expect(start(t.cell(1, 0)), "still in the cell pressed").toBe(false);
    t.move(t.cell(2, 0));
    expect(start(t.cell(2, 0)), "cells").toBe(true);
    t.up(t.cell(2, 0));
    expect(start(t.cell(2, 0)), "the drag is over").toBe(false);
  });
  it("removed: every listener goes (a thread drawn again does not stack copy handlers)", async () => {
    const t = await setup();
    const doc = dom!.document as any, kinds = ["pointerdown", "pointermove", "pointerup", "pointercancel", "selectstart", "keydown", "copy"];
    const before = kinds.map((k) => doc.listenerCount(k));
    expect(before.every((n: number) => n >= 1)).toBe(true);
    offs.pop()!();
    expect(kinds.map((k) => doc.listenerCount(k))).toEqual(kinds.map(() => 0));
  });
});

describe("a phone, a finger or a pen: left alone", () => {
  it.each([["a phone (coarse pointer)", { phone: true }, "mouse"], ["a touch press", {}, "touch"], ["a pen press", {}, "pen"]])("%s: no cells", async (_n, o, pointerType) => {
    const t = await setup(o as any);
    t.down(t.cell(1, 0), { pointerType }); fire(t.cell(3, 0), "pointermove", { pointerType });
    expect([t.selected(), t.copy().prevented]).toEqual(["000|000|000|000", false]);
  });
  it("removed: no listeners left, nothing selected", async () => {
    const t = await setup();
    t.down(t.cell(1, 0)); t.move(t.cell(3, 0));
    offs.pop()!();
    expect(t.selected()).toBe("000|000|000|000");
    t.down(t.cell(1, 0)); t.move(t.cell(3, 0));
    expect(t.selected()).toBe("000|000|000|000");
  });
});

describe("where it is installed", () => {
  it("the Fleet chat and every Hub conversation install it; the Hub serves it (/assets/)", () => {
    const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    expect(src("src/ui/panel-chat.js")).toMatch(/const offCells = installTableSelection\(ls, \{ phone:/);
    expect(src("src/ui/panel-chat.js")).toMatch(/offQuote\(\); offCells\(\);/);
    expect(src("src/ui/panel-hub.js")).toMatch(/const offCells = installTableSelection\(list, \{ phone \}\);/);
    expect(src("src/ui/panel-hub.js")).toMatch(/offQuote\(\); offCells\(\);/);
    expect(src("src/auth-api.ts")).toContain('"chat-table-select.js",');
    const css = src("src/ui/shared/app.css");
    expect(css).toMatch(/\.msg \.md table\.cells-on[^{]*\{[^}]*user-select: none/);
    expect(css).toMatch(/\.msg \.md td\.cell-sel[^{]*\{[^}]*background-image/);
  });
});
