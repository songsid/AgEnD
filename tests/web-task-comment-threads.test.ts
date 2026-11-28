/**
 * The comment threads' web routes (docs/design/task-board.md, "Comment threads") through the real web handler:
 *
 *   1. An admin session writes a comment with its recipient and the comment it answers, then edits, reacts, resolves and
 *      deletes through POST /ui/tasks/cards/<id>/comments/<n>/<verb>; the card read carries each.
 *   2. Who may: a read-only session changes nothing (403) — local or over the link; an edit is its author's; a delete is the
 *      author's or a person's; a refusal carries the board's code and key.
 *   3. What is refused: unknown fields, too many recipients, a reaction that is not one emoji (markup), a bad number.
 *   4. The public link: a hidden instance's comments, its reactions and who resolved or deleted, and a reply to its comment, are
 *      not shown to a read-only session (an admin session sees the board whole).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
import { handleWebRequest } from "../src/web-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { SchedulerDb } from "../src/scheduler/db.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

const TOKEN = "c".repeat(48);
const ANN = { kind: "person" as const, name: "Ann" };
const WEB = { kind: "person" as const, name: "web-user" };          // who an admin session is when no names are kept
const DEV = { kind: "instance" as const, name: "dev-a" };
const SPY = { kind: "instance" as const, name: "spy" };
const FLEET = { defaults: {}, instances: { "dev-a": {}, lead: {}, spy: { cross_instance_visibility: "hidden" } } };

const dirs: Array<{ dir: string; db: SchedulerDb }> = [];
afterEach(() => { for (const h of dirs.splice(0)) { try { h.db.close(); } catch { /* closed */ } rmSync(h.dir, { recursive: true, force: true }); } });
function scratchDb(): SchedulerDb {
  const dir = mkdtempSync(join(tmpdir(), "agend-task-threads-web-"));
  const db = new SchedulerDb(join(dir, "scheduler.db"));
  db.board.setCommentRouting({ instances: () => ["dev-a", "lead", "spy"], enabled: () => true });
  dirs.push({ dir, db });
  return db;
}

/** One request as an admin or read-only session, on the local page or over the temporary public link. */
function call(db: SchedulerDb, method: string, path: string, body?: unknown, opts: { local?: boolean; tier?: "admin" | "read"; owner?: string } = {}) {
  const sessions = new WebSessionStore(), exposureId = "a".repeat(32), pub = "https://sample.trycloudflare.com", local = "http://127.0.0.1:19280";
  const s = sessions.create({ tier: opts.tier ?? "admin", surface: opts.local ? "local" : "gateway", exposureId: opts.local ? undefined : exposureId, label: "t", tokenEpoch: tokenEpoch(TOKEN),
    ...(opts.owner ? { owner: { adapterId: "owner", userId: opts.owner } } : {}) } as never);
  const origin = opts.local ? local : pub;
  const headers: Record<string, string> = { host: new URL(origin).host, cookie: `${opts.local ? "" : "__Host-"}agend_session=${s.sessionId}`, origin, "sec-fetch-site": "same-origin",
    "x-agend-csrf": csrfTokenFor(s.sessionId), "content-type": "application/json" };
  return new Promise<{ status: number; body: any }>((resolve) => {
    const req = Object.assign(new EventEmitter(), { method, url: path, headers, destroy: vi.fn() });
    if (!opts.local) bindGatewayRequest(req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
    let status = 0;
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { status = c; },
      end: (t = "") => resolve({ status, body: t ? JSON.parse(String(t)) : null }) });
    // People kept (`owner`): each signed-in account is someone, whatever its name — two that set none are both "web-user".
    const webPerson = (owner?: { userId: string }) => ({ key: `acct:${owner?.userId ?? "operator"}`, bound: !!owner, userId: owner?.userId ?? "web-user", voterKey: `owner:${owner?.userId}`, name: "web-user", set: false });
    handleWebRequest(req as never, res as never, new URL(path, origin), { webToken: TOKEN, webSessions: sessions, scheduler: { db },
      fleetConfig: FLEET, logger: { debug() {}, info() {}, warn() {}, error() {} }, ...(opts.owner ? { webPerson } : {}),
      getUiStatus: () => ({ instances: [] }), listWebPrompts: () => [], needsYouItems: () => [] } as never);
    if (body !== undefined) { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); } else { req.emit("end"); }
  });
}
const local = { local: true as const };
const seed = (db: SchedulerDb) => {
  db.board.createProject(ANN, { name: "Game" });
  return db.board.createCards(ANN, { project: "Game", cards: [{ title: "Ship it", assignee: "dev-a" }] }).cards[0]!;
};
const comments = (db: SchedulerDb, code = "M-1") => db.board.detail(code).comments;

describe("1. an admin session works a card's comments", () => {
  it("writes with a recipient and a reply, edits, reacts, resolves and deletes; the card read carries each", async () => {
    const db = scratchDb();
    const c = seed(db);
    const first = await call(db, "POST", `/ui/tasks/cards/${c.code}`, { comment: "what do you think?", to: ["lead"] }, local);
    expect(first.status).toBe(200);
    const root = comments(db)[0]!;
    expect((await call(db, "POST", `/ui/tasks/cards/${c.code}`, { comment: "I agree", replyTo: root.id, to: [] }, local)).status).toBe(200);
    const reply = comments(db)[1]!;
    expect(reply).toMatchObject({ parentId: root.id, author: "web-user" });
    const base = `/ui/tasks/cards/${c.code}/comments`;
    const edited = await call(db, "POST", `${base}/${reply.id}/edit`, { text: "I agree, ship it" }, local);
    expect(edited.status).toBe(200);
    expect(edited.body.comment).toMatchObject({ id: reply.id, text: "I agree, ship it" });
    expect(edited.body.comment.editedAt).toBeTruthy();
    const reacted = await call(db, "POST", `${base}/${root.id}/react`, { emoji: "👍" }, local);
    expect(reacted.body.comment.reactions).toEqual([{ emoji: "👍", by: [{ name: "web-user", kind: "person" }] }]);
    expect((await call(db, "POST", `${base}/${root.id}/react`, { emoji: "👍", on: false }, local)).body.comment.reactions).toBeUndefined();
    expect((await call(db, "POST", `${base}/${root.id}/resolve`, { resolved: true }, local)).body.comment.resolved).toMatchObject({ by: "web-user" });
    expect((await call(db, "POST", `${base}/${root.id}/resolve`, { resolved: false }, local)).body.comment.resolved).toBeUndefined();
    const read = (await call(db, "GET", `/ui/tasks/cards/${c.code}`, undefined, local)).body;
    expect(read.comments.map((e: any) => [e.id, e.parentId, !!e.editedAt])).toEqual([[root.id, undefined, false], [reply.id, root.id, true]]);
    const gone = await call(db, "POST", `${base}/${reply.id}/delete`, {}, local);
    expect(gone.body.comment).toMatchObject({ text: "", deleted: { by: "web-user" } });
    expect((await call(db, "GET", `/ui/tasks/cards/${c.code}`, undefined, local)).body.comments[1]).toMatchObject({ text: "", deleted: { by: "web-user" }, parentId: root.id });
    expect((await call(db, "GET", `/ui/tasks/board`, undefined, local)).body.cards[0].commentCount).toBe(1);
  });

  it("the card read says who the viewer writes as (an admin session's person), and nothing to a read-only session", async () => {
    const db = scratchDb();
    const c = seed(db);
    expect((await call(db, "GET", `/ui/tasks/cards/${c.code}`, undefined, local)).body.viewer).toEqual({ name: "web-user", kind: "person" });
    expect((await call(db, "GET", `/ui/tasks/cards/${c.code}`)).body.viewer).toEqual({ name: "web-user", kind: "person" });      // an admin session over the link
    expect((await call(db, "GET", `/ui/tasks/cards/${c.code}`, undefined, { tier: "read" })).body.viewer).toBeUndefined();
    expect((await call(db, "GET", `/ui/tasks/cards/${c.code}`, undefined, { tier: "read", local: true })).body.viewer).toBeUndefined();
  });

  it("each comment says whether it is the viewer's; two accounts that are both \"web-user\" are told apart by their key, not their name", async () => {
    const db = scratchDb();
    const c = seed(db);
    // A comment written through the page by account A, one by account B (both named web-user), one by an instance.
    const post = (owner: string, comment: string) => call(db, "POST", `/ui/tasks/cards/${c.code}`, { comment, to: [] }, { ...local, owner });
    expect((await post("a", "from a")).status).toBe(200);
    expect((await post("b", "from b")).status).toBe(200);
    db.board.updateCard(DEV, c.code, { comment: "from dev" });
    const ids = comments(db).map((e) => e.id);
    const read = async (owner: string) => (await call(db, "GET", `/ui/tasks/cards/${c.code}`, undefined, { ...local, owner })).body;
    expect((await read("a")).comments.map((e: any) => e.mine)).toEqual([true, false, false]);
    expect((await read("b")).comments.map((e: any) => e.mine)).toEqual([false, true, false]);
    // …and the board holds them to it: B cannot edit A's comment although the names are the same; A can edit their own.
    const edit = (owner: string, id: number, text: string) => call(db, "POST", `/ui/tasks/cards/${c.code}/comments/${id}/edit`, { text }, { ...local, owner });
    const refused = await edit("b", ids[0]!, "hijacked");
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "forbidden", key: "comment_not_yours" });
    expect((await edit("a", ids[0]!, "from a, edited")).status).toBe(200);
    expect(comments(db).map((e) => e.text)).toEqual(["from a, edited", "from b", "from dev"]);
    // The key itself is the board's: no read returns it.
    expect(JSON.stringify((await read("a")))).not.toContain("acct:a");
  });

  it("each reaction says whether it is the viewer's, by the key: two accounts named alike each press and take back their own", async () => {
    const db = scratchDb();
    const c = seed(db);
    db.board.updateCard(DEV, c.code, { comment: "shipped" });
    const id = comments(db)[0]!.id;
    const react = (owner: string, on: boolean) => call(db, "POST", `/ui/tasks/cards/${c.code}/comments/${id}/react`, { emoji: "👍", on }, { ...local, owner });
    const read = async (owner: string) => (await call(db, "GET", `/ui/tasks/cards/${c.code}`, undefined, { ...local, owner })).body.comments[0].reactions;
    expect((await react("a", true)).status).toBe(200);
    expect((await react("b", true)).status).toBe(200);
    expect(await read("a")).toEqual([{ emoji: "👍", by: [{ name: "web-user", kind: "person" }, { name: "web-user", kind: "person" }], mine: true }]);
    expect(await read("b")).toEqual([{ emoji: "👍", by: [{ name: "web-user", kind: "person" }, { name: "web-user", kind: "person" }], mine: true }]);
    expect((await react("b", false)).status).toBe(200);                 // b takes theirs back: a's stays, and is still a's
    expect(await read("a")).toEqual([{ emoji: "👍", by: [{ name: "web-user", kind: "person" }], mine: true }]);
    expect(await read("b")).toEqual([{ emoji: "👍", by: [{ name: "web-user", kind: "person" }], mine: false }]);
    expect(JSON.stringify(await read("a")), "no key in a read").not.toContain("acct:");
  });

  it("with no people kept (every session is the operator) the viewer's comments are every web-user comment, as before", async () => {
    const db = scratchDb();
    const c = seed(db);
    db.board.updateCard(WEB, c.code, { comment: "from a page" });
    db.board.updateCard(DEV, c.code, { comment: "from dev" });
    expect((await call(db, "GET", `/ui/tasks/cards/${c.code}`, undefined, local)).body.comments.map((e: any) => e.mine)).toEqual([true, false]);
    expect((await call(db, "GET", `/ui/tasks/cards/${c.code}`, undefined, { tier: "read", local: true })).body.comments.map((e: any) => e.mine)).toEqual([undefined, undefined]);
  });

  it("is on the public link's manifest for an admin session, and nowhere a read-only one writes", () => {
    for (const verb of ["edit", "react", "resolve", "delete"]) expect(isPublicWebRoute("POST", `/ui/tasks/cards/M-3/comments/12/${verb}`), verb).toBe(true);
    expect(isPublicWebRoute("GET", "/ui/tasks/cards/M-3/comments/12/edit")).toBe(false);
  });
});

describe("2. who may", () => {
  it("a read-only session changes nothing, on the local page or over the link", async () => {
    const db = scratchDb();
    const c = seed(db);
    const e = (db.board.updateCard(WEB, c.code, { comment: "mine" }), comments(db)[0]!);
    for (const opts of [{ tier: "read" as const, local: true as const }, { tier: "read" as const }]) {
      for (const [verb, body] of [["edit", { text: "x" }], ["react", { emoji: "👍" }], ["resolve", {}], ["delete", {}]] as const) {
        const r = await call(db, "POST", `/ui/tasks/cards/${c.code}/comments/${e.id}/${verb}`, body, opts);
        expect([verb, !!opts.local, r.status]).toEqual([verb, !!opts.local, 403]);
      }
      expect((await call(db, "POST", `/ui/tasks/cards/${c.code}`, { comment: "no", to: [] }, opts)).status).toBe(403);
    }
    expect(comments(db).map((x) => [x.text, x.deleted, x.reactions, x.resolved])).toEqual([["mine", undefined, undefined, undefined]]);
  });

  it("an edit is its author's: a person cannot edit an instance's comment, or another person's", async () => {
    const db = scratchDb();
    const c = seed(db);
    db.board.updateCard(DEV, c.code, { comment: "from dev" });
    db.board.updateCard(ANN, c.code, { comment: "from Ann" });
    for (const e of comments(db)) {
      const r = await call(db, "POST", `/ui/tasks/cards/${c.code}/comments/${e.id}/edit`, { text: "rewritten" }, local);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: "forbidden", key: "comment_not_yours" });
    }
    expect(comments(db).map((e) => e.text)).toEqual(["from dev", "from Ann"]);
  });

  it("a delete is the author's or a person's: an admin session deletes an instance's comment", async () => {
    const db = scratchDb();
    const c = seed(db);
    db.board.updateCard(DEV, c.code, { comment: "from dev" });
    const e = comments(db)[0]!;
    const r = await call(db, "POST", `/ui/tasks/cards/${c.code}/comments/${e.id}/delete`, {}, local);
    expect(r.status).toBe(200);
    expect(comments(db)[0]).toMatchObject({ text: "", deleted: { by: "web-user" } });
  });

  it("a reaction is anyone's; resolving is only a thread's first comment (409-free 400 with the key)", async () => {
    const db = scratchDb();
    const c = seed(db);
    db.board.updateCard(DEV, c.code, { comment: "root" });
    const root = comments(db)[0]!;
    db.board.updateCard(DEV, c.code, { comment: "reply", replyTo: root.id });
    const reply = comments(db)[1]!;
    expect((await call(db, "POST", `/ui/tasks/cards/${c.code}/comments/${root.id}/react`, { emoji: "🎉" }, local)).status).toBe(200);
    const r = await call(db, "POST", `/ui/tasks/cards/${c.code}/comments/${reply.id}/resolve`, {}, local);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "invalid", key: "resolve_root_only" });
  });
});

describe("3. what is refused", () => {
  it("unknown fields, too many recipients, a bad number, another card's comment, a card that is not there", async () => {
    const db = scratchDb();
    const c = seed(db);
    const other = db.board.createCards(ANN, { cards: [{ title: "Other", assignee: "dev-a" }] }).cards[0]!;
    db.board.updateCard(WEB, other.code, { comment: "elsewhere" });
    const e = (db.board.updateCard(WEB, c.code, { comment: "mine" }), comments(db)[0]!);
    const foreign = comments(db, other.code)[0]!;
    const base = `/ui/tasks/cards/${c.code}/comments`;
    expect((await call(db, "POST", `${base}/${e.id}/edit`, { text: "x", extra: 1 }, local)).status).toBe(400);
    expect((await call(db, "POST", `${base}/${e.id}/delete`, { force: true }, local)).status).toBe(400);
    expect((await call(db, "POST", `/ui/tasks/cards/${c.code}`, { comment: "x", to: ["a", "b", "c", "d", "e", "f"] }, local)).status).toBe(400);
    expect((await call(db, "POST", `/ui/tasks/cards/${c.code}`, { comment: "x", replyTo: 0 }, local)).status).toBe(400);
    expect((await call(db, "POST", `${base}/${foreign.id}/edit`, { text: "x" }, local)).status).toBe(404);
    expect((await call(db, "POST", `${base}/9999/edit`, { text: "x" }, local)).body).toMatchObject({ code: "not_found", key: "comment_not_found" });
    expect((await call(db, "POST", `/ui/tasks/cards/M-99/comments/1/edit`, { text: "x" }, local)).status).toBe(404);
    expect((await call(db, "POST", `${base}/abc/edit`, { text: "x" }, local)).status).toBe(404);
    expect(comments(db).map((x) => x.text)).toEqual(["mine"]);
  });

  it("a reaction that is not one emoji — markup above all — is refused with the board's key", async () => {
    const db = scratchDb();
    const c = seed(db);
    const e = (db.board.updateCard(WEB, c.code, { comment: "mine" }), comments(db)[0]!);
    for (const emoji of ["<script>alert(1)</script>", "\"><img src=x onerror=alert(1)>", "ok", "👍<b>", "javascript:alert(1)"]) {
      const r = await call(db, "POST", `/ui/tasks/cards/${c.code}/comments/${e.id}/react`, { emoji }, local);
      expect([emoji, r.status, r.body.key]).toEqual([emoji, 400, "reaction_invalid"]);
    }
    expect(comments(db)[0]!.reactions).toBeUndefined();
  });

  it("the words of an edit are stored as typed and never as markup: the API answers JSON, and the page escapes them", async () => {
    const db = scratchDb();
    const c = seed(db);
    const e = (db.board.updateCard(WEB, c.code, { comment: "plain" }), comments(db)[0]!);
    const nasty = "<img src=x onerror=alert(1)> <script>alert(2)</script> [x](javascript:alert(3))";
    const r = await call(db, "POST", `/ui/tasks/cards/${c.code}/comments/${e.id}/edit`, { text: nasty }, local);
    expect(r.body.comment.text).toBe(nasty);
    expect(comments(db)[0]!.text).toBe(nasty);
  });
});

describe("4. the public link", () => {
  /** A card whose comments a hidden instance (spy) wrote, reacted to and resolved, and a visible one answered. */
  function hiddenThread(db: SchedulerDb) {
    const c = seed(db);
    db.board.updateCard(SPY, c.code, { comment: "the vault code is 4711" });
    const secret = comments(db)[0]!;
    db.board.updateCard(DEV, c.code, { comment: "noted", replyTo: secret.id });
    db.board.updateCard(ANN, c.code, { comment: "a visible root" });
    const visible = comments(db).at(-1)!;
    db.board.react(SPY, c.code, visible.id, "👀", true);
    db.board.react(ANN, c.code, visible.id, "👍", true);
    db.board.resolveThread(SPY, c.code, visible.id, true);
    return { c, secret, visible };
  }

  it("a read-only session sees none of the hidden instance's words, reactions or name on a thread, and the reply to its comment stands alone", async () => {
    const db = scratchDb();
    const { c, visible } = hiddenThread(db);
    const read = (await call(db, "GET", `/ui/tasks/cards/${c.code}`, undefined, { tier: "read" })).body;
    expect(JSON.stringify(read)).not.toMatch(/spy|vault|4711|👀/);
    expect(read.comments.map((e: any) => [e.text, e.parentId])).toEqual([["noted", undefined], ["a visible root", undefined]]);
    const shown = read.comments.find((e: any) => e.id === visible.id);
    expect(shown.reactions).toEqual([{ emoji: "👍", by: [{ name: "Ann", kind: "person" }] }]);
    expect(shown.resolved).toMatchObject({ by: "" });
  });

  it("an admin session over the link, and the local page, see the thread whole", async () => {
    const db = scratchDb();
    const { c, secret } = hiddenThread(db);
    for (const opts of [{}, local]) {
      const read = (await call(db, "GET", `/ui/tasks/cards/${c.code}`, undefined, opts)).body;
      expect(read.comments.map((e: any) => [e.text, e.parentId])).toEqual([["the vault code is 4711", undefined], ["noted", secret.id], ["a visible root", undefined]]);
      expect(read.comments[2].reactions.map((r: any) => r.emoji)).toEqual(["👀", "👍"]);
      expect(read.comments[2].resolved.by).toBe("spy");
    }
  });

  it("a card kept out of sight: a read-only session is refused before it could tell (403), an admin session sees the board whole (M-3278)", async () => {
    const db = scratchDb();
    db.board.createProject(ANN, { name: "Game" });
    const hidden = db.board.createCards(ANN, { project: "Game", cards: [{ title: "Secret work", assignee: "spy" }] }).cards[0]!;
    db.board.updateCard(WEB, hidden.code, { comment: "mine" });
    const e = comments(db, hidden.code)[0]!;
    expect((await call(db, "POST", `/ui/tasks/cards/${hidden.code}/comments/${e.id}/react`, { emoji: "👍" }, { tier: "read" })).status).toBe(403);
    // an admin session sees the board whole (M-3278), so the card is there for it
    expect((await call(db, "POST", `/ui/tasks/cards/${hidden.code}/comments/${e.id}/react`, { emoji: "👍" })).status).toBe(200);
  });
});
