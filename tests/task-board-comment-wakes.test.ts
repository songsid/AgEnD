/**
 * Comments and `@<instance>` mentions wake (docs/design/task-board.md, "Comments and mentions"; #2801 had made a
 * comment notify nobody). The rules, each tested here:
 *
 *   1. Reading `@<instance>` out of a comment: case, punctuation, boundaries, longest name, code, one name once.
 *   2. Whom a comment wakes: its card's assignee (not the writer), each instance it names (even a non-assignee), once.
 *   3. What it does not wake: an unknown or task-board-off name (said to the writer, never refused), a card still
 *      waiting on its dependencies, a finished card's assignee, a comment the assignee has already read, the fleet's
 *      switch off.
 *   4. The loop guard: agents answering each other wake each other for a few turns only; a person's word lifts it; a
 *      comment wakes a bounded number of instances.
 *   5. The notice (words, no waiting for the writer's own message) and the delivery in a real FleetManager.
 *   6. Compatibility: comments written before this rule are never told after an upgrade; no schema change.
 *
 * Isolation: temp databases; a simulated clock for the waker's 10 s window (its timers seam); fake system time for the
 * guard's window; a FleetManager with no fleet (nothing starts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerDb } from "../src/scheduler/db.js";
import { Scheduler } from "../src/scheduler/index.js";
import { FleetManager } from "../src/fleet-manager.js";
import { AGENT_COMMENT_CHAIN, AGENT_COMMENT_WINDOW_MS, MAX_COMMENT_WAKES, type Actor, type TaskBoard, type Wake } from "../src/scheduler/task-board.js";
import { parseMentions, withoutCode } from "../src/scheduler/task-board-mentions.js";
import { TaskBoardWaker, wakeMessage } from "../src/task-board-waker.js";
import { boardCommentWakesOn } from "../src/task-board-tool.js";
import { validateFleetConfig } from "../src/config-validator.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const LEAD: Actor = { kind: "instance", name: "lead" };
const DEV: Actor = { kind: "instance", name: "dev-a" };
const DEV_B: Actor = { kind: "instance", name: "dev-b" };
const SCRIPT: Actor = { kind: "script", name: "web-token" };

const dirs: string[] = [];
const dbs: SchedulerDb[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix = "task-board-comment-wakes-") => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

/** The fleet in these tests: lead, dev-a, dev-b, and `quiet`, which has the task board off. */
const INSTANCES = ["lead", "dev-a", "dev-b", "quiet"];

interface Rig { db: SchedulerDb; board: TaskBoard; path: string; heard: Array<{ to: string; code: string; reasons: string[]; by: Record<string, string | undefined>; texts: Record<string, string | undefined> }>; take: () => Rig["heard"]; switchOn: { value: boolean } }
function rig(path = join(tmp(), "scheduler.db"), instances: string[] = INSTANCES): Rig {
  const db = new SchedulerDb(path); dbs.push(db);
  const board = db.board;
  const switchOn = { value: true };
  board.setBoardOff((n) => n === "quiet");
  board.setCommentRouting({ instances: () => instances, enabled: () => switchOn.value });
  if (!board.listProjects(true).length) board.createProject(ANN, { name: "Game" });
  const heard: Rig["heard"] = [];
  board.onChange((c) => { for (const w of c.wakes) heard.push({ to: w.instance, code: w.code, reasons: w.reasons, by: w.by, texts: w.texts }); });
  return { db, board, path, heard, take: () => heard.splice(0), switchOn };
}
const card = (board: TaskBoard, by: Actor, extra: Record<string, unknown> = {}) =>
  board.createCards(by, { project: "Game", cards: [{ title: "Build the leaderboard", needsReview: false, ...extra }] }).cards[0]!;
/** The notes a comment's write said (keys). */
const noteKeys = (r: { said: Array<{ key: string }> }) => r.said.map((n) => n.key);

describe("1. reading @<instance> out of a comment", () => {
  const names = ["lead", "dev-a", "dev-b"];
  const read = (text: string, known: string[] = names) => parseMentions(text, known).names;

  it("case does not matter; the name is the instance's own spelling", () => {
    expect(read("ping @Lead and @DEV-A, thanks")).toEqual(["lead", "dev-a"]);
  });

  it("brackets, quotes, sentence punctuation and CJK text around the mention are fine", () => {
    for (const text of ["(@lead)", "@lead,", "@lead.", "@lead:", "@lead!", "“@lead”", "'@lead'", "請@lead看一下", "@lead請看", "ok\n@lead\nnow", "@lead"]) {
      expect(read(text), text).toEqual(["lead"]);
    }
  });

  it("an @ that is part of something else is not a mention: an address, a path, @@, a longer name", () => {
    for (const text of ["me@example.com", "me@lead", "a/@lead", "\\@lead", "@@lead", "x-@lead", "1.@lead", "@lead-2", "@lead_x", "@lead.v2", "@leadership", "@ lead", "lead", "@"]) {
      expect(read(text), text).toEqual([]);
    }
  });

  it("the longest name wins; a dot or hyphen inside a name keeps it whole", () => {
    expect(read("@dev-a", ["dev", "dev-a"])).toEqual(["dev-a"]);
    expect(read("@dev please", ["dev", "dev-a"])).toEqual(["dev"]);
    expect(read("@dev-a.", ["dev", "dev-a"])).toEqual(["dev-a"]);
    expect(read("@svc.v2.", ["svc.v2", "svc"])).toEqual(["svc.v2"]);
    expect(read("@svc.v2x", ["svc.v2"])).toEqual([]);
  });

  it("an exact-case name wins over one that differs only by case; a name that fits several equally names none", () => {
    expect(read("@dev and @Dev", ["Dev", "dev"])).toEqual(["dev", "Dev"]);
    expect(parseMentions("@DEV", ["Dev", "dev"])).toEqual({ names: [], unknown: [] });
  });

  it("text in code (inline or fenced) is never read, and what follows it still is", () => {
    expect(read("see `@lead` and ```\n@dev-a\n```, then @dev-b")).toEqual(["dev-b"]);
    expect(read("```\n@lead")).toEqual([]);                                 // an unclosed fence runs to the end
    expect(withoutCode("a `b` c")).toBe("a     c");
  });

  it("one name once, however often a comment says it", () => {
    expect(read("@lead @lead @LEAD")).toEqual(["lead"]);
  });

  it("a very long comment, or a very long word after an @, is cheap and still read right", () => {
    const text = `${"@x ".repeat(4000)}@dev-a ${"@" + "w".repeat(500)}`;
    const started = Date.now();
    const out = parseMentions(text, names);
    expect(Date.now() - started).toBeLessThan(500);
    expect(out.names).toEqual(["dev-a"]);
    expect(out.unknown).toEqual(["x", "w".repeat(64)]);
  });

  it("words that name no instance are reported (at most three) and are never names", () => {
    expect(parseMentions("@nobody @types/node @a @b @c @lead", names)).toEqual({ names: ["lead"], unknown: ["nobody", "types", "a"] });
    expect(parseMentions("no mention here", names)).toEqual({ names: [], unknown: [] });
    expect(parseMentions("@lead", [])).toEqual({ names: [], unknown: ["lead"] });
  });
});

describe("2. whom a comment wakes", () => {
  it("a person's comment wakes the instance assignee, with the words and who wrote them", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    take();
    const r = board.updateCard(ANN, c.code, { comment: "weekly, not daily" });
    expect(take()).toEqual([{ to: "dev-a", code: c.code, reasons: ["comment"], by: { comment: "Ann" }, texts: { comment: "weekly, not daily" } }]);
    expect(noteKeys(r)).toEqual(["comment_wakes"]);
    expect(r.notes[0]).toContain("dev-a (assignee)");
  });

  it("another instance's comment wakes the assignee too; the assignee's own comment wakes nobody, not even the dispatcher", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    take();
    board.updateCard(DEV_B, c.code, { comment: "the spec changed" });
    expect(take().map((w) => [w.to, w.by.comment])).toEqual([["dev-a", "dev-b"]]);
    board.updateCard(DEV, c.code, { comment: "noted, will redo it" });
    expect(take()).toEqual([]);
  });

  it("a card with no assignee, or a person for assignee, wakes no one by a plain comment", () => {
    const { board, take } = rig();
    const nobody = card(board, ANN);
    board.updateCard(ANN, nobody.code, { comment: "who takes this?" });
    const person = card(board, LEAD, { assignee: "Ann" });
    take();
    board.updateCard(DEV, person.code, { comment: "done on my side" });
    // A person's name is no instance: the board hands the wake over, the fleet's waker drops it (isInstance).
    expect(take().filter((w) => w.to !== "Ann")).toEqual([]);
  });

  it("an @mention wakes an instance that is not the assignee; the assignee is not woken by that comment as well", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    take();
    const r = board.updateCard(ANN, c.code, { comment: "@dev-b can you review the cache part?" });
    expect(take()).toEqual([
      { to: "dev-b", code: c.code, reasons: ["mention"], by: { mention: "Ann" }, texts: { mention: "@dev-b can you review the cache part?" } },
      { to: "dev-a", code: c.code, reasons: ["comment"], by: { comment: "Ann" }, texts: { comment: "@dev-b can you review the cache part?" } },
    ]);
    expect(r.notes[0]).toContain("dev-b (mentioned), dev-a (assignee)");
  });

  it("naming the assignee is one wake, as a mention; naming the same instance twice, one", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    take();
    board.updateCard(ANN, c.code, { comment: "@dev-a @Dev-A please look; @dev-a?" });
    expect(take()).toEqual([{ to: "dev-a", code: c.code, reasons: ["mention"], by: { mention: "Ann" }, texts: { mention: "@dev-a @Dev-A please look; @dev-a?" } }]);
  });

  it("a writer who names itself is not woken", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    take();
    board.updateCard(DEV, c.code, { comment: "@dev-a is on it; @lead FYI" });
    expect(take().map((w) => [w.to, w.reasons])).toEqual([["lead", ["mention"]]]);
  });

  it("a person whose name is an instance's name is not that instance: their @mention of it still wakes it", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    take();
    const sameName: Actor = { kind: "person", name: "lead" };               // the dashboard's signed-in user happens to be called "lead"
    board.updateCard(sameName, c.code, { comment: "@lead @Lead could you look?" });
    expect(take().map((w) => [w.to, w.reasons, w.by])).toEqual([
      ["lead", ["mention"], { mention: "lead" }],
      ["dev-a", ["comment"], { comment: "lead" }],
    ]);
    // The instance itself, writing `@lead`, is still not woken by its own comment (an agent's name is its identity).
    board.updateCard(LEAD, c.code, { comment: "@lead noted" });
    expect(take().map((w) => w.to)).toEqual(["dev-a"]);
  });

  it("a mention wakes on a finished card too, a plain comment does not", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.moveCard(DEV, c.code, "claimed");
    board.moveCard(DEV, c.code, "done", { result: "r" });
    expect(board.getCard(c.code).status).toBe("done");
    take();
    board.updateCard(ANN, c.code, { comment: "thanks" });
    expect(take()).toEqual([]);
    board.updateCard(ANN, c.code, { comment: "@dev-b FYI: shipped" });
    expect(take().map((w) => [w.to, w.reasons])).toEqual([["dev-b", ["mention"]]]);
  });

  it("a card still waiting on what it depends on: its assignee reads comments when it can start, a mention still wakes", () => {
    const { board, take } = rig();
    const first = card(board, ANN, { assignee: "dev-a" });
    const later = card(board, ANN, { assignee: "dev-b", dependsOn: [first.code] });
    take();
    board.updateCard(ANN, later.code, { comment: "read the spec first" });
    expect(take()).toEqual([]);
    board.updateCard(ANN, later.code, { comment: "@lead is that right?" });
    expect(take().map((w) => [w.to, w.reasons])).toEqual([["lead", ["mention"]]]);
  });

  it("a comment that comes with a move: a blocked question's answer is told once, in the answer's words; a start keeps the words", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.moveCard(DEV, c.code, "claimed");
    board.moveCard(DEV, c.code, "blocked", { reason: "codes or messages?" });
    take();
    board.moveCard(LEAD, c.code, "claimed", { comment: "codes, says the person" });
    expect(take()).toEqual([{ to: "dev-a", code: c.code, reasons: ["answered"], by: { answered: "lead" }, texts: { answered: "codes, says the person" } }]);
    board.moveCard(DEV, c.code, "review", { result: "r" });
    take();     // lead, who handed the card out, hears the review; this test is about the send-back's words
    board.moveCard(LEAD, c.code, "claimed", { reason: "ties share a rank", comment: "see the rule in the spec" });
    expect(take().map((w) => [w.to, w.reasons.sort()])).toEqual([["dev-a", ["comment", "sent_back"]]]);
    board.moveCard(DEV, c.code, "blocked", { reason: "q2" });
    take();
    // Someone starts a card that is open, with words: the start and the words come as one notice.
    const o = card(board, LEAD, { assignee: "dev-b" });
    take();
    board.moveCard(ANN, o.code, "claimed", { comment: "start with the API" });
    expect(take()).toEqual([{ to: "dev-b", code: o.code, reasons: ["start", "comment"], by: { start: "Ann", comment: "Ann" }, texts: { comment: "start with the API" } }]);
  });

  it("a plain `task`-tool task (not on the board) wakes nobody by a comment, as it wakes nobody by an assignment", () => {
    const { db, board, take } = rig();
    const t = db.createTask({ title: "Plain", created_by: "lead", assignee: "dev-a" }, LEAD);
    take();
    expect(board.isOnBoard(board.getCard(t.id))).toBe(false);
    board.updateCard(ANN, t.id, { comment: "@dev-b look" });
    expect(take()).toEqual([]);
  });
});

describe("3. what a comment does not wake, and what the writer is told", () => {
  it("a name that is no instance, or has the task board off, is ignored — said to the writer, not refused", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    take();
    const r = board.updateCard(DEV_B, c.code, { comment: "@quiet @ghost can you help? @lead" });
    expect(take().map((w) => [w.to, w.reasons])).toEqual([["lead", ["mention"]], ["dev-a", ["comment"]]]);
    expect(noteKeys(r)).toEqual(["mention_off", "mention_unknown", "comment_wakes"]);
    expect(r.notes[0]).toBe("@quiet has the task board switched off, so it was not woken: it cannot read the card");
    expect(r.notes[1]).toBe("@ghost: no such instance, nobody was woken for it");
    expect(board.detail(c.code).comments.at(-1)!.text).toBe("@quiet @ghost can you help? @lead");   // the comment itself is kept
  });

  it("an assignee with the task board off is promised no wake (it has no tool to act on a notice); the fleet's waker drops what the board hands over", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.setBoardOff((n) => n === "dev-a");                                  // it had the card; the board is switched off for it since
    take();
    const r = board.updateCard(ANN, c.code, { comment: "hello" });
    expect(noteKeys(r)).toEqual([]);                                          // nobody is said to be told
    expect(take().map((w) => w.to)).toEqual(["dev-a"]);                       // the wake itself is the waker's to drop (below), as for an assignment
  });

  it("a comment the assignee has read with its own write by the time the notice goes out is not told (wakeHolds)", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.moveCard(DEV, c.code, "claimed");
    board.updateCard(ANN, c.code, { comment: "cache it 30 s" });
    const [w] = take().filter((x) => x.reasons.includes("comment"));
    const wake: Wake = { instance: "dev-a", uuid: board.getCard(c.code).uuid, code: c.code, title: c.title, parent: null, reasons: ["comment"], by: { comment: "Ann" }, texts: { comment: w!.texts.comment } };
    expect(board.wakeHolds(wake)?.reasons).toEqual(["comment"]);
    board.updateCard(DEV, c.code, { log: "started" });                      // any write of its own reads the comments so far
    expect(board.wakeHolds(wake)).toBeNull();
    // A mention is told regardless: it was asked for by name.
    expect(board.wakeHolds({ ...wake, instance: "dev-b", reasons: ["mention"], by: { mention: "Ann" }, texts: { mention: "x" } })?.reasons).toEqual(["mention"]);
  });

  it("the fleet's switch off: comments and mentions wake nobody and say nothing (the old rule)", () => {
    const { board, take, switchOn } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    take();
    switchOn.value = false;
    const r = board.updateCard(ANN, c.code, { comment: "@dev-b please" });
    expect(take()).toEqual([]);
    expect(r.said).toEqual([]);
    switchOn.value = true;                                                   // read at each comment: back on at once
    board.updateCard(ANN, c.code, { comment: "@dev-b please" });
    expect(take().map((w) => w.to).sort()).toEqual(["dev-a", "dev-b"]);
  });

  it("a script's comment (the header token) is held to an agent's rules; the system's wakes nobody", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    take();
    board.updateCard(SCRIPT, c.code, { comment: "from the CLI" });
    expect(take().map((w) => w.to)).toEqual(["dev-a"]);
  });
});

describe("4. the loop guard", () => {
  /** lead and dev-a answer each other, each naming the other, as two agents in a loop would. */
  function pingPong(r: Rig, c: { code: string }, comments: number) {
    const said: Array<{ by: string; woke: string[]; keys: string[] }> = [];
    for (let i = 0; i < comments; i++) {
      const [by, other] = i % 2 === 0 ? [LEAD, "dev-a"] : [DEV, "lead"];
      const res = r.board.updateCard(by, c.code, { comment: `@${other} your turn (${i + 1})` });
      said.push({ by: by.name, woke: r.take().map((w) => w.to), keys: noteKeys(res).filter((k) => k !== "new_comment") });
    }
    return said;
  }

  it(`agents answering each other wake each other for ${AGENT_COMMENT_CHAIN} turns, then the talk is kept on the card and wakes nobody`, () => {
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.take();
    const said = pingPong(r, c, AGENT_COMMENT_CHAIN + 3);
    expect(said.map((s) => s.woke)).toEqual([["dev-a"], ["lead"], ["dev-a"], ["lead"], [], [], []]);
    expect(said[AGENT_COMMENT_CHAIN]!.keys).toEqual(["comment_chain"]);
    expect(said[AGENT_COMMENT_CHAIN - 1]!.keys).toEqual(["comment_wakes"]);
    // Every comment is on the card, woken or not.
    expect(r.board.detail(c.code).comments).toHaveLength(AGENT_COMMENT_CHAIN + 3);
    expect(r.board.detail(c.code).comments.at(-1)!.text).toBe(`@dev-a your turn (${AGENT_COMMENT_CHAIN + 3})`);
  });

  it("a person's comment lifts it: the chain starts again, and the person's own comment is never held", () => {
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.take();
    pingPong(r, c, AGENT_COMMENT_CHAIN + 1);
    r.board.updateCard(ANN, c.code, { comment: "@lead @dev-a carry on" });
    expect(r.take().map((w) => w.to).sort()).toEqual(["dev-a", "lead"]);
    expect(pingPong(r, c, AGENT_COMMENT_CHAIN + 1).map((s) => s.woke.length)).toEqual([1, 1, 1, 1, 0]);
  });

  it("a person's send-back or confirmation lifts it too", () => {
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a", needsReview: true });
    r.board.moveCard(DEV, c.code, "claimed");
    r.board.moveCard(DEV, c.code, "review", { result: "r" });
    r.take();
    pingPong(r, c, AGENT_COMMENT_CHAIN + 1);
    r.board.moveCard(LEAD, c.code, "claimed", { reason: "again, please" });   // an agent's send-back does not lift it
    expect(r.take().map((w) => w.reasons)).toEqual([["sent_back"]]);
    const res = r.board.updateCard(LEAD, c.code, { comment: "@dev-a do it" });
    expect(noteKeys(res)).toEqual(["comment_chain"]);
    r.board.moveCard(DEV, c.code, "review", { result: "r2" });
    r.take();
    r.board.moveCard(ANN, c.code, "claimed", { reason: "the person sends it back" });     // a person's send-back lifts it
    r.take();
    expect(noteKeys(r.board.updateCard(LEAD, c.code, { comment: "@dev-a now" }))).toEqual(["comment_wakes"]);
  });

  it(`it counts only the last ${AGENT_COMMENT_WINDOW_MS / 60_000} minutes: a slow talk between agents is never held`, () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T09:00:00Z"));
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.take();
    expect(pingPong(r, c, AGENT_COMMENT_CHAIN + 1).map((s) => s.woke.length)).toEqual([1, 1, 1, 1, 0]);
    vi.setSystemTime(new Date("2026-11-18T09:00:00Z").getTime() + AGENT_COMMENT_WINDOW_MS + 1000);
    const res = r.board.updateCard(LEAD, c.code, { comment: "@dev-a any news?" });
    expect(r.take().map((w) => w.to)).toEqual(["dev-a"]);
    expect(noteKeys(res)).toEqual(["comment_wakes"]);
  });

  it("one agent writing again before anyone answers is one turn, not a loop; its notes to itself neither count nor break the chain", () => {
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.take();
    // The assignee's own notes wake no one and say nothing about a loop, however many there are.
    for (let i = 0; i < AGENT_COMMENT_CHAIN + 2; i++) expect(noteKeys(r.board.updateCard(DEV, c.code, { comment: `note ${i}`, log: `l${i}` }))).toEqual([]);
    // The lead writing again and again, dev-a answering only in notes to itself: every comment is told.
    const woke: number[] = [];
    for (let i = 0; i < AGENT_COMMENT_CHAIN + 3; i++) {
      r.board.updateCard(LEAD, c.code, { comment: `c${i}` });
      woke.push(r.take().length);
      r.board.updateCard(DEV, c.code, { comment: `own note ${i}` });
      r.take();
    }
    expect(woke).toEqual(Array(AGENT_COMMENT_CHAIN + 3).fill(1));
    // dev-a answering the lead is the next turn; with the lead's writing again, the chain runs out as before.
    const d = card(r.board, LEAD, { assignee: "dev-a" });
    r.take();
    const turns: number[] = [];
    for (let i = 0; i < AGENT_COMMENT_CHAIN + 1; i++) {
      const [by, other] = i % 2 === 0 ? [LEAD, "dev-a"] : [DEV, "lead"];
      r.board.updateCard(by, d.code, { comment: `@${other} turn ${i}` });
      r.board.updateCard(by, d.code, { comment: `@${other} and again, nobody answered yet` });      // the same turn
      turns.push(r.take().length);
    }
    expect(turns).toEqual([2, 2, 2, 2, 0]);        // two comments a turn, each told; the 5th turn is held, both of them
  });

  it("notes to itself cannot push a stopped talk out of what is read: after many of them the next comment is still held (#4367 review)", () => {
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.take();
    expect(pingPong(r, c, AGENT_COMMENT_CHAIN + 1).map((s) => s.woke.length)).toEqual([1, 1, 1, 1, 0]);
    // More of the assignee's own notes than any fixed page of entries, all within the window, none by a person.
    for (let i = 0; i < 150; i++) r.board.updateCard(DEV, c.code, { comment: `own note ${i}` });
    expect(r.take()).toEqual([]);
    const res = r.board.updateCard(LEAD, c.code, { comment: "@dev-a back to you" });
    expect(r.take()).toEqual([]);
    expect(noteKeys(res)).toEqual(["comment_chain"]);
    // A person's word still lifts it.
    r.board.updateCard(ANN, c.code, { comment: "carry on" });
    r.take();
    expect(r.board.updateCard(LEAD, c.code, { comment: "@dev-a go" }) && r.take().map((w) => w.to)).toEqual(["dev-a"]);
  });

  it("a loop through the assignee counts too: plain comments to the assignee are turns, not only @mentions", () => {
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.take();
    const woke: string[][] = [];
    const keys: string[][] = [];
    for (let i = 0; i < AGENT_COMMENT_CHAIN + 1; i++) {
      // The lead writes plainly (it wakes dev-a only as the card's assignee); dev-a answers naming the lead.
      const res = i % 2 === 0 ? r.board.updateCard(LEAD, c.code, { comment: `ok (${i})` }) : r.board.updateCard(DEV, c.code, { comment: `@lead done (${i})` });
      woke.push(r.take().map((w) => w.to));
      keys.push(noteKeys(res).filter((k) => k !== "new_comment"));
    }
    expect(woke).toEqual([["dev-a"], ["lead"], ["dev-a"], ["lead"], []]);
    expect(keys.at(-1)).toEqual(["comment_chain"]);
  });

  it("each comment counts with the assignee it had when it was written: handing the card to one of the two talking does not lift the guard", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-11-18T09:00:00Z").getTime();
    let step = 0;
    const tick = () => vi.setSystemTime(t0 + ++step * 1000);
    tick();
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.take();
    const say = (by: Actor, comment: string) => {
      tick();
      const res = r.board.updateCard(by, c.code, { comment });
      return { woke: r.take().map((w) => w.to), keys: noteKeys(res).filter((k) => k !== "new_comment") };
    };
    // dev-a names the lead; the lead answers plainly, which wakes dev-a as the card's assignee: four turns.
    expect([say(DEV, "@lead go"), say(LEAD, "ok"), say(DEV, "@lead go"), say(LEAD, "ok")].map((s) => s.woke)).toEqual([["lead"], ["dev-a"], ["lead"], ["dev-a"]]);
    // The card goes to the lead. Today's assignee is now one of the two; the lead's earlier comments were not notes to itself.
    tick();
    r.board.updateCard(ANN, c.code, { assignee: "lead" });
    r.take();
    expect(say(DEV, "@lead once more")).toEqual({ woke: [], keys: ["comment_chain"] });
    // Handed back (to dev-a) the same talk is counted the same way.
    tick();
    r.board.updateCard(ANN, c.code, { assignee: "dev-a" });
    r.take();
    expect(say(LEAD, "and again")).toEqual({ woke: [], keys: ["comment_chain"] });
    // A handover inside the talk does not hide its turns either: the window and a person's word still lift it.
    expect(say(ANN, "@lead @dev-a go on").woke.sort()).toEqual(["dev-a", "lead"]);
    expect(say(LEAD, "ok").woke).toEqual(["dev-a"]);
  });

  it(`an agent's comment wakes at most ${MAX_COMMENT_WAKES} instances; a person's comment, every one it names`, () => {
    const many = Array.from({ length: 8 }, (_, i) => `inst-${i + 1}`);
    const r = rig(undefined, [...INSTANCES, ...many]);
    const c = card(r.board, ANN);                                            // nobody's: no assignee to hear it as a comment
    r.take();
    const text = many.map((n) => `@${n}`).join(" ");
    const res = r.board.updateCard(LEAD, c.code, { comment: text });
    expect(r.take().map((w) => w.to)).toEqual(many.slice(0, MAX_COMMENT_WAKES));
    expect(noteKeys(res)).toEqual(["mention_cap", "comment_wakes"]);
    r.board.updateCard(ANN, c.code, { comment: text });
    expect(r.take().map((w) => w.to)).toEqual(many);
  });

  it(`the card's assignee is one of the ${MAX_COMMENT_WAKES}: an agent's comment naming ${MAX_COMMENT_WAKES} others on a sixth instance's card wakes ${MAX_COMMENT_WAKES} in all (#4367 review)`, () => {
    const many = Array.from({ length: 6 }, (_, i) => `inst-${i + 1}`);
    const r = rig(undefined, [...INSTANCES, ...many]);
    const c = card(r.board, ANN, { assignee: "inst-6" });
    r.take();
    const res = r.board.updateCard(LEAD, c.code, { comment: many.slice(0, MAX_COMMENT_WAKES).map((n) => `@${n}`).join(" ") });
    const woke = r.take().map((w) => w.to);
    expect(woke).toHaveLength(MAX_COMMENT_WAKES);
    expect(woke.sort()).toEqual([...many.slice(0, MAX_COMMENT_WAKES - 1), "inst-6"].sort());
    expect(noteKeys(res)).toEqual(["mention_cap", "comment_wakes"]);
    // Naming the assignee too is one wake, not two: exactly the limit, nothing trimmed.
    const d = card(r.board, ANN, { assignee: "inst-6" });
    r.take();
    const all = r.board.updateCard(LEAD, d.code, { comment: ["inst-6", ...many.slice(0, MAX_COMMENT_WAKES - 1)].map((n) => `@${n}`).join(" ") });
    expect(r.take()).toHaveLength(MAX_COMMENT_WAKES);
    expect(noteKeys(all)).toEqual(["comment_wakes"]);
  });

  it(`a dispatcher's answer kept for a busy assignee: the assignee's answer_kept notice is one of the ${MAX_COMMENT_WAKES} (#4367 re-review)`, () => {
    const many = Array.from({ length: 5 }, (_, i) => `inst-${i + 1}`);
    // dev-a is busy with b; a waits blocked on a question to its dispatcher, the lead. A fresh board each time.
    const setup = () => {
      const r = rig(undefined, [...INSTANCES, ...many]);
      const [a, b] = [card(r.board, LEAD, { assignee: "dev-a" }), card(r.board, LEAD, { assignee: "dev-a" })];
      r.board.moveCard(DEV, a.code, "claimed");
      r.board.moveCard(DEV, a.code, "blocked", { reason: "which scores count?" });
      r.board.moveCard(DEV, b.code, "claimed");
      r.take();
      return { r, a };
    };
    // The control: an ordinary answer, no mention — kept, the card stays blocked, only the assignee hears it.
    const c = setup();
    const p = c.r.board.moveCard(LEAD, c.a.code, "claimed", { comment: "the best of three" });
    expect(p.card.status).toBe("blocked");
    expect(c.r.take().map((w) => `${w.to}:${w.reasons.join("+")}`)).toEqual(["dev-a:answer_kept"]);
    // Five others named in the kept answer: four of them, and the assignee — five in all, never six.
    const { r, a } = setup();
    const res = r.board.moveCard(LEAD, a.code, "claimed", { comment: `the best of three; ${many.map((n) => `@${n}`).join(" ")} please note` });
    expect(res.card.status).toBe("blocked");
    const woke = r.take();
    expect(woke).toHaveLength(MAX_COMMENT_WAKES);
    expect(woke.map((w) => `${w.to}:${w.reasons.join("+")}`).sort()).toEqual(["dev-a:answer_kept", "inst-1:mention", "inst-2:mention", "inst-3:mention", "inst-4:mention"]);
    expect(noteKeys(res)).toContain("mention_cap");
  });

  it(`the assignee named last, after ${MAX_COMMENT_WAKES} others, is still one of the ${MAX_COMMENT_WAKES}: the cap is on the final audience, in any order (#4367 re-review)`, () => {
    const many = Array.from({ length: 6 }, (_, i) => `inst-${i + 1}`);
    const r = rig(undefined, [...INSTANCES, ...many]);
    const c = card(r.board, ANN, { assignee: "inst-6" });
    r.take();
    const res = r.board.updateCard(LEAD, c.code, { comment: many.map((n) => `@${n}`).join(" ") });      // @inst-1 … @inst-5 @inst-6 (the assignee)
    const woke = r.take().map((w) => w.to).sort();
    expect(woke).toEqual(["inst-1", "inst-2", "inst-3", "inst-4", "inst-6"]);
    expect(noteKeys(res)).toEqual(["mention_cap", "comment_wakes"]);
    // And in the middle.
    const d = card(r.board, ANN, { assignee: "inst-6" });
    r.take();
    r.board.updateCard(LEAD, d.code, { comment: "@inst-1 @inst-2 @inst-6 @inst-3 @inst-4 @inst-5" });
    expect(r.take().map((w) => w.to).sort()).toEqual(["inst-1", "inst-2", "inst-3", "inst-4", "inst-6"]);
  });
});

describe("5. the notice", () => {
  const wake = (over: Partial<Wake>): Wake => ({ instance: "dev-a", uuid: "u1", code: "M-4", title: "Leaderboard", parent: null, reasons: ["comment"], by: { comment: "Ann" }, texts: { comment: "weekly, not daily" }, ...over });

  it("says who wrote it and what, and when to answer on the card; a mention says the card may not be its own", () => {
    expect(wakeMessage([wake({})])).toBe('[Task board] M-4 "Leaderboard": new comment from Ann: "weekly, not daily" — reply on the card (task update, with a comment) only if it asks or needs something from you. Read it with: task get M-4');
    expect(wakeMessage([wake({ reasons: ["mention"], by: { mention: "lead" }, texts: { mention: "@dev-a what do you think?" } })]))
      .toBe('[Task board] M-4 "Leaderboard": lead mentioned you in a comment: "@dev-a what do you think?" — reply on the card (task update, with a comment) if it asks something of you; the card is not yours unless it says so. Read it with: task get M-4');
  });

  it("a long comment is cut to a line; several comments on a card are one line, the last words", () => {
    const long = "x".repeat(300);
    expect(wakeMessage([wake({ texts: { comment: long } })])).toContain(`"${"x".repeat(160)}…"`);
  });

  function waker() {
    const sent: Array<{ instance: string; message: string }> = [];
    const timers: Array<{ fn: () => void; live: boolean }> = [];
    const w = new TaskBoardWaker({
      deliver: (instance, message) => { sent.push({ instance, message }); return true; },
      isInstance: (n) => INSTANCES.includes(n),
      holds: (x) => x,
      card: () => undefined,
      log: () => {},
      timers: { set: (fn) => { const t = { fn, live: true }; timers.push(t); return t; }, clear: (h) => { (h as { live: boolean }).live = false; } },
    });
    return { w, sent, fire: () => { for (const t of timers.splice(0)) if (t.live) t.fn(); } };
  }

  describe("the notice of a person's comment or mention says a person reads the card", () => {
    const SAYS = "a person reads the card; no @ needed";
    /** The notices the board's own rules produce for one write, as text per instance. */
    function notices(board: TaskBoard, write: () => void): Map<string, string> {
      const got: Wake[] = [];
      const off = board.onChange((c) => got.push(...c.wakes));
      try { write(); } finally { off(); }
      return new Map([...new Set(got.map((w) => w.instance))].map((i) => [i, wakeMessage(got.filter((w) => w.instance === i), (u) => board.findCard(u))]));
    }

    it("a person's comment to the assignee and a person's @mention carry it", () => {
      const { board } = rig();
      const c = card(board, LEAD, { assignee: "dev-a" });
      const comment = notices(board, () => board.updateCard(ANN, c.code, { comment: "how is it going?" }));
      expect(comment.get("dev-a")).toContain('new comment from Ann: "how is it going?" — reply on the card (task update, with a comment) only if it asks or needs something from you (a person reads the card; no @ needed)');
      const mention = notices(board, () => board.updateCard(ANN, c.code, { comment: "@dev-b can you take a look?" }));
      expect(mention.get("dev-b")).toContain(`Ann mentioned you in a comment: "@dev-b can you take a look?" — reply on the card (task update, with a comment) if it asks something of you; the card is not yours unless it says so (${SAYS})`);
    });

    it("counter-evidence: an instance's comment or @mention, a script's, and the other notices do not say it", () => {
      const { board } = rig();
      const c = card(board, LEAD, { assignee: "dev-a" });
      expect(notices(board, () => board.updateCard(LEAD, c.code, { comment: "status?" })).get("dev-a")).not.toContain(SAYS);
      expect(notices(board, () => board.updateCard(DEV, c.code, { comment: "@dev-b please look" })).get("dev-b")).not.toContain(SAYS);
      // A script (the web token) is not a person at a keyboard; the sentence is for a person's comment only.
      expect(notices(board, () => board.updateCard(SCRIPT, c.code, { comment: "build finished" })).get("dev-a")).not.toContain(SAYS);
      // Other news (an assignment by a person, a send-back) is not about replying to a comment.
      const assigned = notices(board, () => board.updateCard(ANN, c.code, { assignee: "dev-b" }));
      expect(assigned.get("dev-b")).toContain("assigned to you by Ann");
      expect(assigned.get("dev-b")).not.toContain(SAYS);
    });

    it("gathered in one window the sentence follows the last writer: a person after an instance has it, an instance after a person does not", () => {
      const { w, sent, fire } = waker();
      w.note([wake({ by: { comment: "lead" }, texts: { comment: "first" } })]);
      w.note([wake({ by: { comment: "Ann" }, byPerson: { comment: true }, texts: { comment: "second" } })]);
      fire();
      expect(sent[0]!.message).toContain(`new comment from Ann: "second" (+1 earlier comment: task get M-4) — reply on the card (task update, with a comment) only if it asks or needs something from you (${SAYS})`);
      w.note([wake({ by: { comment: "Ann" }, byPerson: { comment: true }, texts: { comment: "first" } })]);
      w.note([wake({ by: { comment: "lead" }, texts: { comment: "second" } })]);
      fire();
      expect(sent[1]!.message).toContain('new comment from lead: "second"');
      expect(sent[1]!.message).not.toContain(SAYS);
    });
  });

  it("several comments gathered in one window: the notice quotes the last and counts the earlier ones; another card is its own", () => {
    const { w, sent, fire } = waker();
    w.note([wake({ by: { comment: "Ann" }, texts: { comment: "first" } })]);
    w.note([wake({ by: { comment: "Bob" }, texts: { comment: "second" } })]);
    w.note([wake({ uuid: "u2", code: "M-5", by: { comment: "Ann" }, texts: { comment: "elsewhere" } })]);
    fire();
    expect(sent).toHaveLength(1);
    const lines = sent[0]!.message.split("\n");
    expect(lines.find((l) => l.includes("M-4"))).toContain('new comment from Bob: "second" (+1 earlier comment: task get M-4) — reply');
    expect(lines.find((l) => l.includes("M-5"))).toContain('new comment from Ann: "elsewhere" — reply');
    expect(lines.find((l) => l.includes("M-5"))).not.toContain("earlier");
    w.note([wake({ texts: { comment: "a" } }), wake({ texts: { comment: "b" } }), wake({ texts: { comment: "c" } })]);
    fire();
    expect(sent[1]!.message).toContain('"c" (+2 earlier comments: task get M-4)');
    // One comment alone says nothing of the kind.
    w.note([wake({ texts: { comment: "only" } })]);
    fire();
    expect(sent[2]!.message).not.toContain("earlier");
  });

  it("through the board's own rules: a comment, then a mention of the same instance, is one notice that quotes the mention and counts the comment", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    take();
    const sent: string[] = [];
    const timers: Array<{ fn: () => void; live: boolean }> = [];
    const waker = new TaskBoardWaker({
      deliver: (_to, text) => { sent.push(text); return true; },
      isInstance: (n) => INSTANCES.includes(n),
      holds: (x) => board.wakeHolds(x),
      card: (u) => board.findCard(u),
      log: () => {},
      timers: { set: (fn) => { const t = { fn, live: true }; timers.push(t); return t; }, clear: (h) => { (h as { live: boolean }).live = false; } },
    });
    board.onChange((ch) => waker.note(ch.wakes));
    board.updateCard(ANN, c.code, { comment: "weekly, not daily" });
    board.updateCard(DEV_B, c.code, { comment: "@dev-a the spec changed" });
    for (const t of timers.splice(0)) if (t.live) t.fn();
    expect(sent).toEqual([`[Task board] ${c.code} "Build the leaderboard": dev-b mentioned you in a comment: "@dev-a the spec changed" (+1 earlier comment: task get ${c.code}) — reply on the card (task update, with a comment) if it asks something of you; the card is not yours unless it says so. Read it with: task get ${c.code}`]);
    waker.stop();
  });

  it("an agent's comment is sent with the window, and so is an agent's assignment: nothing waits for its writer's own message", () => {
    const { w, sent, fire } = waker();
    w.note([wake({ by: { comment: "lead" } })]);
    fire();
    expect(sent.map((s) => s.instance)).toEqual(["dev-a"]);
    // An assignment by the same writer used to wait up to two minutes for a message of its own; it goes with the window now.
    const assigned = waker();
    assigned.w.note([wake({ reasons: ["assigned"], by: { assigned: "lead" }, texts: {} })]);
    assigned.fire();
    expect(assigned.sent.map((s) => s.instance)).toEqual(["dev-a"]);
    expect(assigned.sent[0]!.message).toContain("assigned to you by lead");
  });

  it("a name that is not a fleet instance (a person), or an instance with the task board off, is not sent a notice", () => {
    const { w, sent, fire } = waker();
    w.note([wake({ instance: "Ann" })]);
    fire();
    expect(sent).toEqual([]);
    const off: Array<{ instance: string; message: string }> = [];
    const timers: Array<{ fn: () => void; live: boolean }> = [];
    const quiet = new TaskBoardWaker({
      deliver: (instance, message) => { off.push({ instance, message }); return true; },
      isInstance: (n) => INSTANCES.includes(n),
      boardOff: (n) => n === "quiet",
      holds: (x) => x,
      card: () => undefined,
      log: () => {},
      timers: { set: (fn) => { const t = { fn, live: true }; timers.push(t); return t; }, clear: () => {} },
    });
    quiet.note([wake({ instance: "quiet", reasons: ["mention"], by: { mention: "Ann" }, texts: {} })]);
    for (const t of timers.splice(0)) t.fn();
    expect(off).toEqual([]);
  });
});

describe("5b. in a real FleetManager: a comment or mention is one durable notice, and the switch is read at each comment", () => {
  async function fleet(config: Record<string, unknown>) {
    vi.useFakeTimers();
    const d = tmp("task-board-comment-fm-");
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d) as unknown as Record<string, any>;
    fm.fleetConfig = config;
    fm.ensureDeliveryOutbox();
    const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
    fm.scheduler = scheduler;
    fm.attachTaskBoard(scheduler.db);
    const notices = () => {
      const db = new Database(join(d, "delivery-outbox.db"), { readonly: true });
      try {
        return (db.prepare("SELECT target_instance, payload_json FROM deliveries WHERE kind='system_notice'").all() as Array<{ target_instance: string; payload_json: string }>)
          .map((r) => ({ to: r.target_instance, text: JSON.parse(r.payload_json).content as string }));
      } finally { db.close(); }
    };
    const stop = () => { fm.taskBoardWaker.stop(); fm.deliveryOutbox?.close?.(); scheduler.db.close(); };
    return { fm, board: scheduler.db.board, call: (instance: string, args: Record<string, unknown>) => fm.handleTaskCrudHttp(instance, args) as Promise<string>, notices, stop };
  }
  const base = { defaults: {}, instances: { lead: {}, "dev-a": {}, "dev-b": {}, quiet: { dashboard: { task_board: false } } } };

  it("an agent's @mention through the task tool: the answer says whom it wakes; 10 s later the mentioned instance has one notice", async () => {
    const f = await fleet(base);
    // Handed out by the person: an instance's own assignment waits up to 2 minutes for its message (#2785 (c)), which is not what is tested here.
    const c = f.board.createCards(ANN, { cards: [{ title: "Leaderboard", assignee: "dev-a" }] }).cards[0]!;
    await vi.advanceTimersByTimeAsync(10_000);
    const before = f.notices().length;                                        // the assignment notice
    const out = await f.call("lead", { action: "update", id: c.code, comment: "@dev-b please review; @quiet too" });
    expect(out).toContain("this comment is told to dev-b (mentioned), dev-a (assignee) as a [Task board] notice: no need to message them about it");
    expect(out).toContain("@quiet has the task board switched off, so it was not woken");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(f.notices()).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1_000);
    const fresh = f.notices().slice(before);
    expect(fresh.map((n) => n.to).sort()).toEqual(["dev-a", "dev-b"]);
    expect(fresh.find((n) => n.to === "dev-b")!.text).toBe(`[Task board] ${c.code} "Leaderboard": lead mentioned you in a comment: "@dev-b please review; @quiet too" — reply on the card (task update, with a comment) if it asks something of you; the card is not yours unless it says so. Read it with: task get ${c.code}`);
    expect(fresh.find((n) => n.to === "dev-a")!.text).toContain("new comment from lead");
    f.stop();
  });

  it("the person's comment from the dashboard's own write wakes the assignee the same way", async () => {
    const f = await fleet(base);
    const c = f.board.createCards(ANN, { cards: [{ title: "Leaderboard", assignee: "dev-a" }] }).cards[0]!;
    await vi.advanceTimersByTimeAsync(10_000);
    const before = f.notices().length;
    f.board.updateCard(ANN, c.code, { comment: "weekly, not daily" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.notices().slice(before)).toEqual([{ to: "dev-a", text: expect.stringContaining('new comment from Ann: "weekly, not daily"') }]);
    f.stop();
  });

  it("defaults.task_board.comment_wakes: false brings back the old rule, read at each comment", async () => {
    const config: Record<string, any> = { ...base, defaults: { task_board: { comment_wakes: false } } };
    const f = await fleet(config);
    const c = f.board.createCards(ANN, { cards: [{ title: "Leaderboard", assignee: "dev-a" }] }).cards[0]!;
    await vi.advanceTimersByTimeAsync(10_000);
    const before = f.notices().length;
    const out = await f.call("lead", { action: "update", id: c.code, comment: "@dev-b please" });
    expect(out).not.toContain("told to");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.notices()).toHaveLength(before);
    config.defaults = { task_board: { comment_wakes: true } };               // a fleet.yaml edit applies to the next comment
    await f.call("lead", { action: "update", id: c.code, comment: "@dev-b please" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.notices().slice(before).map((n) => n.to).sort()).toEqual(["dev-a", "dev-b"]);
    f.stop();
  });
});

describe("6. compatibility", () => {
  it("comments written before the rule are never told after an upgrade; only a comment written after is", () => {
    const path = join(tmp(), "scheduler.db");
    // The database as the release before this one left it: comments (some naming an instance) on cards, nothing told.
    const before = rig(path);
    before.switchOn.value = false;
    const c = card(before.board, LEAD, { assignee: "dev-a" });
    before.board.updateCard(ANN, c.code, { comment: "an old comment" });
    before.board.updateCard(DEV_B, c.code, { comment: "@lead an old mention" });
    before.db.close();
    // Upgraded: the same file, opened by the new board with a waker on it.
    const after = rig(path);
    const sent: string[] = [];
    const timers: Array<{ fn: () => void; live: boolean }> = [];
    const waker = new TaskBoardWaker({
      deliver: (_to, text) => { sent.push(text); return true; },
      isInstance: (n) => INSTANCES.includes(n),
      holds: (w) => after.board.wakeHolds(w),
      card: (u) => after.board.findCard(u),
      log: () => {},
      timers: { set: (fn) => { const t = { fn, live: true }; timers.push(t); return t; }, clear: (h) => { (h as { live: boolean }).live = false; } },
    });
    after.board.onChange((ch) => waker.note(ch.wakes));
    const pass = () => { for (const t of timers.splice(0)) if (t.live) t.fn(); };
    pass();
    expect(sent).toEqual([]);                                                  // opening the file wakes nobody
    expect(after.board.detail(c.code).comments.map((e) => e.text)).toEqual(["an old comment", "@lead an old mention"]);   // and the old data reads as before
    after.board.updateCard(ANN, c.code, { comment: "a new comment" });
    pass();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('new comment from Ann: "a new comment"');
    expect(sent[0]).not.toContain("old");
    waker.stop();
  });

  it("the rule needs no new table or column of its own: the schema is what it was, plus only the comment-thread columns and table, and the comment status's (`wakes`) and unread's", () => {
    const path = join(tmp(), "scheduler.db");
    const r = rig(path);
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.board.updateCard(ANN, c.code, { comment: "@dev-b look" });
    r.db.close();
    const raw = new Database(path, { readonly: true });
    try {
      const cols = (t: string) => (raw.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((x) => x.name);
      // The wake rule itself added nothing; the columns after `at` and the reactions table are the comment threads' (tests/task-board-comment-threads.test.ts),
      // `wakes` is the comment status's and the two read tables are the unread's (tests/task-board-comment-status.test.ts).
      expect(cols("task_entries")).toEqual(["id", "task_id", "kind", "author", "author_kind", "text", "at",
        "parent_id", "edited_at", "deleted_at", "deleted_by", "resolved_at", "resolved_by", "notify", "author_key", "wakes"]);
      const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'task%' ORDER BY name").all() as Array<{ name: string }>).map((x) => x.name);
      // (task_attachments, an additive table for files on a card, was added later — nothing about comments or wakes changed.)
      expect(tables).toEqual(["task_attachments", "task_card_reads", "task_counters", "task_entries", "task_entry_reactions", "task_events", "task_liveness", "task_projects", "task_reads_floor", "task_watchers", "tasks"]);
      // The event a comment leaves is the one it always left — its text, nothing about whom it woke — and now the number of its entry.
      const ev = raw.prepare("SELECT data FROM task_events WHERE type = 'commented'").get() as { data: string };
      expect(JSON.parse(ev.data)).toEqual({ text: "@dev-b look", entry: 1 });
    } finally { raw.close(); }
  });

  it("defaults.task_board.comment_wakes is read as on unless it is false, and checked as a boolean", () => {
    expect(boardCommentWakesOn(undefined)).toBe(true);
    expect(boardCommentWakesOn({})).toBe(true);
    expect(boardCommentWakesOn({ defaults: { task_board: {} } })).toBe(true);
    expect(boardCommentWakesOn({ defaults: { task_board: { comment_wakes: true } } })).toBe(true);
    expect(boardCommentWakesOn({ defaults: { task_board: { comment_wakes: false } } })).toBe(false);
    const errors = (v: unknown) => validateFleetConfig({ defaults: { task_board: { comment_wakes: v } }, instances: { a: { working_directory: "/tmp" } } } as never)
      .errors.filter((e) => e.path.endsWith("comment_wakes"));
    expect(errors(true)).toEqual([]);
    expect(errors(false)).toEqual([]);
    for (const bad of ["no", 0, null]) expect(errors(bad)).toHaveLength(1);
  });
});
