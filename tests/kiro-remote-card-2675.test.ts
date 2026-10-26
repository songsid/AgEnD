/**
 * #2675: kiro V3's Question and MCP `Input requested` cards, read from the pane (tests/fixtures/kiro-question-2592 and
 * kiro-2.34.0-audit, captured live from 2.34.0 / 2.33.1) and answered from the chat on a verified cursor. The answer
 * sequencer runs against a card that follows tui.js `A0`'s keys (2.34.0) and paints the fixtures' own rows.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import { readKiroMcpInputCard, readKiroQuestionCard, KiroBackend, probeKiroCliCompatibility } from "../src/backend/kiro.js";
import type { RemoteCard } from "../src/backend/types.js";
import { answerRemoteCard, type RemoteCardAction, type RemoteCardKey } from "../src/remote-card-answer.js";

const Q_DIR = join(import.meta.dirname, "fixtures", "kiro-question-2592");
const MCP_DIR = join(import.meta.dirname, "fixtures", "kiro-2.34.0-audit");
const qPane = (name: string) => readFileSync(join(Q_DIR, `${name}.pane.txt`), "utf-8");
const mcpPane = (name: string) => readFileSync(join(MCP_DIR, `${name}.pane.txt`), "utf-8");
const read = (pane: string): RemoteCard | null => readKiroQuestionCard(pane) ?? readKiroMcpInputCard(pane);
const CAPTURES = [["2.34.0", "120"], ["2.34.0", "80"], ["2.33.1", "120"]] as const;

describe("#2675 reading kiro V3's Question card", () => {
  it.each(CAPTURES)("%s at %s columns: the basic card — question, options, the typed-answer row, the cursor", (version, width) => {
    expect(readKiroQuestionCard(qPane(`${version}-${width}-40-question`))).toEqual({
      kind: "question", identity: "Question\nWhich branch should I use?\noptions\n1. main\n2. release", title: "Question",
      question: "Which branch should I use?", page: "options", freeText: true, cursor: 0, typed: null, rowWidth: Number(width),
      options: [{ n: 1, title: "main", recommended: false, description: null }, { n: 2, title: "release", recommended: false, description: null }],
    });
  });

  it.each(CAPTURES)("%s at %s columns: (recommended), a description row, the cursor where a person left it", (version, width) => {
    const rich = readKiroQuestionCard(qPane(`${version}-${width}-50-question-rich`))!;
    expect(rich.options).toEqual([
      { n: 1, title: "Staged rollout", recommended: true, description: "Ship to 10% of hosts first, then the rest" },
      { n: 2, title: "All at once", recommended: false, description: null },
      { n: 3, title: "Choose components", recommended: false, description: null },
    ]);
    expect(rich.cursor).toBe(0);
    const back = readKiroQuestionCard(qPane(`${version}-${width}-52-question-suboptions-back`))!;
    expect(back.cursor).toBe(2);
    expect(back.identity).toBe(rich.identity);   // moving is not another card
  });

  it.each(CAPTURES)("%s at %s columns: the sub-options page is its own card, with its boxes", (version, width) => {
    const sub = readKiroQuestionCard(qPane(`${version}-${width}-51-question-suboptions`))!;
    expect(sub).toMatchObject({ page: "suboptions", freeText: false, cursor: 0, question: "How should I deploy this change?" });
    expect(sub.options.map(o => [o.title, o.checked])).toEqual([["api", true], ["web", true]]);
    expect(sub.identity).not.toBe(readKiroQuestionCard(qPane(`${version}-${width}-50-question-rich`))!.identity);
  });

  it.each(CAPTURES)("%s at %s columns: an answer being typed is the same card, on its freetext page", (version, width) => {
    const typing = readKiroQuestionCard(qPane(`${version}-${width}-41-question-paste`))!;
    expect(typing).toMatchObject({ page: "freetext", cursor: null, typed: "hello from agend" });
    expect(typing.identity).toBe(readKiroQuestionCard(qPane(`${version}-${width}-40-question`))!.identity);
  });

  it.each(CAPTURES.flatMap(([v, w]) => ["42-question-paste-enter", "43-after-turn", "53-question-esc", "59-end"].map(s => [v, w, s])))(
    "%s at %s columns, %s: no card", (version, width, step) => {
      expect(read(qPane(`${version}-${width}-${step}`))).toBeNull();
    });
});

describe("#2675 reading kiro V3's MCP input card", () => {
  it.each(["120", "80"])("%s columns: a form — the server, its rows, Submit / Decline, the focused field", width => {
    const form = readKiroMcpInputCard(mcpPane(`mcp-${width}-10-form-2.34.0`))!;
    expect(form).toMatchObject({ kind: "input", server: "MCP server", mode: "form", actions: ["Submit", "Decline"], cursorRow: "Favourite colour (required)" });
    expect(form.rows[0]).toBe("The audit server asks for a few values");
    // Filling in a field moves the focus and repaints rows: still the same request.
    expect(readKiroMcpInputCard(mcpPane(`mcp-${width}-12-form-paste-enter-2.34.0`))!.identity).toBe(form.identity);
  });

  it.each(["120", "80"])("%s columns: a url request — the URL row is masked, the host stays", width => {
    const url = readKiroMcpInputCard(mcpPane(`mcp-${width}-20-url-2.34.0`))!;
    expect(url).toMatchObject({ mode: "url", cursorRow: "Copy URL", actions: ["Open in browser", "Copy URL", "I'll open it myself", "Decline", "Cancel"] });
    expect(url.rows).toContain("Host: example.invalid");
    expect(url.rows).toContain("URL: (shown in the instance pane)");
    expect(JSON.stringify(url)).not.toContain("example.invalid/authorize");
  });

  it("a URL that wraps: every row of it is masked, up to the next action (#2677 review)", () => {
    const wrapped = mcpPane("mcp-80-20-url-2.34.0").replace(/^(\s*URL: .*)$/m, "$1\n   continued-path?token=SECRETTAIL123\n   &more=SECRETTAIL456");
    const url = readKiroMcpInputCard(wrapped)!;
    expect(url).not.toBeNull();
    expect(JSON.stringify(url)).not.toContain("SECRETTAIL");
    expect(url.rows).toEqual(readKiroMcpInputCard(mcpPane("mcp-80-20-url-2.34.0"))!.rows);
  });

  it.each(["mcp-120-13-form-esc-2.34.0", "mcp-120-19-after-turn-2.34.0", "mcp-120-21-url-esc-2.34.0", "mcp-120-30-question-2.34.0"])("%s: no input card", name => {
    expect(readKiroMcpInputCard(mcpPane(name))).toBeNull();
  });

  it("the kiro backend gives both held cards their reader and an identity (and nothing else gets one)", () => {
    const help = readFileSync(join(import.meta.dirname, "fixtures", "kiro-help", "chat-help-2.34.0.txt"), "utf-8");
    const b = new KiroBackend("/tmp/kiro-2675", probeKiroCliCompatibility("/fake/kiro-cli", (_b, args) => (args[0] === "--version" ? "kiro-cli 2.34.0\n" : help)));
    const withReader = b.getRuntimeDialogs().filter(d => d.remoteCard);
    expect(withReader.map(d => d.description)).toEqual([
      "Kiro MCP server is asking for input — answer it in the instance pane",
      "Kiro agent is asking a question — answer it in the instance pane",
    ]);
    expect(withReader.every(d => d.holdOnly && d.keys.length === 0)).toBe(true);
    const question = qPane("2.34.0-120-50-question-rich");
    expect(withReader[1].requestIdentity!(question)).toBe(readKiroQuestionCard(question)!.identity);
  });
});

// ── A card that takes keys the way tui.js 2.34.0 `A0` does, painted with the fixtures' rows ─────────────────────────

const RICH = qPane("2.34.0-120-50-question-rich");
const IDLE = qPane("2.34.0-120-43-after-turn");
const lines = (pane: string) => pane.replace(/\n+$/, "").split("\n");
/** The fixture's rows above the card body (through the question and its blank row), its divider and its key hints. */
const HEAD = (() => { const rows = lines(RICH); return rows.slice(0, rows.findIndex(r => r.startsWith(" ❯ 1."))); })();
const DIVIDER = lines(RICH).find(r => /^─{20,}$/.test(r))!;
const OPTIONS_FOOTER = "   esc to cancel · ↑↓ to navigate · ↵ to submit";
const SUB_FOOTER = "   esc to go back · ↑↓ to navigate · space to toggle · ↵ to submit";

interface Option { title: string; recommended?: boolean; description?: string; sub?: string[] }
const DEPLOY: Option[] = [
  { title: "Staged rollout", recommended: true, description: "Ship to 10% of hosts first, then the rest" },
  { title: "All at once" },
  { title: "Choose components", sub: ["api", "web"] },
];

class FakeQuestionCard {
  open = true;
  page: "options" | "sub" | "free" = "options";
  cursor: number;
  typed = "";
  subFocus = 0;
  checked: boolean[] = [];
  answers: string[] = [];
  keys: string[] = [];
  /** A key that does nothing (the TUI dropped it). */
  deaf: RemoteCardKey | null = null;
  /** Another question painted in this card's place (the agent asked the next one). */
  question: string | null = null;
  constructor(readonly options: Option[] = DEPLOY, readonly freeText = true) {
    this.cursor = Math.max(0, options.findIndex(o => o.recommended));
  }
  private rows(): number { return this.options.length + (this.freeText ? 1 : 0); }
  private close(answer: string) { this.open = false; this.answers.push(answer); }
  key(key: RemoteCardKey): boolean {
    this.keys.push(key);
    if (!this.open || key === this.deaf) return true;
    if (this.page === "free") {
      if (key === "Escape") { this.page = "options"; this.typed = ""; }
      else if (key === "Enter" && this.typed.trim()) this.close(this.typed);
      else if (key === "Space") this.typed += " ";
      return true;
    }
    if (this.page === "sub") {
      const sub = this.options[this.cursor].sub!;
      if (key === "Up" || key === "Down") this.subFocus = (this.subFocus + (key === "Up" ? -1 : 1) + sub.length) % sub.length;
      else if (key === "Space") this.checked[this.subFocus] = !this.checked[this.subFocus];
      else if (key === "Enter") this.close(`${this.options[this.cursor].title} [${sub.filter((_, i) => this.checked[i]).join(", ")}]`);
      else if (key === "Escape") this.page = "options";
      return true;
    }
    if (key === "Up" || key === "Down") this.cursor = (this.cursor + (key === "Up" ? -1 : 1) + this.rows()) % this.rows();
    else if (key === "Escape") this.close("(cancelled)");
    else if (key === "Space" && this.freeText) { this.page = "free"; this.typed = " "; }
    else if (key === "Enter") {
      if (this.cursor === this.options.length) { this.page = "free"; this.typed = ""; return true; }
      const option = this.options[this.cursor];
      if (option.sub) { this.page = "sub"; this.subFocus = 0; this.checked = option.sub.map(() => true); }
      else this.close(option.title);
    }
    return true;
  }
  paste(text: string): boolean {
    this.keys.push(`paste:${text}`);
    if (!this.open || !this.freeText) return true;
    if (this.page === "options") { this.page = "free"; this.typed = text; }
    else if (this.page === "free") this.typed += text;
    return true;
  }
  render(): string {
    if (!this.open) return IDLE;
    const body: string[] = [];
    if (this.page === "sub") {
      this.options[this.cursor].sub!.forEach((title, i) => body.push(`${i === this.subFocus ? " ❯ " : "   "}[${this.checked[i] ? "✓" : " "}] ${title}`));
    } else {
      this.options.forEach((o, i) => {
        body.push(`${this.page === "options" && i === this.cursor ? " ❯ " : "   "}${i + 1}. ${o.title}${o.recommended ? " (recommended)" : ""}`);
        if (o.description) body.push(`      ${o.description}`);
      });
      // The typed-answer row is clipped at the card's edge (120 columns here): a long answer shows its end.
      if (this.page === "free") body.push(` ❯ ${this.typed.slice(-114)}`);
      else if (this.freeText) body.push(`${this.cursor === this.options.length ? " ❯ " : "   "}Type a different answer…`);
    }
    const head = this.question === null ? HEAD : HEAD.map(row => row === " How should I deploy this change?" ? ` ${this.question}` : row);
    return [...head, ...body, DIVIDER, this.page === "sub" ? SUB_FOOTER : OPTIONS_FOOTER, "", ""].join("\n");
  }
}

/** The sequencer's IO over a fake: every key and paste must happen under the lock; `onKey` lets a person interfere. */
function io(card: { key(k: RemoteCardKey): boolean; paste?(t: string): boolean; render(): string }, onKey?: (n: number) => void, onRead?: (locked: boolean) => void) {
  let locked = 0, clock = 0, sent = 0;
  const unlockedKeys: string[] = [];
  return {
    unlockedKeys,
    io: {
      locked: async <T,>(fn: () => Promise<T>) => { locked++; try { return await fn(); } finally { locked--; } },
      read: async (): Promise<string | null> => { onRead?.(locked > 0); return card.render(); },
      key: async (k: RemoteCardKey) => { if (!locked) unlockedKeys.push(k); const ok = card.key(k); onKey?.(++sent); return ok; },
      paste: async (t: string) => { if (!locked) unlockedKeys.push("paste"); return card.paste!(t); },
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
    },
  };
}

const ask = async (card: FakeQuestionCard, action: RemoteCardAction, onKey?: (n: number) => void, identity = read(card.render())!.identity,
  onRead?: (locked: boolean) => void) => {
  const harness = io(card, onKey, onRead);
  const outcome = await answerRemoteCard(harness.io, read, identity, action);
  expect(harness.unlockedKeys).toEqual([]);
  return outcome;
};

describe("#2675 answering the Question card from the chat", () => {
  it("the fake paints what the reader reads on the captured card", () => {
    expect(read(new FakeQuestionCard().render())).toEqual(readKiroQuestionCard(RICH));
  });

  it("an option below the cursor: walked down one verified row at a time, then Enter", async () => {
    const card = new FakeQuestionCard();
    expect(await ask(card, { kind: "option", n: 2 })).toEqual({ outcome: "answered" });
    expect(card.keys).toEqual(["Down", "Enter"]);
    expect(card.answers).toEqual(["All at once"]);
  });

  it("an option above where a person left the cursor: walked up, never wrapping round", async () => {
    const card = new FakeQuestionCard();
    card.cursor = 3;   // on "Type a different answer…"
    expect(await ask(card, { kind: "option", n: 1 })).toEqual({ outcome: "answered" });
    expect(card.keys).toEqual(["Up", "Up", "Up", "Enter"]);
    expect(card.answers).toEqual(["Staged rollout"]);
  });

  it("an option with sub-options opens its page, which is a new card; it is submitted with all, or with one", async () => {
    const card = new FakeQuestionCard();
    expect(await ask(card, { kind: "option", n: 3 })).toEqual({ outcome: "suboptions" });
    expect(card.page).toBe("sub");
    const only = await ask(card, { kind: "suboptions", only: 2 });
    expect(only).toEqual({ outcome: "answered" });
    expect(card.answers).toEqual(["Choose components [web]"]);

    const all = new FakeQuestionCard();
    await ask(all, { kind: "option", n: 3 });
    all.checked = [false, true];   // a person untick "api" in the pane
    all.keys = [];
    expect(await ask(all, { kind: "suboptions", only: null })).toEqual({ outcome: "answered" });
    expect(all.keys).toEqual(["Space", "Enter"]);
    expect(all.answers).toEqual(["Choose components [api, web]"]);
  });

  it("back from the sub-options page", async () => {
    const card = new FakeQuestionCard();
    await ask(card, { kind: "option", n: 3 });
    expect(await ask(card, { kind: "back" })).toEqual({ outcome: "back" });
    expect(card.page).toBe("options");
  });

  it("a typed answer: pasted, seen on the typed-answer row, then Enter; line breaks become spaces", async () => {
    const card = new FakeQuestionCard();
    expect(await ask(card, { kind: "text", text: "release, but\nonly after the freeze" })).toEqual({ outcome: "answered" });
    expect(card.keys).toEqual(["paste:release, but only after the freeze", "Enter"]);
    expect(card.answers).toEqual(["release, but only after the freeze"]);
  });

  it("a long typed answer: a full row clipped at the card's edge that is its end", async () => {
    const card = new FakeQuestionCard();
    const long = "word ".repeat(60).trim();
    expect(await ask(card, { kind: "text", text: long })).toEqual({ outcome: "answered" });
    expect(card.answers).toEqual([long]);
  });

  it("skip: Esc, and the card says Cancelled", async () => {
    const card = new FakeQuestionCard();
    expect(await ask(card, { kind: "skip" })).toEqual({ outcome: "answered" });
    expect(card.keys).toEqual(["Escape"]);
  });

  it("refused without a key: no typed answer on this card, an empty answer, no such option, the wrong page", async () => {
    const noFree = new FakeQuestionCard(DEPLOY, false);
    expect(await ask(noFree, { kind: "text", text: "x" })).toMatchObject({ outcome: "refused" });
    const card = new FakeQuestionCard();
    expect(await ask(card, { kind: "text", text: " \n " })).toMatchObject({ outcome: "refused" });
    expect(await ask(card, { kind: "option", n: 4 })).toMatchObject({ outcome: "refused" });
    expect(await ask(card, { kind: "suboptions", only: null })).toMatchObject({ outcome: "refused" });
    expect(await ask(card, { kind: "decline" })).toMatchObject({ outcome: "refused" });
    card.page = "free"; card.typed = "a person is typing";
    expect(await ask(card, { kind: "option", n: 1 })).toMatchObject({ outcome: "refused" });
    expect(card.keys).toEqual([]);
  });

  it("another card than the one the person saw: stale, no key", async () => {
    const card = new FakeQuestionCard();
    expect(await ask(card, { kind: "option", n: 2 }, undefined, "Question\nSomething else?\noptions\n1. a")).toEqual({ outcome: "stale" });
    expect(card.keys).toEqual([]);
  });

  it("a person moves the cursor while it is walked: it stops, and nothing is submitted", async () => {
    const card = new FakeQuestionCard();
    const outcome = await ask(card, { kind: "option", n: 3 }, n => { if (n === 1) card.cursor = 0; });
    expect(outcome).toMatchObject({ outcome: "stopped" });
    expect(card.keys).not.toContain("Enter");
    expect(card.answers).toEqual([]);
  });

  it("the card is answered in the pane meanwhile: it stops, and nothing more is sent", async () => {
    const card = new FakeQuestionCard();
    const outcome = await ask(card, { kind: "option", n: 3 }, n => { if (n === 1) { card.open = false; card.answers.push("by hand"); } });
    expect(outcome).toMatchObject({ outcome: "stopped" });
    expect(card.keys).toEqual(["Down"]);
    expect(card.answers).toEqual(["by hand"]);
  });

  it("a key the TUI drops: it stops after the wait instead of pressing on", async () => {
    const card = new FakeQuestionCard();
    card.deaf = "Down";
    expect(await ask(card, { kind: "option", n: 2 })).toMatchObject({ outcome: "stopped", step: "moving to option 2" });
    expect(card.keys).toEqual(["Down"]);
  });

  it("another question replaces the card just before the key: the read under the lock refuses it", async () => {
    const card = new FakeQuestionCard();
    const identity = read(card.render())!.identity;
    // The walk's own reads still see the card; the next question is painted by the time the lock is held for Enter.
    const outcome = await ask(card, { kind: "option", n: 2 }, undefined, identity, locked => { if (locked && card.cursor === 1) card.question = "Which region?"; });
    expect(outcome).toMatchObject({ outcome: "stopped", step: "submitting the option" });
    expect(card.keys).toEqual(["Down"]);
    expect(card.answers).toEqual([]);
  });

  it("a submitting key the card ignores: reported as not closed, not as answered", async () => {
    const card = new FakeQuestionCard();
    card.deaf = "Escape";
    expect(await ask(card, { kind: "skip" })).toEqual({ outcome: "stopped", step: "the card did not close" });
    const typed = new FakeQuestionCard();
    typed.deaf = "Enter";
    expect(await ask(typed, { kind: "text", text: "release" })).toEqual({ outcome: "stopped", step: "the card did not close" });
  });

  it("a paste that landed only in part (room left on the row): not the answer — no Enter (#2677 review)", async () => {
    const card = new FakeQuestionCard();
    card.paste = (t: string) => { card.keys.push(`paste:${t}`); card.page = "free"; card.typed = t.slice(0, 3); return true; };
    expect(await ask(card, { kind: "text", text: "release only after review" })).toMatchObject({ outcome: "stopped", step: "the typed answer did not show" });
    expect(card.keys).toEqual(["paste:release only after review"]);
    expect(card.answers).toEqual([]);
  });

  it("a screen that cannot be read after the submit is not an answer (#2677 review)", async () => {
    const card = new FakeQuestionCard();
    card.deaf = "Escape";   // the card stays open…
    const identity = read(card.render())!.identity;
    const harness = io(card);
    const readPane = harness.io.read;
    let failing = false;
    harness.io.read = async () => (failing ? null : readPane());   // …and every capture after the key fails
    const sendKey = harness.io.key;
    harness.io.key = async (key: RemoteCardKey) => { const ok = await sendKey(key); failing = true; return ok; };
    expect(await answerRemoteCard(harness.io, read, identity, { kind: "skip" })).toEqual({ outcome: "stopped", step: "the card did not close" });
    // …nor is a screen that cannot be read before the first key.
    const blind = io(new FakeQuestionCard());
    blind.io.read = async () => null;
    expect(await answerRemoteCard(blind.io, read, identity, { kind: "option", n: 2 })).toEqual({ outcome: "stopped", step: "reading the screen" });
  });

  it("a typed answer that does not show: no Enter", async () => {
    const card = new FakeQuestionCard();
    card.paste = (t: string) => { card.keys.push(`paste:${t}`); return true; };   // the paste never lands
    expect(await ask(card, { kind: "text", text: "release" })).toMatchObject({ outcome: "stopped", step: "the typed answer did not show" });
    expect(card.keys).toEqual(["paste:release"]);
  });
});

// ── The MCP input card: Decline walks to its row; Cancel is Esc ──────────────────────────────────────────────────

class FakeInputCard {
  open = true;
  focus: number;
  keys: string[] = [];
  result: string | null = null;
  constructor(readonly fixture: string, readonly items: string[], start: number) { this.focus = start; }
  key(key: RemoteCardKey): boolean {
    this.keys.push(key);
    if (!this.open) return true;
    if (key === "Up" || key === "Down") this.focus = (this.focus + (key === "Up" ? -1 : 1) + this.items.length) % this.items.length;
    else if (key === "Escape") { this.open = false; this.result = "cancel"; }
    else if (key === "Enter" && this.items[this.focus] === "Decline") { this.open = false; this.result = "decline"; }
    return true;
  }
  render(): string {
    if (!this.open) return mcpPane("mcp-120-19-after-turn-2.34.0");
    // The fixture's own rows, with the ❯ moved to the focused item's row.
    return lines(this.fixture).map(row => {
      const plain = row.replace(/^ ❯ /, "   ");
      const at = this.items.findIndex(item => plain.trim() === item || plain.trim().startsWith(`${item}:`) || plain.trim().startsWith(`${item} (`));
      return at < 0 ? plain : at === this.focus ? plain.replace(/^ {3}/, " ❯ ") : plain;
    }).join("\n");
  }
}

describe("#2675 answering the MCP input card from the chat", () => {
  const FORM = ["Favourite colour", "How many", "A short note", "Submit", "Decline"];
  const URL_ITEMS = ["Open in browser", "Copy URL", "I'll open it myself", "Decline", "Cancel"];

  it("decline a form: down past the fields and Submit, then Enter on Decline", async () => {
    const card = new FakeInputCard(mcpPane("mcp-120-10-form-2.34.0"), FORM, 0);
    const harness = io(card);
    expect(await answerRemoteCard(harness.io, read, read(card.render())!.identity, { kind: "decline" })).toEqual({ outcome: "answered" });
    expect(card.keys).toEqual(["Down", "Down", "Down", "Down", "Enter"]);
    expect(card.result).toBe("decline");
    expect(harness.unlockedKeys).toEqual([]);
  });

  it("decline a url request from Cancel: up, not round", async () => {
    const card = new FakeInputCard(mcpPane("mcp-120-20-url-2.34.0"), URL_ITEMS, 4);
    const harness = io(card);
    expect(await answerRemoteCard(harness.io, read, read(card.render())!.identity, { kind: "decline" })).toEqual({ outcome: "answered" });
    expect(card.keys).toEqual(["Up", "Enter"]);
  });

  it("cancel: Esc", async () => {
    const card = new FakeInputCard(mcpPane("mcp-120-20-url-2.34.0"), URL_ITEMS, 1);
    const harness = io(card);
    expect(await answerRemoteCard(harness.io, read, read(card.render())!.identity, { kind: "cancel" })).toEqual({ outcome: "answered" });
    expect(card.keys).toEqual(["Escape"]);
    expect(card.result).toBe("cancel");
  });

  it("a question's actions are refused on an input card, with no key", async () => {
    const card = new FakeInputCard(mcpPane("mcp-120-10-form-2.34.0"), FORM, 0);
    const harness = io(card);
    for (const action of [{ kind: "option", n: 1 }, { kind: "text", text: "x" }, { kind: "skip" }] as RemoteCardAction[]) {
      expect(await answerRemoteCard(harness.io, read, read(card.render())!.identity, action)).toMatchObject({ outcome: "refused" });
    }
    expect(card.keys).toEqual([]);
  });
});

describe("#2675 in the daemon: posted once the card holds still, retired when it closes, answered under the lock", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const HELP = readFileSync(join(import.meta.dirname, "fixtures", "kiro-help", "chat-help-2.34.0.txt"), "utf-8");
  const daemonFor = (tmux: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "agend-kiro-2675-")); dirs.push(dir);
    const instance = join(dir, "instance"), cwd = join(dir, "work");
    mkdirSync(instance); mkdirSync(cwd);
    const b = new KiroBackend(instance, probeKiroCliCompatibility("/fake/kiro-cli", (_b, args) => (args[0] === "--version" ? "kiro-cli 2.34.0\n" : HELP)));
    (b as unknown as { activeTrustAll: boolean; activeUi: string }).activeTrustAll = true;
    (b as unknown as { activeUi: string }).activeUi = "v3";
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("kiro-test", {
      working_directory: cwd, backend: "kiro-cli", restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "silent",
    } as never, instance, false, b, undefined, { child: () => logger } as never) as unknown as {
      tmux: unknown; probeBlockingDialog(): Promise<{ state: string }>; on(e: string, f: (x: unknown) => void): void;
      answerRemoteCard(identity: string, action: RemoteCardAction): Promise<unknown>;
    };
    daemon.tmux = tmux;
    return { daemon, logger };
  };

  it("remote_card after REMOTE_CARD_STABLE_MS on the same card, once; remote_card_gone when it closes; no key meanwhile", async () => {
    let screen = qPane("2.34.0-120-40-question");
    const keys: string[] = [];
    const { daemon } = daemonFor({
      capturePane: async () => screen, isWindowAlive: async () => true,
      sendSpecialKey: async (k: string) => { keys.push(k); return true; }, sendKeys: async (t: string) => { keys.push(t); return true; },
      pasteBuffer: async (t: string) => { keys.push(t); return true; },
    });
    const events: Array<[string, unknown]> = [];
    daemon.on("remote_card", e => events.push(["card", e]));
    daemon.on("remote_card_gone", e => events.push(["gone", e]));
    const clock = vi.spyOn(performance, "now");
    try {
      clock.mockReturnValue(1_000);
      await daemon.probeBlockingDialog();
      clock.mockReturnValue(2_000);
      await daemon.probeBlockingDialog();
      expect(events).toEqual([]);   // not yet still for long enough
      clock.mockReturnValue(2_600);
      await daemon.probeBlockingDialog();
      clock.mockReturnValue(9_000);
      await daemon.probeBlockingDialog();
      const card = readKiroQuestionCard(screen)!;
      expect(events).toEqual([["card", { name: "kiro-test", card }]]);
      // A person moves the cursor in the pane: the same card, nothing new.
      screen = qPane("2.34.0-120-40-question").replace(" ❯ 1. main", "   1. main").replace("   2. release", " ❯ 2. release");
      await daemon.probeBlockingDialog();
      expect(events).toHaveLength(1);
      screen = qPane("2.34.0-120-43-after-turn");
      await daemon.probeBlockingDialog();
      expect(events[1]).toEqual(["gone", { name: "kiro-test", identity: card.identity }]);
      await daemon.probeBlockingDialog();
      expect(events).toHaveLength(2);
    } finally { clock.mockRestore(); }
    expect(keys).toEqual([]);
  });

  it("a read that started before a newer one finishes late: it neither retires the newer card nor brings its own back (#2677 review)", async () => {
    let now = 1_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const A = qPane("2.34.0-120-50-question-rich"), B = qPane("2.34.0-120-40-question");
      let release!: (pane: string) => void;
      let next: () => Promise<string> = () => new Promise(resolve => { release = resolve; });
      const { daemon } = daemonFor({ capturePane: () => next(), isWindowAlive: async () => true });
      const events: Array<[string, unknown]> = [];
      daemon.on("remote_card", e => events.push(["card", (e as { card: RemoteCard }).card.identity]));
      daemon.on("remote_card_gone", e => events.push(["gone", (e as { identity: string }).identity]));
      const late = daemon.probeBlockingDialog();          // its capture starts at 1000 and is held
      next = async () => B;
      now = 2_000; await daemon.probeBlockingDialog();
      now = 4_000; await daemon.probeBlockingDialog();    // B posted
      release(A);
      await late;
      now = 9_000; await daemon.probeBlockingDialog();
      expect(events).toEqual([["card", readKiroQuestionCard(B)!.identity]]);
    } finally { clock.mockRestore(); }
  });

  it("a card that closes before it was posted is never posted, nor retired", async () => {
    let screen = mcpPane("mcp-120-10-form-2.34.0");
    const { daemon } = daemonFor({ capturePane: async () => screen, isWindowAlive: async () => true });
    const events: unknown[] = [];
    daemon.on("remote_card", e => events.push(e));
    daemon.on("remote_card_gone", e => events.push(e));
    await daemon.probeBlockingDialog();
    screen = mcpPane("mcp-120-13-form-esc-2.34.0");
    await daemon.probeBlockingDialog();
    expect(events).toEqual([]);
  });

  it("a capture that fails after the submit: not answered, though the card stays open (#2677 review)", async () => {
    const card = new FakeQuestionCard();
    card.deaf = "Escape";
    let failing = false;
    const { daemon } = daemonFor({
      capturePane: async () => { if (failing) throw new Error("capture failed"); return card.render(); }, isWindowAlive: async () => true,
      sendSpecialKey: async (k: RemoteCardKey) => { failing = true; return card.key(k); },
    });
    expect(await daemon.answerRemoteCard(read(card.render())!.identity, { kind: "skip" })).toEqual({ outcome: "stopped", step: "the card did not close" });
  });

  it("answerRemoteCard keys the live card through the tmux primitives, and never logs the typed answer", async () => {
    const card = new FakeQuestionCard();
    const { daemon, logger } = daemonFor({
      capturePane: async () => card.render(), isWindowAlive: async () => true,
      sendSpecialKey: async (k: RemoteCardKey) => card.key(k), sendKeys: async (t: string) => (t === " " ? card.key("Space") : false),
      pasteBuffer: async (t: string) => card.paste(t),
    });
    const identity = read(card.render())!.identity;
    expect(await daemon.answerRemoteCard(identity, { kind: "text", text: "ship it on Friday" })).toEqual({ outcome: "answered" });
    expect(card.answers).toEqual(["ship it on Friday"]);
    expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.debug.mock.calls])).not.toContain("Friday");
    // The card is gone now: a second click is stale, and sends nothing.
    card.keys = [];
    expect(await daemon.answerRemoteCard(identity, { kind: "option", n: 1 })).toEqual({ outcome: "stale" });
    expect(card.keys).toEqual([]);
  });
});
