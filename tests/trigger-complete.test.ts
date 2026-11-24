/**
 * Fleet › Tasks' `@` and the chat's `#` completion are one function, `triggerAt` / `insertAtTrigger`
 * (src/ui/trigger-complete.js), told apart by the trigger character.
 *   1. The rule of each trigger, through the generic function: where the list opens, what the query is, what is put in.
 *   2. The two pairs the pages call (`mentionAt` / `insertMention`, `taskRefAt` / `insertTaskRef`) are that function with
 *      their trigger — nothing of their own — and both modules take it from the one file.
 *   3. A trigger that is not one reads nothing.
 * The behaviour of each pair is held by its own suite (task-board-revamp-294 for `@` — its pair lives in a module that needs the
 * app's harness — with the board-parser battery, chat-task-refs for `#`); this one holds the join between them.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error — page modules: plain JS, no declarations
import { insertAtTrigger, triggerAt, withoutCode } from "../src/ui/trigger-complete.js";
// @ts-expect-error — page module
import { insertTaskRef, taskRefAt } from "../src/ui/chat-task-refs.js";

const src = (file: string) => readFileSync(new URL(`../src/ui/${file}`, import.meta.url), "utf8");

describe("the trigger character picks the rule", () => {
  it("`@`: a name of any script, not after a letter / path / address / second @, not in code", () => {
    expect(triggerAt("hi @al", 6, "@")).toEqual({ start: 3, query: "al" });
    expect(triggerAt("請@小金", 4, "@")).toEqual({ start: 1, query: "小金" });
    expect(triggerAt("(@x-y.z", 7, "@")).toEqual({ start: 1, query: "x-y.z" });
    for (const text of ["me@host", "a/@x", "C:\\@x", "@@x", "`ask @x`", "```\n@x\n```"]) expect(triggerAt(text, text.length - (text.endsWith("`") ? 1 : 0), "@"), text).toBeNull();
  });
  it("`#`: a card number or a word of a title, not after a word / path / @ / second #, not in a command line", () => {
    expect(triggerAt("see #M-1", 8, "#")).toEqual({ start: 4, query: "M-1" });
    expect(triggerAt("請看，#登入", 7, "#")).toEqual({ start: 3, query: "登入" });
    for (const text of ["page#top", "a/b#c", "x@y#z", "##x", "# x", "/btw look at #M-3", "  /btw #M"]) expect(triggerAt(text, text.length, "#"), text).toBeNull();
  });
  it("the same text reads differently under each trigger", () => {
    // a `#` is no trigger of the `@` rule, and the other way round
    expect(triggerAt("see #M-1", 8, "@")).toBeNull();
    expect(triggerAt("hi @al", 6, "#")).toBeNull();
    // code hides an `@` (the board does not read it there) but not a `#` (the card list is offered while typing)
    expect(triggerAt("`x @al`", 6, "@")).toBeNull();
    expect(triggerAt("`x #al`", 6, "#")).toEqual({ start: 3, query: "al" });
    // a `/` line is a command for `#` only
    expect(triggerAt("/cmd @al", 8, "@")).toEqual({ start: 5, query: "al" });
    expect(triggerAt("/cmd #al", 8, "#")).toBeNull();
    // `@` has no length limit on what it reads back; `#` stops at 60 characters
    expect(triggerAt(`@${"a".repeat(100)}`, 101, "@")).toEqual({ start: 0, query: "a".repeat(100) });
    expect(triggerAt(`#${"a".repeat(100)}`, 101, "#")).toBeNull();
    expect(triggerAt(`#${"a".repeat(60)}`, 61, "#")).toEqual({ start: 0, query: "a".repeat(60) });
  });
  it("the replacement: trigger, word, one space after unless one is there or a line break follows", () => {
    expect(insertAtTrigger("see @al", { start: 4, query: "al" }, 7, "@", "alpha")).toEqual({ text: "see @alpha ", caret: 11 });
    expect(insertAtTrigger("see #lo", { start: 4, query: "lo" }, 7, "#", "M-3")).toEqual({ text: "see #M-3 ", caret: 9 });
    expect(insertAtTrigger("fix #lo now", { start: 4, query: "lo" }, 7, "#", "S-12")).toEqual({ text: "fix #S-12 now", caret: 10 });
    expect(insertAtTrigger("#\nnext", { start: 0, query: "" }, 1, "#", "M-1")).toEqual({ text: "#M-1\nnext", caret: 4 });
  });
  it("a word that the text after it would run on into a longer one gets a space of its own, when told the words", () => {
    expect(insertAtTrigger("Ping @a b later", { start: 5, query: "a" }, 7, "@", "a", ["a", "a b"])).toEqual({ text: "Ping @a  b later", caret: 8 });
    expect(insertAtTrigger("Ping @a b later", { start: 5, query: "a" }, 7, "@", "a", ["a"])).toEqual({ text: "Ping @a b later", caret: 8 });
    expect(insertAtTrigger("Ping @a b later", { start: 5, query: "a" }, 7, "@", "a")).toEqual({ text: "Ping @a b later", caret: 8 });
  });
  it("withoutCode blanks a fenced block and inline code, line breaks kept", () => {
    expect(withoutCode("a `b` d")).toBe("a     d");
    expect(withoutCode("x\n```\nc\n```\ny")).toBe("x\n   \n \n   \ny");
    expect(withoutCode("```\nnever closed")).toBe(`   \n${" ".repeat(12)}`);
  });
});

describe("a trigger that is not one reads nothing", () => {
  it("no list for an unknown character, a word, or an inherited property name", () => {
    for (const trigger of ["$", "", "@@", "toString", "constructor", "__proto__", undefined, null, 5]) expect(triggerAt("a $b @c #d", 5, trigger), String(trigger)).toBeNull();
  });
});

describe("the pages' pairs are this function with their trigger", () => {
  const pieces = ["", "hi ", "(", "\n", "請", "a", "a/", "`", "```\n", "/cmd ", "me", "@", "#", "al", "M-3", "x.y", " b", ",", "小金", "e\u0301"];
  const texts: string[] = [];
  for (const a of pieces) for (const b of pieces) for (const c of pieces) texts.push(a + b + c);
  it("`#`: taskRefAt / insertTaskRef over every text of a battery and every caret", async () => {
    let offered = 0;
    for (const text of texts) for (let caret = 0; caret <= text.length; caret++) {
      const at = taskRefAt(text, caret);
      expect(at, JSON.stringify({ text, caret })).toEqual(triggerAt(text, caret, "#"));
      if (!at) continue;
      offered++;
      expect(insertTaskRef(text, at, caret, "M-3")).toEqual(insertAtTrigger(text, at, caret, "#", "M-3"));
    }
    expect(offered, "the battery opens the list in many places").toBeGreaterThan(1000);
  });
  it("both modules take the rule from the one file, and keep no copy of it", () => {
    for (const file of ["chat-task-refs.js", "fleet-task-activity.js"]) {
      const text = src(file);
      expect(text, file).toMatch(/from "\.\/trigger-complete\.js"/);
      expect(text, `${file} has no rule of its own`).not.toMatch(/NOT_BEFORE|QUERY_CHAR|NAME_CHAR|MAX_QUERY/);
    }
  });
});
