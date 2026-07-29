import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parsePaneSize, handleViewRequest, type ViewApiContext } from "../src/view-api.js";

describe("parsePaneSize", () => {
  it("accepts tmux's <cols>x<rows> output", () => {
    expect(parsePaneSize("120x32")).toEqual({ cols: 120, rows: 32 });
    expect(parsePaneSize("80x24\n")).toEqual({ cols: 80, rows: 24 });
  });

  it("rejects anything it can't trust as a grid size", () => {
    // A bad size must yield null rather than 0/NaN — the client relies on the
    // headers simply being absent so it can keep its last known size.
    for (const bad of ["", "\n", "0x24", "120x0", "120", "x", "12ax32", "-1x-1", "120 x 32"]) {
      expect(parsePaneSize(bad), bad).toBeNull();
    }
  });
});

function fakeCtx(dataDir: string): ViewApiContext {
  return {
    viewToken: null,
    webToken: "wt",
    dataDir,
    fleetConfig: { instances: { alpha: {} } } as unknown as ViewApiContext["fleetConfig"],
    logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as ViewApiContext["logger"],
    classicChannels: null,
    getInstanceStatus: () => "running",
    getUiStatus: () => ({ instances: [] }),
  };
}

function fakeRes() {
  const out = { code: 0, headers: {} as Record<string, string>, body: "", done: Promise.resolve() };
  let resolve!: () => void;
  out.done = new Promise<void>(r => { resolve = r; });
  const res = {
    writeHead(code: number, headers?: Record<string, string>) { out.code = code; Object.assign(out.headers, headers ?? {}); return res; },
    end(body?: string) { out.body = body ?? ""; resolve(); },
  } as unknown as ServerResponse;
  return { res, out };
}

describe("GET /api/pane/:instance", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "view-api-"));

  it("404s an unknown instance", async () => {
    const { res, out } = fakeRes();
    const handled = handleViewRequest(
      { method: "GET", headers: {} } as IncomingMessage,
      res,
      new URL("http://x/api/pane/nope"),
      fakeCtx(dataDir),
    );
    expect(handled).toBe(true);
    await out.done;
    expect(out.code).toBe(404);
  });

  it("omits the size headers when the instance has no tmux window yet", async () => {
    const { res, out } = fakeRes();
    handleViewRequest(
      { method: "GET", headers: {} } as IncomingMessage,
      res,
      new URL("http://x/api/pane/alpha"),
      fakeCtx(dataDir),
    );
    await out.done;
    expect(out.code).toBe(200);
    expect(out.body).toBe("");
    expect(out.headers["X-Pane-Cols"]).toBeUndefined();
    expect(out.headers["X-Pane-Rows"]).toBeUndefined();
  });
});
