import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import {
  attachmentDelivery, displayName, MAX_SERVED_BYTES, sniffUpload, UPLOAD_LIMITS, UPLOAD_TTL_MS, WebFileLedger, type UploadEntry,
} from "../src/web-upload.js";

/**
 * Web track C2 — files in the web chat, Telegram parity: what may be uploaded (decided from the bytes),
 * where it goes (the instance's inbox, a name chosen by the server), what the agent is handed (the same
 * tags/meta as a Telegram photo or document), and which files the page may fetch back (by an id the
 * fleet issued, never a path). Expectations are written out by hand.
 */

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "c2-")); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const GIF = Buffer.from("GIF89a-----");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const PDF = Buffer.from("%PDF-1.7\n...");

describe("sniffUpload: the type comes from the bytes", () => {
  it.each([
    ["png", PNG, "x.bin", { kind: "photo", mime: "image/png", ext: ".png" }],
    ["jpeg", JPG, "x", { kind: "photo", mime: "image/jpeg", ext: ".jpg" }],
    ["gif", GIF, "x", { kind: "photo", mime: "image/gif", ext: ".gif" }],
    ["webp", WEBP, "x", { kind: "photo", mime: "image/webp", ext: ".webp" }],
    ["pdf", PDF, "x.png", { kind: "document", mime: "application/pdf", ext: ".pdf" }],          // the name does not decide
    ["markdown", Buffer.from("# hi\n"), "notes.md", { kind: "document", mime: "text/plain; charset=utf-8", ext: ".md" }],
    ["utf-8 text, unknown extension", Buffer.from("你好"), "a.weird", { kind: "document", mime: "text/plain; charset=utf-8", ext: ".txt" }],
    ["svg is only text here", Buffer.from("<svg onload=alert(1)>"), "x.svg", { kind: "document", mime: "text/plain; charset=utf-8", ext: ".txt" }],
  ])("%s", (_n, bytes, name, expected) => {
    expect(sniffUpload(bytes, name)).toEqual(expected);
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["a Windows executable", Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1")],
    ["a zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])],
    ["binary with NUL", Buffer.from("abc\x00def")],
    ["invalid UTF-8", Buffer.from([0xc3, 0x28, 0x41])],
    ["RIFF that is not WebP (a WAV)", Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WAVEfmt ")])],
  ])("refuses %s", (_n, bytes) => {
    expect(sniffUpload(bytes, "x.png")).toBeNull();
  });
});

describe("displayName: a label, never a path", () => {
  it.each([
    ["../../etc/passwd", "passwd"], ["C:\\Users\\a\\secret.txt", "secret.txt"], ["%2e%2e%2fx.png", "x.png"],
    [".bashrc", "bashrc"], ["a\u202Egnp.exe", "agnp.exe"], ["line\nbreak.txt", "linebreak.txt"], ["", "file"], [null, "file"],
    ["x".repeat(150), "x".repeat(100)], ["report (final).pdf", "report (final).pdf"],
    // Cut by code point (#1252 review P1), and a lone surrogate from anywhere becomes U+FFFD, so the name always encodes.
    ["x".repeat(99) + "😀😀", "x".repeat(99) + "😀"], ["a\uD83D", "a\uFFFD"], ["\uDE00b", "\uFFFDb"],
  ])("%j → %j", (raw, expected) => { expect(displayName(raw as string, "file")).toBe(expected); });
});

describe("WebFileLedger", () => {
  const png = sniffUpload(PNG, "x.png")!;
  const txt = sniffUpload(Buffer.from("hello"), "n.txt")!;

  it("stores an upload in the inbox under a name it chose, private, written once", () => {
    const ledger = new WebFileLedger();
    const inbox = join(dir, "ws", "inbox");
    const e = ledger.storeUpload({ instance: "w", inboxDir: inbox, bytes: PNG, name: "../../evil name.png", type: png });
    expect(e.path.startsWith(inbox + "/")).toBe(true);
    expect(e.path).toMatch(/\/web-pending-\d+-[0-9a-f]{8}\.png$/);   // pending until a message takes it (#1273)
    expect(e.path).not.toContain("evil");
    expect(e.name).toBe("evil name.png");
    expect(readFileSync(e.path)).toEqual(PNG);
    expect(statSync(e.path).mode & 0o777).toBe(0o600);
    expect(statSync(inbox).mode & 0o777).toBe(0o700);
    expect(e.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("a message takes its uploads once, only for its own instance, before they expire, within the limits", () => {
    let now = 1_000;
    const ledger = new WebFileLedger({ now: () => now });
    const inbox = join(dir, "inbox");
    const a = ledger.storeUpload({ instance: "w", inboxDir: inbox, bytes: PNG, name: "a.png", type: png });
    const b = ledger.storeUpload({ instance: "w", inboxDir: inbox, bytes: Buffer.from("hello"), name: "b.txt", type: txt });
    const other = ledger.storeUpload({ instance: "x", inboxDir: inbox, bytes: PNG, name: "c.png", type: png });
    expect(ledger.takeForMessage("w", [other.id]).ok, "another chat's file").toBe(false);
    expect(ledger.takeForMessage("w", [a.id, a.id]).ok, "the same file twice").toBe(false);
    expect(ledger.takeForMessage("w", ["f".repeat(32)]).ok, "unknown").toBe(false);
    expect(ledger.takeForMessage("w", ["../x"]).ok, "not an id").toBe(false);
    const taken = ledger.takeForMessage("w", [a.id, b.id]);
    expect(taken.ok && taken.entries.map(e => e.name)).toEqual(["a.png", "b.txt"]);
    expect(ledger.takeForMessage("w", [a.id]).ok, "already sent").toBe(false);
    const late = ledger.storeUpload({ instance: "w", inboxDir: inbox, bytes: PNG, name: "late.png", type: png });
    now += UPLOAD_TTL_MS;
    expect(ledger.takeForMessage("w", [late.id]).ok, "expired").toBe(false);
  });

  it("an upload no message took is deleted when it expires — file and id; a sent one stays with the agent", () => {
    let now = 1_000;
    const ledger = new WebFileLedger({ now: () => now });
    const inbox = join(dir, "inbox");
    const abandoned = ledger.storeUpload({ instance: "w", inboxDir: inbox, bytes: PNG, name: "a.png", type: png });
    const sent = ledger.storeUpload({ instance: "w", inboxDir: inbox, bytes: PNG, name: "s.png", type: png });
    const fresh = () => ledger.storeUpload({ instance: "w", inboxDir: inbox, bytes: PNG, name: "f.png", type: png });
    const took = ledger.takeForMessage("w", [sent.id]);
    expect(took.ok).toBe(true);
    if (took.ok) ledger.commit(took.entries);
    now += UPLOAD_TTL_MS - 1;
    ledger.prune();
    expect(existsSync(abandoned.path), "not expired yet").toBe(true);
    now += 1;
    const later = fresh();                                            // any later upload sweeps
    expect(existsSync(abandoned.path), "expired unsent: deleted").toBe(false);
    expect(ledger.read(abandoned.id), "and its id is gone").toBeNull();
    expect(existsSync(sent.path), "sent: the agent's file is kept").toBe(true);
    expect(ledger.read(sent.id)?.bytes).toEqual(PNG);
    expect(existsSync(later.path)).toBe(true);
    expect(readdirSync(inbox).sort()).toEqual([basename(later.path), basename(sent.path)].sort());
  });

  it("the sweep runs on its own once the upload window passes — no later upload needed", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    try {
      const ledger = new WebFileLedger();
      const e = ledger.storeUpload({ instance: "w", inboxDir: join(dir, "inbox"), bytes: PNG, name: "a.png", type: png });
      vi.advanceTimersByTime(UPLOAD_TTL_MS);
      expect(existsSync(e.path), "the window has only just closed").toBe(true);
      vi.advanceTimersByTime(1_000);
      expect(existsSync(e.path)).toBe(false);
      expect(ledger.read(e.id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses more than 5 files, or more than 25 MB together, without marking any of them sent", () => {
    const ledger = new WebFileLedger();
    const inbox = join(dir, "inbox");
    const six = Array.from({ length: 6 }, (_, i) => ledger.storeUpload({ instance: "w", inboxDir: inbox, bytes: PNG, name: `${i}.png`, type: png }).id);
    expect(ledger.takeForMessage("w", six)).toEqual({ ok: false, error: "at most 5 files per message" });
    const big: Buffer = Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]) as Buffer;
    const three = [0, 1, 2].map(i => ledger.storeUpload({ instance: "w", inboxDir: inbox, bytes: big, name: `${i}.png`, type: png }).id);
    const res = ledger.takeForMessage("w", three);
    expect(res.ok).toBe(false);
    expect(ledger.takeForMessage("w", three.slice(0, 2)).ok, "nothing was used up by the refusal").toBe(true);
  });

  it("serves only a regular file within the size limit, read without following a symlink", () => {
    const ledger = new WebFileLedger();
    const f = join(dir, "r.txt");
    writeFileSync(f, "ok");
    expect(ledger.registerServed({ path: dir, instance: "w" }), "a directory").toBeNull();
    expect(ledger.registerServed({ path: join(dir, "missing"), instance: "w" }), "missing").toBeNull();
    const served = ledger.registerServed({ path: f, instance: "w" })!;
    expect(ledger.read(served.id)!.bytes.toString()).toBe("ok");
    // Swapped for a symlink after it was registered: not served.
    unlinkSync(f);
    writeFileSync(join(dir, "secret"), "no");
    symlinkSync(join(dir, "secret"), f);
    expect(ledger.read(served.id)).toBeNull();
    // Changed size after registration: not served either.
    const g = join(dir, "g.txt"); writeFileSync(g, "abc");
    const sg = ledger.registerServed({ path: g, instance: "w" })!;
    writeFileSync(g, "abcdef");
    expect(ledger.read(sg.id)).toBeNull();
    expect(ledger.read("not-an-id")).toBeNull();
    expect(MAX_SERVED_BYTES).toBe(50 * 1024 * 1024);
  });

  it("forget(): an instance's files stop being served", () => {
    const ledger = new WebFileLedger();
    const e = ledger.storeUpload({ instance: "w", inboxDir: join(dir, "inbox"), bytes: PNG, name: "a.png", type: png });
    ledger.forget("w");
    expect(ledger.read(e.id)).toBeNull();
    expect(ledger.takeForMessage("w", [e.id]).ok).toBe(false);
  });
});

describe("attachmentDelivery: what the agent is handed is what Telegram gives it", () => {
  const entry = (kind: "photo" | "document", path: string, name: string) => ({ id: "x", instance: "w", path, kind, mime: "", name, size: 1, expiresAt: 0, state: "sent" }) as UploadEntry;
  it("photos then files, each tagged, the first in image_path / attachment_path, all in *_paths", () => {
    const d = attachmentDelivery("look", [entry("photo", "/i/a.png", "a.png"), entry("document", "/i/r.pdf", "report.pdf"), entry("photo", "/i/b.jpg", "b.jpg")]);
    expect(d.text).toBe("[📷 Image: /i/a.png]\n[📷 Image: /i/b.jpg]\n[📎 File: report.pdf → /i/r.pdf]\nlook");
    expect(d.meta).toEqual({ image_path: "/i/a.png", image_paths: "/i/a.png,/i/b.jpg", attachment_path: "/i/r.pdf" });
  });
  it("no files: the text alone, no meta", () => {
    expect(attachmentDelivery("hi", [])).toEqual({ text: "hi", meta: {} });
  });
});

// ── the routes ─────────────────────────────────────────────────────────────────────────────────────────────

const TOKEN = "u".repeat(48);
function call(method: string, url: string, ctx: WebApiContext, opts: { body?: Buffer | string; headers?: Record<string, string> } = {}) {
  const req = Object.assign(new EventEmitter(), {
    method, url, headers: { "x-agend-token": TOKEN, ...(opts.headers ?? {}) },
    destroy() {}, resume() {},
  });
  const res = Object.assign(new EventEmitter(), {
    status: 0, headers: {} as Record<string, unknown>, body: Buffer.alloc(0) as Buffer,
    setHeader(k: string, v: unknown) { res.headers[k.toLowerCase()] = v; },
    writeHead(s: number) { res.status = s; return res; }, write() { return true; },
    end(chunk?: unknown) { if (chunk) res.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)); return res; },
  });
  handleWebRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL(url, "http://localhost"), ctx);
  setImmediate(() => { if (opts.body !== undefined) req.emit("data", Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body)); req.emit("end"); });
  return { res, done: () => vi.waitFor(() => expect(res.status).not.toBe(0)) };
}
function ctx(over: Record<string, unknown> = {}) {
  const delivered: Array<{ content: string; meta: Record<string, string> }> = [];
  const events: Array<{ event: string; data: any }> = [];
  const c = {
    webToken: TOKEN, dataDir: dir, sseClients: new Set(), fleetConfig: { instances: { w: { working_directory: dir } } },
    instanceIpcClients: new Map([["w", { send() {} }], ["x", { send() {} }]]),
    adapter: null, logger: { info() {}, debug() {}, error() {} }, eventLog: null, lastInboundUser: new Map(),
    deliverToInstance: async (_n: string, p: { content: string; meta: Record<string, string> }) => { delivered.push(p); },
    emitSseEvent: (event: string, data: unknown) => { events.push({ event, data }); },
    getUiStatus: () => ({}), webFiles: new WebFileLedger(),
    ...over,
  } as unknown as WebApiContext;
  return { c, delivered, events };
}
async function upload(c: WebApiContext, instance: string, bytes: Buffer, name: string, headers: Record<string, string> = {}) {
  const r = call("POST", `/ui/upload?instance=${encodeURIComponent(instance)}`, c, { body: bytes, headers: { "x-agend-filename": encodeURIComponent(name), ...headers } });
  await r.done();
  return { status: r.res.status, body: JSON.parse(r.res.body.toString() || "{}") };
}

describe("POST /ui/upload", () => {
  beforeEach(() => { vi.stubEnv("AGEND_HOME", dir); });

  it("stores the file in that instance's workspace inbox and answers with an id — never the path", async () => {
    const { c } = ctx();
    const r = await upload(c, "w", PNG, "shot.png", { "content-type": "application/x-anything" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/), kind: "photo", name: "shot.png", size: PNG.length, mime: "image/png" });
    expect(JSON.stringify(r.body)).not.toContain(dir);
    expect(readdirSync(join(dir, "workspaces", "w", "inbox"))).toHaveLength(1);
  });

  it.each(["../w", "..", "a/b", "nobody", ""])("refuses instance %j (404) and writes nothing", async (name) => {
    const { c } = ctx();
    expect((await upload(c, name, PNG, "x.png")).status).toBe(404);
    expect(() => readdirSync(join(dir, "workspaces"))).toThrow();
  });

  it("an instance name that is not one path segment is refused even if something registered it", async () => {
    const { c } = ctx({ instanceIpcClients: new Map([["../escape", { send() {} }], ["a/b", { send() {} }], ["..", { send() {} }]]) });
    for (const bad of ["../escape", "a/b", ".."]) expect((await upload(c, bad, PNG, "x.png")).status, bad).toBe(404);
    expect(() => readdirSync(join(dir, "workspaces"))).toThrow();
  });

  it("refuses a type it cannot read from the bytes (415)", async () => {
    const { c } = ctx();
    const r = await upload(c, "w", Buffer.from("MZ\x90\x00", "latin1"), "setup.png");
    expect(r.status).toBe(415);
  });

  it("refuses over 10 MB — by Content-Length before reading, and while streaming", async () => {
    const { c } = ctx();
    expect((await upload(c, "w", PNG, "x.png", { "content-length": String(UPLOAD_LIMITS.maxFileBytes + 1) })).status).toBe(413);
    expect((await upload(c, "w", Buffer.concat([PNG, Buffer.alloc(UPLOAD_LIMITS.maxFileBytes)]), "x.png")).status).toBe(413);
  });

  it("a long Unicode name is cut by code point: the upload and its download both work (#1252 review P1)", async () => {
    const { c } = ctx();
    const name = "x".repeat(99) + "😀.txt";                          // the 100th code point is the emoji
    const up = await upload(c, "w", Buffer.from("hello"), name);
    expect(up.status).toBe(200);
    expect(up.body.name).toBe("x".repeat(99) + "😀");                 // whole, never half a surrogate pair
    const got = call("GET", `/ui/file/${up.body.id}`, c);
    await got.done();
    expect(got.res.status).toBe(200);
    expect(got.res.headers["content-disposition"]).toBe(`attachment; filename*=UTF-8''${encodeURIComponent("x".repeat(99) + "😀")}`);
    expect(got.res.body.toString()).toBe("hello");
  });

  it("a ClassicBot room (in classicBot.yaml, not fleet.yaml) takes uploads; unregistered or stopped mid-body it does not (#1252 review r2)", async () => {
    const classic = new Set(["room"]);
    const { c } = ctx({
      fleetConfig: { instances: {} },                                 // the room is not a fleet instance…
      instanceIpcClients: new Map([["room", { send() {} }]]),
      isClassicInstance: (n: string) => classic.has(n),              // …it is a Classic one
    });
    const ok = await upload(c, "room", PNG, "a.png");
    expect(ok.status).toBe(200);
    expect(readdirSync(join(dir, "workspaces", "room", "inbox"))).toHaveLength(1);
    const ipc = (c as unknown as { instanceIpcClients: Map<string, unknown> }).instanceIpcClients;
    for (const remove of [() => { classic.delete("room"); c.webFiles!.forget("room"); }, () => { ipc.delete("room"); }]) {
      classic.add("room"); ipc.set("room", { send() {} });
      const req = Object.assign(new EventEmitter(), { method: "POST", url: "/ui/upload?instance=room", headers: { "x-agend-token": TOKEN, "x-agend-filename": "b.png" }, destroy() {}, resume() {} });
      const res = Object.assign(new EventEmitter(), { status: 0, headers: {} as Record<string, unknown>, body: "",
        setHeader() {}, writeHead(st: number) { res.status = st; return res; }, end(b?: unknown) { res.body = String(b ?? ""); return res; } });
      handleWebRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL("http://localhost/ui/upload?instance=room"), c);
      req.emit("data", PNG);
      remove();
      req.emit("end");
      expect(res.status).toBe(404);
    }
    expect(readdirSync(join(dir, "workspaces", "room", "inbox")), "only the first upload was stored").toHaveLength(1);
  });

  it("an instance deleted while the body was still arriving gets nothing stored and no id (#1252 review P2-3)", async () => {
    const { c } = ctx();
    const ipc = (c as unknown as { instanceIpcClients: Map<string, unknown> }).instanceIpcClients;
    const config = (c as unknown as { fleetConfig: { instances: Record<string, unknown> } }).fleetConfig;
    for (const remove of [
      () => { ipc.delete("w"); delete config.instances.w; c.webFiles!.forget("w"); },   // deleted
      () => { ipc.delete("w"); },                                                         // stopped: its IPC is gone
    ]) {
      ipc.set("w", { send() {} }); config.instances.w = { working_directory: dir };
      const req = Object.assign(new EventEmitter(), { method: "POST", url: "/ui/upload?instance=w", headers: { "x-agend-token": TOKEN, "x-agend-filename": "a.png" }, destroy() {}, resume() {} });
      const res = Object.assign(new EventEmitter(), { status: 0, headers: {} as Record<string, unknown>, body: "",
        setHeader() {}, writeHead(st: number) { res.status = st; return res; }, end(b?: unknown) { res.body = String(b ?? ""); return res; } });
      handleWebRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL("http://localhost/ui/upload?instance=w"), c);
      req.emit("data", PNG);                                         // the body is still arriving…
      remove();                                                      // …when the instance goes away
      req.emit("end");
      expect(res.status).toBe(404);
    }
    expect(() => readdirSync(join(dir, "workspaces", "w", "inbox"))).toThrow();   // nothing was ever written
  });

  it("needs the same credential as every /ui route", async () => {
    const { c } = ctx();
    const r = call("POST", "/ui/upload?instance=w", c, { body: PNG, headers: { "x-agend-token": "wrong".padEnd(48, "x") } });
    await r.done();
    expect(r.res.status).toBe(401);
  });
});

describe("POST /ui/send with files", () => {
  beforeEach(() => { vi.stubEnv("AGEND_HOME", dir); });
  const send = async (c: WebApiContext, body: unknown) => {
    const r = call("POST", "/ui/send", c, { body: JSON.stringify(body) });
    await r.done();
    return { status: r.res.status, body: JSON.parse(r.res.body.toString()) };
  };

  it("hands the agent the Telegram tags and meta, and shows the chat the files by id (no path)", async () => {
    const { c, delivered, events } = ctx();
    const img = (await upload(c, "w", PNG, "shot.png")).body;
    const doc = (await upload(c, "w", Buffer.from("notes"), "n.md")).body;
    expect((await send(c, { instance: "w", message: "see", attachments: [img.id, doc.id] })).status).toBe(200);
    const inbox = join(dir, "workspaces", "w", "inbox");
    expect(delivered[0]!.content).toMatch(new RegExp(`^\\[📷 Image: ${inbox}/web-\\d+-[0-9a-f]{8}\\.png\\]\\n\\[📎 File: n\\.md → ${inbox}/web-\\d+-[0-9a-f]{8}\\.md\\]\\nsee$`));
    expect(delivered[0]!.meta.image_path).toMatch(/\.png$/);
    expect(delivered[0]!.meta.attachment_path).toMatch(/\.md$/);
    const shown = events.find(e => e.event === "message")!.data;
    expect(shown.attachments.map((a: { name: string }) => a.name)).toEqual(["shot.png", "n.md"]);
    expect(JSON.stringify(shown)).not.toContain(inbox);
  });

  it("a message may be files only; neither text nor files is refused", async () => {
    const { c } = ctx();
    const img = (await upload(c, "w", PNG, "a.png")).body;
    expect((await send(c, { instance: "w", message: "", attachments: [img.id] })).status).toBe(200);
    expect((await send(c, { instance: "w", message: "  " })).status).toBe(400);
  });

  it("an id that is used up, another chat's, or not ours is refused and nothing is delivered", async () => {
    const { c, delivered } = ctx();
    const img = (await upload(c, "w", PNG, "a.png")).body;
    const other = (await upload(c, "x", PNG, "b.png")).body;
    expect((await send(c, { instance: "w", message: "1", attachments: [img.id] })).status).toBe(200);
    expect((await send(c, { instance: "w", message: "2", attachments: [img.id] })).status).toBe(400);
    expect((await send(c, { instance: "w", message: "3", attachments: [other.id] })).status).toBe(400);
    expect((await send(c, { instance: "w", message: "4", attachments: ["../../etc/passwd"] })).status).toBe(400);
    expect(delivered).toHaveLength(1);
  });
});

describe("a message's files are only used up once the agent has them (#1252 review P2-2)", () => {
  beforeEach(() => { vi.stubEnv("AGEND_HOME", dir); });
  const send = async (c: WebApiContext, body: unknown) => {
    const r = call("POST", "/ui/send", c, { body: JSON.stringify(body) });
    await r.done();
    return { status: r.res.status, body: JSON.parse(r.res.body.toString()) };
  };

  it.each([
    ["answers false (the IPC went away, or the instance restarted)", async () => false],
    ["throws", async () => { throw new Error("socket closed"); }],
  ])("delivery that %s: 503, nothing shown, and the same ids can be sent again", async (_why, fail) => {
    let outcome: () => Promise<unknown> = fail;
    const delivered: unknown[] = [];
    const { c, events } = ctx({ deliverToInstance: async (_n: string, p: unknown) => { const r = await outcome(); delivered.push(p); return r; } });
    const img = (await upload(c, "w", PNG, "a.png")).body;
    expect((await send(c, { instance: "w", message: "hi", attachments: [img.id] })).status).toBe(503);
    expect(events.filter(e => e.event === "message")).toEqual([]);
    outcome = async () => true;
    expect((await send(c, { instance: "w", message: "hi", attachments: [img.id] })).status, "retry with the same id").toBe(200);
    expect((await send(c, { instance: "w", message: "again", attachments: [img.id] })).status, "now it is used up").toBe(400);
  });

  it.each([
    ["a same-size regular file", (p: string) => { const o = join(dir, "other.png"); writeFileSync(o, Buffer.alloc(PNG.length, 7)); renameSync(o, p); }],
    ["a symlink", (p: string) => { const t = join(dir, "secret.bin"); writeFileSync(t, Buffer.alloc(PNG.length, 7)); unlinkSync(p); symlinkSync(t, p); }],
  ])("the file swapped for %s while it was being delivered: the failed send's retry is refused (400) and the id serves nothing (#1304 review r2)", async (_what, swap) => {
    let attempts = 0;
    const { c } = ctx({ deliverToInstance: async (_n: string, p: { meta: Record<string, string> }) => { attempts++; swap(p.meta.image_path!); return false; } });
    const img = (await upload(c, "w", PNG, "a.png")).body;
    expect((await send(c, { instance: "w", message: "hi", attachments: [img.id] })).status).toBe(503);
    expect((await send(c, { instance: "w", message: "hi", attachments: [img.id] })).status, "not the file that was uploaded").toBe(400);
    expect(attempts, "nothing delivered on the retry").toBe(1);
    expect(c.webFiles!.read(img.id)).toBeNull();
  });

  it("two sends of the same file at once: one takes it, the other is refused while it is on its way", async () => {
    let finish!: (v: boolean) => void;
    const { c } = ctx({ deliverToInstance: () => new Promise<boolean>(r => { finish = r; }) });
    const img = (await upload(c, "w", PNG, "a.png")).body;
    const first = call("POST", "/ui/send", c, { body: JSON.stringify({ instance: "w", message: "1", attachments: [img.id] }) });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect((await send(c, { instance: "w", message: "2", attachments: [img.id] })).status).toBe(400);
    finish(true);
    await first.done();
    expect(first.res.status).toBe(200);
  });

  it("a file whose window closes while its message is being delivered is not swept from under it", () => {
    let now = 0;
    const ledger = new WebFileLedger({ now: () => now });
    const png = sniffUpload(PNG, "a.png")!;
    const a = ledger.storeUpload({ instance: "w", inboxDir: join(dir, "inbox"), bytes: PNG, name: "a.png", type: png });
    const b = ledger.storeUpload({ instance: "w", inboxDir: join(dir, "inbox"), bytes: PNG, name: "b.png", type: png });
    const ta = ledger.takeForMessage("w", [a.id]); const tb = ledger.takeForMessage("w", [b.id]);
    if (!ta.ok || !tb.ok) throw new Error("not taken");
    now += UPLOAD_TTL_MS + 1;
    ledger.prune();
    expect([existsSync(a.path), existsSync(b.path)], "both reserved: kept").toEqual([true, true]);
    ledger.commit(ta.entries);                                       // delivered: the agent's
    ledger.release(tb.entries);                                      // not delivered, and its window has closed: gone
    expect([existsSync(a.path), existsSync(b.path)]).toEqual([true, false]);
    expect(ledger.read(b.id)).toBeNull();
  });

  it("commit is final: a later release cannot hand a delivered file to another message", () => {
    const ledger = new WebFileLedger({ now: () => 0 });
    const e = ledger.storeUpload({ instance: "w", inboxDir: join(dir, "inbox"), bytes: PNG, name: "a.png", type: sniffUpload(PNG, "a.png")! });
    const t = ledger.takeForMessage("w", [e.id]);
    if (!t.ok) throw new Error("not taken");
    ledger.commit(t.entries);
    ledger.release(t.entries);
    expect(ledger.takeForMessage("w", [e.id]).ok).toBe(false);
  });
});

describe("the upload window is measured on an elapsed clock, not the wall clock (#1252 review P2-4)", () => {
  afterEach(() => { vi.useRealTimers(); });
  const png = () => sniffUpload(PNG, "a.png")!;

  it("the wall clock jumping forward does not expire an upload early", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const ledger = new WebFileLedger();
    const a = ledger.storeUpload({ instance: "w", inboxDir: join(dir, "inbox"), bytes: PNG, name: "a.png", type: png() });
    vi.advanceTimersByTime(5 * 60_000);
    vi.setSystemTime(Date.now() + 60 * 60_000);                       // an hour ahead
    ledger.storeUpload({ instance: "w", inboxDir: join(dir, "inbox"), bytes: PNG, name: "b.png", type: png() });   // sweeps
    expect(existsSync(a.path)).toBe(true);
    expect(ledger.takeForMessage("w", [a.id]).ok).toBe(true);
  });

  it("the wall clock jumping back does not keep an upload past its sweep", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const ledger = new WebFileLedger();
    const a = ledger.storeUpload({ instance: "w", inboxDir: join(dir, "inbox"), bytes: PNG, name: "a.png", type: png() });
    vi.setSystemTime(Date.now() - 60 * 60_000);                       // an hour back
    vi.advanceTimersByTime(UPLOAD_TTL_MS + 1_000);                    // the one sweep timer fires
    expect(existsSync(a.path)).toBe(false);
    expect(ledger.read(a.id)).toBeNull();
  });
});

describe("GET /ui/file/<id>", () => {
  beforeEach(() => { vi.stubEnv("AGEND_HOME", dir); });
  const get = async (c: WebApiContext, id: string, headers?: Record<string, string>) => { const r = call("GET", `/ui/file/${id}`, c, { headers }); await r.done(); return r.res; };

  it("an image is shown inline with its own type, sandboxed, not sniffed, not cached", async () => {
    const { c } = ctx();
    const img = (await upload(c, "w", PNG, "a.png")).body;
    const res = await get(c, img.id);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-disposition"]).toBe("inline; filename*=UTF-8''a.png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(String(res.headers["content-security-policy"])).toContain("sandbox");
    expect(res.body).toEqual(PNG);
  });

  it("anything else is a download, served as plain text or octet-stream — never as HTML", async () => {
    const { c } = ctx();
    const html = (await upload(c, "w", Buffer.from("<script>alert(1)</script>"), "x.html")).body;
    const res = await get(c, html.id);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(String(res.headers["content-disposition"])).toMatch(/^attachment; filename\*=UTF-8''x\.html$/);
  });

  it("whatever type a file was registered with, only the four image types are ever served as themselves", async () => {
    const { c } = ctx();
    const page = join(dir, "page.html"); writeFileSync(page, "<script>alert(1)</script>");
    const f = (c as unknown as { webFiles: WebFileLedger }).webFiles.registerServed({ path: page, mime: "text/html", instance: "w" })!;
    const res = await get(c, f.id);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(String(res.headers["content-disposition"])).toMatch(/^attachment;/);
    const svg = join(dir, "x.svg"); writeFileSync(svg, "<svg/>");
    const g = (c as unknown as { webFiles: WebFileLedger }).webFiles.registerServed({ path: svg, mime: "image/svg+xml", instance: "w" })!;
    expect((await get(c, g.id)).headers["content-type"]).toBe("application/octet-stream");
  });

  it("unknown or malformed ids are 404; the route needs the /ui credential", async () => {
    const { c } = ctx();
    expect((await get(c, "f".repeat(32))).status).toBe(404);
    expect((await get(c, "..%2f..%2fetc%2fpasswd")).status).toBe(404);
    const img = (await upload(c, "w", PNG, "a.png")).body;
    expect((await get(c, img.id, { "x-agend-token": "nope".padEnd(48, "x") })).status).toBe(401);
  });
});

describe("deleting an instance stops serving its files", () => {
  it("removeInstance forgets the instance's files once the removal succeeded", async () => {
    vi.stubEnv("AGEND_HOME", dir);
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { authorizeExplicitInstanceRemoval } = await import("../src/instance-removal.js");
    const fm = new FleetManager(dir);
    const any = fm as unknown as Record<string, any>;
    const f = join(dir, "r.txt"); writeFileSync(f, "x");
    const served = fm.webFiles.registerServed({ path: f, instance: "w" })!;
    any.lifecycle = { remove: async () => { throw new Error("refused"); } };
    await expect(fm.removeInstance("w", authorizeExplicitInstanceRemoval("dashboard-confirmed"))).rejects.toThrow();
    expect(fm.webFiles.read(served.id), "a failed removal keeps them").not.toBeNull();
    any.lifecycle = { remove: async () => {} };
    any.statuslineWatcher = { unwatch() {} };
    await fm.removeInstance("w", authorizeExplicitInstanceRemoval("dashboard-confirmed"));
    expect(fm.webFiles.read(served.id)).toBeNull();
  });
});

describe("files an agent attaches to its reply are shown in the web chat", () => {
  it("registered by id when they exist; a missing one is left out; the path never reaches the chat", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(dir);
    const any = fm as unknown as Record<string, any>;
    const events: any[] = [];
    any.emitSseEvent = (event: string, data: unknown) => events.push({ event, data });
    any.getInstanceIdle = () => true; any.clearCancelButton = () => {}; any.reactDone = () => {};
    mkdirSync(join(dir, "out"));
    const chart = join(dir, "out", "chart.png"); writeFileSync(chart, PNG);
    any.afterReplyRouted("w", { text: "here", files: [chart, join(dir, "out", "missing.pdf")] });
    const msg = events.find(e => e.event === "message").data;
    expect(msg.attachments).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{32}$/), kind: "photo", name: "chart.png", size: PNG.length, mime: "image/png" }]);
    expect(JSON.stringify(msg)).not.toContain(join(dir, "out"));
    expect(fm.webFiles.read(msg.attachments[0].id)!.bytes).toEqual(PNG);
  });
});

// ── the page ────────────────────────────────────────────────────────────────────────────────────────────────

describe("chat-render.js: file helpers", () => {
  const SRC = readFileSync(join(process.cwd(), "src", "ui", "chat-render.js"), "utf8");
  const c = vm.createContext({}); vm.runInContext(SRC, c);
  const R = (c as any).AgendChatRender;
  const f = (name: string, size: number) => ({ name, size });

  it("checkFiles keeps what fits and says why it refused the rest", () => {
    const MB = 1024 * 1024;
    const r = R.checkFiles([f("a", 9 * MB)], [f("empty", 0), f("big", 11 * MB), f("b", 9 * MB), f("c", 9 * MB), f("d", 1 * MB)]);
    expect(r.kept.map((x: { name: string }) => x.name)).toEqual(["a", "b", "d"]);
    expect(r.rejected).toEqual([{ name: "empty", reason: "empty" }, { name: "big", reason: "too-large" }, { name: "c", reason: "too-much" }]);
    const six = R.checkFiles([], [1, 2, 3, 4, 5, 6].map(i => f(String(i), 10)));
    expect(six.kept).toHaveLength(5);
    expect(six.rejected).toEqual([{ name: "6", reason: "too-many" }]);
  });

  it("attachmentsHtml: only fleet-issued ids become URLs, names are text, images inline, others downloads", () => {
    const id = "a".repeat(32);
    expect(R.attachmentsHtml([{ id, kind: "photo", name: '"><img src=x onerror=alert(1)>', size: 1 }]))
      .toBe(`<div class="atts"><a class="att-img" href="/ui/file/${id}" target="_blank" rel="noopener noreferrer"><img src="/ui/file/${id}" alt="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;" loading="lazy"></a></div>`);
    expect(R.attachmentsHtml([{ id, kind: "document", name: "r.pdf", size: 2048 }])).toContain(`download="r.pdf">📎 r.pdf <span class="att-size">2.0 KB</span>`);
    expect(R.attachmentsHtml([{ id: "javascript:alert(1)", kind: "photo", name: "x" }, { id: "../etc", kind: "document", name: "y" }])).toBe("");
    expect(R.attachmentsHtml(undefined)).toBe("");
  });
});

describe("dashboard sendMsg with files (the real page script)", () => {
  const RENDER = readFileSync(join(process.cwd(), "src", "ui", "chat-render.js"), "utf8");
  const PAGE = readFileSync(join(process.cwd(), "src", "ui", "dashboard.html"), "utf8").match(/<script>\n([\s\S]*?)<\/script>/)![1]!;
  function page() {
    const nodes: Record<string, any> = { msgIn: { value: "", style: {}, scrollHeight: 20, focus() {} }, messages: { innerHTML: "" }, uptime: {}, failedSend: { textContent: "", append() {} }, pendingFiles: { textContent: "", append() {} } };
    const toasts: string[] = [];
    const c = vm.createContext({
      localStorage: { getItem: () => null }, navigator: { language: "en" },
      document: { addEventListener() {}, getElementById: (n: string) => nodes[n] ?? null, createElement: () => ({ style: {}, remove() {}, append() {} }), body: { appendChild() {} } },
      setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
      fetch: async () => ({ ok: true, json: async () => ({}) }), URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
      EventSource: class { addEventListener() {} },
    });
    vm.runInContext(RENDER, c);
    vm.runInContext(PAGE, c);
    (c as any).captureToast = (m: string) => toasts.push(m);
    vm.runInContext('toast=(m)=>captureToast(m);renderMsgs=()=>{};renderList=()=>{};cur="w";', c);
    return { c, nodes, toasts, read: (s: string) => vm.runInContext(s, c) };
  }

  it("uploads each file, then sends the message naming them", async () => {
    const p = page();
    const calls: unknown[] = [];
    (p.c as any).recordCall = (x: unknown) => calls.push(x);
    p.read(`uploadFile = async (t, f) => { recordCall(["upload", t, f.name]); return { id: f.name === "a.png" ? "${"1".repeat(32)}" : "${"2".repeat(32)}" }; }`);
    p.read(`api = async (m, path, body) => { recordCall(["api", path, body]); return { sent: true }; }`);
    p.read(`pendingFiles.w = [{ name: "a.png", size: 3, type: "image/png" }, { name: "b.txt", size: 2, type: "text/plain" }]`);
    p.nodes.msgIn.value = "with files";
    await p.read("sendMsg()");
    expect(calls).toEqual([
      ["upload", "w", "a.png"], ["upload", "w", "b.txt"],
      ["api", "/ui/send", { instance: "w", message: "with files", attachments: ["1".repeat(32), "2".repeat(32)] }],
    ]);
    expect(p.read("pendingFiles.w.length")).toBe(0);
  });

  it("an upload that fails keeps the files pending and gives the text back, with the server's reason", async () => {
    const p = page();
    p.read(`uploadFile = async (t, f) => { throw new Error(f.name + ": unsupported file type"); }`);
    p.read(`api = async () => { throw new Error("must not be called"); }`);
    p.read(`pendingFiles.w = [{ name: "x.exe", size: 3, type: "" }]`);
    p.nodes.msgIn.value = "keep me";
    await p.read("sendMsg()");
    expect(p.read("pendingFiles.w.map(f => f.name)")).toEqual(["x.exe"]);
    expect(p.nodes.msgIn.value).toBe("keep me");
    expect(p.toasts).toEqual(["x.exe: unsupported file type"]);
  });

  it("files alone can be sent; nothing at all sends nothing", async () => {
    const p = page();
    const calls: unknown[] = [];
    (p.c as any).recordCall = (x: unknown) => calls.push(x);
    p.read(`uploadFile = async () => ({ id: "${"3".repeat(32)}" })`);
    p.read(`api = async (m, path, body) => { recordCall(body); return { sent: true }; }`);
    await p.read("sendMsg()");
    expect(calls).toEqual([]);
    p.read(`pendingFiles.w = [{ name: "a.png", size: 3, type: "image/png" }]`);
    await p.read("sendMsg()");
    expect(calls).toEqual([{ instance: "w", message: "", attachments: ["3".repeat(32)] }]);
  });

  it("files chosen while a send is in flight are never lost when it fails (#1252 review P2-5)", async () => {
    const p = page();
    let fail!: () => void;
    p.read(`uploadFile = async (t, f) => ({ id: "${"4".repeat(32)}" })`);
    (p.c as any).held = new Promise<void>(r => { fail = r; });
    p.read(`api = async () => { await held; return { error: "Instance delivery failed" }; }`);
    p.read(`pendingFiles.w = [0,1,2,3,4].map(i => ({ name: "old" + i, size: 1, type: "text/plain" }))`);
    const sending = p.read("sendMsg()");
    await new Promise(r => setImmediate(r));
    // While the five are on their way, five more are chosen: there is no room — the five in flight still own it.
    p.read(`addFiles([0,1,2,3,4].map(i => ({ name: "new" + i, size: 1, type: "text/plain" })))`);
    expect(p.read("pendingFiles.w.length")).toBe(0);
    expect(p.toasts.filter(t => t.includes("new"))).toHaveLength(5);  // each refusal is said, none is silent
    fail();
    await sending;
    expect(p.read("pendingFiles.w.map(f => f.name)")).toEqual(["old0", "old1", "old2", "old3", "old4"]);
    // With room left, a file chosen meanwhile is kept beside the ones that come back.
    p.read(`pendingFiles.w = [{ name: "a", size: 1, type: "text/plain" }]`);
    (p.c as any).held = new Promise<void>(r => { fail = r; });
    const again = p.read("sendMsg()");
    await new Promise(r => setImmediate(r));
    p.read(`addFiles([{ name: "b", size: 1, type: "text/plain" }])`);
    fail();
    await again;
    expect(p.read("pendingFiles.w.map(f => f.name)")).toEqual(["a", "b"]);
  });

  it("addFiles refuses what does not fit and says why", () => {
    const p = page();
    p.read(`addFiles([{ name: "huge.bin", size: ${11 * 1024 * 1024} }, { name: "ok.png", size: 5 }])`);
    expect(p.read("pendingFiles.w.map(f => f.name)")).toEqual(["ok.png"]);
    expect(p.toasts).toEqual(["huge.bin: over 10 MB"]);
  });
});
