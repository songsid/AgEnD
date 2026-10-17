import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
let handler: any;
vi.mock("node:http", async importOriginal => ({ ...await importOriginal<typeof import("node:http")>(), createServer: (fn: any) => {
  handler = fn; return { listen(_port: number, _host: string, done: () => void) { done(); }, close(done: () => void) { done(); } };
} }));
const { createTelegramMock } = await import("../e2e/mock-servers/telegram-mock.js");
afterEach(() => vi.restoreAllMocks());
describe("mock Telegram HTTP error disclosure", () => {
  it("the actual request handler keeps parser detail out of HTTP and logs it locally", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {}), mock = createTelegramMock({ port: 0 });
    await mock.start();
    try {
      const req = Object.assign(new PassThrough(), { method: "POST", url: "/botfixture/sendMessage" });
      const res = { headersSent: false, writeHead: vi.fn(), end: vi.fn() }, work = handler(req, res);
      req.emit("error", new Error("private_parser_sentinel")); await work;
      expect(res.writeHead).toHaveBeenCalledWith(500, { "Content-Type": "application/json" });
      expect(JSON.parse(res.end.mock.calls[0]![0])).toEqual({ ok: false, error: "Internal mock error" });
      expect(res.end.mock.calls[0]![0]).not.toContain("private_parser_sentinel"); expect(log).toHaveBeenCalledOnce(); expect(log.mock.calls[0]![1]).toBeInstanceOf(Error);
      const good = Object.assign(new PassThrough(), { method: "GET", url: "/botfixture/getMe" }), ok = { writeHead: vi.fn(), end: vi.fn() };
      await handler(good, ok); expect(ok.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" }); expect(JSON.parse(ok.end.mock.calls[0]![0]).ok).toBe(true);
    } finally { await mock.stop(); }
  });
});
