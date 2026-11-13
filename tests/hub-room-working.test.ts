/**
 * Hub rooms WorkBar helper (hub-rooms-ux.md §3). Literal room-detail rows (no #3848 fixture import).
 * Stacked on #3850 so hroom() resolves; PR 2 adds the HUB_UI_MODULES line.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setLang } from "/assets/app-i18n.js";
import { assistantFootnote, workingLine } from "/ui/js/hub-room-working.js";

beforeAll(async () => { await import("/ui/js/hub-room-strings.js"); });
afterEach(() => setLang("en", { store: false }));

type Member = { id: string; kind: string; name: string; presence: string; owner?: { name: string } };
const agent = (over: Partial<Member> = {}): Member => ({ id: "exp-ph", kind: "agent", name: "project-helper", owner: { name: "林小華" }, presence: "online", ...over });
const notes = (over: Partial<Member> = {}): Member => ({ id: "exp-dn", kind: "agent", name: "desk-notes", owner: { name: "吳小安" }, presence: "online", ...over });
const assistant = (over: Partial<Member> = {}): Member => ({ id: "asst", kind: "assistant", name: "房間助理", presence: "online", ...over });
const person = (over: Partial<Member> = {}): Member => ({ id: "person-chen", kind: "person", name: "陳主任", presence: "online", ...over });
const later = (over: Partial<Member> = {}): Member => ({ id: "exp-rb", kind: "later", name: "report-bot", owner: { name: "吳小安" }, presence: "offline", ...over });
const detail = (members: Member[]) => ({
  room: { id: "room-weekly", name: "研一主管週會" },
  me: { id: "person-wang", role: "manager" },
  members,
});

describe("workingLine", () => {
  it("is null when nobody working, and people (or later rows) never count", () => {
    expect(workingLine(detail([]))).toBeNull();
    expect(workingLine(detail([agent(), assistant(), person({ presence: "working" }), later({ presence: "working" })]))).toBeNull();
    expect(workingLine(undefined)).toBeNull();
  });

  it("one agent: workingOne with the agent name, EN and zh-TW", () => {
    const row = detail([agent({ presence: "working" }), person({ presence: "working" })]);
    setLang("en", { store: false });
    expect(workingLine(row)).toEqual({ text: "project-helper is working on it", names: ["project-helper"], count: 1 });
    setLang("zh-TW", { store: false });
    expect(workingLine(row)).toEqual({ text: "project-helper 正在處理", names: ["project-helper"], count: 1 });
  });

  it("one assistant: workingOne with the room-assistant word, EN and zh-TW", () => {
    const row = detail([assistant({ presence: "working" }), person({ presence: "working" })]);
    setLang("en", { store: false });
    expect(workingLine(row)).toEqual({ text: "Room assistant is working on it", names: ["Room assistant"], count: 1 });
    setLang("zh-TW", { store: false });
    expect(workingLine(row)).toEqual({ text: "房間助理 正在處理", names: ["房間助理"], count: 1 });
  });

  it("several: workingMany with the count and names, people ignored", () => {
    const row = detail([
      agent({ presence: "working" }),
      notes({ presence: "working" }),
      assistant({ presence: "working" }),
      person({ presence: "working" }),
      later({ presence: "working" }),
    ]);
    setLang("en", { store: false });
    expect(workingLine(row)).toEqual({
      text: "3 agents are working",
      names: ["project-helper", "desk-notes", "Room assistant"],
      count: 3,
    });
    setLang("zh-TW", { store: false });
    expect(workingLine(row)).toEqual({
      text: "3 個 Agent 正在處理",
      names: ["project-helper", "desk-notes", "房間助理"],
      count: 3,
    });
  });
});

describe("assistantFootnote", () => {
  it("returns basedOnRecent for an assistant answer, and empty for a person or a non-answer", () => {
    setLang("en", { store: false });
    expect(assistantFootnote({ author: { kind: "assistant", id: "asst", name: "Room assistant" }, answerTo: "msg-ask", text: "整理好了" }))
      .toBe("Based on this room's recent conversation");
    expect(assistantFootnote({ author: { kind: "person", id: "person-chen", name: "陳主任" }, answerTo: "msg-ask", text: "收到" }))
      .toBe("");
    expect(assistantFootnote({ author: { kind: "assistant", id: "asst", name: "Room assistant" }, text: "待命" }))
      .toBe("");
    setLang("zh-TW", { store: false });
    expect(assistantFootnote({ author: { kind: "assistant", id: "asst" }, answerTo: "msg-ask" }))
      .toBe("根據這個房間最近的對話");
  });
});
