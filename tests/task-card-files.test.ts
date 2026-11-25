/**
 * Files on task cards: an agent puts what it made ON the card, under the comment it came with.
 *
 *  1. The store: a file is staged whole or in parts, checked (size, sha256, order), typed by its bytes, held for its writer only and
 *     dropped when nobody uses it.
 *  2. The board: the write that carries the comment links the files — update, move, attach — all or nothing; limits per card; the
 *     counts, the detail and the card text an agent reads; a card pruned takes its files with it; a table an older release ignores.
 *  3. The tool: the internal `upload` action, the `attach` action, the raw `attach` an out-of-date caller sends, and the note an
 *     agent gets when its words name a path on its machine.
 *  4. The agent's side: the files are read inside its working directory (no symlink, no escape) and staged in parts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchedulerDb } from "../src/scheduler/db.js";
import type { Actor } from "../src/scheduler/task-board.js";
import { PENDING_TTL_MS, TASK_FILE_LIMITS, TASK_FILE_PART_BYTES, TaskFileError, TaskFileStore } from "../src/scheduler/task-files.js";
import { ATTACH_FILES_MAX, attachHint, boardToolAction, pathHint, unsupportedFields } from "../src/task-board-tool.js";
import { releaseUploads, sendTaskWrite, stageAttachments, stageFile, wantsAttach, type TaskSend } from "../src/task-attach-client.js";
import { cardText } from "../src/scheduler/task-board-text.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const DEV: Actor = { kind: "instance", name: "dev-a" };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);

let dir: string, db: SchedulerDb;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agend-task-files-"));
  db = new SchedulerDb(join(dir, "scheduler.db"));
  db.board.createCards(ANN, { cards: [{ title: "Survivors", assignee: "dev-a" }] });   // M-1 (a main task with no sub tasks: moved by hand)
});
afterEach(() => { try { db.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

/** The agent's side's call to the fleet's tool, as the CLI or the daemon makes it. */
const sendAs = (instance: string): TaskSend => async (call) => {
  try { return { result: boardToolAction(db, instance, call) }; } catch (err) { return { error: (err as Error).message }; }
};
const stageAs = async (instance: string, name: string, bytes: Uint8Array): Promise<string> => {
  const got = await stageFile(name, bytes, sendAs(instance));
  if ("error" in got) throw new Error(got.error);
  return got.upload;
};
const filesDir = () => join(dir, "task-files");
const onDisk = (uuid: string) => { try { return readdirSync(join(filesDir(), uuid)); } catch { return []; } };
const rows = () => (db as unknown as { db: { prepare(s: string): { all(): Array<Record<string, unknown>> } } }).db.prepare("SELECT * FROM task_attachments ORDER BY at, rowid").all();

describe("1. the store", () => {
  it("a file in parts comes out whole: same bytes, sha256 checked, typed by what it is (a picture, text, HTML as an opaque document)", async () => {
    const big = Buffer.concat([PNG, randomBytes(TASK_FILE_PART_BYTES * 2 + 17)]);     // three parts
    const png = await stageAs("dev-a", "shot.png", big);
    const html = await stageAs("dev-a", "game.html", Buffer.from("<!doctype html><script>1</script>"));
    const md = await stageAs("dev-a", "design.md", Buffer.from("# Design\n\n- a\n- b\n"));
    const card = db.board.getCard("M-1");
    db.board.updateCard(DEV, "M-1", { comment: "here", attach: [png, html, md] });
    const files = db.board.attachments(card.uuid);
    expect(files.map((f) => [f.name, f.mime, f.kind, f.size])).toEqual([
      ["shot.png", "image/png", "photo", big.length],
      ["game.html", "application/octet-stream", "document", 33],     // markup is never typed as a page
      ["design.md", "text/plain; charset=utf-8", "document", 18],
    ]);
    expect(readFileSync(join(filesDir(), card.uuid, png)).equals(big)).toBe(true);
    expect(lstatSync(join(filesDir(), card.uuid, png)).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(filesDir(), card.uuid)).mode & 0o777).toBe(0o700);
    expect(files.every((f) => f.author === "dev-a" && f.authorKind === "instance")).toBe(true);
  });

  it("a part that does not add up is refused and the upload with it: wrong order, wrong size, wrong checksum, too large, empty", async () => {
    const store = db.board.files()!;
    const bytes = randomBytes(TASK_FILE_PART_BYTES + 100);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const part = (index: number, b: Buffer, over: Record<string, unknown> = {}, upload?: string) =>
      ({ name: "a.bin", data_b64: b.toString("base64"), part: { index, count: 2, bytes: bytes.length, sha256, ...(upload ? { upload } : {}), ...over } });
    const first = store.receive("dev-a", part(0, bytes.subarray(0, TASK_FILE_PART_BYTES)));
    expect(first.done).toBe(false);
    // Out of order (an upload nobody opened): refused, and the one in progress is gone with it.
    expect(() => store.receive("dev-a", part(1, bytes.subarray(TASK_FILE_PART_BYTES), {}, "f".repeat(32)))).toThrow(/out of order/);
    expect(() => store.receive("dev-a", part(1, bytes.subarray(TASK_FILE_PART_BYTES), {}, first.upload))).toThrow(/out of order/);
    const again = store.receive("dev-a", part(0, bytes.subarray(0, TASK_FILE_PART_BYTES)));
    expect(() => store.receive("dev-a", part(1, bytes.subarray(TASK_FILE_PART_BYTES), { sha256: "0".repeat(64) }, again.upload))).toThrow(/out of order|checksum/);
    const third = store.receive("dev-a", part(0, bytes.subarray(0, TASK_FILE_PART_BYTES)));
    expect(() => store.receive("dev-a", part(1, randomBytes(5), {}, third.upload))).toThrow(/add up|checksum/);
    const fourth = store.receive("dev-a", part(0, bytes.subarray(0, TASK_FILE_PART_BYTES)));
    expect(store.receive("dev-a", part(1, bytes.subarray(TASK_FILE_PART_BYTES), {}, fourth.upload))).toMatchObject({ done: true, size: bytes.length });
    expect(() => store.receive("dev-a", { name: "z", data_b64: "" })).toThrow(/empty/);
    expect(() => store.receive("dev-a", { name: "z", data_b64: "x".repeat(10), part: { index: 0, count: 3, bytes: TASK_FILE_LIMITS.fileBytes + 1, sha256 } })).toThrow(/at most 10 MiB/);
    expect(() => store.receive("dev-a", { name: "z" })).toThrow(TaskFileError);
    // Nothing half-written is left in staging.
    expect(readdirSync(join(filesDir(), "pending")).filter((f) => f.endsWith(".part"))).toEqual([]);
  });

  it("a staged file is its writer's, used once, and dropped after the wait", async () => {
    let now = 1_000_000;
    const store = new TaskFileStore(filesDir(), () => now);
    db.board.setFiles(store);
    const id = store.receive("dev-a", { name: "a.txt", data_b64: Buffer.from("hi").toString("base64") }).upload;
    expect(() => store.adopt("dev-b", [id])).toThrow(/no longer staged/);      // not its writer's
    expect(() => store.adopt("dev-a", [id, id])).toThrow(/twice/);
    expect(store.adopt("dev-a", [id]).map((f) => f.name)).toEqual(["a.txt"]);
    now += PENDING_TTL_MS + 1;
    expect(() => store.adopt("dev-a", [id])).toThrow(/no longer staged/);
    expect(existsSync(join(filesDir(), "pending", id))).toBe(false);
  });

  it("an instance holds at most a few staged files and one upload in parts at a time", async () => {
    const store = db.board.files()!;
    for (let i = 0; i < 20; i++) store.receive("dev-a", { name: `f${i}`, data_b64: Buffer.from("x").toString("base64") });
    expect(() => store.receive("dev-a", { name: "one-too-many", data_b64: Buffer.from("x").toString("base64") })).toThrow(/waiting for a comment/);
    expect(() => store.receive("dev-b", { name: "other", data_b64: Buffer.from("x").toString("base64") })).not.toThrow();
  });
});

describe("2. the board links them to the write's comment — all or nothing", () => {
  it("update: the comment, its files, and nothing else changes; no words leaves a line naming the files (an older release shows it as the comment it is)", async () => {
    const a = await stageAs("dev-a", "a.md", Buffer.from("# A"));
    const b = await stageAs("dev-a", "b.txt", Buffer.from("B"));
    const card = db.board.getCard("M-1");
    const { notes } = db.board.updateCard(DEV, "M-1", { attach: [a, b] });
    expect(notes).not.toContain("no change");
    const comments = db.board.entries(card.uuid, ["comment"]);
    expect(comments.map((e) => e.text)).toEqual(["📎 a.md, b.txt"]);
    expect(db.board.attachments(card.uuid).map((f) => f.entryId)).toEqual([comments[0]!.id, comments[0]!.id]);
    expect(db.board.getCard("M-1").version).toBe(card.version + 1);
    const withWords = await stageAs("dev-a", "c.csv", Buffer.from("x,y\n1,2\n"));
    db.board.updateCard(DEV, "M-1", { comment: "## Result\n\nit works", attach: [withWords] });
    const last = db.board.entries(card.uuid, ["comment"]).at(-1)!;
    expect(last.text).toBe("## Result\n\nit works");
    expect(db.board.attachments(card.uuid).at(-1)!).toMatchObject({ name: "c.csv", entryId: last.id });
  });

  it("move: the status, the result, the comment and the files are one write; a refused move leaves the files staged, nothing linked", async () => {
    const card = db.board.getCard("M-1");
    const f = await stageAs("dev-a", "index.html", Buffer.from("<h1>game</h1>"));
    expect(() => db.board.moveCard(DEV, "M-1", "open", { comment: "x", attach: [f] })).toThrow(/already open/);
    expect(rows()).toEqual([]);
    db.board.moveCard(DEV, "M-1", "claimed", {});
    const { card: moved } = db.board.moveCard(DEV, "M-1", "review", { result: "a game", comment: "Open `index.html`", attach: [f] });
    expect(moved.status).toBe("review");
    expect(moved.result).toBe("a game");
    expect(db.board.attachments(card.uuid).map((x) => x.name)).toEqual(["index.html"]);
    expect(onDisk(card.uuid)).toEqual([f]);
  });

  it("anyone who may comment may attach to the card (a file is a comment's), and a person's comment on it is unchanged", async () => {
    db.board.createCards(ANN, { cards: [{ title: "Not dev-b's", assignee: "dev-a" }] });   // M-2
    const f = await stageAs("dev-b", "note.txt", Buffer.from("n"));
    db.board.updateCard({ kind: "instance", name: "dev-b" }, "M-2", { attach: [f] });
    expect(db.board.attachments(db.board.getCard("M-2").uuid)[0]).toMatchObject({ author: "dev-b", authorKind: "instance" });
    expect(() => db.board.updateCard({ kind: "instance", name: "dev-b" }, "M-2", { title: "mine now" })).toThrow(/you can only comment/);
  });

  it("limits: 20 files and 50 MiB on a card; a file another instance staged, or one that expired, is refused with the reason", async () => {
    const card = db.board.getCard("M-1");
    for (let batch = 0; batch < 2; batch++) {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) ids.push(await stageAs("dev-a", `f${batch}-${i}.txt`, Buffer.from(`${batch}${i}`)));
      db.board.updateCard(DEV, "M-1", { comment: `batch ${batch}`, attach: ids });
    }
    expect(db.board.attachments(card.uuid)).toHaveLength(20);
    const one = await stageAs("dev-a", "21st.txt", Buffer.from("x"));
    expect(() => db.board.updateCard(DEV, "M-1", { attach: [one] })).toThrow(/at most 20 on a card/);
    expect(() => db.board.updateCard(DEV, "M-1", { attach: ["f".repeat(32)] })).toThrow(/no longer staged/);
    expect(() => db.board.updateCard({ kind: "instance", name: "dev-b" }, "M-1", { attach: [one] })).toThrow(/no longer staged/);
    // The bytes: a card at 49 MiB takes no more than 1 MiB.
    db.board.createCards(ANN, { cards: [{ title: "Heavy", assignee: "dev-a" }] });      // M-2
    const heavy = db.board.getCard("M-2");
    (db as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
      .prepare("INSERT INTO task_attachments (id, task_id, entry_id, name, mime, kind, size, sha256, author, author_kind, at) VALUES (?, ?, NULL, 'big', 'application/octet-stream', 'document', ?, 'x', 'dev-a', 'instance', ?)")
      .run("e".repeat(32), heavy.uuid, 49 * 1024 * 1024, new Date().toISOString());
    const two = await stageAs("dev-a", "two.bin", randomBytes(2 * 1024 * 1024));
    expect(() => db.board.updateCard(DEV, "M-2", { attach: [two] })).toThrow(/at most 50 MiB on a card/);
    db.board.updateCard(DEV, "M-2", { attach: [await stageAs("dev-a", "one.bin", randomBytes(1024 * 1024))] });
  });

  it("a write that fails after the files moved puts them back: no row, the file staged again", async () => {
    const f = await stageAs("dev-a", "a.md", Buffer.from("# A"));
    const card = db.board.getCard("M-1");
    const board = db.board as unknown as { settleWakes: () => unknown };
    const real = board.settleWakes;
    board.settleWakes = () => { throw new Error("boom"); };
    expect(() => db.board.updateCard(DEV, "M-1", { comment: "x", attach: [f] })).toThrow("boom");
    board.settleWakes = real;
    expect(rows()).toEqual([]);
    expect(onDisk(card.uuid)).toEqual([]);
    expect(existsSync(join(filesDir(), "pending", f))).toBe(true);
    db.board.updateCard(DEV, "M-1", { comment: "again", attach: [f] });          // and it is still the writer's to use
    expect(db.board.attachments(card.uuid)).toHaveLength(1);
  });

  it("a failure AFTER the commit moves nothing back: the rows are there for good, so the files stay where they say", async () => {
    const f = await stageAs("dev-a", "a.md", Buffer.from("# A"));
    const card = db.board.getCard("M-1");
    const board = db.board as unknown as { revision: () => number };
    const real = board.revision;
    board.revision = () => { throw new Error("late"); };           // read once the write has committed, to tell the listeners
    expect(() => db.board.updateCard(DEV, "M-1", { comment: "x", attach: [f] })).toThrow("late");
    board.revision = real;
    expect(rows()).toHaveLength(1);                                // committed
    expect(onDisk(card.uuid)).toEqual([f]);                        // …and its file is still under the card, not back in staging
    expect(existsSync(join(filesDir(), "pending", f))).toBe(false);
    expect(readFileSync(join(filesDir(), card.uuid, f), "utf8")).toBe("# A");
    expect(db.board.attachments(card.uuid).map((x) => x.name)).toEqual(["a.md"]);
  });

  it("the card as the dashboard and the agents read it: a count on the card, the files in the detail, the names in the card text", async () => {
    const f = await stageAs("dev-a", "design.md", Buffer.from("# D"));
    const card = db.board.getCard("M-1");
    expect(db.board.view(card).attachmentCount).toBe(0);
    db.board.updateCard(DEV, "M-1", { comment: "done", attach: [f] });
    expect(db.board.view(card).attachmentCount).toBe(1);
    const detail = db.board.detail("M-1");
    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0]).toMatchObject({ id: f, cardId: "M-1", name: "design.md", entryId: detail.comments[0]!.id });
    expect(JSON.stringify(detail)).not.toContain(dir);                        // a label and an id — never where it is kept
    expect(cardText(db.board, db.board.getCard("M-1"))).toContain("files on the card (1): design.md (3 B, dev-a)");
    // A scope that leaves an author out leaves their files out too — counted nowhere.
    expect(db.board.attachments(card.uuid, { leaveOutAuthors: ["dev-a"] })).toEqual([]);
    expect(db.board.view(card, { leaveOutAuthors: ["dev-a"] }).attachmentCount).toBe(0);
  });

  it("the comment's wake is the comment's: a file wakes nobody a comment would not", async () => {
    const f = await stageAs("dev-a", "a.md", Buffer.from("# A"));
    const seen: Array<{ wakes: unknown[] }> = [];
    db.board.onChange((c) => seen.push({ wakes: c.wakes }));
    db.board.updateCard(DEV, "M-1", { attach: [f] });      // by the assignee itself: nobody to wake
    expect(seen).toHaveLength(1);
    expect(seen[0]!.wakes).toEqual([]);
  });

  it("a card pruned takes its files with it, and a folder or staged file nobody holds is swept; rows from a release that pruned without them go too", async () => {
    const f = await stageAs("dev-a", "a.md", Buffer.from("# A"));
    const card = db.board.getCard("M-1");
    db.board.updateCard(DEV, "M-1", { comment: "x", attach: [f] });
    db.board.moveCard(DEV, "M-1", "claimed", {});
    db.board.moveCard(DEV, "M-1", "review", { result: "ok" });
    db.board.moveCard(ANN, "M-1", "done", {});
    const stray = "0".repeat(8) + "-0000-4000-8000-" + "0".repeat(12);
    mkdirSync(join(filesDir(), stray), { recursive: true });
    writeFileSync(join(filesDir(), stray, "f".repeat(32)), "orphan");
    writeFileSync(join(filesDir(), "pending", "c".repeat(32)), "stale staged file");
    (db as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 40 * 86_400_000).toISOString(), card.uuid);
    expect(await db.pruneOldTasks(30)).toBe(1);
    expect(rows()).toEqual([]);
    expect(existsSync(join(filesDir(), card.uuid))).toBe(false);
    expect(existsSync(join(filesDir(), stray))).toBe(false);
    expect(existsSync(join(filesDir(), "pending", "c".repeat(32)))).toBe(false);
  });

  it("additive: the table is new, the card's own columns are the same, and a bare board (no store) refuses a file in words, not a crash", () => {
    const tables = (db as unknown as { db: { prepare(s: string): { all(): Array<{ name: string }> } } }).db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    expect(tables).toContain("task_attachments");
    db.board.setFiles(null);
    expect(() => db.board.updateCard(DEV, "M-1", { attach: ["a".repeat(32)] })).toThrow(/not available here/);
  });
});

describe("3. the tool", () => {
  it("`upload` is internal: not an agent's action, and refused in words when a part is malformed; a raw `attach` of paths is refused with what to use", () => {
    expect(unsupportedFields({ action: "upload", name: "a", data_b64: "eA==" })).toBeNull();
    expect(unsupportedFields({ action: "update", id: "M-1", attach: ["./a.md"] })).toMatch(/update does not take "attach".*read on your side/);
    expect(unsupportedFields({ action: "update", id: "M-1", uploads: ["a".repeat(32)], comment: "x" })).toBeNull();
    expect(() => boardToolAction(db, "dev-a", { action: "upload", name: "a", data_b64: "eA==", part: { index: 9 } })).toThrow(/malformed/);
    expect(() => boardToolAction(db, "dev-a", { action: "attach", id: "M-1" })).toThrow(/name at least one file/);
  });

  it("`attach` through the tool: one write, the answer says what is on the card", async () => {
    const f = await stageAs("dev-a", "design.md", Buffer.from("# Design\n"));
    const answer = boardToolAction(db, "dev-a", { action: "attach", id: "M-1", uploads: [f], comment: "the design" });
    expect(answer).toMatch(/^ok M-1 /);
    expect(answer).toContain("attached to M-1: design.md (9 B)");
    const g = await stageAs("dev-a", "x.html", Buffer.from("<p>x</p>"));
    expect(boardToolAction(db, "dev-a", { action: "update", id: "M-1", log: "step", uploads: [g] })).toMatch(/^ok M-1/);
    expect(db.board.attachments(db.board.getCard("M-1").uuid)).toHaveLength(2);
  });

  it("a pile of parts is only a reminder: more than 3 files in one write, or an .html with .js / .css beside it, is noted — the write goes through; one finished file is not", async () => {
    const attach = async (names: string[], over: Record<string, unknown> = {}) => {
      const card = db.board.createCards(ANN, { cards: [{ title: `Card for ${names.join("+")}`, assignee: "dev-a" }] }).cards[0]!;   // a card each: 20 files at most
      const uploads = await Promise.all(names.map((n) => stageAs("dev-a", n, Buffer.from(`<!-- ${n} -->`))));
      const answer = boardToolAction(db, "dev-a", { action: "attach", id: card.code, uploads, comment: "done", ...over })!;
      expect(db.board.attachments(card.uuid).map((f) => f.name), "the write went through").toEqual(names);
      return answer;
    };
    expect(ATTACH_FILES_MAX).toBe(3);
    expect(await attach(["survivor.html"]), "one finished file").not.toMatch(/note:/);
    expect(await attach(["design.md", "survivor.html", "screenshot.png"]), "three files, no parts").not.toMatch(/note:/);
    const four = await attach(["a.md", "b.md", "c.md", "d.md"]);
    expect(four).toMatch(/\nnote: 4 files attached\. Attach only the finished thing the person will open: usually one file, at most 3, never source, modules, config, logs or drafts\./);
    expect(four).toMatch(/ONE \.html with its CSS and JS inline/);
    expect(four).not.toMatch(/beside its/);
    for (const parts of [["index.html", "game.js"], ["index.html", "style.css"], ["INDEX.HTM", "main.mjs", "a.md"], ["game.html", "game.js", "style.css"]]) {
      const answer = await attach(parts);
      expect(answer, parts.join("+")).toMatch(new RegExp(`\\nnote: ${parts.length} files attached \\(an \\.html beside its \\.js / \\.css\\)\\.`));
    }
    // A script or a stylesheet alone, or two other files beside a page, are not a pile of parts.
    expect(await attach(["tool.js"])).not.toMatch(/note:/);
    expect(await attach(["index.html", "design.md"])).not.toMatch(/note:/);
    expect(await attach(["index.html", "data.json"])).not.toMatch(/note:/);
    // Through update and move too (the same `uploads`); a write the board refuses says nothing of it (it threw).
    const second = db.board.createCards(ANN, { cards: [{ title: "Second", assignee: "dev-a" }] }).cards[0]!;
    const upd = boardToolAction(db, "dev-a", { action: "update", id: second.code, log: "step", uploads: await Promise.all(["x.html", "x.js"].map((n) => stageAs("dev-a", n, Buffer.from("x")))) })!;
    expect(upd).toMatch(/note: 2 files attached \(an \.html beside its \.js \/ \.css\)/);
    expect(attachHint([])).toBeNull();
    expect(() => boardToolAction(db, "dev-a", { action: "attach", id: second.code, uploads: ["f".repeat(32)] })).toThrow(/no longer staged/);
    // A path in the words beside files is not noted (the files came with it): only the reminder about the files is.
    const both = await attach(["index.html", "app.js"], { comment: "see /data/workspaces/dev/index.html" });
    expect(both.split("\n").filter((l) => l.startsWith("note:")).map((l) => l.slice(0, 40))).toEqual(["note: 2 files attached (an .html beside "]);
  });

  it("a path on the agent's machine in words the person reads: the answer says they cannot open it and how to attach; code, URLs and `context` are left alone", () => {
    const note = (args: Record<string, unknown>) => pathHint(args);
    expect(note({ action: "move", comment: "設計文件路徑：/data/workspaces/planner/survivor-design.md（含 MVP）" })).toMatch(/names a path on your machine \(\/data\/workspaces\/planner\/survivor-design\.md\)/);
    expect(note({ action: "update", result: "see ~/work/out/index.html" })).toMatch(/your result names a path/);
    expect(note({ action: "update", state: "built at C:\\Users\\me\\game\\index.html" })).toMatch(/your state names a path/);
    expect(note({ action: "update", log: "wrote /home/dev/out.txt" })).toMatch(/agend-agent task attach M-n <file>/);
    // macOS's home directory is a home like /home: named too.
    expect(note({ action: "update", comment: "the doc is /Users/x/doc.md" })).toMatch(/your comment names a path on your machine \(\/Users\/x\/doc\.md\)/);
    expect(note({ action: "update", result: "設計文件：/Users/me/work/design.md（含 MVP）" })).toMatch(/your result names a path on your machine \(\/Users\/me\/work\/design\.md\)/);
    expect(note({ action: "update", comment: "the doc is `/Users/x/doc.md`" }), "in code: deliberate").toBeNull();
    expect(note({ action: "update", comment: "https://example.com/Users/x" }), "inside a URL").toBeNull();
    expect(note({ action: "update", comment: "Users/x or the /Users folder" }), "no file below /Users").toBeNull();
    for (const plain of ["/usr/bin", "/tmp/x", "run /usr/bin and /tmp/x"]) expect(note({ action: "update", comment: plain }), plain).toBeNull();
    expect(note({ action: "update", result: "see /data/workspaces/dev/index.html" })).toMatch(/your result names a path/);
    // Only where an agent's own files live. `/tmp`, `/usr`, `/etc`… in a sentence are ordinary prose, not a file it meant the person to open.
    for (const prose of ["wrote /tmp/out.txt", "the binary is /usr/bin/node", "see /etc/hosts and /var/log/x", "in /opt/app/run", "under /mnt/c/work", "at /root/x and /srv/www/y", "the /app/dist build", "/workspace/foo"]) {
      expect(note({ action: "update", comment: prose }), prose).toBeNull();
    }
    expect(note({ action: "update", comment: "Run `/usr/bin/foo --help` first" })).toBeNull();
    expect(note({ action: "update", comment: "```sh\ncat /data/x/y.md\n```" })).toBeNull();
    expect(note({ action: "update", comment: "open /ui/fleet?card=M-1 and https://example.com/data/x" })).toBeNull();
    expect(note({ action: "update", context: "paths: /data/workspaces/planner/a.md" })).toBeNull();
    expect(note({ action: "update", comment: "/data/workspaces/planner/a.md", uploads: ["a".repeat(32)] })).toBeNull();
    expect(note({ action: "update", comment: "all fine" })).toBeNull();
    // Through the tool: appended to the write's answer, the write itself unchanged.
    const answer = boardToolAction(db, "dev-a", { action: "update", id: "M-1", comment: "doc: /data/workspaces/planner/a.md" })!;
    expect(answer.split("\n")[0]).toMatch(/^ok M-1/);
    expect(answer).toMatch(/\nnote: your comment names a path on your machine/);
    expect(db.board.entries(db.board.getCard("M-1").uuid, ["comment"]).map((e) => e.text)).toEqual(["doc: /data/workspaces/planner/a.md"]);
  });
});

describe("4. the agent's side reads inside its own working directory and stages in parts", () => {
  let work: string, calls: Array<Record<string, unknown>>;
  const ctx = () => ({ workspace: work, stateDir: join(dir, "state"), instance: "dev-a" });
  const record = (inner: TaskSend): TaskSend => async (call) => { calls.push(call); return inner(call); };
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), "agend-task-files-work-")); calls = []; });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  it("`attach` becomes `uploads`: a small file is one call, a large one is parts, and the write that follows carries the ids", async () => {
    writeFileSync(join(work, "small.md"), "# small");
    const large = randomBytes(TASK_FILE_PART_BYTES * 2 + 1);
    writeFileSync(join(work, "large.bin"), large);
    const out = await stageAttachments({ action: "update", id: "M-1", comment: "c", attach: ["small.md", join(work, "large.bin")] }, ctx(), record(sendAs("dev-a")));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.args).toMatchObject({ action: "update", id: "M-1", comment: "c" });
    expect(out.args.attach).toBeUndefined();
    expect(out.args.uploads).toHaveLength(2);
    expect(calls.filter((c) => c.action === "upload")).toHaveLength(1 + 3);
    expect(calls.every((c) => typeof (c.data_b64 as string) === "string" && Buffer.from(c.data_b64 as string, "base64").length <= TASK_FILE_PART_BYTES)).toBe(true);
    db.board.updateCard(DEV, "M-1", { comment: "c", attach: out.args.uploads as string[] });
    expect(db.board.attachments(db.board.getCard("M-1").uuid).map((f) => [f.name, f.size])).toEqual([["small.md", 7], ["large.bin", large.length]]);
  });

  it("a path outside the working directory, a symlink, a folder, an empty file, a missing one, a file over the limit: refused before anything is staged", async () => {
    mkdirSync(join(work, "sub"));
    writeFileSync(join(work, "ok.md"), "ok");
    writeFileSync(join(work, "empty.md"), "");
    writeFileSync(join(dir, "outside.md"), "secret");
    symlinkSync(join(dir, "outside.md"), join(work, "link.md"));
    writeFileSync(join(work, "huge.bin"), Buffer.alloc(TASK_FILE_LIMITS.fileBytes + 1));
    for (const [path, why] of [[join(dir, "outside.md"), /outside your working directory/], ["link.md", /symlink/], ["sub", /not a regular file/], ["empty.md", /empty/], ["nope.md", /cannot be read/], ["huge.bin", /over the size limit/]] as const) {
      calls = [];
      const out = await stageAttachments({ action: "update", id: "M-1", attach: ["ok.md", path] }, ctx(), record(sendAs("dev-a")));
      expect(out.ok, path).toBe(false);
      expect(out.ok ? "" : out.error, path).toMatch(why);
      expect(calls, `${path}: nothing staged, the good file included`).toEqual([]);
    }
  });

  it("it only touches the calls that name files; `attach` with nothing in it is an error for the action and a no-op for the others; a failing fleet says why", async () => {
    expect(wantsAttach({ action: "update", attach: ["a"] })).toBe(true);
    expect(wantsAttach({ action: "done", attach: ["a"] })).toBe(false);
    expect(wantsAttach({ action: "update", comment: "x" })).toBe(false);
    expect(await stageAttachments({ action: "attach", id: "M-1", attach: [] }, ctx(), sendAs("dev-a"))).toEqual({ ok: false, error: "attach: name at least one file" });
    expect(await stageAttachments({ action: "update", id: "M-1", comment: "c", attach: [] }, ctx(), sendAs("dev-a"))).toEqual({ ok: true, args: { action: "update", id: "M-1", comment: "c" } });
    expect(await stageAttachments({ action: "update", attach: [1] } as never, ctx(), sendAs("dev-a"))).toMatchObject({ ok: false });
    writeFileSync(join(work, "a.md"), "a");
    const refusing: TaskSend = async () => ({ error: "the fleet is full" });
    expect(await stageAttachments({ action: "update", id: "M-1", attach: ["a.md"] }, ctx(), refusing)).toEqual({ ok: false, error: "attach: a.md — the fleet is full" });
  });
});

describe("5. a refused write gives its staged files back — tried again and again, it never fills the room", () => {
  let work: string;
  const ctx = () => ({ workspace: work, stateDir: join(dir, "state"), instance: "dev-a" });
  const staged = () => (db.board.files() as unknown as { staged: Map<string, unknown> }).staged.size;
  const pending = () => { try { return readdirSync(join(filesDir(), "pending")).length; } catch { return 0; } };
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), "agend-task-files-work-")); for (let i = 0; i < 10; i++) writeFileSync(join(work, `f${i}.txt`), `file ${i}`); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });
  const files = (n: number) => Array.from({ length: n }, (_, i) => `f${i}.txt`);

  it("a write the card refuses (at its 20 files) five times in a row leaves nothing staged, and the next good write still goes through", async () => {
    for (let batch = 0; batch < 2; batch++) {
      const sent = await sendTaskWrite({ action: "update", id: "M-1", comment: `batch ${batch}`, attach: files(10) }, ctx(), sendAs("dev-a"));
      expect(sent.staging, "fills the card").toBe(false);
    }
    expect(db.board.attachments(db.board.getCard("M-1").uuid)).toHaveLength(20);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const sent = await sendTaskWrite({ action: "update", id: "M-1", comment: "one more", attach: files(10) }, ctx(), sendAs("dev-a"));
      expect(sent.staging).toBe(false);
      expect(!sent.staging && sent.answer.error, `attempt ${attempt}`).toMatch(/at most 20 on a card/);
      expect([attempt, staged(), pending()], "given back at once").toEqual([attempt, 0, 0]);
    }
    db.board.createCards(ANN, { cards: [{ title: "Next", assignee: "dev-a" }] });   // M-2
    const ok = await sendTaskWrite({ action: "update", id: "M-2", comment: "fine", attach: files(10) }, ctx(), sendAs("dev-a"));
    expect(!ok.staging && ok.answer.error).toBeUndefined();
    expect(db.board.attachments(db.board.getCard("M-2").uuid)).toHaveLength(10);
  });

  it("without the release the room does fill — the control: the same refusals, files left staged, stop the third try", async () => {
    const fleet = sendAs("dev-a");
    const noRelease: TaskSend = async (call) => (call.action === "release" ? { result: JSON.stringify({ released: 0 }) } : fleet(call));
    for (let batch = 0; batch < 2; batch++) await sendTaskWrite({ action: "update", id: "M-1", comment: `batch ${batch}`, attach: files(10) }, ctx(), noRelease);
    await sendTaskWrite({ action: "update", id: "M-1", comment: "refused", attach: files(10) }, ctx(), noRelease);
    await sendTaskWrite({ action: "update", id: "M-1", comment: "refused", attach: files(10) }, ctx(), noRelease);
    const third = await sendTaskWrite({ action: "update", id: "M-1", comment: "refused", attach: files(5) }, ctx(), noRelease);
    expect(third.staging && third.error, "the room is full").toMatch(/waiting for a comment already/);
  });

  it("a stale `version` and a refused move give them back too; one staged for a write that went through is not released", async () => {
    const card = db.board.getCard("M-1");
    const stale = await sendTaskWrite({ action: "update", id: "M-1", comment: "x", version: card.version + 5, attach: files(3) }, ctx(), sendAs("dev-a"));
    expect(!stale.staging && stale.answer.error).toBeTruthy();
    expect(staged()).toBe(0);
    const good = await sendTaskWrite({ action: "update", id: "M-1", comment: "y", attach: files(2) }, ctx(), sendAs("dev-a"));
    expect(!good.staging && good.answer.error).toBeUndefined();
    expect(staged()).toBe(0);                                         // used, not staged any more
    expect(db.board.attachments(card.uuid)).toHaveLength(2);
  });

  it("a failure half-way through staging gives back the files already staged", async () => {
    const fleet = sendAs("dev-a");
    let uploads = 0;
    const failing: TaskSend = async (call) => (call.action === "upload" && ++uploads === 3 ? { error: "the fleet is full" } : fleet(call));
    const out = await stageAttachments({ action: "update", id: "M-1", attach: files(4) }, ctx(), failing);
    expect(out.ok).toBe(false);
    expect(staged()).toBe(0);
    expect(pending()).toBe(0);
  });

  it("`release` is the writer's own: another instance's, an unknown id and a file already on a card are left alone", async () => {
    const store = db.board.files()!;
    const mine = await stageAs("dev-a", "a.md", Buffer.from("a")), other = await stageAs("dev-b", "b.md", Buffer.from("b"));
    const used = await stageAs("dev-a", "c.md", Buffer.from("c"));
    db.board.updateCard(DEV, "M-1", { comment: "c", attach: [used] });
    expect(store.release("dev-a", [mine, other, used, "f".repeat(32), "not-an-id"])).toBe(1);
    expect(staged()).toBe(1);                                          // dev-b's
    expect(existsSync(join(filesDir(), "pending", other))).toBe(true);
    expect(existsSync(join(filesDir(), "pending", mine))).toBe(false);
    expect(db.board.attachments(db.board.getCard("M-1").uuid).map((f) => f.id)).toEqual([used]);
    // Through the tool, the internal action the agent's side uses; a bare board answers none released.
    expect(JSON.parse(boardToolAction(db, "dev-b", { action: "release", uploads: [other] })!)).toEqual({ released: 1 });
    expect(unsupportedFields({ action: "release", uploads: ["a".repeat(32)] })).toBeNull();
    expect(unsupportedFields({ action: "release", id: "M-1" })).toMatch(/release does not take "id"/);
    db.board.setFiles(null);
    expect(JSON.parse(boardToolAction(db, "dev-a", { action: "release", uploads: [mine] })!)).toEqual({ released: 0 });
    await releaseUploads([], async () => { throw new Error("never called"); });
  });
});
