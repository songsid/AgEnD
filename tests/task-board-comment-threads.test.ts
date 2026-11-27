/**
 * Comment threads on a task card (docs/design/task-board.md, "Comment threads"): reply, react, edit, resolve, delete, and the
 * recipient a comment is written for. The rules, each tested here:
 *
 *   1. Edit: only the author (person or instance, by name and kind), only a live comment; marked edited; nothing woken.
 *   2. Threads: a reply names the comment it answers; one that is not there, deleted, or another card's writes nothing.
 *   3. Reactions: anyone puts one on and takes their own back; one emoji only (never markup); a bounded number of kinds.
 *   4. Resolve: a thread's first comment only; undone again.
 *   5. Delete: the author or a person; a placeholder stays (the thread holds); words, reactions, files and the history's copy go.
 *   6. Counts and reads: a deleted comment is not counted, searched, or "new" to the assignee; an untouched entry reads as before.
 *   7. Wakes: `to` (the comment box's recipient) replaces the assignee rule; a reply tells its comment's author; an edit wakes only
 *      the `@` it adds; reactions, resolving and deleting wake nobody — and each is a change the page hears.
 *   8. The loop guard counts a recipient that no `@` named.
 *   9. Compatibility: an older database opens, its rows read as before; an older release's writes still land; a prune takes the
 *      reactions with their comments.
 *
 * Isolation: temp databases; the fleet's names and switches are the board's own seams (no FleetManager).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerDb } from "../src/scheduler/db.js";
import { AGENT_COMMENT_CHAIN, MAX_REACTION_KINDS, type Actor, type TaskBoard, type Wake } from "../src/scheduler/task-board.js";
import { boardToolAction } from "../src/task-board-tool.js";
import { wakeMessage } from "../src/task-board-waker.js";
import { cardText } from "../src/scheduler/task-board-text.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const BOB: Actor = { kind: "person", name: "Bob" };
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
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "task-board-threads-")); dirs.push(d); return d; };

/** The fleet in these tests: lead, dev-a, dev-b, and `quiet`, which has the task board off. */
const INSTANCES = ["lead", "dev-a", "dev-b", "quiet"];
type Heard = { to: string; code: string; reasons: string[]; by: Record<string, string | undefined>; texts: Record<string, string | undefined>; wake: Wake };
interface Rig { db: SchedulerDb; board: TaskBoard; path: string; heard: Heard[]; changes: Array<{ rev: number; ids: string[] }>; take: () => Heard[] }
function rig(path = join(tmp(), "scheduler.db")): Rig {
  const db = new SchedulerDb(path); dbs.push(db);
  const board = db.board;
  board.setBoardOff((n) => n === "quiet");
  board.setCommentRouting({ instances: () => INSTANCES, enabled: () => true });
  if (!board.listProjects(true).length) board.createProject(ANN, { name: "Game" });
  const heard: Heard[] = [];
  const changes: Rig["changes"] = [];
  board.onChange((c) => {
    changes.push({ rev: c.rev, ids: c.ids });
    for (const w of c.wakes) heard.push({ to: w.instance, code: w.code, reasons: w.reasons, by: w.by, texts: w.texts, wake: w });
  });
  return { db, board, path, heard, changes, take: () => heard.splice(0) };
}
const card = (board: TaskBoard, by: Actor, extra: Record<string, unknown> = {}) =>
  board.createCards(by, { project: "Game", cards: [{ title: "Build the leaderboard", needsReview: false, ...extra }] }).cards[0]!;
const say = (board: TaskBoard, code: string, by: Actor, comment: string, extra: Record<string, unknown> = {}) => {
  board.updateCard(by, code, { comment, ...extra });
  return board.detail(code).comments.at(-1)!;
};
const noteKeys = (r: { said: Array<{ key: string }> }) => r.said.map((n) => n.key);
const errorOf = (fn: () => unknown): { code?: string; key?: string; message: string } => {
  try { fn(); } catch (e) { return e as { code?: string; key?: string; message: string }; }
  throw new Error("expected a refusal");
};
const woken = (heard: Heard[]) => heard.map((h) => `${h.to}:${h.reasons.join("+")}`).sort();

describe("1. editing a comment", () => {
  it("its author changes the words; it reads as edited, and the card's version does not move", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    const first = say(r.board, c.code, ANN, "ship it friday");
    const v = r.board.getCard(c.code).version;
    const out = r.board.editComment(ANN, c.code, first.id, "ship it monday");
    expect(out.entry.text).toBe("ship it monday");
    expect(out.entry.editedAt).toBeTruthy();
    expect(r.board.getCard(c.code).version).toBe(v);
    expect(r.board.detail(c.code).comments.map((e) => [e.text, !!e.editedAt])).toEqual([["ship it monday", true]]);
  });

  it("an instance edits its own comment too; a script its own (name and kind)", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    const mine = say(r.board, c.code, DEV, "done?");
    expect(r.board.editComment(DEV, c.code, mine.id, "done.").entry.text).toBe("done.");
    const script = say(r.board, c.code, SCRIPT, "from a script");
    expect(r.board.editComment(SCRIPT, c.code, script.id, "from a script, again").entry.text).toBe("from a script, again");
  });

  it("nobody else may: not another person, not an instance, not a person with an instance's name, not the other way round", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    const byAnn = say(r.board, c.code, ANN, "mine");
    const byDev = say(r.board, c.code, DEV, "its");
    for (const [who, id] of [[BOB, byAnn.id], [DEV, byAnn.id], [ANN, byDev.id], [{ kind: "person", name: "dev-a" } as Actor, byDev.id], [{ kind: "instance", name: "Ann" } as Actor, byAnn.id], [SCRIPT, byAnn.id]] as const) {
      const e = errorOf(() => r.board.editComment(who, c.code, id, "hijacked"));
      expect(e).toMatchObject({ code: "forbidden", key: "comment_not_yours" });
    }
    expect(r.board.detail(c.code).comments.map((e) => e.text)).toEqual(["mine", "its"]);
  });

  it("an empty edit, a deleted comment, a comment of another card, a send-back, and an unknown number are refused", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    const other = card(r.board, ANN, { assignee: "dev-b" });
    const live = say(r.board, c.code, ANN, "hello");
    const foreign = say(r.board, other.code, ANN, "elsewhere");
    expect(errorOf(() => r.board.editComment(ANN, c.code, live.id, "   "))).toMatchObject({ code: "invalid", key: "comment_empty" });
    expect(errorOf(() => r.board.editComment(ANN, c.code, foreign.id, "x"))).toMatchObject({ code: "not_found", key: "comment_not_found" });
    expect(errorOf(() => r.board.editComment(ANN, c.code, 9999, "x"))).toMatchObject({ code: "not_found" });
    expect(errorOf(() => r.board.editComment(ANN, c.code, live.id, "x".repeat(4001)))).toMatchObject({ code: "too_long" });
    r.board.deleteComment(ANN, c.code, live.id);
    expect(errorOf(() => r.board.editComment(ANN, c.code, live.id, "back"))).toMatchObject({ key: "comment_deleted" });
    // a send-back is a `reject` entry, not a comment: it is the confirmer's word on the card and is not edited
    const w = card(r.board, ANN, { assignee: "dev-a", needsReview: true });
    r.board.moveCard(DEV, w.code, "claimed"); r.board.updateCard(DEV, w.code, { result: "done it" }); r.board.moveCard(DEV, w.code, "review");
    r.board.moveCard(ANN, w.code, "claimed", { reason: "not yet" });
    const reject = r.board.detail(w.code).comments.find((e) => e.kind === "reject")!;
    expect(errorOf(() => r.board.editComment(ANN, w.code, reject.id, "yes yet"))).toMatchObject({ code: "not_found" });
  });

  it("editing to the same words changes nothing and is said so", () => {
    const r = rig();
    const c = card(r.board, ANN);
    const e = say(r.board, c.code, ANN, "same");
    const rev = r.board.revision();
    const out = r.board.editComment(ANN, c.code, e.id, "same");
    expect(out.notes).toEqual(["no change"]);
    expect(out.entry.editedAt).toBeUndefined();
    expect(r.board.revision()).toBe(rev);
  });
});

describe("2. replies", () => {
  it("a reply names the comment it answers (the one it was written under, however deep)", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    const root = say(r.board, c.code, ANN, "root");
    const one = say(r.board, c.code, DEV, "one", { replyTo: root.id });
    const two = say(r.board, c.code, ANN, "two", { replyTo: one.id });
    const all = r.board.detail(c.code).comments;
    expect(all.map((e) => [e.text, e.parentId])).toEqual([["root", undefined], ["one", root.id], ["two", one.id]]);
    expect(two.parentId).toBe(one.id);
  });

  it("a reply to a comment that is not there, was deleted, or is another card's writes nothing at all", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    const other = card(r.board, ANN, { assignee: "dev-b" });
    const gone = say(r.board, c.code, ANN, "short lived");
    const foreign = say(r.board, other.code, ANN, "elsewhere");
    r.board.deleteComment(ANN, c.code, gone.id);
    const before = r.board.detail(c.code).comments.length;
    expect(errorOf(() => r.board.updateCard(ANN, c.code, { comment: "re", replyTo: 9999 }))).toMatchObject({ key: "comment_not_found" });
    expect(errorOf(() => r.board.updateCard(ANN, c.code, { comment: "re", replyTo: foreign.id }))).toMatchObject({ key: "comment_not_found" });
    expect(errorOf(() => r.board.updateCard(ANN, c.code, { comment: "re", replyTo: gone.id }))).toMatchObject({ key: "comment_deleted" });
    expect(r.board.detail(c.code).comments).toHaveLength(before);
  });

  it("replyTo and to go with a comment: alone they are refused", () => {
    const r = rig();
    const c = card(r.board, ANN);
    const root = say(r.board, c.code, ANN, "root");
    expect(errorOf(() => r.board.updateCard(ANN, c.code, { replyTo: root.id }))).toMatchObject({ key: "reply_needs_comment" });
    expect(errorOf(() => r.board.updateCard(ANN, c.code, { to: ["dev-a"] }))).toMatchObject({ key: "reply_needs_comment" });
  });
});

describe("3. reactions", () => {
  it("anyone puts one on; the same one twice is one; each takes only their own back; the page reads who", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    const e = say(r.board, c.code, DEV, "done");
    r.board.react(ANN, c.code, e.id, "👍", true);
    r.board.react(ANN, c.code, e.id, "👍", true);
    r.board.react(BOB, c.code, e.id, "👍", true);
    r.board.react(LEAD, c.code, e.id, "🎉", true);
    let got = r.board.detail(c.code).comments[0]!;
    expect(got.reactions).toEqual([
      { emoji: "👍", by: [{ name: "Ann", kind: "person" }, { name: "Bob", kind: "person" }] },
      { emoji: "🎉", by: [{ name: "lead", kind: "instance" }] },
    ]);
    r.board.react(ANN, c.code, e.id, "👍", false);
    r.board.react(ANN, c.code, e.id, "🎉", false);          // not Ann's: nothing changes
    got = r.board.detail(c.code).comments[0]!;
    expect(got.reactions).toEqual([{ emoji: "👍", by: [{ name: "Bob", kind: "person" }] }, { emoji: "🎉", by: [{ name: "lead", kind: "instance" }] }]);
    r.board.react(BOB, c.code, e.id, "👍", false);
    r.board.react(LEAD, c.code, e.id, "🎉", false);
    expect(r.board.detail(c.code).comments[0]!.reactions).toBeUndefined();
  });

  it("a person and an instance of the same name are two reactors", () => {
    const r = rig();
    const c = card(r.board, ANN);
    const e = say(r.board, c.code, ANN, "x");
    r.board.react({ kind: "person", name: "dev-a" }, c.code, e.id, "👍", true);
    r.board.react(DEV, c.code, e.id, "👍", true);
    expect(r.board.detail(c.code).comments[0]!.reactions![0]!.by).toHaveLength(2);
  });

  it("a reaction is one emoji and never markup", () => {
    const r = rig();
    const c = card(r.board, ANN);
    const e = say(r.board, c.code, ANN, "x");
    for (const bad of ["", "   ", "a", "ok", "<script>alert(1)</script>", "👍<b>", "\"><img src=x onerror=1>", "👍 👍", "👍\u0000", "javascript:1", "x".repeat(40), "👍".repeat(20)]) {
      expect(errorOf(() => r.board.react(ANN, c.code, e.id, bad, true)), JSON.stringify(bad)).toMatchObject({ key: "reaction_invalid" });
    }
    for (const good of ["👍", "❤️", "🎉", "👩‍💻", "👍🏽", "🇹🇼", "1️⃣"]) r.board.react(ANN, c.code, e.id, good, true);
    expect(r.board.detail(c.code).comments[0]!.reactions!.map((x) => x.emoji)).toEqual(["👍", "❤️", "🎉", "👩‍💻", "👍🏽", "🇹🇼", "1️⃣"]);
  });

  it("a comment carries a bounded number of different emoji; one already there can still be added to", () => {
    const r = rig();
    const c = card(r.board, ANN);
    const e = say(r.board, c.code, ANN, "x");
    const palette = ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😇", "🙂", "🙃", "😉", "😌", "😍", "🥰", "😘", "😗", "😙", "😚"];
    expect(palette).toHaveLength(MAX_REACTION_KINDS);
    for (const m of palette) r.board.react(ANN, c.code, e.id, m, true);
    expect(errorOf(() => r.board.react(ANN, c.code, e.id, "🤩", true))).toMatchObject({ key: "reaction_limit" });
    expect(() => r.board.react(BOB, c.code, e.id, "😀", true)).not.toThrow();
  });

  it("a deleted or unknown comment takes none", () => {
    const r = rig();
    const c = card(r.board, ANN);
    const e = say(r.board, c.code, ANN, "x");
    r.board.deleteComment(ANN, c.code, e.id);
    expect(errorOf(() => r.board.react(ANN, c.code, e.id, "👍", true))).toMatchObject({ key: "comment_deleted" });
    expect(errorOf(() => r.board.react(ANN, c.code, 9999, "👍", true))).toMatchObject({ key: "comment_not_found" });
  });
});

describe("4. resolving a thread", () => {
  it("a thread's first comment is resolved by a name and opened again; a reply cannot be", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    const root = say(r.board, c.code, ANN, "question");
    const reply = say(r.board, c.code, DEV, "answer", { replyTo: root.id });
    expect(errorOf(() => r.board.resolveThread(ANN, c.code, reply.id, true))).toMatchObject({ key: "resolve_root_only" });
    const done = r.board.resolveThread(BOB, c.code, root.id, true);
    expect(done.entry.resolved).toMatchObject({ by: "Bob" });
    expect(r.board.detail(c.code).comments[0]!.resolved?.by).toBe("Bob");
    expect(r.board.resolveThread(BOB, c.code, root.id, true).notes).toEqual(["no change"]);
    expect(r.board.resolveThread(ANN, c.code, root.id, false).entry.resolved).toBeUndefined();
    expect(r.board.detail(c.code).comments[0]!.resolved).toBeUndefined();
  });
});

describe("5. deleting a comment", () => {
  it("leaves a placeholder: the words are gone, the replies still hang from it, and the history's copy is scrubbed", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    const root = say(r.board, c.code, ANN, "secret words");
    say(r.board, c.code, DEV, "an answer", { replyTo: root.id });
    r.board.deleteComment(ANN, c.code, root.id);
    const comments = r.board.detail(c.code).comments;
    expect(comments[0]).toMatchObject({ id: root.id, text: "", deleted: { by: "Ann" } });
    expect(comments[1]).toMatchObject({ text: "an answer", parentId: root.id });
    expect(JSON.stringify(r.board.detail(c.code))).not.toContain("secret words");
    // stored nowhere either: the row and the event
    const raw = new Database(r.path, { readonly: true });
    try {
      expect(raw.prepare("SELECT text FROM task_entries WHERE id = ?").get(root.id)).toEqual({ text: "" });
      expect(JSON.stringify(raw.prepare("SELECT data FROM task_events").all())).not.toContain("secret words");
    } finally { raw.close(); }
  });

  it("scrubs the history's copy of a comment written before the entry was named in its event", () => {
    const r = rig();
    const c = card(r.board, ANN);
    const root = say(r.board, c.code, ANN, "old secret");
    const raw = new Database(r.path);
    try {
      raw.prepare("UPDATE task_events SET data = ? WHERE type = 'commented'").run(JSON.stringify({ text: "old secret" }));   // as a release without the number wrote it
    } finally { raw.close(); }
    r.board.deleteComment(ANN, c.code, root.id);
    expect(JSON.stringify(r.board.detail(c.code).history)).not.toContain("old secret");
  });

  it("the author, or a person; an instance or a script only its own", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    const byAnn = say(r.board, c.code, ANN, "ann's");
    const byDev = say(r.board, c.code, DEV, "dev's");
    const byDev2 = say(r.board, c.code, DEV, "dev's second");
    expect(errorOf(() => r.board.deleteComment(DEV, c.code, byAnn.id))).toMatchObject({ code: "forbidden", key: "comment_delete_forbidden" });
    expect(errorOf(() => r.board.deleteComment(SCRIPT, c.code, byDev.id))).toMatchObject({ code: "forbidden" });
    expect(() => r.board.deleteComment(DEV, c.code, byDev.id)).not.toThrow();
    expect(() => r.board.deleteComment(BOB, c.code, byDev2.id)).not.toThrow();        // a person, not the author
    expect(() => r.board.deleteComment(ANN, c.code, byAnn.id)).not.toThrow();
    expect(r.board.detail(c.code).comments.every((e) => e.deleted)).toBe(true);
    expect(r.board.deleteComment(ANN, c.code, byAnn.id).notes).toEqual(["no change"]);   // again: nothing
  });

  it("its reactions and its files go with it", async () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    const staged = JSON.parse(boardToolAction(r.db, "dev-a", { action: "upload", name: "a.txt", data_b64: Buffer.from("hello").toString("base64") })!) as { upload: string };
    r.board.updateCard(DEV, c.code, { comment: "see file", attach: [staged.upload] });
    const e = r.board.detail(c.code).comments[0]!;
    r.board.react(ANN, c.code, e.id, "👍", true);
    const folder = join(join(r.path, ".."), "task-files", r.board.getCard(c.code).uuid);
    expect(existsSync(folder) && readdirSync(folder)).toEqual([staged.upload]);
    r.board.deleteComment(DEV, c.code, e.id);
    expect(r.board.attachments(r.board.getCard(c.code).uuid)).toEqual([]);
    expect(existsSync(join(folder, staged.upload))).toBe(false);
    const raw = new Database(r.path, { readonly: true });
    try { expect(raw.prepare("SELECT COUNT(*) AS n FROM task_entry_reactions").get()).toEqual({ n: 0 }); } finally { raw.close(); }
  });
});

describe("6. counts and reads", () => {
  it("a deleted comment is not counted, not 'new' to the assignee, and its words are not found by a search", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    const first = say(r.board, c.code, ANN, "needle in a haystack");
    say(r.board, c.code, ANN, "another");
    expect(r.board.view(r.board.getCard(c.code)).commentCount).toBe(2);
    expect(r.board.view(r.board.getCard(c.code)).newCommentCount).toBe(2);
    expect(r.board.search("needle").map((h) => h.card.code)).toEqual([c.code]);
    r.board.deleteComment(ANN, c.code, first.id);
    const v = r.board.view(r.board.getCard(c.code));
    expect(v.commentCount).toBe(1);
    expect(v.newCommentCount).toBe(1);
    expect(r.board.newComments(r.board.getCard(c.code)).map((e) => e.text)).toEqual(["another"]);
    expect(r.board.search("needle")).toEqual([]);
    expect(r.board.myWork("dev-a").newComments[0]!.entries.map((e) => e.text)).toEqual(["another"]);
    expect(cardText(r.board, r.board.getCard(c.code))).not.toContain("needle");
  });

  it("an entry nobody replied to, edited, resolved or reacted to has exactly the fields it always had", () => {
    const r = rig();
    const c = card(r.board, ANN);
    r.board.updateCard(ANN, c.code, { comment: "plain" });
    const e = r.board.detail(c.code).comments[0]!;
    expect(Object.keys(e).sort()).toEqual(["at", "author", "authorKind", "cardId", "id", "kind", "text"]);
  });
});

describe("7. who is woken", () => {
  const assigned = (r: Rig) => { const c = card(r.board, ANN, { assignee: "dev-a", dispatcher: { kind: "person" } }); r.take(); return c; };

  it("without `to` it is the old rule: the assignee, and each `@name`", () => {
    const r = rig();
    const c = assigned(r);
    r.board.updateCard(ANN, c.code, { comment: "@dev-b look" });
    expect(woken(r.take())).toEqual(["dev-a:comment", "dev-b:mention"]);
  });

  it("`to` the assignee is the old rule's comment — and only the assignee", () => {
    const r = rig();
    const c = assigned(r);
    r.board.updateCard(ANN, c.code, { comment: "please", to: ["dev-a"] });
    expect(woken(r.take())).toEqual(["dev-a:comment"]);
  });

  it("`to` another instance wakes that one and not the assignee, and the writer is told who", () => {
    const r = rig();
    const c = assigned(r);
    const out = r.board.updateCard(ANN, c.code, { comment: "please", to: ["lead"] });
    expect(woken(r.take())).toEqual(["lead:mention"]);
    expect(noteKeys(out)).toContain("comment_wakes");
    expect(out.notes.join(" ")).toContain("lead (addressed)");
  });

  it("`to` the assignee of a finished card, or one still waiting on what it depends on, is asked for by name: it goes as a mention (the old rule would tell nobody)", () => {
    const r = rig();
    const done = card(r.board, ANN, { assignee: "dev-a" });
    r.board.moveCard(DEV, done.code, "claimed"); r.board.moveCard(DEV, done.code, "done", { result: "ok" });
    r.take();
    r.board.updateCard(ANN, done.code, { comment: "thanks — one more thing", to: ["dev-a"] });
    expect(woken(r.take())).toEqual(["dev-a:mention"]);
    r.board.updateCard(ANN, done.code, { comment: "thanks" });                            // no recipient chosen: the old rule, a finished card tells nobody
    expect(woken(r.take())).toEqual([]);
    const first = card(r.board, ANN, { assignee: "dev-b" });
    const waiting = card(r.board, ANN, { assignee: "dev-a", dependsOn: [first.code] });
    r.take();
    r.board.updateCard(ANN, waiting.code, { comment: "heads up", to: ["dev-a"] });
    expect(woken(r.take())).toEqual(["dev-a:mention"]);
  });

  it("`to: []` notifies no agent; an `@name` in the words still does", () => {
    const r = rig();
    const c = assigned(r);
    r.board.updateCard(ANN, c.code, { comment: "just a note", to: [] });
    expect(woken(r.take())).toEqual([]);
    r.board.updateCard(ANN, c.code, { comment: "@lead and a note", to: [] });
    expect(woken(r.take())).toEqual(["lead:mention"]);
  });

  it("`to` and an `@` for the same instance wake it once; `to` the assignee and `@` it is one mention", () => {
    const r = rig();
    const c = assigned(r);
    r.board.updateCard(ANN, c.code, { comment: "@lead please", to: ["lead"] });
    expect(woken(r.take())).toEqual(["lead:mention"]);
    r.board.updateCard(ANN, c.code, { comment: "@dev-a please", to: ["dev-a"] });
    expect(woken(r.take())).toEqual(["dev-a:mention"]);
  });

  it("an unknown or task-board-off recipient is said, never refused; the comment is kept", () => {
    const r = rig();
    const c = assigned(r);
    const out = r.board.updateCard(ANN, c.code, { comment: "hello", to: ["ghost", "quiet"] });
    expect(noteKeys(out)).toEqual(expect.arrayContaining(["mention_unknown", "mention_off"]));
    expect(woken(r.take())).toEqual([]);
    expect(r.board.detail(c.code).comments).toHaveLength(1);
  });

  it("a person who is also the name of an instance can still address that instance", () => {
    const r = rig();
    const c = assigned(r);
    r.board.updateCard({ kind: "person", name: "lead" }, c.code, { comment: "hi", to: ["lead"] });
    expect(woken(r.take())).toEqual(["lead:mention"]);
  });

  it("a reply that chose no recipient tells the author of the comment it answers when that is an instance — and the assignee, as before", () => {
    const r = rig();
    const c = assigned(r);
    const asked = say(r.board, c.code, LEAD, "can you take a look?");
    r.take();
    r.board.updateCard(ANN, c.code, { comment: "yes", replyTo: asked.id });
    expect(woken(r.take())).toEqual(["dev-a:comment", "lead:mention"]);
    // a person's comment is nobody's to tell
    const note = say(r.board, c.code, ANN, "a note");
    r.take();
    r.board.updateCard(BOB, c.code, { comment: "agreed", replyTo: note.id });
    expect(woken(r.take())).toEqual(["dev-a:comment"]);
  });

  it("a reply with a chosen recipient wakes that one only", () => {
    const r = rig();
    const c = assigned(r);
    const asked = say(r.board, c.code, LEAD, "can you take a look?");
    r.take();
    r.board.updateCard(ANN, c.code, { comment: "not you", replyTo: asked.id, to: ["dev-b"] });
    expect(woken(r.take())).toEqual(["dev-b:mention"]);
  });

  it("the notice says which comment a reply answers", () => {
    const r = rig();
    const c = assigned(r);
    const asked = say(r.board, c.code, LEAD, "can you take a look at the layout and the colours before we ship?");
    r.take();
    r.board.updateCard(ANN, c.code, { comment: "yes please", replyTo: asked.id });
    const heard = r.take();
    const toLead = heard.find((h) => h.to === "lead")!;
    expect(toLead.wake.replies?.mention).toMatchObject({ id: asked.id, author: "lead" });
    const text = wakeMessage([toLead.wake], () => r.board.getCard(c.code));
    expect(text).toContain(`replying to c${asked.id} (lead): "can you take a look`);
    const toAssignee = heard.find((h) => h.to === "dev-a")!;
    expect(wakeMessage([toAssignee.wake], () => r.board.getCard(c.code))).toContain("replying to");
  });

  it("an edit wakes nobody — unless it adds an `@`, and then only the one it adds", () => {
    const r = rig();
    const c = assigned(r);
    const e = say(r.board, c.code, ANN, "@lead first words");
    r.take();
    r.board.editComment(ANN, c.code, e.id, "@lead second words");                 // same mention, other words: nobody
    expect(woken(r.take())).toEqual([]);
    r.board.editComment(ANN, c.code, e.id, "first words");                        // takes the mention away: nobody
    expect(woken(r.take())).toEqual([]);
    r.board.editComment(ANN, c.code, e.id, "@dev-b @lead now both");              // adds two: both, never the assignee
    expect(woken(r.take())).toEqual(["dev-b:mention", "lead:mention"]);
    r.board.editComment(ANN, c.code, e.id, "@dev-b @lead @dev-a now three");      // adds the assignee by name: the assignee only
    expect(woken(r.take())).toEqual(["dev-a:mention"]);
    expect(r.take()).toEqual([]);
  });

  it("an edit that adds an `@` of a task-board-off or unknown name says so and wakes nobody", () => {
    const r = rig();
    const c = assigned(r);
    const e = say(r.board, c.code, ANN, "words");
    r.take();
    const out = r.board.editComment(ANN, c.code, e.id, "words @quiet");
    expect(noteKeys(out)).toContain("mention_off");
    expect(woken(r.take())).toEqual([]);
  });

  it("an agent's edit that adds an `@` is held to the loop guard like its comment", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    r.board.updateCard(ANN, c.code, { comment: "go" });
    r.take();
    const mine = say(r.board, c.code, LEAD, "thinking");
    for (let i = 0; i < AGENT_COMMENT_CHAIN + 1; i++) {
      say(r.board, c.code, i % 2 ? LEAD : DEV_B, `@${i % 2 ? "dev-b" : "lead"} ping ${i}`);
    }
    r.take();
    const out = r.board.editComment(LEAD, c.code, mine.id, "thinking @dev-b");
    expect(noteKeys(out)).toContain("comment_chain");
    expect(woken(r.take())).toEqual([]);
  });

  it("reactions, resolving and deleting wake nobody — and each is a change the page hears (the revision moves, the card is named)", () => {
    const r = rig();
    const c = assigned(r);
    const e = say(r.board, c.code, LEAD, "@dev-b look");
    r.take();
    r.changes.length = 0;
    const rev0 = r.board.revision();
    r.board.react(ANN, c.code, e.id, "👍", true);
    r.board.react(ANN, c.code, e.id, "👍", false);
    r.board.resolveThread(ANN, c.code, e.id, true);
    r.board.resolveThread(ANN, c.code, e.id, false);
    r.board.deleteComment(ANN, c.code, e.id);
    expect(r.take()).toEqual([]);
    expect(r.board.revision()).toBe(rev0 + 5);
    expect(r.changes.map((x) => x.ids)).toEqual(Array(5).fill([c.code]));
  });

  it("an edit that changes nothing, a reaction already there, and an undone one that never was leave the revision alone", () => {
    const r = rig();
    const c = card(r.board, ANN);
    const e = say(r.board, c.code, ANN, "x");
    r.board.react(ANN, c.code, e.id, "👍", true);
    const rev = r.board.revision();
    r.board.react(ANN, c.code, e.id, "👍", true);
    r.board.react(BOB, c.code, e.id, "👍", false);
    r.board.resolveThread(ANN, c.code, e.id, false);
    expect(r.board.revision()).toBe(rev);
  });

  it("a card that is not on the board (the `task` tool's own) wakes nobody by a comment or a recipient", () => {
    const r = rig();
    const plain = r.board.legacyCreate(DEV, { title: "plain", assignee: "dev-a" });
    r.board.updateCard(ANN, plain.code, { comment: "hi", to: ["lead"] });
    expect(woken(r.take())).toEqual([]);
  });
});

describe("8. the loop guard counts a recipient no `@` named", () => {
  it("two agents answering each other by recipient and reply alone are stopped after the same number of turns as by `@`", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    r.take();
    r.board.updateCard(ANN, c.code, { comment: "begin", to: ["lead"] });
    r.take();
    let last = say(r.board, c.code, LEAD, "one", { to: ["dev-b"] });
    const spoken: string[] = [];
    for (let i = 0; i < AGENT_COMMENT_CHAIN + 2; i++) {
      const [by, to] = i % 2 === 0 ? [DEV_B, "lead"] : [LEAD, "dev-b"];
      const out = r.board.updateCard(by, c.code, { comment: `turn ${i}`, to: [to], replyTo: last.id });
      last = r.board.detail(c.code).comments.at(-1)!;
      spoken.push(...noteKeys(out).filter((k) => k === "comment_chain"));
    }
    expect(spoken.length).toBeGreaterThan(0);
    // and the person's word lifts it: the next agent comment wakes again
    r.board.updateCard(ANN, c.code, { comment: "carry on", to: [] });
    r.take();
    r.board.updateCard(DEV_B, c.code, { comment: "back", to: ["lead"] });
    expect(woken(r.take())).toEqual(["lead:mention"]);
  });

  it("a recipient list an agent chose keeps the assignee out of the turn count (it was not told)", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    r.take();
    for (let i = 0; i < AGENT_COMMENT_CHAIN + 3; i++) {
      const out = r.board.updateCard(LEAD, c.code, { comment: `note ${i}`, to: [] });
      expect(noteKeys(out)).not.toContain("comment_chain");
    }
    expect(woken(r.take())).toEqual([]);
  });
});

describe("9. compatibility", () => {
  /** A database as a release without the threads left it: the original columns, rows in them, no reactions table. */
  function oldDatabase(path: string): void {
    const seed = rig(path);
    const c = card(seed.board, ANN, { assignee: "dev-a" });
    seed.board.updateCard(ANN, c.code, { comment: "an old comment" });
    seed.db.close();
    const raw = new Database(path);
    try {
      raw.exec("DROP TABLE task_entry_reactions; DROP INDEX IF EXISTS idx_task_entries_parent;");
      const keep = ["id", "task_id", "kind", "author", "author_kind", "text", "at"];
      raw.exec(`CREATE TABLE task_entries_old AS SELECT ${keep.join(", ")} FROM task_entries; DROP TABLE task_entries;
        CREATE TABLE task_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, author TEXT NOT NULL, author_kind TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL);
        INSERT INTO task_entries SELECT ${keep.join(", ")} FROM task_entries_old; DROP TABLE task_entries_old;
        CREATE INDEX idx_task_entries_task ON task_entries(task_id, id);`);
    } finally { raw.close(); }
  }

  it("an older database opens: the columns and the table are added, every old comment reads as it did, and it takes the new writes", () => {
    const path = join(tmp(), "scheduler.db");
    oldDatabase(path);
    const r = rig(path);
    const code = r.board.listCards({}).cards[0]!.code;
    const old = r.board.detail(code).comments[0]!;
    expect(old).toEqual({ id: 1, cardId: code, kind: "comment", author: "Ann", authorKind: "person", text: "an old comment", at: old.at });
    expect(r.board.react(BOB, code, old.id, "👍", true).entry.reactions).toHaveLength(1);
    expect(r.board.editComment(ANN, code, old.id, "an old comment, edited").entry.editedAt).toBeTruthy();
    const reply = say(r.board, code, DEV, "an answer", { replyTo: old.id });
    expect(reply.parentId).toBe(old.id);
    // the old comment's event has no entry number: deleting it still finds and scrubs it
    r.board.deleteComment(ANN, code, old.id);
    expect(r.board.detail(code).comments[0]).toMatchObject({ text: "", deleted: { by: "Ann" } });
  });

  it("a release without the threads writes a comment as it always did, and the current one reads it (no number, no recipients)", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    const uuid = r.board.getCard(c.code).uuid;
    r.db.close();
    const raw = new Database(r.path);
    try {
      raw.prepare("INSERT INTO task_entries (task_id, kind, author, author_kind, text, at) VALUES (?, 'comment', 'old', 'person', 'from an older release', '2026-01-01T00:00:00.000Z')")
        .run(uuid);
    } finally { raw.close(); }
    const again = rig(r.path);
    expect(again.board.detail(c.code).comments.map((e) => e.text)).toEqual(["from an older release"]);
    expect(again.board.view(again.board.getCard(c.code)).commentCount).toBe(1);
    again.board.react(ANN, c.code, again.board.detail(c.code).comments[0]!.id, "👍", true);
  });

  it("the database's own prune takes a card's reactions with its comments, and sweeps those an older release's prune left behind", async () => {
    const r = rig();
    // in no project: an active project keeps its record, and a finished card of none is pruned once it is old
    const c = r.board.createCards(ANN, { cards: [{ title: "Old news", needsReview: false }] }).cards[0]!;
    const e = say(r.board, c.code, ANN, "x");
    r.board.react(ANN, c.code, e.id, "👍", true);
    r.board.moveCard(ANN, c.code, "claimed"); r.board.moveCard(ANN, c.code, "done", { result: "ok" });
    const raw = new Database(r.path);
    try {
      raw.prepare("UPDATE tasks SET updated_at = '2020-01-01T00:00:00.000Z', done_at = '2020-01-01T00:00:00.000Z'").run();
      // what an older release's prune leaves: reactions of a comment that is gone
      raw.prepare("INSERT INTO task_entry_reactions (entry_id, emoji, by, by_kind, at) VALUES (9999, '🎉', 'Ann', 'person', '2026-01-01T00:00:00.000Z')").run();
    } finally { raw.close(); }
    await r.db.pruneOldTasks(30);
    const check = new Database(r.path, { readonly: true });
    try {
      expect(check.prepare("SELECT COUNT(*) AS n FROM task_entries").get()).toEqual({ n: 0 });
      expect(check.prepare("SELECT COUNT(*) AS n FROM task_entry_reactions").get()).toEqual({ n: 0 });
    } finally { check.close(); }
  });
});

describe("10. an agent's side: the `task` tool", () => {
  const tool = (db: SchedulerDb, instance: string, args: Record<string, unknown>) => boardToolAction(db, instance, args) as string;

  it("get --detail shows each comment's number, an edit, and what it answers; a deleted one is not shown", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    const root = say(r.board, c.code, ANN, "root words");
    say(r.board, c.code, LEAD, "an answer", { replyTo: root.id });
    const gone = say(r.board, c.code, ANN, "oops");
    r.board.editComment(ANN, c.code, root.id, "root words, clearer");
    r.board.deleteComment(ANN, c.code, gone.id);
    const text = cardText(r.board, r.board.getCard(c.code));
    expect(text).toMatch(new RegExp(`c${root.id} Ann \\S+ \\S+ \\(edited\\)`));
    expect(text).toContain(`(reply to c${root.id})`);
    expect(text).not.toContain("oops");
    expect(text).toContain("root words, clearer");
  });

  it("update with reply_to answers a comment (c12, #12, 12 alike) and tells its author; a number that is none is refused by name", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    r.take();
    const asked = say(r.board, c.code, LEAD, "can you check the layout?");
    r.take();
    for (const ref of [`c${asked.id}`, `#${asked.id}`, String(asked.id), asked.id]) {
      const out = tool(r.db, "dev-a", { action: "update", id: c.code, comment: `looked at it (${ref})`, reply_to: ref });
      expect(out).toMatch(/^ok M-1/);
      expect(woken(r.take())).toEqual(["lead:mention"]);
    }
    expect(r.board.detail(c.code).comments.filter((e) => e.parentId === asked.id)).toHaveLength(4);
    for (const bad of ["abc", "c", "0", "-3", 1.5, {}]) {
      expect(() => tool(r.db, "dev-a", { action: "update", id: c.code, comment: "x", reply_to: bad }), JSON.stringify(bad)).toThrow(/reply_to.*comment's number/);
    }
    expect(() => tool(r.db, "dev-a", { action: "update", id: c.code, comment: "x", reply_to: 9999 })).toThrow(/no comment c9999/);
    expect(() => tool(r.db, "dev-a", { action: "update", id: c.code, reply_to: asked.id })).toThrow(/replyTo and to go with a comment/);
  });

  it("edit_comment changes the agent's own comment and no one else's; an @ it adds wakes that one", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    const mine = say(r.board, c.code, DEV, "first draft");
    const hers = say(r.board, c.code, ANN, "ann's");
    r.take();
    expect(tool(r.db, "dev-a", { action: "edit_comment", id: c.code, comment_id: `c${mine.id}`, comment: "second draft" })).toBe(`ok ${c.code} c${mine.id} edited`);
    expect(woken(r.take())).toEqual([]);
    expect(() => tool(r.db, "dev-a", { action: "edit_comment", id: c.code, comment_id: hers.id, comment: "mine now" })).toThrow(/only its author can edit/);
    expect(() => tool(r.db, "dev-a", { action: "edit_comment", id: c.code, comment: "x" })).toThrow(/comment_id is the comment's number/);
    expect(() => tool(r.db, "dev-a", { action: "edit_comment", id: c.code, comment_id: mine.id })).toThrow(/comment is required/);
    tool(r.db, "dev-a", { action: "edit_comment", id: c.code, comment_id: mine.id, comment: "second draft, @lead please look" });
    expect(woken(r.take())).toEqual(["lead:mention"]);
    expect(tool(r.db, "dev-a", { action: "edit_comment", id: c.code, comment_id: mine.id, comment: "second draft, @lead please look" })).toContain("no change");
    expect(r.board.detail(c.code).comments.map((e) => e.text)).toEqual(["second draft, @lead please look", "ann's"]);
  });

  it("the fields each action takes are enforced by name: edit_comment takes no status; update takes reply_to", async () => {
    const { unsupportedFields } = await import("../src/task-board-tool.js");
    expect(unsupportedFields({ action: "edit_comment", id: "M-1", comment_id: 1, comment: "x", status: "done" })).toMatch(/edit_comment does not take "status"/);
    expect(unsupportedFields({ action: "edit_comment", id: "M-1", comment_id: 1, comment: "x" })).toBeNull();
    expect(unsupportedFields({ action: "update", id: "M-1", comment: "x", reply_to: 3 })).toBeNull();
    expect(unsupportedFields({ action: "move", id: "M-1", to: "done", reply_to: 3 })).toMatch(/move does not take "reply_to"/);
  });

  it("the notice a reply sends names the comment it answers, its author and its words", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-b" });
    r.take();
    const asked = say(r.board, c.code, LEAD, "which colour for the buttons?");
    r.take();
    tool(r.db, "dev-a", { action: "update", id: c.code, comment: "blue", reply_to: asked.id });
    const toLead = r.take().find((h) => h.to === "lead")!;
    const text = wakeMessage([toLead.wake], () => r.board.getCard(c.code));
    expect(text).toContain(`dev-a mentioned you in a comment: "blue" (replying to c${asked.id} (lead): "which colour for the buttons?")`);
    expect(text).toContain("task update, with a comment and reply_to");
  });
});

describe("11. the loop guard counts what was stored when a comment was written, not its words today", () => {
  /** Two agents `@` each other on a card nobody holds: each writes, then `evade` takes the comment's `@` away. */
  function ping(r: Rig, evade: (by: Actor, code: string, id: number) => void): { woken: string[][]; held: boolean[] } {
    const c = card(r.board, ANN);                          // no assignee: only the `@` can make a turn
    r.take();
    const out = { woken: [] as string[][], held: [] as boolean[] };
    for (let i = 0; i < AGENT_COMMENT_CHAIN + 3; i++) {
      const [by, to] = i % 2 === 0 ? [LEAD, "dev-b"] : [DEV_B, "lead"];
      const wrote = r.board.updateCard(by, c.code, { comment: `@${to} ping ${i}` });
      out.held.push(noteKeys(wrote).includes("comment_chain"));
      out.woken.push(woken(r.take()));
      evade(by, c.code, r.board.detail(c.code).comments.at(-1)!.id);
    }
    return out;
  }
  const turns = (o: ReturnType<typeof ping>) => o.held.map((h) => (h ? "held" : "woke"));
  const BASELINE = ["woke", "woke", "woke", "woke", "held", "held", "held"];

  it("without any evasion: four turns wake, then the guard holds (the control)", () => {
    expect(turns(ping(rig(), () => {}))).toEqual(BASELINE);
  });

  it("deleting each comment right after it is written does not take its turn out of the count", () => {
    const r = rig();
    const o = ping(r, (by, code, id) => { r.board.deleteComment(by, code, id); });
    expect(turns(o)).toEqual(BASELINE);
    expect(o.woken[4]).toEqual([]);                        // the fifth wakes nobody
  });

  it("editing the `@` out of each comment right after it is written does not either", () => {
    const r = rig();
    const o = ping(r, (by, code, id) => { r.board.editComment(by, code, id, "no one named here"); });
    expect(turns(o)).toEqual(BASELINE);
  });

  it("nor does an edit and then a deletion", () => {
    const r = rig();
    const o = ping(r, (by, code, id) => { r.board.editComment(by, code, id, "words"); r.board.deleteComment(by, code, id); });
    expect(turns(o)).toEqual(BASELINE);
  });

  it("a comment written without an `@` and edited to name one counts from the edit, and then keeps counting when the `@` goes again", () => {
    const r = rig();
    const c = card(r.board, ANN);
    r.take();
    // five comments, each edited to name the other and written by alternating agents: the fifth edit is the fifth turn
    const edits: boolean[] = [];
    for (let i = 0; i < AGENT_COMMENT_CHAIN + 1; i++) {
      const [by, to] = i % 2 === 0 ? [LEAD, "dev-b"] : [DEV_B, "lead"];
      r.board.updateCard(by, c.code, { comment: `plain ${i}` });
      const id = r.board.detail(c.code).comments.at(-1)!.id;
      const edited = r.board.editComment(by, c.code, id, `@${to} now ${i}`);
      edits.push(noteKeys(edited).includes("comment_chain"));
      r.board.editComment(by, c.code, id, "and the name is gone again");
      r.take();
    }
    expect(edits).toEqual([false, false, false, false, true]);
  });

  it("a row from before the names were stored is read from its words, as it always was — and an edit keeps what its words named", () => {
    const r = rig();
    const c = card(r.board, ANN);
    const uuid = r.board.getCard(c.code).uuid;
    const raw = (r.board as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db;
    const old = (author: string, text: string, secondsAgo: number) => raw.prepare("INSERT INTO task_entries (task_id, kind, author, author_kind, text, at) VALUES (?, 'comment', ?, 'instance', ?, ?)")
      .run(uuid, author, text, new Date(Date.now() - secondsAgo * 1000).toISOString());
    old("lead", "@dev-b look", 50); old("dev-b", "@lead done", 40); old("lead", "no name in these words", 35); old("lead", "@dev-b again", 30); old("dev-b", "@lead ok", 20);
    r.take();
    // four of the five name someone (the third does not): the next one is the fifth turn... counted as turns of a change of writer:
    // lead, dev-b, (skipped), lead, dev-b → four turns; the comment now written by lead is the fifth
    const now = r.board.updateCard(LEAD, c.code, { comment: "@dev-b once more" });
    expect(noteKeys(now)).toContain("comment_chain");
    // an edit of such a row (no `at` stored) keeps the `@` its old words named
    const id = r.board.detail(c.code).comments[3]!.id;      // lead's "@dev-b again"
    const before = r.board.detail(c.code).comments.map((e) => e.text);
    expect(before[3]).toBe("@dev-b again");
    r.board.editComment(LEAD, c.code, id, "the name is gone");
    const stored = JSON.parse(((r.board as unknown as { db: { prepare(s: string): { get(id: number): { notify: string } } } }).db.prepare("SELECT notify FROM task_entries WHERE id = ?").get(id)).notify) as { at: string[] };
    expect(stored.at).toEqual(["dev-b"]);
  });

  it("a row from before them whose words have no `@` is not a turn (nothing changes for old data)", () => {
    const r = rig();
    const c = card(r.board, ANN);
    const uuid = r.board.getCard(c.code).uuid;
    const raw = (r.board as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db;
    for (const [author, text] of [["lead", "a note"], ["dev-b", "another note"], ["lead", "more words"], ["dev-b", "still none"], ["lead", "nothing"]] as const) {
      raw.prepare("INSERT INTO task_entries (task_id, kind, author, author_kind, text, at) VALUES (?, 'comment', ?, 'instance', ?, ?)").run(uuid, author, text, new Date().toISOString());
    }
    r.take();
    expect(noteKeys(r.board.updateCard(LEAD, c.code, { comment: "@dev-b look" }))).not.toContain("comment_chain");
  });

  it("every comment stores what its words named: `at`, and with it `to` and whether the old assignee rule applies", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    r.board.updateCard(ANN, c.code, { comment: "@lead and @dev-b, not @ghost", to: ["dev-a"] });
    r.board.updateCard(ANN, c.code, { comment: "no names" });
    const raw = (r.board as unknown as { db: { prepare(s: string): { all(): Array<{ notify: string }> } } }).db;
    expect(raw.prepare("SELECT notify FROM task_entries ORDER BY id").all().map((x) => JSON.parse(x.notify))).toEqual([
      { to: ["dev-a"], assignee: false, at: ["lead", "dev-b"] },
      { to: [], assignee: true, at: [] },
    ]);
  });
});

describe("12. who wrote a comment: the writer's key, then the name", () => {
  const SESSION_A: Actor = { kind: "person", name: "web-user", key: "acct:a" };
  const SESSION_B: Actor = { kind: "person", name: "web-user", key: "acct:b" };

  it("two people who are both \"web-user\" are not each other: one cannot edit the other's comment, each edits their own", () => {
    const r = rig();
    const c = card(r.board, ANN);
    const byA = say(r.board, c.code, SESSION_A, "from a");
    const byB = say(r.board, c.code, SESSION_B, "from b");
    for (const [who, id] of [[SESSION_B, byA.id], [SESSION_A, byB.id]] as const) {
      expect(errorOf(() => r.board.editComment(who, c.code, id, "hijacked"))).toMatchObject({ code: "forbidden", key: "comment_not_yours" });
    }
    expect(r.board.editComment(SESSION_A, c.code, byA.id, "a, edited").entry.text).toBe("a, edited");
    expect(r.board.editComment(SESSION_B, c.code, byB.id, "b, edited").entry.text).toBe("b, edited");
    expect([...r.board.commentsWrittenBy(c.code, SESSION_A)]).toEqual([byA.id]);
    expect([...r.board.commentsWrittenBy(c.code, SESSION_B)]).toEqual([byB.id]);
  });

  it("the same key under another name is the same person (they renamed themselves); the kind must match too", () => {
    const r = rig();
    const c = card(r.board, ANN);
    const mine = say(r.board, c.code, SESSION_A, "mine");
    expect(r.board.editComment({ kind: "person", name: "Alex", key: "acct:a" }, c.code, mine.id, "still mine").entry.text).toBe("still mine");
    expect(errorOf(() => r.board.editComment({ kind: "script", name: "web-user", key: "acct:a" }, c.code, mine.id, "x"))).toMatchObject({ key: "comment_not_yours" });
  });

  it("without a key on either side the name decides, as it did: a comment written before keys, or an actor with none", () => {
    const r = rig();
    const c = card(r.board, ANN);
    const old = say(r.board, c.code, { kind: "person", name: "Ann" }, "no key kept");
    expect(r.board.editComment({ kind: "person", name: "Ann", key: "acct:ann" }, c.code, old.id, "edited").entry.text).toBe("edited");   // the comment has no key: the name decides
    expect(errorOf(() => r.board.editComment({ kind: "person", name: "Bob", key: "acct:bob" }, c.code, old.id, "x"))).toMatchObject({ key: "comment_not_yours" });
    const keyed = say(r.board, c.code, SESSION_A, "keyed");
    expect(r.board.editComment({ kind: "person", name: "web-user" }, c.code, keyed.id, "no key given").entry.text).toBe("no key given");   // the actor has no key: the name decides
  });

  it("the key is stored for a person's comment only, and is not in what a read returns", () => {
    const r = rig();
    const c = card(r.board, ANN, { assignee: "dev-a" });
    say(r.board, c.code, SESSION_A, "a person's");
    say(r.board, c.code, { ...DEV, key: "ignored" }, "an instance's");
    const raw = (r.board as unknown as { db: { prepare(s: string): { all(): Array<{ author_key: string | null }> } } }).db;
    expect(raw.prepare("SELECT author_key FROM task_entries ORDER BY id").all().map((x) => x.author_key)).toEqual(["acct:a", null]);
    expect(JSON.stringify(r.board.detail(c.code))).not.toContain("acct:a");
  });

  it("deleting stays a person's: another \"web-user\" may delete (an administrator), an instance only its own", () => {
    const r = rig();
    const c = card(r.board, ANN);
    const byA = say(r.board, c.code, SESSION_A, "from a");
    expect(() => r.board.deleteComment(SESSION_B, c.code, byA.id)).not.toThrow();
  });
});
