/**
 * A comment's status and the person's unread (docs/design/task-board.md, "Comment status" and "Unread"):
 *
 *   1. What the board keeps with a comment (`task_entries.wakes`): whom it was written for, as what, and — when it could not wake
 *      someone — why (task board off, contact rules, loop guard, no such instance, the cap, comment wakes off, not waiting).
 *   2. What the waker tells the board as the news goes out: handed to delivery under a key, or not sent (and why); a gathered window
 *      of comments is one notice for all of them.
 *   3. How far a notice got, read from the delivery outbox: sending, queued, delivered, read (consumed), failed, unconfirmed,
 *      withdrawn — and a notice that was never handed over is lost after a while. (`wakeViews`, `DeliveryOutbox.noticeProgress`.)
 *   4. The person's unread: a reply under their comment, an `@` to them, the answer of the instance their comment woke, a card handed
 *      to them to confirm or answer; never their own words, a deleted comment, or what came before their floor; opening a card reads it.
 *   5. Compatibility: nothing new on a comment written without it; an older release reads the same database; the schema grows only by
 *      one column and two tables.
 *
 * Isolation: temp databases; the waker's timers seam; fake Date for the clock.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerDb } from "../src/scheduler/db.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { MAX_COMMENT_WAKES, type Actor, type EntryWake, type TaskBoard, type WakeSkip } from "../src/scheduler/task-board.js";
import { UNREAD_WINDOW_DAYS } from "../src/scheduler/task-board-unread.js";
import { TaskBoardWaker, cardsOfKey } from "../src/task-board-waker.js";
import { wakeViews } from "../src/web-api.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const BOB: Actor = { kind: "person", name: "Bob" };
const LEAD: Actor = { kind: "instance", name: "lead" };
const DEV: Actor = { kind: "instance", name: "dev-a" };
const DEV_B: Actor = { kind: "instance", name: "dev-b" };
const INSTANCES = ["lead", "dev-a", "dev-b", "quiet"];

const dirs: string[] = [];
const dbs: SchedulerDb[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "task-board-comment-status-")); dirs.push(d); return d; };

interface Rig { db: SchedulerDb; board: TaskBoard; path: string; wakesOn: { value: boolean }; contactHeld: Set<string>; boardOff: Set<string> }
function rig(path = join(tmp(), "scheduler.db"), instances: string[] = INSTANCES): Rig {
  const db = new SchedulerDb(path); dbs.push(db);
  const board = db.board;
  const wakesOn = { value: true };
  const contactHeld = new Set<string>();
  const boardOff = new Set<string>(["quiet"]);
  board.setBoardOff((n) => boardOff.has(n));
  board.setCommentRouting({ instances: () => instances, enabled: () => wakesOn.value });
  board.setContactGate((source, _target) => !contactHeld.has(source));
  if (!board.listProjects(true).length) board.createProject(ANN, { name: "Game" });
  return { db, board, path, wakesOn, contactHeld, boardOff };
}
const card = (board: TaskBoard, by: Actor, extra: Record<string, unknown> = {}) =>
  board.createCards(by, { project: "Game", cards: [{ title: "Build the leaderboard", needsReview: false, ...extra }] }).cards[0]!;
/** What the board kept for the comment, by instance. */
const kept = (board: TaskBoard, code: string, entry: number): Record<string, EntryWake> => Object.fromEntries((board.entryWakes(code).get(entry) ?? []).map((w) => [w.to, w]));
const lastEntry = (board: TaskBoard, code: string) => board.detail(code).comments.at(-1)!.id;
const skipsOf = (board: TaskBoard, code: string, entry: number) => Object.fromEntries(Object.entries(kept(board, code, entry)).map(([n, w]) => [n, w.skip ?? "-"]));

describe("1. what the board keeps with a comment", () => {
  it("a person's comment on a card whose assignee is an instance is kept as written for it, as its assignee", () => {
    const { board } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.updateCard(ANN, c.code, { comment: "how is it going?" });
    const wakes = kept(board, c.code, lastEntry(board, c.code));
    expect(Object.keys(wakes)).toEqual(["dev-a"]);
    expect(wakes["dev-a"]).toMatchObject({ to: "dev-a", why: "assignee" });
    expect(wakes["dev-a"]!.key).toBeUndefined();
    expect(wakes["dev-a"]!.skip).toBeUndefined();
  });

  it("an @ names another instance (as a mention); the recipient the writer chose is addressed; both beside the assignee", () => {
    const { board } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.updateCard(ANN, c.code, { comment: "@dev-b please look", to: ["lead"] });
    const wakes = kept(board, c.code, lastEntry(board, c.code));
    expect(Object.fromEntries(Object.entries(wakes).map(([n, w]) => [n, w.why]))).toEqual({ "dev-b": "mention", lead: "addressed" });
  });

  it("a comment nobody was meant to hear leaves nothing (the column stays empty)", () => {
    const { board, db } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.updateCard(ANN, c.code, { comment: "a note to myself", to: [] });
    expect(board.entryWakes(c.code).size).toBe(0);
    const raw = (db as unknown as { db: Database.Database }).db.prepare("SELECT wakes FROM task_entries WHERE kind = 'comment'").get() as { wakes: string | null };
    expect(raw.wakes).toBeNull();
  });

  it("an instance with the task board off is kept as not woken (board_off) — as the assignee, as an @, as the chosen recipient", () => {
    const { board, boardOff } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    boardOff.add("dev-a");                                        // its board was switched off after the card was handed to it
    board.updateCard(ANN, c.code, { comment: "are you there?" });
    expect(skipsOf(board, c.code, lastEntry(board, c.code))).toEqual({ "dev-a": "board_off" });
    board.updateCard(ANN, c.code, { comment: "@quiet hello", to: [] });
    expect(skipsOf(board, c.code, lastEntry(board, c.code))).toEqual({ quiet: "board_off" });
    board.updateCard(ANN, c.code, { comment: "hello", to: ["quiet"] });
    expect(skipsOf(board, c.code, lastEntry(board, c.code))).toEqual({ quiet: "board_off" });
  });

  it("a name that is no instance is kept as unknown, so a typo is not silent", () => {
    const { board } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.updateCard(ANN, c.code, { comment: "@dev-c where are you", to: [] });
    expect(skipsOf(board, c.code, lastEntry(board, c.code))).toEqual({ "dev-c": "unknown" });
  });

  it("an agent that @-names a person (to tell them something) leaves no 'no such instance' under its comment — only a person's typo does", () => {
    const { board } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.updateCard(DEV, c.code, { comment: "@Ann the report is ready" });
    expect(board.entryWakes(c.code).size).toBe(0);
    board.updateCard(ANN, c.code, { comment: "@dev-c where are you", to: [] });
    expect(skipsOf(board, c.code, lastEntry(board, c.code))).toEqual({ "dev-c": "unknown" });
  });

  it("an agent's words held by the contact rules are kept as contact_held", () => {
    const { board, contactHeld } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    contactHeld.add("dev-b");
    board.updateCard(DEV_B, c.code, { comment: "@lead ping" });
    expect(skipsOf(board, c.code, lastEntry(board, c.code))).toEqual({ lead: "contact_held", "dev-a": "contact_held" });
  });

  it("agents answering each other until the loop guard stops them: the comment it stopped is kept as loop_guard", () => {
    const { board } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    let from = DEV_B, to = "dev-a";
    for (let i = 0; i < 8; i++) { board.updateCard(from, c.code, { comment: `@${to} turn ${i}` }); [from, to] = from.name === "dev-b" ? [DEV, "dev-b"] : [DEV_B, "dev-a"]; }
    const lists = [...board.entryWakes(c.code).values()];
    expect(lists.some((l) => l.every((w) => !w.skip))).toBe(true);                // the first turns woke
    expect(lists.some((l) => l.some((w) => w.skip === "loop_guard"))).toBe(true);
    // A person writing on it lifts the guard: the next one wakes again.
    board.updateCard(ANN, c.code, { comment: "carry on", to: ["dev-a"] });
    expect(skipsOf(board, c.code, lastEntry(board, c.code))).toEqual({ "dev-a": "-" });
  });

  it("an agent's comment that names more instances than may be woken keeps the surplus as cap", () => {
    const names = ["lead", "dev-a", "dev-b", "dev-c", "dev-d", "dev-e", "dev-f", "dev-g"];
    const { board } = rig(join(tmp(), "scheduler.db"), names);
    const c = card(board, LEAD, { assignee: "lead" });
    board.updateCard(DEV, c.code, { comment: names.filter((n) => n !== "dev-a" && n !== "lead").map((n) => `@${n}`).join(" ") });
    const list = Object.values(kept(board, c.code, lastEntry(board, c.code)));
    expect(list.filter((w) => !w.skip).length).toBeLessThanOrEqual(MAX_COMMENT_WAKES);
    expect(list.filter((w) => w.skip === "cap").length).toBeGreaterThan(0);
  });

  it("comment wakes switched off for the fleet: what the box said it would do does not happen, and says so (wakes_off)", () => {
    const { board, wakesOn } = rig();
    wakesOn.value = false;
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.updateCard(ANN, c.code, { comment: "go", to: ["lead"] });
    expect(skipsOf(board, c.code, lastEntry(board, c.code))).toEqual({ lead: "wakes_off" });
    board.updateCard(ANN, c.code, { comment: "go" });
    expect(skipsOf(board, c.code, lastEntry(board, c.code))).toEqual({ "dev-a": "wakes_off" });
  });

  it("a finished card's assignee is not woken by the old rule: nothing is kept for it (the box said nobody would hear)", () => {
    const { board } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.moveCard(DEV, c.code, "claimed", {});
    board.moveCard(DEV, c.code, "done", { result: "r" });
    board.updateCard(ANN, c.code, { comment: "one more thing", to: [] });
    expect(board.entryWakes(c.code).size).toBe(0);
  });

  it("an edit adds only the instances its new words name, keeping what the comment already had", () => {
    const { board } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.updateCard(ANN, c.code, { comment: "see @dev-b" });
    const id = lastEntry(board, c.code);
    expect(Object.keys(kept(board, c.code, id)).sort()).toEqual(["dev-a", "dev-b"]);
    board.editComment(ANN, c.code, id, "see @dev-b and @lead");
    const after = kept(board, c.code, id);
    expect(Object.keys(after).sort()).toEqual(["dev-a", "dev-b", "lead"]);
    expect(after.lead!.why).toBe("mention");
  });

  it("the card's assignee does not hear its own comment: nothing is kept for it (no 'not woken' under its own answer)", () => {
    const { board } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.updateCard(DEV, c.code, { comment: "an answer from the assignee" });
    expect(board.entryWakes(c.code).size).toBe(0);
    board.updateCard(DEV, c.code, { comment: "and it asks @lead" });
    expect(Object.keys(kept(board, c.code, lastEntry(board, c.code)))).toEqual(["lead"]);
  });

  it("an agent's comment is kept like a person's (it woke someone too)", () => {
    const { board } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.updateCard(DEV_B, c.code, { comment: "@lead FYI" });
    const wakes = kept(board, c.code, lastEntry(board, c.code));
    expect(wakes.lead).toMatchObject({ why: "mention" });
  });
});

describe("2. what the waker tells the board as the news goes out", () => {
  function wired(r: Rig, over: { boardOff?: (n: string) => boolean; deliver?: () => boolean; holds?: (w: any) => any } = {}) {
    const timers: Array<{ fn: () => void; live: boolean }> = [];
    const sent: Array<{ instance: string; key: string }> = [];
    const settled: Array<{ uuid: string; instance: string; key?: string; skip?: WakeSkip }> = [];
    const waker = new TaskBoardWaker({
      deliver: (instance, _message, key) => { sent.push({ instance, key }); return over.deliver ? over.deliver() : true; },
      isInstance: (n) => INSTANCES.includes(n),
      ...(over.boardOff ? { boardOff: over.boardOff } : {}),
      holds: over.holds ?? ((w) => r.board.wakeHolds(w)),
      card: (u) => r.board.findCard(u),
      settled: (e) => { settled.push(e); if (e.key) r.board.wakeHanded(e.uuid, e.instance, e.key); else if (e.skip) r.board.wakeDropped(e.uuid, e.instance, e.skip); },
      log: () => {},
      timers: { set: (fn) => { const t = { fn, live: true }; timers.push(t); return t; }, clear: (h) => { (h as { live: boolean }).live = false; } },
    });
    r.board.onChange((ch) => waker.note(ch.wakes));
    return { waker, sent, settled, fire: () => { for (const t of timers.splice(0)) if (t.live) t.fn(); } };
  }

  it("the comment carries the key of the notice that took it to delivery; a second comment in the same window shares that notice", () => {
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    const w = wired(r);
    r.board.updateCard(ANN, c.code, { comment: "first" });
    const first = lastEntry(r.board, c.code);
    r.board.updateCard(ANN, c.code, { comment: "second" });
    const second = lastEntry(r.board, c.code);
    expect(kept(r.board, c.code, first)["dev-a"]!.key).toBeUndefined();            // gathering: not handed over yet
    w.fire();
    expect(w.sent).toHaveLength(1);
    const key = w.sent[0]!.key;
    expect(kept(r.board, c.code, first)["dev-a"]!.key).toBe(key);
    expect(kept(r.board, c.code, second)["dev-a"]!.key).toBe(key);
    expect(cardsOfKey(key)).toEqual([c.uuid]);
    w.waker.stop();
  });

  it("a comment written after the notice went out waits for the next one", () => {
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    const w = wired(r);
    r.board.updateCard(ANN, c.code, { comment: "first" });
    w.fire();
    r.board.updateCard(ANN, c.code, { comment: "later" });
    const later = lastEntry(r.board, c.code);
    expect(kept(r.board, c.code, later)["dev-a"]!.key).toBeUndefined();
    w.fire();
    expect(kept(r.board, c.code, later)["dev-a"]!.key).toBe(w.sent[1]!.key);
    w.waker.stop();
  });

  it("news the fleet could not take is kept as not_taken; an instance whose board went off while it gathered, as board_off", () => {
    const a = rig();
    const c = card(a.board, LEAD, { assignee: "dev-a" });
    const refuse = wired(a, { deliver: () => false });
    a.board.updateCard(ANN, c.code, { comment: "hello" });
    refuse.fire();
    expect(skipsOf(a.board, c.code, lastEntry(a.board, c.code))).toEqual({ "dev-a": "not_taken" });
    const b = rig();
    const d = card(b.board, LEAD, { assignee: "dev-a" });
    const off = wired(b, { boardOff: (n) => n === "dev-a" });
    b.board.updateCard(ANN, d.code, { comment: "hello" });
    off.fire();
    expect(off.sent).toEqual([]);
    expect(skipsOf(b.board, d.code, lastEntry(b.board, d.code))).toEqual({ "dev-a": "board_off" });
  });

  it("news the card no longer holds as it goes out is kept as not_waiting", () => {
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    const w = wired(r, { holds: () => null });
    r.board.updateCard(ANN, c.code, { comment: "hello" });
    w.fire();
    expect(skipsOf(r.board, c.code, lastEntry(r.board, c.code))).toEqual({ "dev-a": "not_waiting" });
  });

  it("a writer the contact rules no longer let through is kept as contact_held when the notice goes out", () => {
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    const timers: Array<{ fn: () => void; live: boolean }> = [];
    const waker = new TaskBoardWaker({
      deliver: () => true, isInstance: (n) => INSTANCES.includes(n), mayReach: () => false,
      holds: (x) => r.board.wakeHolds(x), card: (u) => r.board.findCard(u),
      settled: (e) => { if (e.key) r.board.wakeHanded(e.uuid, e.instance, e.key); else if (e.skip) r.board.wakeDropped(e.uuid, e.instance, e.skip); },
      log: () => {}, timers: { set: (fn) => { const t = { fn, live: true }; timers.push(t); return t; }, clear: () => {} },
    });
    r.board.onChange((ch) => waker.note(ch.wakes));
    r.board.updateCard(DEV_B, c.code, { comment: "heads up" });
    for (const t of timers.splice(0)) t.fn();
    expect(skipsOf(r.board, c.code, lastEntry(r.board, c.code))["dev-a"]).toBe("contact_held");
  });

  it("handing over changes no revision and writes no event (it is not a board write), and names the card to read again", () => {
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.board.updateCard(ANN, c.code, { comment: "hi" });
    const before = { rev: r.board.revision(), events: r.board.events(c.uuid, 100).length };
    expect(r.board.wakeHanded(c.uuid, "dev-a", "task-board:dev-a:1:1:cards=" + c.uuid)).toEqual([c.code]);
    expect(r.board.wakeHanded(c.uuid, "dev-a", "again")).toEqual([]);              // nothing left waiting: nothing touched
    expect({ rev: r.board.revision(), events: r.board.events(c.uuid, 100).length }).toEqual(before);
  });
});

describe("3. how far a notice got", () => {
  const T0 = Date.parse("2026-11-26T10:00:00Z");
  const at = new Date(T0).toISOString();
  const wake = (over: Partial<EntryWake> = {}): EntryWake => ({ to: "dev-a", why: "assignee", at, key: "k1", ...over });
  const progress = (state: string, extra: Record<string, unknown> = {}) => new Map([["k1", { target: "dev-a", state: state as never, createdAt: at, finishedAt: null, consumedAt: null, ...extra }]]);

  it("each stage of the outbox has its word; read is the CLI's own evidence (consumed_at)", () => {
    for (const [state, want] of [["queued", "queued"], ["retry_wait", "queued"], ["delivering", "queued"], ["submission_started", "queued"], ["reconciliation_pending", "queued"],
      ["delivered", "delivered"], ["failed", "failed"], ["uncertain", "uncertain"], ["cancelled", "withdrawn"]] as const) {
      expect([state, wakeViews([wake()], progress(state), T0 + 1000)[0]!.state]).toEqual([state, want]);
    }
    const read = wakeViews([wake()], progress("delivered", { consumedAt: "2026-11-26T10:00:20Z" }), T0 + 30_000)[0]!;
    expect(read).toMatchObject({ state: "read", readAt: "2026-11-26T10:00:20Z" });
  });

  it("not yet handed over is sending, and lost once the fleet has had a while (it stopped while gathering)", () => {
    const w = wake({ key: undefined });
    expect(wakeViews([w], new Map(), T0 + 5_000)[0]).toMatchObject({ state: "sending" });
    expect(wakeViews([w], new Map(), T0 + 3 * 60_000)[0]).toMatchObject({ state: "skipped", skip: "lost" });
  });

  it("not woken keeps its reason; a key the outbox no longer has is unknown, never a guess", () => {
    expect(wakeViews([wake({ key: undefined, skip: "board_off" })], new Map(), T0)[0]).toMatchObject({ state: "skipped", skip: "board_off" });
    expect(wakeViews([wake()], new Map(), T0)[0]).toMatchObject({ state: "unknown" });
  });

  it("carries no key, no text and no delivery id", () => {
    const view = wakeViews([wake()], progress("delivered"), T0)[0]!;
    expect(JSON.stringify(view)).not.toMatch(/k1|task-board|deliveryId/);
    expect(Object.keys(view).sort()).toEqual(["at", "state", "to", "why"]);
  });

  it("the real outbox: a notice's progress by its key — queued, delivered, then read once the transcript shows it consumed", () => {
    const d = tmp();
    const outbox = new DeliveryOutbox(join(d, "outbox.db"), "boot-1");
    try {
      const key = "task-board:dev-a:1:1:cards=u1";
      expect(outbox.noticeProgress([key]).size).toBe(0);
      outbox.admitSystemNotice("dev-a", key, "[Task board] hi", new Date());
      expect(outbox.noticeProgress([key]).get(key)).toMatchObject({ target: "dev-a", state: "queued", consumedAt: null });
      expect(outbox.noticeProgress([key, "other"]).size).toBe(1);
      const text = JSON.stringify([...outbox.noticeProgress([key]).values()]);
      expect(text).not.toContain("[Task board] hi");
    } finally { outbox.close(); }
  });
});

describe("4. the person's unread", () => {
  /** Ann asked dev-a on a card; the floor is set before, so what comes after counts. */
  function asked() {
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.board.unreadFor("Ann");                                  // the floor: nothing before this is news
    r.board.updateCard(ANN, c.code, { comment: "how is it going?" });
    return { ...r, c };
  }
  const reasons = (board: TaskBoard, person: string) => Object.fromEntries(board.unreadFor(person).cards.map((u) => [u.id, u.reasons]));

  it("the answer of the instance her comment woke is unread — however it is written (no reply_to) — once, for the first answer", () => {
    const { board, c } = asked();
    expect(board.unreadFor("Ann").total).toBe(0);
    board.updateCard(DEV, c.code, { comment: "going well" });
    expect(reasons(board, "Ann")).toEqual({ [c.code]: ["answer"] });
    expect(board.unreadFor("Ann").cards[0]).toMatchObject({ n: 1, by: "dev-a" });
    board.markRead("Ann", c.code);
    board.updateCard(DEV, c.code, { comment: "and another thing" });             // not an answer: nobody asked for it
    expect(board.unreadFor("Ann").total).toBe(0);
  });

  it("an instance that was not asked does not answer: its comment is no news for her", () => {
    const { board, c } = asked();
    board.updateCard(DEV_B, c.code, { comment: "unrelated" });
    expect(board.unreadFor("Ann").total).toBe(0);
  });

  it("a reply under her comment (reply_to) is unread, whoever wrote it", () => {
    const { board, c } = asked();
    const mine = lastEntry(board, c.code);
    board.updateCard(DEV_B, c.code, { comment: "my take", replyTo: mine });
    expect(reasons(board, "Ann")).toEqual({ [c.code]: ["reply"] });
  });

  it("an @ to her is unread (not in code), and so is an @ with her name in another case", () => {
    const { board, c } = asked();
    board.updateCard(DEV_B, c.code, { comment: "see `@Ann` in code" });
    expect(board.unreadFor("Ann").total).toBe(0);
    board.updateCard(DEV_B, c.code, { comment: "@ann can you confirm?" });
    expect(reasons(board, "Ann")).toEqual({ [c.code]: ["mention"] });
  });

  it("her own words, a deleted comment, and an unrelated comment are not news", () => {
    const { board, c } = asked();
    board.updateCard(ANN, c.code, { comment: "@ann note to self" });
    board.updateCard(DEV, c.code, { comment: "an answer" });
    const answer = lastEntry(board, c.code);
    board.deleteComment(ANN, c.code, answer);
    expect(board.unreadFor("Ann").total).toBe(0);
  });

  it("a card handed to her to confirm is unread; a card she moved herself, or already confirmed, is not", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a", needsReview: true, dispatcher: { kind: "person" } });
    r.board.unreadFor("Ann");
    r.board.moveCard(DEV, c.code, "claimed", {});
    r.board.moveCard(DEV, c.code, "review", { result: "r" });
    expect(r.board.unreadFor("Ann").cards.map((u) => [u.id, u.reasons])).toEqual([[c.code, ["review"]]]);
    r.board.markRead("Ann", c.code);
    expect(r.board.unreadFor("Ann").total).toBe(0);
    r.board.moveCard(ANN, c.code, "claimed", { reason: "not yet" });              // she sent it back herself
    r.board.moveCard(DEV, c.code, "review", { result: "r" });
    expect(r.board.unreadFor("Ann").total).toBe(1);
    r.board.markRead("Ann", c.code);
    r.board.moveCard(ANN, c.code, "done", {});
    expect(r.board.unreadFor("Ann").total).toBe(0);                               // no longer waits for her
  });

  it("opening the card reads it — and only that card; it counts again from the next comment", () => {
    const r = rig();
    const a = card(r.board, LEAD, { assignee: "dev-a" });
    const b = card(r.board, LEAD, { assignee: "dev-a" });
    r.board.unreadFor("Ann");
    r.board.updateCard(ANN, a.code, { comment: "a?" });
    r.board.updateCard(ANN, b.code, { comment: "b?" });
    r.board.updateCard(DEV, a.code, { comment: "a!" });
    r.board.updateCard(DEV, b.code, { comment: "b!" });
    expect(r.board.unreadFor("Ann").cards.map((u) => u.id).sort()).toEqual([a.code, b.code].sort());
    r.board.markRead("Ann", a.code);
    expect(r.board.unreadFor("Ann").cards.map((u) => u.id)).toEqual([b.code]);
    r.board.markRead("Ann", a.code);                                              // idempotent
    r.board.updateCard(ANN, a.code, { comment: "again?" });
    r.board.updateCard(DEV, a.code, { comment: "again!" });
    expect(r.board.unreadFor("Ann").cards.map((u) => u.id).sort()).toEqual([a.code, b.code].sort());
  });

  it("each person has their own: what Ann read is still unread for Bob, who was not asked anything", () => {
    const { board, c } = asked();
    board.updateCard(DEV, c.code, { comment: "going well" });
    expect(board.unreadFor("Ann").total).toBe(1);
    expect(board.unreadFor("Bob").total).toBe(0);                                  // Bob's floor is now: nothing was for him
    board.markRead("Ann", c.code);
    expect(board.unreadFor("Ann").total).toBe(0);
  });

  it("an old history is not unread: the first time a person is asked, everything so far is behind their floor", () => {
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.board.updateCard(ANN, c.code, { comment: "an old question" });
    r.board.updateCard(DEV, c.code, { comment: "an old answer, @Ann" });
    expect(r.board.unreadFor("Ann").total).toBe(0);
    r.board.updateCard(DEV, c.code, { comment: "@Ann a new one" });
    expect(r.board.unreadFor("Ann").total).toBe(1);
  });

  it("only a recent comment is news (UNREAD_WINDOW_DAYS), so a card nobody opens does not keep every query walking its history", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-10-01T09:00:00Z");
    vi.setSystemTime(t0);
    const { board, c } = asked();
    board.updateCard(DEV, c.code, { comment: "going well" });
    expect(board.unreadFor("Ann").total).toBe(1);
    vi.setSystemTime(t0 + (UNREAD_WINDOW_DAYS - 1) * 86_400_000);
    expect(board.unreadFor("Ann").total).toBe(1);                                  // still within the window
    vi.setSystemTime(t0 + (UNREAD_WINDOW_DAYS + 1) * 86_400_000);
    expect(board.unreadFor("Ann").total).toBe(0);                                  // too old to be news
    board.updateCard(DEV_B, c.code, { comment: "@ann a fresh one" });
    expect(board.unreadFor("Ann").total).toBe(1);                                  // a new comment on the same card is
  });

  it("the 30 days are in the query: the range of comment numbers it reads starts at the first comment inside the window, found by an index", () => {
    const r = rig();
    const raw = (r.board as unknown as { db: { prepare(s: string): { all(...a: unknown[]): Array<Record<string, unknown>> } } }).db;
    const plan = raw.prepare("EXPLAIN QUERY PLAN SELECT MIN(id) AS id FROM task_entries INDEXED BY idx_task_entries_at WHERE at >= ?").all("2026-01-01T00:00:00.000Z").map((x) => String(x.detail)).join(" | ");
    expect(plan, "the window's first comment is an index search, not a scan of the comments").toMatch(/USING (COVERING )?INDEX idx_task_entries_at/);
    // And the comments older than it, whatever number they hold, are never read: an old comment under the floor's reach stays unread-free.
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-09-01T09:00:00Z");
    vi.setSystemTime(t0);
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.board.unreadFor("Ann");
    r.board.updateCard(ANN, c.code, { comment: "an old question" });
    r.board.updateCard(DEV, c.code, { comment: "an old answer" });
    vi.setSystemTime(t0 + (UNREAD_WINDOW_DAYS + 5) * 86_400_000);
    expect(r.board.unreadFor("Ann").total).toBe(0);
    r.board.updateCard(ANN, c.code, { comment: "a new question" });
    r.board.updateCard(DEV, c.code, { comment: "a new answer" });
    expect(r.board.unreadFor("Ann").cards[0]).toMatchObject({ n: 1, reasons: ["answer"] });
  });

  it("two accounts that are both \"web-user\" do not share what they have read, or each other's words: marks, floors and replies go by the key", () => {
    const r = rig();
    const A: Actor = { kind: "person", name: "web-user", key: "acct:a" }, B: Actor = { kind: "person", name: "web-user", key: "acct:b" };
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.board.unreadFor(A); r.board.unreadFor(B);                                      // each has a floor of their own
    const raw = (r.board as unknown as { db: { prepare(s: string): { all(): Array<Record<string, unknown>> } } }).db;
    expect(raw.prepare("SELECT person FROM task_reads_floor ORDER BY person").all().map((x) => x.person)).toEqual(["key:acct:a", "key:acct:b"]);
    r.board.updateCard(A, c.code, { comment: "a's question", to: [] });                 // (no agent is asked: the replies are what is news)
    const a1 = lastEntry(r.board, c.code);
    r.board.updateCard(B, c.code, { comment: "b's question", to: [] });
    const b1 = lastEntry(r.board, c.code);
    r.board.updateCard(DEV, c.code, { comment: "to a", replyTo: a1 });
    expect(r.board.unreadFor(A).cards.map((u) => [u.id, u.reasons]), "a reply under a's comment is a's news").toEqual([[c.code, ["reply"]]]);
    expect(r.board.unreadFor(B).total, "…and not b's, though the name is the same").toBe(0);
    r.board.updateCard(DEV, c.code, { comment: "to b", replyTo: b1 });
    expect(r.board.unreadFor(B).total).toBe(1);
    r.board.markRead(A, c.code);
    expect(r.board.unreadFor(A).total, "a has read it").toBe(0);
    expect(r.board.unreadFor(B).total, "b's mark is b's").toBe(1);
    r.board.markRead(B, c.code);
    expect(r.board.unreadFor(B).total).toBe(0);
    expect(raw.prepare("SELECT person FROM task_card_reads ORDER BY person").all().map((x) => x.person)).toEqual(["key:acct:a", "key:acct:b"]);
    // Another account's comment is not "their own words": a's mention of the name is news to b (b did not write it), and a comment b wrote is not b's news.
    r.board.updateCard(A, c.code, { comment: "@web-user from a" });
    expect(r.board.unreadFor(B).cards[0]!.reasons).toEqual(["mention"]);
    expect(r.board.unreadFor(A).total, "a's own words are never news to a").toBe(0);
  });

  it("a session with no key is read by its name (the name alone, kept apart from every key's marks)", () => {
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.board.unreadFor("Ann");
    r.board.updateCard(ANN, c.code, { comment: "a question" });
    r.board.updateCard(DEV, c.code, { comment: "an answer" });
    expect(r.board.unreadFor("Ann").total).toBe(1);
    expect(r.board.unreadFor({ name: "Ann", key: "acct:ann" }).total, "another reader (a key) has a floor of its own: nothing before it is news").toBe(0);
    const raw = (r.board as unknown as { db: { prepare(s: string): { all(): Array<Record<string, unknown>> } } }).db;
    expect(raw.prepare("SELECT person FROM task_reads_floor ORDER BY person").all().map((x) => x.person)).toEqual(["key:acct:ann", "name:Ann"]);
  });

  it("a cancelled card is not looked at; a finished one still is (an agent often answers as it finishes)", () => {
    const { board, c } = asked();
    board.updateCard(DEV, c.code, { comment: "going well" });
    board.moveCard(DEV, c.code, "claimed", {});
    board.moveCard(DEV, c.code, "done", { result: "r" });
    expect(board.unreadFor("Ann").cards.map((u) => u.id)).toEqual([c.code]);
    const r = rig();
    const k = card(r.board, LEAD, { assignee: "dev-a" });
    r.board.unreadFor("Ann");
    r.board.updateCard(ANN, k.code, { comment: "how is it going?" });
    r.board.updateCard(DEV, k.code, { comment: "an answer" });
    expect(r.board.unreadFor("Ann").total).toBe(1);
    r.board.moveCard(ANN, k.code, "cancelled", { reason: "not needed" });
    expect(r.board.unreadFor("Ann").total).toBe(0);
  });

  it("the entries to mark as new on the card's page are the comments that are", () => {
    const { board, c } = asked();
    board.updateCard(DEV, c.code, { comment: "going well" });
    const answer = lastEntry(board, c.code);
    board.updateCard(DEV_B, c.code, { comment: "@Ann also this" });
    const mention = lastEntry(board, c.code);
    expect(board.unreadFor("Ann").cards[0]!.entries.sort()).toEqual([answer, mention].sort());
  });

  it("a card the board pruned leaves no mark behind", () => {
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.board.markRead("Ann", c.code);
    const raw = (r.db as unknown as { db: Database.Database }).db;
    expect((raw.prepare("SELECT COUNT(*) AS n FROM task_card_reads").get() as { n: number }).n).toBe(1);
    raw.prepare("DELETE FROM tasks WHERE id = ?").run(c.uuid);
    raw.exec("DELETE FROM task_card_reads WHERE task_id NOT IN (SELECT id FROM tasks)");
    expect((raw.prepare("SELECT COUNT(*) AS n FROM task_card_reads").get() as { n: number }).n).toBe(0);
  });
});

describe("5. compatibility", () => {
  it("a database written before this (no `wakes`, no read tables) opens, reads and writes as it did, and gains only those", () => {
    const path = join(tmp(), "scheduler.db");
    const old = new Database(path);
    old.exec(`
      CREATE TABLE task_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, author TEXT NOT NULL, author_kind TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL);
    `);
    old.close();
    const r = rig(path);
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.board.updateCard(ANN, c.code, { comment: "hello" });
    const raw = (r.db as unknown as { db: Database.Database }).db;
    const cols = (raw.prepare("PRAGMA table_info(task_entries)").all() as Array<{ name: string }>).map((x) => x.name);
    expect(cols).toContain("wakes");
    expect(r.board.detail(c.code).comments[0]).toMatchObject({ text: "hello", author: "Ann" });
  });

  it("an older release reads the same database: its own columns, its own SELECT *, an INSERT naming only its columns", () => {
    const path = join(tmp(), "scheduler.db");
    const r = rig(path);
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.board.updateCard(ANN, c.code, { comment: "from the new release" });
    r.db.close();
    const raw = new Database(path);
    try {
      const row = raw.prepare("SELECT * FROM task_entries WHERE kind = 'comment'").get() as Record<string, unknown>;
      expect(row.text).toBe("from the new release");
      raw.prepare("INSERT INTO task_entries (task_id, kind, author, author_kind, text, at) VALUES (?, 'comment', 'old', 'instance', 'from the old release', ?)").run(c.uuid, new Date().toISOString());
      const again = new SchedulerDb(path); dbs.push(again);
      expect(again.board.detail(c.code).comments.map((e) => e.text)).toEqual(["from the new release", "from the old release"]);
      expect(again.board.entryWakes(c.code).size).toBe(1);                         // only the comment that was written for someone
    } finally { raw.close(); }
  });

  it("a hand-edited or corrupt `wakes` never breaks a read: only well-formed rows are kept", () => {
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.board.updateCard(ANN, c.code, { comment: "hi" });
    const raw = (r.db as unknown as { db: Database.Database }).db;
    raw.prepare("UPDATE task_entries SET wakes = ? WHERE kind = 'comment'").run('[{"to":"dev-a"},{"to":7,"at":"x"},{"to":"lead","at":"2026-01-01T00:00:00Z","why":"nope","skip":"bogus"},"x"]');
    expect(r.board.entryWakes(c.code).get(lastEntry(r.board, c.code))).toEqual([{ to: "lead", why: "mention", at: "2026-01-01T00:00:00Z" }]);
    raw.prepare("UPDATE task_entries SET wakes = 'not json' WHERE kind = 'comment'").run();
    expect(r.board.entryWakes(c.code).size).toBe(0);
  });

  it("comments, reactions and edits write no task event of their own for this (the old history is not changed)", () => {
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.board.updateCard(ANN, c.code, { comment: "hi" });
    r.board.wakeHanded(c.uuid, "dev-a", "k");
    const types = r.board.events(c.uuid, 100).map((e) => e.type);
    expect(types.filter((t) => !["created", "commented"].includes(t))).toEqual([]);
  });
});
