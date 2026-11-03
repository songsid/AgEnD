import { describe, expect, it } from "vitest";
import { selectionCard, SELECTION_REQUEST_MAX } from "../src/selection-card.js";
import { remoteCardPrompt } from "../src/remote-card-prompt.js";
import { answerRemoteCard, type RemoteCardIo } from "../src/remote-card-answer.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { readFileSync } from "node:fs";

const rule = "─".repeat(80), separator = "╌".repeat(80);
const tail = Array.from({ length: 28 }, (_, i) => `echo same-tail-${i}`).join("\n");
const shell = (command: string, cursor = 1, countdown = "1:55", option = "Yes") => [
  rule, " Bash command", " Run the isolated probe", separator,
  ...command.split("\n").map(row => ` ${row}`), separator,
  ` ⚠ Claude Code will automatically block this request in ${countdown}, to avoid holding up an unattended session`,
  " Do you want to proceed?", `${cursor === 1 ? " ❯" : "  "} 1. ${option}`,
  `${cursor === 2 ? " ❯" : "  "} 2. No`, "", " Esc to cancel · Tab to amend", "",
].join("\n");
const read = (pane: string) => selectionCard(pane, "Claude Code");

describe("#2965 full-command human approval", () => {
  it("reads the entire real Claude 2.1.317 wrapped permission rather than its shortened transcript preview", () => {
    const pane = readFileSync(new URL("./fixtures/claude-2.1.317-long-command-2965.pane.txt", import.meta.url), "utf8");
    const card = read(pane)!;
    expect(card.question).toContain("FIRST_REQUEST");
    expect(card.question).toContain("END_REQUEST' > sentinel");
    for (let i = 0; i < 42; i++) expect(card.question).toContain(`wrapped-command-${String(i).padStart(2, "0")}`);
    expect(read(pane.replace("FIRST_REQUEST", "HISTORY_ONLY"))!.identity).toBe(card.identity);
    expect(read(pane.replaceAll("FIRST_REQUEST", "OTHER_REQUEST"))!.identity).not.toBe(card.identity);
  });
  it("shows and binds the full wrapped command, including its prefix beyond the old ten/14-row tail", () => {
    const command = `printf FIRST-REQUEST\n${tail}`;
    const card = read(shell(command))!;
    expect(card.question).toContain(command);
    expect(remoteCardPrompt("worker", card).message).toContain(command);
    expect(card.identity).not.toBe(read(shell(`printf OTHER-REQUEST\n${tail}`))!.identity);
    const permission = new ClaudeCodeBackend("/scratch/unused-instance").getRuntimeDialogs().find(d => /Claude Bash permission/.test(d.description))!;
    expect(permission.requestIdentity!(shell(command))).toBe(card.identity);
    expect(permission.requestIdentity!(shell(command).split("\n").slice(7).join("\n"))).toBeNull();
  });
  it("keeps characters beyond 200 columns and option suffixes beyond 160 columns", () => {
    const command = `printf '${"x".repeat(280)} suffix-one'`;
    const option = `Yes, allow ${"a".repeat(180)} ending-one`;
    const a = read(shell(command, 1, "1:55", option))!;
    expect(a.question).toContain(command);
    expect(a.options[0]!.title).toBe(option);
    expect(a.identity).not.toBe(read(shell(command.replace("one", "two"), 1, "1:55", option))!.identity);
    expect(a.identity).not.toBe(read(shell(command, 1, "1:55", option.replace("one", "two")))!.identity);
  });
  it("never masks command arguments or whitespace that looks like a countdown", () => {
    const a = read(shell("sleep 30s; echo 'at 1:55'; printf 'a  b'"))!;
    for (const other of ["sleep 29s; echo 'at 1:55'; printf 'a  b'", "sleep 30s; echo 'at 1:54'; printf 'a  b'", "sleep 30s; echo 'at 1:55'; printf 'a b'"]) {
      expect(read(shell(other))!.identity).not.toBe(a.identity);
    }
    const indented = "python - <<'PY'\nif True:\n    print('inside')\n\nPY";
    expect(read(shell(indented))!.question).toContain(indented);
    const literalSeparator = `cat <<'EOF'\n--------\n${separator}\nEOF`;
    expect(read(shell(literalSeparator))!.question).toContain(literalSeparator);
  });
  it("ignores cursor movement and only the provider's separate countdown row", () => {
    expect(read(shell("echo safe", 2, "1:54"))!.identity).toBe(read(shell("echo safe", 1, "1:55"))!.identity);
    const literal = "⚠ Claude Code will automatically block this request in 1:55, to avoid holding up an unattended session";
    expect(read(shell(literal))!.identity).not.toBe(read(shell(literal.replace("1:55", "1:54")))!.identity);
  });
  it("holds a clipped shell header or an oversized request rather than approving its visible tail", () => {
    const pane = shell(`echo prefix\n${tail}`);
    expect(read(pane.slice(pane.indexOf("echo same-tail-10")))).toBeNull();
    expect(read(shell("x".repeat(SELECTION_REQUEST_MAX)))).toBeNull();
    expect(read(shell("echo prefix\n… +30 lines (ctrl+o to expand)\necho tail"))).toBeNull();
    expect(read(shell("echo hidden\x08characters"))).toBeNull();
  });
  it("keeps literal box characters and trailing spaces within the native command gutter", () => {
    const a = shell("printf literal│  ").replace(" printf literal", " │ printf literal");
    const b = a.replace("literal│", "literal┃");
    expect(read(a)!.question).toContain("printf literal│  ");
    expect(read(a)!.identity).not.toBe(read(b)!.identity);
    expect(read(a)!.identity).not.toBe(read(a.replace("literal│  ", "literal│ "))!.identity);
  });
  it("holds ambiguous command-owned dialog headers rather than treating their suffix as a complete request", () => {
    expect(read(shell(`cat <<'EOF'\n${rule}\nBash command\n${separator}\necho hidden suffix\nEOF`))).toBeNull();
    const title = "Would you like to run the following command?";
    expect(selectionCard(`${title}\n\n$ cat <<'EOF'\n${title}\n$ echo tail\nEOF\n\n› 1. Yes, proceed (y)\n  2. No (esc)\n`, "Codex")).toBeNull();
  });
  it("Codex keeps the full command across its interior double blank, and refuses a clipped request", () => {
    const prefix = "  Would you like to run the following command?\n\n  Environment: local\n\n  Reason: isolated probe\n\n";
    const command = `  $ printf FIRST-REQUEST\n${tail}\n\n\n`;
    const options = "› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel\n";
    const card = selectionCard(prefix + command + options, "Codex")!;
    expect(card.question).toContain("printf FIRST-REQUEST");
    expect(card.identity).not.toBe(selectionCard(prefix + command.replace("FIRST", "OTHER") + options, "Codex")!.identity);
    expect(selectionCard(command + options, "Codex")).toBeNull();
    expect(selectionCard(prefix + rule + "\n" + command + options, "Codex")).toBeNull();
    expect(selectionCard(prefix + " $ echo first\n… +30 lines (ctrl+o to expand)\necho tail\n\n" + options, "Codex")).toBeNull();
    const program = "  $ python - <<'PY'\n  if True:\n      print('inside')\n  PY\n\n";
    expect(selectionCard(prefix + program + options, "Codex")!.question).toContain("$ python - <<'PY'\nif True:\n    print('inside')\nPY");
  });
  it.each([false, true])("a replacement with the same tail gets no submitting Enter (swap during navigation=%s)", async swapDuringWalk => {
    let cursor = 1, changed = !swapDuringWalk, closed = false, ticks = 0;
    const keys: string[] = [];
    const pane = () => closed ? "> " : shell(`printf ${changed ? "OTHER" : "FIRST"}\n${tail}`, cursor);
    const identity = read(shell(`printf FIRST\n${tail}`))!.identity;
    const io: RemoteCardIo = {
      locked: fn => fn(), read: async () => pane(), sleep: async () => {}, now: () => ticks += 100,
      paste: async () => false,
      key: async key => { keys.push(key); if (key === "Down") { cursor++; changed = true; } if (key === "Enter") closed = true; return true; },
    };
    const result = await answerRemoteCard(io, read, identity, { kind: "option", n: 2 });
    expect(result.outcome).toBe(swapDuringWalk ? "stopped" : "stale");
    expect(keys).toEqual(swapDuringWalk ? ["Down"] : []);
  });
  it("an unchanged full command still walks to the chosen option and submits once", async () => {
    let cursor = 1, closed = false, ticks = 0;
    const keys: string[] = [];
    const command = `printf FIRST\n${tail}`;
    const io: RemoteCardIo = {
      locked: fn => fn(), read: async () => closed ? "> " : shell(command, cursor), sleep: async () => {}, now: () => ticks += 100,
      paste: async () => false, key: async key => { keys.push(key); if (key === "Down") cursor++; if (key === "Enter") closed = true; return true; },
    };
    expect(await answerRemoteCard(io, read, read(shell(command))!.identity, { kind: "option", n: 2 })).toEqual({ outcome: "answered" });
    expect(keys).toEqual(["Down", "Enter"]);
  });
});
