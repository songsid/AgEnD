/**
 * #1937: the web chat's upload limits — configurable (web.upload_max_file_mb / web.upload_max_total_mb), one source for
 * the route, the send, the served-file cap, the page's own check and its words; uploads streamed to disk and counted by
 * the bytes that came; a stalled or endless upload dropped with its part file; the public link's per-file cap; and
 * every other request keeping its old bound on arriving.
 */
import { EventEmitter } from "node:events";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = () => { throw Error("upload cap tests must not spawn any process"); };
  return { ...real, spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});
// #1778 shape: a real FleetManager's pino transport opens <AGEND_HOME>/daemon.log late, racing the scratch home's removal.
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
// The dispatch's receive bound, recorded (and still applied).
const receive = vi.hoisted(() => ({ calls: [] as Array<{ url: string; ms: number }> }));
vi.mock("../src/web-upload.js", async original => {
  const real = await original<typeof import("../src/web-upload.js")>();
  return { ...real, limitRequestReceive: (req: { url?: string } & Parameters<typeof real.limitRequestReceive>[0], ms: number) => { receive.calls.push({ url: req.url ?? "", ms }); return real.limitRequestReceive(req, ms); } };
});

const U = await import("../src/web-upload.js");
const { handleWebRequest, serveAppShell } = await import("../src/web-api.js");
const { bindGatewayRequest } = await import("../src/web-request-context.js");
const { WebSessionStore, csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
const { validateFleetConfig } = await import("../src/config-validator.js");
const { createPublicWebGateway, PUBLIC_GATEWAY_RECEIVE_MS } = await import("../src/public-web-gateway.js");
type WebApiContext = import("../src/web-api.js").WebApiContext;

const MB = 1024 * 1024;
const TOKEN = "u".repeat(48);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "caps-1937-")); vi.stubEnv("AGEND_HOME", dir); receive.calls.length = 0; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const inbox = () => join(dir, "workspaces", "w", "inbox");
const inboxFiles = () => (existsSync(inbox()) ? readdirSync(inbox()) : []);
function ctx(web: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    webToken: TOKEN, dataDir: dir, sseClients: new Set(), fleetConfig: { instances: { w: { working_directory: dir } }, web },
    instanceIpcClients: new Map([["w", { send() {} }]]), adapter: null, logger: { info() {}, debug() {}, warn() {}, error() {} },
    eventLog: null, lastInboundUser: new Map(), deliverToInstance: async () => {}, emitSseEvent: () => {}, getUiStatus: () => ({}),
    webFiles: new U.WebFileLedger({ limits: () => U.uploadLimits((ctxRef.current?.fleetConfig as { web?: Record<string, unknown> } | undefined)?.web) }),
    ...over,
  } as unknown as WebApiContext;
}
/** The ledger reads the context's config, as the fleet's reads its own (set by each test that builds one). */
const ctxRef: { current: WebApiContext | null } = { current: null };
const make = (web: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => { const c = ctx(web, over); ctxRef.current = c; return c; };

describe("uploadLimits: the one source of the numbers", () => {
  it("defaults: 50 MB a file, 5 files, 100 MB a message", () => {
    expect(U.uploadLimits(undefined)).toEqual({ maxFileBytes: 50 * MB, maxFiles: 5, maxTotalBytes: 100 * MB });
    expect(U.UPLOAD_LIMITS).toEqual({ maxFileBytes: 50 * MB, maxFiles: 5, maxTotalBytes: 100 * MB });
  });
  it("the config's sizes, in whole MB within 1–500", () => {
    expect(U.uploadLimits({ upload_max_file_mb: 1, upload_max_total_mb: 500 })).toEqual({ maxFileBytes: 1 * MB, maxFiles: 5, maxTotalBytes: 500 * MB });
    expect(U.uploadLimits({ upload_max_file_mb: 500, upload_max_total_mb: 500 }).maxFileBytes).toBe(500 * MB);
  });
  it.each([0, 501, 1.5, -1, "50", null, Number.NaN])("a value it cannot use (%s) is the default", (v) => {
    expect(U.uploadLimits({ upload_max_file_mb: v, upload_max_total_mb: v })).toEqual({ maxFileBytes: 50 * MB, maxFiles: 5, maxTotalBytes: 100 * MB });
  });
  it("a file is never allowed more than a whole message", () => {
    expect(U.uploadLimits({ upload_max_file_mb: 80, upload_max_total_mb: 30 }).maxFileBytes).toBe(30 * MB);
    expect(U.uploadLimits({ upload_max_total_mb: 20 }).maxFileBytes).toBe(20 * MB);
  });
  it("over the public link a file is at most 95 MB, and says it was lowered", () => {
    expect(U.PUBLIC_LINK_MAX_FILE_BYTES).toBe(95 * MB);
    expect(U.uploadLimits({ upload_max_file_mb: 200, upload_max_total_mb: 300 }, { publicLink: true })).toEqual({ maxFileBytes: 95 * MB, maxFiles: 5, maxTotalBytes: 300 * MB, publicLinkCapped: true });
    expect(U.uploadLimits({ upload_max_file_mb: 95, upload_max_total_mb: 300 }, { publicLink: true }), "at the cap: not lowered").toEqual({ maxFileBytes: 95 * MB, maxFiles: 5, maxTotalBytes: 300 * MB });
    expect(U.uploadLimits(undefined, { publicLink: true })).toEqual(U.uploadLimits(undefined));
    expect(U.uploadLimits({ upload_max_file_mb: 200, upload_max_total_mb: 300 }).maxFileBytes, "this computer's listener: as configured").toBe(200 * MB);
  });
  it("the 413 says the number in force, and why on the public link", () => {
    expect(U.fileTooLargeText(U.uploadLimits({ upload_max_file_mb: 7 }))).toBe("a file can be at most 7 MB");
    expect(U.fileTooLargeText(U.uploadLimits({ upload_max_file_mb: 200, upload_max_total_mb: 200 }, { publicLink: true })))
      .toBe("a file can be at most 95 MB over the public link (its Cloudflare tunnel carries about 100 MB per request)");
    expect(U.mbText(2.5 * MB)).toBe("2.5");
  });
});

describe("UploadSniffer: sniffUpload() as the bytes stream in", () => {
  const sniff = (chunks: Buffer[], name: string) => { const s = new U.UploadSniffer(); for (const c of chunks) s.push(c); return s.result(name); };
  const TEXT = { kind: "document", mime: "text/plain; charset=utf-8", ext: ".txt" };
  const OTHER = (ext: string) => ({ kind: "document", mime: "application/octet-stream", ext });
  const ni = Buffer.from("你好");                                    // two 3-byte characters
  it("a character split across two chunks is still one character: text", () => {
    expect(sniff([ni.subarray(0, 1), ni.subarray(1, 4), ni.subarray(4)], "a.weird")).toEqual(TEXT);
  });
  it("a character cut off at the very end is not valid UTF-8", () => {
    expect(sniff([Buffer.from("ok "), ni.subarray(0, 2)], "a.dat")).toEqual(OTHER(".dat"));
    expect(U.sniffUpload(Buffer.concat([Buffer.from("ok "), ni.subarray(0, 2)]), "a.dat")).toEqual(OTHER(".dat"));
  });
  it("a NUL or a bad byte in a later chunk makes it a download", () => {
    expect(sniff([Buffer.from("plain text "), Buffer.from([0x61, 0x00])], "x.log")).toEqual(OTHER(".log"));
    expect(sniff([Buffer.from("plain text "), Buffer.from([0xc3, 0x28])], "x.log")).toEqual(OTHER(".log"));
  });
  it("a signature split across the first chunks is still read", () => {
    expect(sniff([PNG.subarray(0, 3), PNG.subarray(3), Buffer.alloc(100, 1)], "x")).toEqual({ kind: "photo", mime: "image/png", ext: ".png" });
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
    expect(sniff([webp.subarray(0, 5), webp.subarray(5, 9), webp.subarray(9)], "x")).toEqual({ kind: "photo", mime: "image/webp", ext: ".webp" });
  });
  it("nothing pushed (or only empty chunks): null", () => {
    expect(sniff([], "x")).toBeNull();
    expect(sniff([Buffer.alloc(0)], "x")).toBeNull();
  });
});

describe("fleet.yaml: the validator (its warnings are what agend doctor and the fleet's start show, #1879)", () => {
  const warnings = (web: Record<string, unknown>) => validateFleetConfig({ instances: {}, web } as never).warnings.filter(w => w.path.startsWith("web."));
  it("known keys; whole MB in range: nothing to say", () => {
    expect(warnings({ upload_max_file_mb: 50, upload_max_total_mb: 100 })).toEqual([]);
    expect(validateFleetConfig({ instances: {}, web: { upload_max_file_mb: 50 } } as never).errors).toEqual([]);
  });
  it("a value it cannot use: ignored, and which default applies", () => {
    expect(warnings({ upload_max_file_mb: 0, upload_max_total_mb: "lots" })).toEqual([
      { path: "web.upload_max_file_mb", message: "must be a whole number of MB, 1–500 — ignored, the default 50 MB applies" },
      { path: "web.upload_max_total_mb", message: "must be a whole number of MB, 1–500 — ignored, the default 100 MB applies" },
    ]);
    expect(warnings({ upload_max_file_mb: 501 })).toHaveLength(1);
    expect(warnings({ upload_max_file_mb: 2.5 })).toHaveLength(1);
  });
  it("a file above the message, and above what the public link carries", () => {
    expect(warnings({ upload_max_file_mb: 80, upload_max_total_mb: 60 })).toEqual([
      { path: "web.upload_max_file_mb", message: "is above web.upload_max_total_mb (80 > 60): one file can be at most 60 MB" },
    ]);
    expect(warnings({ upload_max_file_mb: 200, upload_max_total_mb: 300 })).toEqual([
      { path: "web.upload_max_file_mb", message: "over the public link a file stays at 95 MB (a Cloudflare quick tunnel carries about 100 MB per request)" },
    ]);
    expect(warnings({ upload_max_file_mb: 200 }), "held to the default 100 MB message: still over the link's 95").toHaveLength(2);
    expect(warnings({ upload_max_file_mb: 200, upload_max_total_mb: 90 }), "held to a 90 MB message: under the link's 95").toEqual([
      { path: "web.upload_max_file_mb", message: "is above web.upload_max_total_mb (200 > 90): one file can be at most 90 MB" },
    ]);
    expect(warnings({ upload_max_file_mb: 95, upload_max_total_mb: 300 })).toEqual([]);
  });
});

// ── the route, over a real HTTP server ──────────────────────────────────────────────────────────────────────────

async function serve(c: WebApiContext): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => handleWebRequest(req, res, new URL(req.url ?? "/", "http://127.0.0.1"), c));
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}
/** POST the chunks; `length` false: no Content-Length (chunked), as a browser streaming a body may send. */
function post(port: number, path: string, chunks: Buffer[], opts: { length?: boolean; name?: string; abortAfter?: number } = {}) {
  return new Promise<{ status: number; body: any; headers: Record<string, unknown> }>((resolve, reject) => {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const req = request({ host: "127.0.0.1", port, method: "POST", path, headers: { "x-agend-token": TOKEN, "x-agend-filename": opts.name ?? "f.bin", ...(opts.length === false ? {} : { "content-length": String(total) }) } }, res => {
      let b = ""; res.setEncoding("utf8"); res.on("data", (c: string) => { b += c; });
      res.on("end", () => { let body: unknown = null; try { body = JSON.parse(b); } catch { body = b; } resolve({ status: res.statusCode ?? 0, body, headers: res.headers }); });
    });
    req.on("error", (e: NodeJS.ErrnoException) => (opts.abortAfter !== undefined || e.code === "ECONNRESET" || e.code === "EPIPE" ? resolve({ status: -1, body: null, headers: {} }) : reject(e)));
    let i = 0;
    const next = () => {
      if (opts.abortAfter !== undefined && i === opts.abortAfter) { req.destroy(); return; }
      if (i >= chunks.length) { req.end(); return; }
      const ok = req.write(chunks[i++]!);
      if (ok) setImmediate(next); else req.once("drain", next);
    };
    next();
  });
}
const pieces = (bytes: number, first = PNG): Buffer[] => {
  const out: Buffer[] = [first.subarray(0, Math.min(first.length, bytes))];
  let left = bytes - out[0]!.length;
  while (left > 0) { const n = Math.min(left, 256 * 1024); out.push(Buffer.alloc(n, 7)); left -= n; }
  return out;
};

describe("POST /ui/upload: streamed to disk, counted by the bytes that came", () => {
  it("exactly at the configured cap: stored, whole; one byte over: 413 with the number in force, and nothing left behind", async () => {
    const c = make({ upload_max_file_mb: 1 }), s = await serve(c);
    try {
      for (const length of [true, false]) {
        const at = await post(s.port, "/ui/upload?instance=w", pieces(1 * MB), { length });
        expect(at.status, JSON.stringify(at.body)).toBe(200);
        expect(at.body).toMatchObject({ kind: "photo", size: 1 * MB });
        const over = await post(s.port, "/ui/upload?instance=w", pieces(1 * MB + 1), { length });
        expect(over.status).toBe(413);
        expect(over.body).toEqual({ error: "a file can be at most 1 MB", max_bytes: 1 * MB });
      }
      await vi.waitFor(() => expect(inboxFiles().filter(f => f.endsWith(U.PART_SUFFIX))).toEqual([]));
      const stored = inboxFiles();
      expect(stored, "the two at the cap, under their stored names").toHaveLength(2);
      for (const f of stored) { expect(f).toMatch(/^web-pending-\d+-[0-9a-f]{8}\.png$/); expect(statSync(join(inbox(), f)).size).toBe(1 * MB); }
    } finally { await s.close(); }
  }, 30_000);

  it("a change to the config applies to the next upload (agend reload): the route and the message total read it each time", async () => {
    const c = make({ upload_max_file_mb: 1 }), s = await serve(c);
    try {
      expect((await post(s.port, "/ui/upload?instance=w", pieces(1.5 * MB))).status).toBe(413);
      (c.fleetConfig as { web: Record<string, unknown> }).web = { upload_max_file_mb: 2, upload_max_total_mb: 2 };
      const ok = await post(s.port, "/ui/upload?instance=w", pieces(1.5 * MB));
      expect(ok.status).toBe(200);
      const two = await post(s.port, "/ui/upload?instance=w", pieces(1 * MB));
      expect(c.webFiles!.takeForMessage("w", [ok.body.id, two.body.id])).toEqual({ ok: false, error: "the files together are over 2 MB" });
    } finally { await s.close(); }
  }, 30_000);

  it("the client goes away mid-body: its part file goes too", async () => {
    const c = make(), s = await serve(c);
    try {
      const r = await post(s.port, "/ui/upload?instance=w", pieces(4 * MB), { abortAfter: 6 });
      expect(r.status).toBe(-1);
      await vi.waitFor(() => expect(inboxFiles()).toEqual([]));
      expect(c.webFiles!.ownedPaths().size).toBe(0);
    } finally { await s.close(); }
  }, 30_000);

  it("a file over MEDIA_RANGE_MAX downloads streamed from its checked descriptor, every byte; swapped after registering: 404", async () => {
    const c = make(), s = await serve(c);
    try {
      const body = Buffer.concat(pieces(U.MEDIA_RANGE_MAX + 12_345));
      const up = await post(s.port, "/ui/upload?instance=w", [body]);
      expect(up.status).toBe(200);
      const get = (id: string) => new Promise<{ status: number; length: unknown; bytes: Buffer }>((resolve, reject) => {
        const r = request({ host: "127.0.0.1", port: s.port, path: `/ui/file/${id}`, headers: { "x-agend-token": TOKEN } }, res => {
          const parts: Buffer[] = []; res.on("data", (b: Buffer) => parts.push(b)); res.on("end", () => resolve({ status: res.statusCode ?? 0, length: res.headers["content-length"], bytes: Buffer.concat(parts) }));
        });
        r.on("error", reject); r.end();
      });
      const got = await get(up.body.id);
      expect(got.status).toBe(200);
      expect(got.length).toBe(String(body.length));
      expect(Buffer.compare(got.bytes, body)).toBe(0);
      const at = join(inbox(), inboxFiles()[0]!);
      unlinkSync(at); writeFileSync(join(dir, "other"), body); symlinkSync(join(dir, "other"), at);
      expect((await get(up.body.id)).status).toBe(404);
    } finally { await s.close(); }
  }, 30_000);

  it("Prism #1941 P3-2: a video over MEDIA_RANGE_MAX asked whole (no Range) streams too; a Range still answers one slice", async () => {
    const c = make(), s = await serve(c);
    try {
      const body = Buffer.concat(pieces(U.MEDIA_RANGE_MAX + 1_000, Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])));
      mkdirSync(inbox(), { recursive: true });
      const at = join(inbox(), "clip.mp4"); writeFileSync(at, body);
      const served = c.webFiles!.registerServed({ path: at, instance: "w" })!;
      expect(served.mime).toBe("video/mp4");
      const slices = vi.spyOn(c.webFiles!, "readSlice");
      const get = (headers: Record<string, string> = {}) => new Promise<{ status: number; length: unknown; bytes: Buffer }>((resolve, reject) => {
        const r = request({ host: "127.0.0.1", port: s.port, path: `/ui/file/${served.id}`, headers: { "x-agend-token": TOKEN, ...headers } }, res => {
          const parts: Buffer[] = []; res.on("data", (b: Buffer) => parts.push(b)); res.on("end", () => resolve({ status: res.statusCode ?? 0, length: res.headers["content-length"], bytes: Buffer.concat(parts) }));
        });
        r.on("error", reject); r.end();
      });
      const whole = await get();
      expect(whole.status).toBe(200);
      expect(whole.length).toBe(String(body.length));
      expect(Buffer.compare(whole.bytes, body)).toBe(0);
      expect(slices, "never read whole into memory").not.toHaveBeenCalled();
      const ranged = await get({ range: "bytes=0-" });
      expect(ranged.status).toBe(206);
      expect(ranged.bytes.length).toBe(U.MEDIA_RANGE_MAX);
      expect(slices).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  }, 30_000);

  it("a file larger than 50 MB may be served when uploads that large are allowed (the served cap follows the upload cap)", () => {
    const ledger = new U.WebFileLedger({ limits: () => U.uploadLimits({ upload_max_file_mb: 120, upload_max_total_mb: 200 }) });
    expect(ledger.maxServedBytes()).toBe(120 * MB);
    expect(new U.WebFileLedger().maxServedBytes()).toBe(U.MAX_SERVED_BYTES);
    expect(new U.WebFileLedger({ limits: () => U.uploadLimits({ upload_max_file_mb: 5 }) }).maxServedBytes(), "never below 50 MB").toBe(U.MAX_SERVED_BYTES);
  });
});

// ── the route's own clocks, and what a request says about itself (a request driven by hand) ─────────────────────

function fakeUpload(c: WebApiContext, headers: Record<string, string> = {}, opts: { publicLink?: { cookie: string; csrf: string; isCurrent?: () => boolean } } = {}) {
  const req = Object.assign(new EventEmitter(), {
    method: "POST", url: "/ui/upload?instance=w", complete: false, destroyed: 0,
    headers: opts.publicLink
      ? { host: "sample.trycloudflare.com", cookie: opts.publicLink.cookie, origin: "https://sample.trycloudflare.com", "sec-fetch-site": "same-origin", "x-agend-csrf": opts.publicLink.csrf, "x-agend-filename": "f.bin", ...headers }
      : { "x-agend-token": TOKEN, "x-agend-filename": "f.bin", ...headers },
    destroy() { req.destroyed++; }, resume() {}, pause() {},
  });
  if (opts.publicLink) bindGatewayRequest(req as never, { surface: "gateway", exposureId: "a".repeat(32), expectedOrigin: "https://sample.trycloudflare.com", isCurrent: opts.publicLink.isCurrent ?? (() => true) });
  const res = Object.assign(new EventEmitter(), { status: 0, body: null as any, headersSent: false, destroyed: false, setHeader() {},
    writeHead(st: number) { res.status = st; return res; }, end(b?: unknown) { res.body = b ? JSON.parse(String(b)) : null; return res; } });
  handleWebRequest(req as never, res as never, new URL(`${opts.publicLink ? "https://sample.trycloudflare.com" : "http://localhost"}/ui/upload?instance=w`), c);
  const end = () => { req.complete = true; req.emit("end"); };
  return { req, res, end };
}
/** Let the part file's open and writes land (the write stream is asynchronous). */
const settleIo = () => new Promise<void>(r => setTimeout(r, 30));

describe("POST /ui/upload: its clocks and its counting", () => {
  it("Content-Length that lies low: counted by the bytes that came — over the cap is 413, and the part file goes", async () => {
    const c = make({ upload_max_file_mb: 1 });
    const u = fakeUpload(c, { "content-length": "10" });
    u.req.emit("data", Buffer.concat(pieces(1 * MB)));
    expect(u.res.status).toBe(0);
    u.req.emit("data", Buffer.from([1]));
    expect(u.res.status).toBe(413);
    expect(u.req.destroyed, "a body still arriving is stopped").toBe(1);
    await vi.waitFor(() => expect(inboxFiles()).toEqual([]));
  });
  it("Content-Length over the cap: 413 before a byte is read; nothing is created", () => {
    const c = make({ upload_max_file_mb: 1 });
    const u = fakeUpload(c, { "content-length": String(1 * MB + 1) });
    expect(u.res.status).toBe(413);
    expect(existsSync(join(dir, "workspaces"))).toBe(false);
  });
  it("a minute without a byte: dropped with 408, its part file removed; data in time keeps it going", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = make();
    const u = fakeUpload(c);
    for (let i = 0; i < 3; i++) { vi.advanceTimersByTime(U.UPLOAD_STALL_MS - 1_000); u.req.emit("data", Buffer.from("abc")); }
    expect(u.res.status, "a byte every 59 s is not a stall").toBe(0);
    vi.advanceTimersByTime(U.UPLOAD_STALL_MS);
    expect(u.res.status).toBe(408);
    expect(u.res.body).toEqual({ error: "the upload stalled — attach the file again" });
    expect(u.req.destroyed).toBe(1);
    vi.useRealTimers(); await settleIo();
    expect(inboxFiles()).toEqual([]);
  });
  it("over 30 minutes in all: dropped with 408 even while bytes keep coming", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = make();
    const u = fakeUpload(c);
    for (let t = 0; t < U.UPLOAD_MAX_MS - 30_000; t += 30_000) { vi.advanceTimersByTime(30_000); u.req.emit("data", Buffer.from("x")); }
    expect(u.res.status).toBe(0);
    vi.advanceTimersByTime(30_000);
    expect(u.res.status).toBe(408);
    expect(u.res.body).toEqual({ error: "the upload took too long — attach the file again" });
    vi.useRealTimers(); await settleIo();
    expect(inboxFiles()).toEqual([]);
  });
  it("an upload that ends is not dropped later by its clocks", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = make();
    const u = fakeUpload(c);
    u.req.emit("data", PNG); u.end();
    vi.useRealTimers();
    await vi.waitFor(() => expect(u.res.status).toBe(200));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.advanceTimersByTime(U.UPLOAD_MAX_MS + 1);
    expect(u.req.destroyed).toBe(0);
    vi.useRealTimers();
    expect(inboxFiles()).toHaveLength(1);
  });
  it("the connection closes before the body is whole (no error event): dropped, its part file removed", async () => {
    const c = make();
    const u = fakeUpload(c);
    u.req.emit("data", Buffer.from("partial"));
    await settleIo();
    expect(inboxFiles().filter(f => f.endsWith(U.PART_SUFFIX))).toHaveLength(1);
    u.req.emit("close");
    await settleIo();
    expect(existsSync(join(dir, "workspaces", "w"))).toBe(false);
    u.req.emit("end");                                              // anything after is ignored
    expect(u.res.status).toBe(0);
  });
  it("Prism #1941 P3-1: a part file whose open fails takes back the directories made for it — never one that was there", () => {
    const fail = (() => { throw Object.assign(new Error("too many open files"), { code: "EMFILE" }); }) as unknown as typeof import("node:fs").openSync;
    expect(() => U.createPartFile(inbox(), fail)).toThrow("too many open files");
    expect(existsSync(join(dir, "workspaces")), "all made here: all gone").toBe(false);
    mkdirSync(join(dir, "workspaces", "w"), { recursive: true });
    expect(() => U.createPartFile(inbox(), fail)).toThrow();
    expect(existsSync(inbox())).toBe(false);
    expect(existsSync(join(dir, "workspaces", "w")), "the workspace was there already").toBe(true);
    const ok = U.createPartFile(inbox());
    expect(existsSync(ok.path)).toBe(true);
    closeSync(ok.fd);
  });
  it("an empty body: 415, and nothing left (not even the inbox made for it)", async () => {
    const c = make();
    const u = fakeUpload(c);
    u.end();
    expect(u.res.status).toBe(415);
    await settleIo();
    expect(existsSync(join(dir, "workspaces", "w"))).toBe(false);
  });

  function publicSession(c: WebApiContext) {
    const sessions = new WebSessionStore();
    const s = sessions.create({ tier: "admin", surface: "gateway", exposureId: "a".repeat(32), label: "t", tokenEpoch: tokenEpoch(TOKEN) } as never);
    (c as unknown as { webSessions: unknown }).webSessions = sessions;
    return { cookie: `__Host-agend_session=${s.sessionId}`, csrf: csrfTokenFor(s.sessionId), revoke: () => sessions.revokeById(s.sessionId) };
  }
  it("Prism #1941 P2-1: the session revoked, or the public link closed, while the write finishes: nothing is stored", async () => {
    const c = make();
    const stored = () => inboxFiles().filter(f => !f.endsWith(U.PART_SUFFIX));
    // Unchanged: stored.
    const ok = fakeUpload(c, {}, { publicLink: publicSession(c) });
    ok.req.emit("data", PNG); ok.end();
    await vi.waitFor(() => expect(ok.res.status).toBe(200));
    expect(stored()).toHaveLength(1);
    // Revoked after the body ended, before the write's finish (which is asynchronous): refused, nothing more stored.
    const pub = publicSession(c);
    const revoked = fakeUpload(c, {}, { publicLink: pub });
    revoked.req.emit("data", PNG); revoked.end();
    expect(revoked.res.status, "the end-of-body check passed").toBe(0);
    pub.revoke();
    await vi.waitFor(() => expect(revoked.res.status).toBe(401));
    // The public link closed in the same wait.
    let open = true;
    const closing = fakeUpload(c, {}, { publicLink: { ...publicSession(c), isCurrent: () => open } });
    closing.req.emit("data", PNG); closing.end();
    expect(closing.res.status).toBe(0);
    open = false;
    await vi.waitFor(() => expect(closing.res.status).not.toBe(0));
    expect(closing.res.status).not.toBe(200);
    await settleIo();
    expect(stored(), "only the unchanged one").toHaveLength(1);
    expect(inboxFiles().filter(f => f.endsWith(U.PART_SUFFIX)), "their part files went too").toEqual([]);
  });
  it("over the public link a file is at most 95 MB whatever the config says — and the 413 says why", async () => {
    const c = make({ upload_max_file_mb: 200, upload_max_total_mb: 300 });
    const pub = publicSession(c);
    const over = fakeUpload(c, { "content-length": String(95 * MB + 1) }, { publicLink: pub });
    expect(over.res.status).toBe(413);
    expect(over.res.body).toEqual({ error: "a file can be at most 95 MB over the public link (its Cloudflare tunnel carries about 100 MB per request)", max_bytes: 95 * MB, public_link: true });
    const at = fakeUpload(c, { "content-length": String(95 * MB) }, { publicLink: pub });
    expect(at.res.status, "at the cap: read").toBe(0);
    at.req.emit("data", PNG); at.end();
    await vi.waitFor(() => expect(at.res.status).toBe(200));
    // This computer's listener: the configured 200 MB.
    const local = fakeUpload(c, { "content-length": String(95 * MB + 1) });
    expect(local.res.status).toBe(0);
    local.req.emit("data", PNG); local.end();
    await vi.waitFor(() => expect(local.res.status).toBe(200));
  });
});

// ── what each listener allows for receiving a request ──────────────────────────────────────────────────────────

describe("receiving a request: the upload's own clocks, the old bound for everything else", () => {
  it("isUploadRequest: POST /ui/upload only", () => {
    expect(U.isUploadRequest({ method: "POST", url: "/ui/upload?instance=w" })).toBe(true);
    expect(U.isUploadRequest({ method: "POST", url: "/ui/upload" })).toBe(true);
    expect(U.isUploadRequest({ method: "GET", url: "/ui/upload" })).toBe(false);
    expect(U.isUploadRequest({ method: "POST", url: "/ui/uploads" })).toBe(false);
    expect(U.isUploadRequest({ method: "POST", url: "/ui/send" })).toBe(false);
  });
  it("limitRequestReceive: not whole in time, its connection is dropped; whole in time, or closed, it is left alone", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const mk = () => { const destroy = vi.fn(); return Object.assign(new EventEmitter(), { complete: false, socket: { destroy } }); };
    const slow = mk(); U.limitRequestReceive(slow, 10_000);
    vi.advanceTimersByTime(9_999); expect(slow.socket.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(slow.socket.destroy).toHaveBeenCalledTimes(1);
    const whole = mk(); U.limitRequestReceive(whole, 10_000); whole.complete = true;
    vi.advanceTimersByTime(10_000); expect(whole.socket.destroy).not.toHaveBeenCalled();
    const closed = mk(); U.limitRequestReceive(closed, 10_000); closed.emit("close");
    vi.advanceTimersByTime(10_000); expect(closed.socket.destroy).not.toHaveBeenCalled();
  });
  it("the fleet's dispatch: no bound for an upload; 10 s for any other public-link request; Node's old 300 s here", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(dir) as any;
    fm.fleetConfig = { instances: { w: { working_directory: dir } }, defaults: {} };
    fm.initializeWebAuthTokens();
    const fire = (url: string, publicLink = false) => {
      const req = Object.assign(new EventEmitter(), { method: "POST", url, headers: { host: publicLink ? "sample.trycloudflare.com" : "127.0.0.1" }, complete: false, socket: { destroy() {} }, resume() {}, destroy() {} });
      if (publicLink) bindGatewayRequest(req as never, { surface: "gateway", exposureId: "a".repeat(32), expectedOrigin: "https://sample.trycloudflare.com", isCurrent: () => true });
      const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, getHeader() { return undefined; }, writeHead() { return res; }, end() { return res; }, write() { return true; } });
      try { fm.dispatchWebHttp(req, res, 19280); } catch { /* the route's own answer is not what is checked */ }
    };
    fire("/ui/upload?instance=w"); fire("/ui/upload?instance=w", true);
    fire("/ui/send"); fire("/ui/send", true);
    expect(receive.calls).toEqual([{ url: "/ui/send", ms: 300_000 }, { url: "/ui/send", ms: PUBLIC_GATEWAY_RECEIVE_MS }]);
    expect(PUBLIC_GATEWAY_RECEIVE_MS).toBe(10_000);
    fm.startHealthServer(0);
    try { expect(fm.healthServer.requestTimeout).toBe(U.UPLOAD_REQUEST_TIMEOUT_MS); } finally { await new Promise<void>(r => fm.healthServer.close(() => r())); }
  }, 30_000);
  it("the public gateway's listener allows an upload's time too (its 10 s is per request, above)", () => {
    const g = createPublicWebGateway({ exposureId: "e", isCurrent: () => true, isOpen: () => true, dispatch: () => {} });
    expect(g.server.requestTimeout).toBe(U.UPLOAD_REQUEST_TIMEOUT_MS);
    expect(g.server.headersTimeout).toBe(5_000);
    expect(U.UPLOAD_REQUEST_TIMEOUT_MS).toBeGreaterThan(U.UPLOAD_MAX_MS);
  });
});

// ── the page ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the page: the limits in force, and words with their numbers", () => {
  function shellBody(web: Record<string, unknown>, publicLink: boolean): Record<string, unknown> | null {
    const req: any = Object.assign(new EventEmitter(), { method: "GET", url: "/ui", headers: { host: publicLink ? "x.trycloudflare.com" : "127.0.0.1:19280" } });
    if (publicLink) bindGatewayRequest(req, { surface: "gateway", exposureId: "e1", expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
    let body = "";
    serveAppShell(req, { setHeader() {}, writeHead() {}, end(t: string) { body = t; } } as never, { fleetConfig: { web } } as never, "full");
    const m = /<body[^>]* data-upload-limits="([^"]*)"/.exec(body);
    return m ? JSON.parse(m[1]!.replace(/&#(\d+);/g, (_x, n) => String.fromCharCode(Number(n)))) : null;
  }
  it("<body data-upload-limits> carries uploadLimits() for this page — the public link's cap included", () => {
    expect(shellBody({}, false)).toEqual({ maxFileBytes: 50 * MB, maxFiles: 5, maxTotalBytes: 100 * MB });
    expect(shellBody({ upload_max_file_mb: 200, upload_max_total_mb: 300 }, false)).toEqual({ maxFileBytes: 200 * MB, maxFiles: 5, maxTotalBytes: 300 * MB });
    expect(shellBody({ upload_max_file_mb: 200, upload_max_total_mb: 300 }, true)).toEqual({ maxFileBytes: 95 * MB, maxFiles: 5, maxTotalBytes: 300 * MB, publicLinkCapped: true });
  });

  const SRC = readFileSync(join(process.cwd(), "src", "ui", "chat-render.js"), "utf8");
  const render = (limits?: string) => {
    const c = vm.createContext(limits === undefined ? {} : { document: { body: { dataset: { uploadLimits: limits } } } });
    vm.runInContext(SRC, c);
    return (c as any).AgendChatRender;
  };
  it("chat-render reads the page's limits (and the defaults without them, or with a malformed one)", () => {
    const R = render(JSON.stringify({ maxFileBytes: 2 * MB, maxFiles: 3, maxTotalBytes: 3 * MB }));
    const f = (name: string, size: number) => ({ name, size });
    const r = R.checkFiles([], [f("at", 2 * MB), f("over", 2 * MB + 1), f("b", 1 * MB), f("c", 1)]);
    expect(r.kept.map((x: { name: string }) => x.name)).toEqual(["at", "b"]);
    expect(r.rejected).toEqual([{ name: "over", reason: "too-large" }, { name: "c", reason: "too-much" }]);
    expect(R.checkFiles([], [1, 2, 3, 4].map(i => f(String(i), 1))).rejected).toEqual([{ name: "4", reason: "too-many" }]);
    for (const bad of [undefined, "not json", JSON.stringify({ maxFileBytes: 0, maxFiles: 5, maxTotalBytes: 1 }), JSON.stringify({ maxFileBytes: "1" })]) {
      expect(render(bad).fileLimits()).toEqual({ maxFileBytes: 50 * MB, maxFiles: 5, maxTotalBytes: 100 * MB, publicLinkCapped: false });
    }
  });
  it("a refusal's words carry the numbers in force; over the public link it says that is the link's limit", () => {
    const R = render(JSON.stringify({ maxFileBytes: 2.5 * MB, maxFiles: 3, maxTotalBytes: 7 * MB }));
    expect(R.fileRejection("too-large")).toEqual({ key: "chat.file_too_large", values: ["2.5"] });
    expect(R.fileRejection("too-many")).toEqual({ key: "chat.file_too_many", values: [3] });
    expect(R.fileRejection("too-much")).toEqual({ key: "chat.file_too_much", values: ["7"] });
    expect(R.fileRejection("empty")).toEqual({ key: "chat.file_empty", values: [] });
    expect(render(JSON.stringify({ maxFileBytes: 95 * MB, maxFiles: 5, maxTotalBytes: 300 * MB, publicLinkCapped: true })).fileRejection("too-large"))
      .toEqual({ key: "chat.file_too_large_public", values: ["95"] });
  });
  it("the strings, EN and zh-TW, take the numbers — none is written into them", () => {
    const src = readFileSync(join(process.cwd(), "src", "ui", "chat-strings.js"), "utf8");
    for (const key of ["file_too_large", "file_too_large_public", "file_too_many", "file_too_much"]) {
      const all = [...src.matchAll(new RegExp(`\\b${key}: "([^"]*)"`, "g"))].map(m => m[1]!);
      expect(all, key).toHaveLength(2);
      for (const s of all) { expect(s, key).toContain("{0}"); expect(s.replace("{0}", ""), key).not.toMatch(/\d/); }
    }
  });
});
