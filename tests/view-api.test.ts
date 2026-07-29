import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parsePaneSize, handleViewRequest, type ViewApiContext } from "../src/view-api.js";
import { getAgendHome, getTmuxSocketName } from "../src/paths.js";
import { getTmuxSession } from "../src/config.js";

describe("parsePaneSize", () => {
  it("accepts tmux's <cols>x<rows> output", () => {
    expect(parsePaneSize("120x36")).toEqual({ cols: 120, rows: 36 });
    expect(parsePaneSize("80x24\n")).toEqual({ cols: 80, rows: 24 });
  });

  it("rejects anything it can't trust as a grid size", () => {
    // A bad size must yield null rather than 0/NaN — the client relies on the
    // headers simply being absent so it can keep its last known size.
    for (const bad of ["", "\n", "0x24", "120x0", "120", "x", "12ax36", "-1x-1", "120 x 36"]) {
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

  // End-to-end against a real tmux server. Safe to run anywhere: the isolated
  // AGEND_HOME vitest injects gives getTmuxSocketName() a private socket, so
  // this never touches an operator's live fleet.
  it("reports the pane's real grid size in the response headers", async () => {
    const home = getAgendHome();
    const socket = getTmuxSocketName();
    expect(socket, "isolated AGEND_HOME should yield a private tmux socket").toBeTruthy();
    const session = getTmuxSession();
    const tmux = (...args: string[]) =>
      execFileSync("tmux", ["-L", socket!, ...args], { encoding: "utf-8" });
    try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); } catch { return; }  // no tmux → skip

    try {
      tmux("new-session", "-d", "-s", session, "-x", "120", "-y", "36", "sleep 60");
      const wid = tmux("list-windows", "-t", session, "-F", "#{window_id}").trim().split("\n")[0];
      const dir = join(home, "instances", "alpha");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "window-id"), wid);

      const { res, out } = fakeRes();
      handleViewRequest(
        { method: "GET", headers: {} } as IncomingMessage,
        res,
        new URL("http://x/api/pane/alpha"),
        fakeCtx(home),
      );
      await out.done;
      expect(out.code).toBe(200);
      expect(out.headers["X-Pane-Cols"]).toBe("120");
      expect(out.headers["X-Pane-Rows"]).toBe("36");
    } finally {
      try { tmux("kill-server"); } catch { /* already gone */ }
    }
  });
});
