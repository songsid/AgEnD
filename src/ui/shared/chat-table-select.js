// M-3326 (the user, 11-18): a chat table's cells are selected as a spreadsheet's (Outline's tables), not as the
// browser's text selection that runs across whole rows. On a desk, press in a cell of a message's table and drag:
//
// - within that one cell, nothing changes — the browser's own text selection (and 「引用」 on it, #4155) as before;
// - into another cell of the same table, the selection becomes cells: the rectangle between the cell pressed and the
//   cell under the pointer (straight down: one column; diagonally: a block), drawn as selected; the browser's text
//   selection is dropped while it lasts. Shift+click on a cell of that table moves the far corner there.
// - Ctrl/Cmd+C copies those cells as TSV (a row per line, cells by tabs: a spreadsheet pastes it as cells); a cell that
//   starts with = or @ gets a leading ' so it pastes as text, never as a live formula.
// - Esc, a press anywhere else, or a new press in a cell clears it. The thread drawing the table again clears it too.
//
// The Fleet chat and a Hub conversation install it on their thread (panel-chat.js, panel-hub.js). A phone (a coarse
// pointer) and a touch or pen press are left alone: there the press is the long-press menu and the system's own
// selection. The message menu, Reply and Copy text are untouched (they act on the whole message).
//
// CSSOM only (classes; no style attribute: #1300); app.css draws `.cell-sel` and `.cells-on`.

/** The tables whose cells can be selected: a message's Markdown table, and a csv/tsv text card's. */
const TABLES = ".msg .md table, .msg .tc-table";
const SEL = "cell-sel", ON = "cells-on";

const elOf = (n) => (n && (n.nodeType === 1 ? n : n.parentElement)) || null;

/** The cell (td/th) `node` is in, when that cell belongs to a selectable table inside `list`; else null. */
export function cellOf(list, node) {
  const e = elOf(node);
  const cell = e && e.closest ? e.closest("td, th") : null;
  if (!cell) return null;
  const table = cell.closest("table");
  if (!table || !list.contains(table) || !table.matches(TABLES)) return null;
  return cell;
}

/** The table's rows as arrays of cells (head rows first). Markdown and csv tables have no spans: a plain grid. */
export function grid(table) {
  const rows = [];
  for (const part of table.children) {
    const trs = part.tagName === "TR" ? [part] : [...part.children].filter((r) => r.tagName === "TR");
    for (const tr of trs) rows.push([...tr.children].filter((c) => c.tagName === "TD" || c.tagName === "TH"));
  }
  return rows;
}

/** Where a cell sits in its table's grid: { r, c }, or null. */
export function cellPos(rows, cell) {
  for (let r = 0; r < rows.length; r++) { const c = rows[r].indexOf(cell); if (c >= 0) return { r, c }; }
  return null;
}

/** The cells of the rectangle between two cells of one table, as rows of cells (a short row: the cells it has). */
export function rectCells(table, a, b) {
  const rows = grid(table), pa = cellPos(rows, a), pb = cellPos(rows, b);
  if (!pa || !pb) return [];
  const [r0, r1] = [Math.min(pa.r, pb.r), Math.max(pa.r, pb.r)], [c0, c1] = [Math.min(pa.c, pb.c), Math.max(pa.c, pb.c)];
  const out = [];
  for (let r = r0; r <= r1; r++) out.push(rows[r].slice(c0, c1 + 1));
  return out;
}

/** A cell's text for TSV: its words on one line (a tab or a line break inside becomes a space), ends trimmed. */
export function cellText(cell) {
  return String(cell?.textContent ?? "").replace(/[\t\r\n]+/g, " ").replace(/ /g, " ").trim();
}

/**
 * A cell as a spreadsheet takes it. M-3326 (#4172 review; the leader's call): a cell that starts with = or @ would be a live
 * formula once pasted (a Hub room carries other people's words: =IMPORTXML(…)), so it gets a leading ' (kept as text).
 * + and - are left alone: "-5" and "+1" stay numbers.
 */
export function tsvCell(cell) {
  const text = cellText(cell);
  return /^[=@]/.test(text) ? `'${text}` : text;
}

/** Rows of cells as TSV: cells by tabs, rows by line breaks. */
export function toTsv(rows) {
  return rows.map((row) => row.map(tsvCell).join("\t")).join("\n");
}

/**
 * Install the cell selection on `list` (the thread element). `deps.phone()` → true on a phone (a coarse pointer): then
 * nothing is selected as cells. Returns a function that removes everything (and clears a selection).
 */
export function installTableSelection(list, deps = {}) {
  const doc = list.ownerDocument;
  const win = doc.defaultView;
  // anchor: the cell pressed; focus: the far corner; cells: true once the drag left the anchor (a cell selection).
  let anchor = null, focus = null, cells = false, dragging = false, painted = [];

  const phone = () => { try { return !!deps.phone?.(); } catch { return false; } };
  function unpaint() {
    for (const c of painted) c.classList.remove(SEL);
    painted = [];
  }
  function clear() {
    unpaint();
    anchor?.closest?.("table")?.classList.remove(ON);
    anchor = null; focus = null; cells = false; dragging = false;
  }
  const active = () => {
    if (cells && anchor && !anchor.isConnected) clear();   // the thread drew the table again
    return cells && !!anchor;
  };
  function paint() {
    unpaint();
    const table = anchor.closest("table");
    for (const row of rectCells(table, anchor, focus)) for (const c of row) { c.classList.add(SEL); painted.push(c); }
  }
  function toCells(cell) {
    if (!cells) { cells = true; anchor.closest("table")?.classList.add(ON); }
    focus = cell; paint();
    doc.getSelection?.()?.removeAllRanges?.();
  }

  function onDown(e) {
    const cell = e.button === 0 && e.pointerType === "mouse" && !phone() ? cellOf(list, e.target) : null;
    // Shift+click in the same table: the far corner moves there (a selection already made, or from the cell pressed).
    if (cell && e.shiftKey && anchor && anchor.isConnected && cell.closest("table") === anchor.closest("table")) {
      e.preventDefault(); dragging = true; toCells(cell); return;
    }
    clear();
    if (!cell) return;
    anchor = cell; focus = cell; dragging = true;
  }
  function onMove(e) {
    if (!dragging || !anchor) return;
    if (!anchor.isConnected) { clear(); return; }
    const cell = cellOf(list, e.target);
    // Off the table (or in another): the corner stays where it was.
    if (!cell || cell.closest("table") !== anchor.closest("table")) { if (cells) doc.getSelection?.()?.removeAllRanges?.(); return; }
    if (cell === focus && cells) { doc.getSelection?.()?.removeAllRanges?.(); return; }
    if (cell === anchor && !cells) return;            // still in the cell pressed: the browser's text selection
    toCells(cell);
  }
  function onUp() { dragging = false; }
  // While cells are selected, a drag must not start the browser's own selection again.
  function onSelectStart(e) { if (dragging && cells) e.preventDefault(); }
  function onKey(e) {
    if (e.key === "Escape" && active()) clear();
  }
  function onCopy(e) {
    if (!active()) return;
    // A field with its own selection (the composer) copies its own text.
    const ae = doc.activeElement;
    if (ae && (ae.isContentEditable || /^(INPUT|TEXTAREA)$/.test(ae.tagName || "")) && ae.selectionStart !== ae.selectionEnd) return;
    const sel = doc.getSelection?.();
    if (sel && !sel.isCollapsed && String(sel.toString() || "").trim()) return;   // a text selection made since
    const tsv = toTsv(rectCells(anchor.closest("table"), anchor, focus));
    if (!e.clipboardData) return;
    e.clipboardData.setData("text/plain", tsv);
    e.preventDefault();
  }

  doc.addEventListener("pointerdown", onDown, true);
  doc.addEventListener("pointermove", onMove, true);
  doc.addEventListener("pointerup", onUp, true);
  doc.addEventListener("pointercancel", onUp, true);
  doc.addEventListener("selectstart", onSelectStart, true);
  doc.addEventListener("keydown", onKey);
  doc.addEventListener("copy", onCopy);
  win?.addEventListener?.("blur", onUp);
  return () => {
    clear();
    doc.removeEventListener("pointerdown", onDown, true);
    doc.removeEventListener("pointermove", onMove, true);
    doc.removeEventListener("pointerup", onUp, true);
    doc.removeEventListener("pointercancel", onUp, true);
    doc.removeEventListener("selectstart", onSelectStart, true);
    doc.removeEventListener("keydown", onKey);
    doc.removeEventListener("copy", onCopy);
    win?.removeEventListener?.("blur", onUp);
  };
}
