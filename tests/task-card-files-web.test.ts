/**
 * Files on task cards, over the web: GET /ui/tasks/files/<id> through the real web handler with a real scheduler database
 * and the real store on disk.
 *
 *  - a file is a DOWNLOAD: an image as an image, text as plain text, everything else — HTML and SVG included — as opaque bytes
 *    with `attachment`, `nosniff`, a sandboxing CSP and no caching. Never a page of the dashboard's own origin.
 *  - it is read with the card: a read-only session reads it; the public link hides a hidden instance's card, its main task's
 *    sub task, and a file a hidden instance wrote on a visible card, with the answer an unknown id gets; an admin session over the
 *    link, like the local page, sees them.
 *  - the card's detail carries the files (a label and an id — never where they are kept) and the board's count.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleWebRequest } from "../src/web-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { SchedulerDb } from "../src/scheduler/db.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { boardToolAction } from "../src/task-board-tool.js";
import { stageFile } from "../src/task-attach-client.js";
import type { Actor } from "../src/scheduler/task-board.js";

const TOKEN = "c".repeat(48);
const ANN: Actor = { kind: "person", name: "Ann" };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("picture")]);
const FLEET = { defaults: {}, instances: { "dev-a": {}, spy: { cross_instance_visibility: "hidden" } } };

function board() {
  const dir = mkdtempSync(join(tmpdir(), "agend-task-files-web-"));
  dirs.push(dir);
  const db = new SchedulerDb(join(dir, "scheduler.db"));
  const stage = async (instance: string, name: string, bytes: Buffer) => {
    const got = await stageFile(name, bytes, async (call) => { try { return { result: boardToolAction(db, instance, call) }; } catch (e) { return { error: (e as Error).message }; } });
    if ("error" in got) throw new Error(got.error);
    return got.upload;
  };
  return { dir, db, stage, close: () => db.close() };
}

/** One request as a local page or as the public link's page (a gateway session); the answer's status, headers and raw body. */
function get(db: SchedulerDb, path: string, opts: { local?: boolean; tier?: "admin" | "read"; method?: string } = {}) {
  const sessions = new WebSessionStore(), exposureId = "a".repeat(32), pub = "https://sample.trycloudflare.com", local = "http://127.0.0.1:19280";
  const s = sessions.create({ tier: opts.tier ?? "admin", surface: opts.local ? "local" : "gateway", exposureId: opts.local ? undefined : exposureId, label: "t", tokenEpoch: tokenEpoch(TOKEN) } as never);
  const origin = opts.local ? local : pub;
  const headers: Record<string, string> = { host: new URL(origin).host, cookie: `${opts.local ? "" : "__Host-"}agend_session=${s.sessionId}`, origin, "sec-fetch-site": "same-origin", "x-agend-csrf": csrfTokenFor(s.sessionId) };
  return new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve) => {
    const req = Object.assign(new EventEmitter(), { method: opts.method ?? "GET", url: path, headers, destroy: vi.fn() });
    if (!opts.local) bindGatewayRequest(req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
    let status = 0; const out: Record<string, string> = {};
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader: (k: string, v: unknown) => { out[k.toLowerCase()] = String(v); },
      writeHead: (c: number) => { status = c; }, end: (b?: Buffer | string) => resolve({ status, headers: out, body: Buffer.isBuffer(b) ? b : Buffer.from(String(b ?? "")) }) });
    handleWebRequest(req as never, res as never, new URL(path, origin), { webToken: TOKEN, webSessions: sessions, scheduler: { db }, fleetConfig: FLEET,
      logger: { debug() {}, info() {}, warn() {}, error() {} }, getUiStatus: () => ({ instances: [] }), listWebPrompts: () => [], needsYouItems: () => [] } as never);
    req.emit("end");
  });
}
const json = (b: Buffer) => JSON.parse(b.toString("utf8"));

describe("a file on a card is a download", () => {
  it("an image is shown as an image; text is plain text; HTML and everything else are opaque downloads — all behind nosniff, a sandboxing CSP, no caching", async () => {
    const b = board();
    b.db.board.createCards(ANN, { cards: [{ title: "Game", assignee: "dev-a" }] });
    const [png, md, html, svg, bin] = [await b.stage("dev-a", "shot.png", PNG), await b.stage("dev-a", "design 設計.md", Buffer.from("# Design\n")),
      await b.stage("dev-a", "index.html", Buffer.from("<script>alert(document.cookie)</script>")), await b.stage("dev-a", "logo.svg", Buffer.from("<svg onload=alert(1)/>")), await b.stage("dev-a", "a.zip", Buffer.from([0x50, 0x4b, 3, 4, 0, 0xff, 0x10]))];
    b.db.board.updateCard({ kind: "instance", name: "dev-a" }, "M-1", { comment: "files", attach: [png, md, html, svg, bin] });
    for (const [id, type, disposition, body] of [
      [png, "image/png", "inline", PNG], [md, "text/plain; charset=utf-8", "attachment", Buffer.from("# Design\n")],
      [html, "application/octet-stream", "attachment", Buffer.from("<script>alert(document.cookie)</script>")], [svg, "application/octet-stream", "attachment", Buffer.from("<svg onload=alert(1)/>")],
      [bin, "application/octet-stream", "attachment", Buffer.from([0x50, 0x4b, 3, 4, 0, 0xff, 0x10])],
    ] as const) {
      for (const local of [true, false]) {
        const r = await get(b.db, `/ui/tasks/files/${id}`, { local, tier: "read" });
        expect([id, local, r.status]).toEqual([id, local, 200]);
        expect(r.headers["content-type"]).toBe(type);
        expect(r.headers["content-disposition"]).toMatch(new RegExp(`^${disposition}; filename\\*=UTF-8''`));
        expect(r.headers["x-content-type-options"]).toBe("nosniff");
        expect(r.headers["cache-control"]).toBe("private, no-store");
        expect(r.headers["content-security-policy"]).toBe("default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
        expect(r.headers["content-length"]).toBe(String(body.length));
        expect(r.body.equals(body)).toBe(true);
      }
    }
    expect((await get(b.db, `/ui/tasks/files/${md}`, { local: true })).headers["content-disposition"]).toContain(encodeURIComponent("design 設計.md"));
    b.close();
  });

  it("an unknown id, a malformed one and a write are refused; a file gone from the disk, or changed in size, is not served", async () => {
    const b = board();
    b.db.board.createCards(ANN, { cards: [{ title: "Game", assignee: "dev-a" }] });
    const id = await b.stage("dev-a", "a.md", Buffer.from("# A\nmore"));
    b.db.board.updateCard({ kind: "instance", name: "dev-a" }, "M-1", { attach: [id] });
    const uuid = b.db.board.getCard("M-1").uuid;
    expect((await get(b.db, `/ui/tasks/files/${"1".repeat(32)}`, { local: true })).status).toBe(404);
    expect((await get(b.db, "/ui/tasks/files/not-an-id", { local: true })).status).toBe(404);
    // There is no write route for a file: a read-only session is refused, an admin's is "not found".
    expect((await get(b.db, `/ui/tasks/files/${id}`, { local: true, method: "POST", tier: "read" })).status).toBe(403);
    expect((await get(b.db, `/ui/tasks/files/${id}`, { local: true, method: "POST" })).status).toBe(404);
    expect((await get(b.db, `/ui/tasks/files/${id}`, { local: true })).status).toBe(200);
    truncateSync(join(b.dir, "task-files", uuid, id), 2);
    expect((await get(b.db, `/ui/tasks/files/${id}`, { local: true })).status).toBe(404);
    unlinkSync(join(b.dir, "task-files", uuid, id));
    expect((await get(b.db, `/ui/tasks/files/${id}`, { local: true })).status).toBe(404);
    b.close();
  });

  it("a symlink put where the file was is not followed", async () => {
    const b = board();
    b.db.board.createCards(ANN, { cards: [{ title: "Game", assignee: "dev-a" }] });
    const id = await b.stage("dev-a", "a.md", Buffer.from("# A"));
    b.db.board.updateCard({ kind: "instance", name: "dev-a" }, "M-1", { attach: [id] });
    const path = join(b.dir, "task-files", b.db.board.getCard("M-1").uuid, id);
    writeFileSync(join(b.dir, "secret.txt"), "# A");
    unlinkSync(path);
    (await import("node:fs")).symlinkSync(join(b.dir, "secret.txt"), path);
    expect((await get(b.db, `/ui/tasks/files/${id}`, { local: true })).status).toBe(404);
    b.close();
  });
});

describe("it is read with the card", () => {
  it("over the public link a hidden instance's card, its sub task, and a file it wrote on a visible card are not found; an admin session there and the local page see them", async () => {
    const b = board();
    b.db.board.createCards(ANN, { cards: [{ title: "Open work", assignee: "dev-a" }, { title: "Secret work", assignee: "spy" }] });     // M-1, M-2
    b.db.board.createCards(ANN, { parent: "M-2", cards: [{ title: "Secret step", assignee: "dev-a" }] });                              // S-1 under the hidden main task
    const visible = await b.stage("dev-a", "mine.md", Buffer.from("fine"));
    const hiddenCard = await b.stage("spy", "secret.md", Buffer.from("secret"));
    const underHidden = await b.stage("dev-a", "step.md", Buffer.from("step"));
    const hiddenAuthor = await b.stage("spy", "spy-note.md", Buffer.from("spy wrote this"));
    b.db.board.updateCard({ kind: "instance", name: "dev-a" }, "M-1", { comment: "ok", attach: [visible] });
    b.db.board.updateCard({ kind: "instance", name: "spy" }, "M-2", { comment: "x", attach: [hiddenCard] });
    b.db.board.updateCard({ kind: "instance", name: "dev-a" }, "S-1", { comment: "x", attach: [underHidden] });
    b.db.board.updateCard({ kind: "instance", name: "spy" }, "M-1", { comment: "spy was here", attach: [hiddenAuthor] });
    const link = (id: string, tier: "admin" | "read") => get(b.db, `/ui/tasks/files/${id}`, { tier });
    expect((await link(visible, "read")).status).toBe(200);
    for (const [name, id] of [["a hidden instance's card", hiddenCard], ["its main task's sub task", underHidden], ["a hidden author's file on a visible card", hiddenAuthor]] as const) {
      const r = await link(id, "read");
      expect([name, r.status, json(r.body)]).toEqual([name, 404, { error: "No such file" }]);                      // as an unknown id answers
      expect((await link(id, "admin")).status, `${name}: an admin session over the link`).toBe(200);
      expect((await get(b.db, `/ui/tasks/files/${id}`, { local: true, tier: "read" })).status, `${name}: the local page`).toBe(200);
    }
    expect(json((await get(b.db, `/ui/tasks/files/${"2".repeat(32)}`, { tier: "read" })).body)).toEqual({ error: "No such file" });
    b.close();
  });

  it("the card's detail carries its files and the board its count, and a read-only link leaves a hidden instance's out; no path is told", async () => {
    const b = board();
    b.db.board.createCards(ANN, { cards: [{ title: "Open work", assignee: "dev-a" }] });
    const mine = await b.stage("dev-a", "mine.md", Buffer.from("fine"));
    const spy = await b.stage("spy", "spy-note.md", Buffer.from("spy"));
    b.db.board.updateCard({ kind: "instance", name: "dev-a" }, "M-1", { comment: "ok", attach: [mine] });
    b.db.board.updateCard({ kind: "instance", name: "spy" }, "M-1", { comment: "hello", attach: [spy] });
    const read = await get(b.db, "/ui/tasks/cards/M-1", { tier: "read" });
    const detail = json(read.body);
    expect(detail.attachments.map((f: any) => [f.name, f.author, f.entryId === detail.comments.find((c: any) => c.author === "dev-a")?.id])).toEqual([["mine.md", "dev-a", true]]);
    expect(detail.card.attachmentCount).toBe(1);
    expect(read.body.toString("utf8")).not.toContain(b.dir);
    const full = json((await get(b.db, "/ui/tasks/cards/M-1", { local: true })).body);
    expect(full.attachments.map((f: any) => f.name)).toEqual(["mine.md", "spy-note.md"]);
    expect(full.card.attachmentCount).toBe(2);
    expect(json((await get(b.db, "/ui/tasks/board", { local: true })).body).cards.find((c: any) => c.id === "M-1").attachmentCount).toBe(2);
    b.close();
  });
});

describe("the public link's manifest", () => {
  it("a file is read over the link (as the card is) and never written", () => {
    expect(isPublicWebRoute("GET", `/ui/tasks/files/${"a".repeat(32)}`)).toBe(true);
    expect(isPublicWebRoute("GET", "/ui/tasks/files/short")).toBe(false);
    expect(isPublicWebRoute("GET", `/ui/tasks/files/${"a".repeat(32)}/x`)).toBe(false);
  });
});
