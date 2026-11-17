import { createServer, request, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, truncateSync } from "node:fs";
import * as fsAsync from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readReplyPreview } from "../src/reply-preview-files.js";
import { ReplyArgs } from "../src/outbound-schemas.js";
import { handleWebRequest, serveAppShell } from "../src/web-api.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

vi.mock("node:fs/promises", async original => { const fs = await original<typeof import("node:fs/promises")>(); return { ...fs, open: vi.fn(fs.open) }; });
const token = "c".repeat(48), exposureId = "a".repeat(32), sessions = new WebSessionStore();
let server: Server, port: number, dir: string, root: string, ctx: any;
const session = (tier: "admin" | "read" | "guest", gateway: boolean) => sessions.create({ tier, surface: gateway ? "gateway" : "local", label: "fixture", tokenEpoch: tokenEpoch(token), ...(gateway ? { exposureId } : {}), ...(tier === "guest" ? { owner: { adapterId: "discord", userId: "900000000000000099" } } : {}) }).sessionId;
async function get(path: string, opts: { tier?: "admin" | "read" | "guest"; gateway?: boolean; anonymous?: boolean; range?: string } = {}): Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }> {
  const gateway = opts.gateway === true;
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: gateway ? "fleet.example.com" : `127.0.0.1:${port}`, ...(!opts.anonymous ? { cookie: `${gateway ? "__Host-" : ""}agend_session=${session(opts.tier ?? "admin", gateway)}` } : {}), ...(gateway ? { "x-rig-gateway": "1" } : {}), ...(opts.range ? { range: opts.range } : {}) } }, res => {
      const chunks: Buffer[] = []; res.on("data", b => chunks.push(Buffer.from(b))); res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks), headers: res.headers }));
    }); req.on("error", reject); req.end();
  });
}
const endpoint = (path: string, op = "meta") => "/ui/reply-preview?" + new URLSearchParams({ instance: "agent-alpha", path, op });
beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("X-Frame-Options", "DENY"); // The real dashboard host guard default.
    if (req.headers["x-rig-gateway"] === "1") bindGatewayRequest(req, { surface: "gateway", exposureId, expectedOrigin: "https://fleet.example.com", isCurrent: () => true });
    if (req.url === "/ui/rig-shell") { serveAppShell(req, res, ctx, "full"); return; }
    if (!handleWebRequest(req, res, new URL(req.url ?? "/", `http://127.0.0.1:${port}`), ctx)) { res.writeHead(404); res.end('{"error":"not_found"}'); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); port = (server.address() as { port: number }).port;
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reply-preview-")); root = join(dir, "project"); mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/app.ts"), "export const changed = true;\n"); writeFileSync(join(dir, "outside.txt"), "Outside fixture text");
  ctx = { webToken: token, webSessions: sessions, fleetConfig: { instances: { "agent-alpha": { backend: "codex", working_directory: root } } }, daemons: new Map(), logger: { info() {}, debug() {}, warn() {}, error() {} } };
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

describe("M-3283 reply preview arguments", () => {
  it("keeps structured relative paths and inclusive line ranges", () => {
    const previews = [{ path: "src/app.ts", line: 1000, endLine: 1002 }];
    expect((ReplyArgs.parse({ text: "Changed the code.", previews }) as any).previews).toEqual(previews);
  });
  it.each(["../outside.txt", "/tmp/outside.txt", "C:/outside.txt", "src/../app.ts", "src\\app.ts", "file:///tmp/app.ts", "src/app.ts\u0000"])("refuses a non-relative or traversing preview path: %s", path => {
    expect(ReplyArgs.safeParse({ text: "Changed.", previews: [{ path }] }).success).toBe(false);
  });
  it.each([{ line: 0 }, { line: -1 }, { line: 3, endLine: 2 }, { endLine: 5 }])("refuses an invalid line range %j", range => {
    expect(ReplyArgs.safeParse({ text: "Changed.", previews: [{ path: "src/app.ts", ...range }] }).success).toBe(false);
  });
});
describe("M-3283 the narrow preview read path", () => {
  it.each([false, true])("reads only the agent's file for an admin session (gateway=%s)", async gateway => {
    const r = await get(endpoint("src/app.ts"), { gateway });
    expect(r.status).toBe(200); expect(JSON.parse(r.body.toString())).toMatchObject({ kind: "text", path: "src/app.ts", text: "export const changed = true;\n" });
  });
  it.each(["guest", "read"] as const)("refuses %s sessions on either listener", async tier => {
    for (const gateway of [false, true]) { const r = await get(endpoint("src/app.ts"), { tier, gateway }); expect(r.status).toBeGreaterThanOrEqual(400); expect(r.body.toString()).not.toContain("export const"); }
  });
  it("refuses anonymous requests", async () => { expect((await get(endpoint("src/app.ts"), { anonymous: true })).status).toBeGreaterThanOrEqual(400); });
  it.each(["../outside.txt", "src/../../outside.txt", "/etc/passwd", "C:/Windows/example.txt"])("does not read a path outside the folder: %s", async path => {
    const r = await get(endpoint(path)); expect(r.status).toBeGreaterThanOrEqual(400); expect(r.body.toString()).not.toContain("Outside fixture text");
  });
  it.skipIf(process.platform === "win32")("refuses a final or parent symlink escape", async () => {
    symlinkSync(join(dir, "outside.txt"), join(root, "linked.txt")); symlinkSync(dir, join(root, "linked-dir"));
    for (const path of ["linked.txt", "linked-dir/outside.txt"]) { const r = await get(endpoint(path)); expect(r.status).toBeGreaterThanOrEqual(400); expect(r.body.toString()).not.toContain("Outside fixture text"); }
  });
  it("reports a missing file without exposing absolute host paths", async () => {
    const r = await get(endpoint("missing.txt")); expect(r.status).toBe(404); expect(JSON.parse(r.body.toString()).error).toBe("not_found"); expect(r.body.toString()).not.toContain(root);
  });
});

describe("asset and current-binding controls", () => {
  it("serves a local image and bounded PDF byte ranges without exposing text as raw HTML", async () => {
    writeFileSync(join(root, "picture.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const pdf = "%PDF-1.4\nExample fixture\n"; writeFileSync(join(root, "example.pdf"), pdf);
    expect(JSON.parse((await get(endpoint("picture.png"))).body.toString()).kind).toBe("image");
    const image = await get(endpoint("picture.png", "raw")); expect(image.status).toBe(200); expect(image.headers["content-type"]).toBe("image/png"); expect(image.headers["cache-control"]).toContain("no-store");
    const part = await get(endpoint("example.pdf", "raw"), { range: "bytes=0-4", gateway: true });
    expect(part.status).toBe(206); expect(part.body.toString()).toBe("%PDF-"); expect(part.headers["content-range"]).toBe(`bytes 0-4/${Buffer.byteLength(pdf)}`);
    expect(part.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(part.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
    expect(image.headers["x-frame-options"]).toBe("DENY");
    expect((await get(endpoint("example.pdf", "raw"), { range: "bytes=999999-" })).status).toBe(416);
    expect((await get(endpoint("src/app.ts", "raw"))).status).toBeGreaterThanOrEqual(400);
  });
  it("rejects fake PDFs and hidden credentials", async () => {
    writeFileSync(join(root, "fake.pdf"), "ordinary text"); writeFileSync(join(root, ".env"), "EXAMPLE_SECRET=fixture");
    for (const path of ["fake.pdf", ".env"]) expect((await get(endpoint(path))).status).toBeGreaterThanOrEqual(400);
  });
  it("returns the agreed explicit remote Windows limitation", async () => {
    ctx.fleetConfig.instances["agent-alpha"].runtime = "windows";
    const r = await get(endpoint("src/app.ts")); expect(r.status).toBe(403); expect(JSON.parse(r.body.toString()).message).toBe("previews of files on a paired Windows computer aren't available yet");
  });
});

describe("async read fences", () => {
  it("drops a read if the configured working folder changes while opening the file", async () => {
    const realOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    vi.mocked(fsAsync.open).mockImplementation((async (...args: Parameters<typeof fsAsync.open>) => {
      const handle = await realOpen(...args);
      ctx.fleetConfig.instances["agent-alpha"].working_directory = join(dir, "other-project");
      return handle;
    }) as typeof fsAsync.open);
    const r = await get(endpoint("src/app.ts"));
    expect(r.status).toBeGreaterThanOrEqual(400); expect(r.body.toString()).not.toContain("export const"); expect(JSON.parse(r.body.toString()).error).toBe("preview_changed");
    vi.mocked(fsAsync.open).mockImplementation(realOpen);
  });
});

describe("the app shell permits only the admin file frame", () => {
  it.each([false, true])("keeps the HTML preview frame and adds the exact file endpoint (gateway=%s)", async gateway => {
    const preview = { previewOrigin: "https://preview.example.com", frameSrc: "https://preview.example.com/frame", boot: "fixture", ok: true };
    ctx.previewForUi = () => preview; ctx.publicPreviewForUi = () => preview;
    const r = await get("/ui/rig-shell", { gateway }); expect(r.status).toBe(200);
    const csp = String(r.headers["content-security-policy"]), frame = /(?:^|;)\s*frame-src ([^;]+)/.exec(csp)?.[1];
    expect(frame).toContain("https://preview.example.com/frame");
    expect(frame?.split(" ")).toContain((gateway ? "https://fleet.example.com" : `http://127.0.0.1:${port}`) + "/ui/reply-preview");
    expect(frame?.split(" ")).not.toContain("'self'");
  });
  it.each(["read", "guest"] as const)("adds no file-frame source for a %s session", async tier => {
    for (const gateway of [false, true]) expect(String((await get("/ui/rig-shell", { tier, gateway })).headers["content-security-policy"])).not.toContain("/ui/reply-preview");
  });
});

describe("R1 protected folders and raw memory bounds", () => {
  it.each(["general", "coordinator"])("does not expose a %s folder on either listener", async kind => {
    const cfg = ctx.fleetConfig.instances["agent-alpha"];
    if (kind === "general") cfg.general_topic = true; else cfg.tool_set = "coordinator";
    writeFileSync(join(root, "fleet.yaml"), "inline_fixture: " + "x".repeat(32));
    for (const gateway of [false, true]) {
      const r = await get(endpoint("fleet.yaml"), { gateway });
      expect(r.status).toBe(404); expect(JSON.parse(r.body.toString()).error).toBe("workspace_not_offered");
      expect(r.body.toString()).not.toContain("inline_fixture");
    }
  });
  it("streams a 50 MiB unranged raw read without a whole-file allocation", async () => {
    const size = 50 * 1024 * 1024, file = join(root, "large.pdf");
    writeFileSync(file, "%PDF-1.4\n"); truncateSync(file, size);
    const allocations = vi.spyOn(Buffer, "alloc");
    const received = await new Promise<{ status: number; bytes: number }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: endpoint("large.pdf", "raw"), headers: { cookie: `agend_session=${session("admin", false)}` } }, res => {
        let bytes = 0; res.on("data", b => { bytes += b.length; }); res.on("end", () => resolve({ status: res.statusCode!, bytes })); res.on("error", reject);
      }); req.on("error", reject); req.end();
    });
    expect(received).toEqual({ status: 200, bytes: size });
    expect(Math.max(...allocations.mock.calls.map(args => Number(args[0])))).toBeLessThanOrEqual(64 * 1024);
    const range = await get(endpoint("large.pdf", "raw"), { range: "bytes=0-6291455" });
    expect(range.status).toBe(206); expect(range.body.length).toBe(4 * 1024 * 1024);
    expect(range.headers["content-range"]).toBe(`bytes 0-4194303/${size}`);
  }, 20_000);
});

describe("R1 stream ownership fences", () => {
  it("stops a retired raw read and closes its opened descriptor", async () => {
    const file = join(root, "stream.pdf"); writeFileSync(file, "%PDF-1.4\n"); truncateSync(file, 256 * 1024);
    const realOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    let opened: Awaited<ReturnType<typeof realOpen>> | undefined;
    vi.mocked(fsAsync.open).mockImplementation((async (...args: Parameters<typeof fsAsync.open>) => opened = await realOpen(...args)) as typeof fsAsync.open);
    let current = true;
    const result = await readReplyPreview(root, join(dir, "state"), "stream.pdf", true, () => current);
    if (result.kind !== "raw") throw Error("expected raw fixture");
    const iterator = result.chunks[Symbol.asyncIterator](); expect((await iterator.next()).done).toBe(false);
    current = false; await expect(iterator.next()).rejects.toMatchObject({ code: "preview_changed" });
    expect(opened?.fd).toBe(-1); await result.close();
    vi.mocked(fsAsync.open).mockImplementation(realOpen);
  });
  it("can close an opened raw read before iteration starts", async () => {
    writeFileSync(join(root, "never-started.pdf"), "%PDF-1.4\nfixture");
    const realOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    let opened: Awaited<ReturnType<typeof realOpen>> | undefined;
    vi.mocked(fsAsync.open).mockImplementation((async (...args: Parameters<typeof fsAsync.open>) => opened = await realOpen(...args)) as typeof fsAsync.open);
    const result = await readReplyPreview(root, join(dir, "state"), "never-started.pdf", true, () => true);
    if (result.kind !== "raw") throw Error("expected raw fixture");
    await result.close(); expect(opened?.fd).toBe(-1); await result.close();
    vi.mocked(fsAsync.open).mockImplementation(realOpen);
  });
});

describe("R1 offered-role fence", () => {
  it("refuses a role that becomes coordinator while the file is opening", async () => {
    const realOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    vi.mocked(fsAsync.open).mockImplementation((async (...args: Parameters<typeof fsAsync.open>) => {
      const handle = await realOpen(...args); ctx.fleetConfig.instances["agent-alpha"].tool_set = "coordinator"; return handle;
    }) as typeof fsAsync.open);
    const r = await get(endpoint("src/app.ts")); expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(r.body.toString()).error).toBe("preview_changed"); expect(r.body.toString()).not.toContain("export const");
    vi.mocked(fsAsync.open).mockImplementation(realOpen);
  });
});
