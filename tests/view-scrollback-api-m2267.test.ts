/**
 * M-2267 (the user, hmsg-435f6df6; constraint hmsg-b8a170c0): the View's scrollback, server side, against a real tmux on
 * the isolated private socket vitest gives AGEND_HOME (never an operator's fleet).
 *  - `?history=1`: the pane's history above its screen and the screen, in one capture; the screen-only read as before;
 *  - the answer says whether the CLI keeps any scrollback (X-Pane-Alternate, X-Pane-History-Lines);
 *  - bounded: at most VIEW_HISTORY.lines lines, at most VIEW_HISTORY.maxBytes (its end, from a whole line);
 *  - scrolling can never affect delivery: the path issues capture/display commands only — never copy-mode, send-keys or
 *    a paste — and the pane is left exactly as it was (not in a mode).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { VIEW_HISTORY, handleViewRequest, parsePaneScrollback, type ViewApiContext } from "../src/view-api.js";
import { tmuxExecHelper } from "../src/tmux-exec-helper.js";
import { getAgendHome, getTmuxSocketName } from "../src/paths.js";
import { getTmuxSession } from "../src/config.js";
import { tmuxBinary } from "../src/tmux-binary.js";

const ctx = (): ViewApiContext => ({
  webToken: "wt", dataDir: getAgendHome(),
  fleetConfig: { instances: { alpha: {} } } as unknown as ViewApiContext["fleetConfig"],
  logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as ViewApiContext["logger"],
  classicChannels: null, getInstanceStatus: () => "running", getUiStatus: () => ({ instances: [] }),
});
function get(path: string) {
  const out = { code: 0, headers: {} as Record<string, string>, body: "" };
  return new Promise<typeof out>((resolve) => {
    const res = {
      writeHead(code: number, headers?: Record<string, string>) { out.code = code; Object.assign(out.headers, headers ?? {}); return res; },
      setHeader() {}, end(body?: Buffer | string) { out.body = body === undefined ? "" : String(body); resolve(out); },
    } as unknown as ServerResponse;
    handleViewRequest({ method: "GET", headers: {} } as IncomingMessage, res, new URL(`http://x${path}`), ctx());
  });
}

/** tmux's subcommand: the first word after its global -L / -f options (their values follow each). */
function subcommand(args: string[]): string {
  let i = 0;
  while (i < args.length && (args[i] === "-L" || args[i] === "-f")) i += 2;
  return args[i]!;
}

let tmux: (...args: string[]) => string, haveTmux = true;
beforeAll(() => {
  const socket = getTmuxSocketName();
  expect(socket, "isolated AGEND_HOME should yield a private tmux socket").toBeTruthy();
  try { execFileSync(tmuxBinary(), ["-L", "agend-test-availability", "-V"], { stdio: "ignore" }); } catch { haveTmux = false; }
  tmux = (...args: string[]) => execFileSync(tmuxBinary(), ["-L", socket!, ...args], { encoding: "utf-8" });
});
afterEach(() => { vi.restoreAllMocks(); try { tmux("kill-server"); } catch { /* none */ } });
afterAll(() => { try { tmux("kill-server"); } catch { /* none */ } });

/** A pane running `command`, the agent "alpha"'s window. */
function pane(command: string, width = 80) {
  tmux("new-session", "-d", "-s", getTmuxSession(), "-x", String(width), "-y", "10", command);
  const wid = tmux("list-windows", "-t", getTmuxSession(), "-F", "#{window_id}").trim().split("\n")[0]!;
  const dir = join(getAgendHome(), "instances", "alpha");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "window-id"), wid);
  return wid;
}
const settle = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise(r => setTimeout(r, 30)); };

describe("the scrollback, from a real tmux pane", () => {
  it("?history=1: what scrolled off, then the screen; the plain read is still the screen only", async () => {
    if (!haveTmux) return;
    const wid = pane("for i in $(seq 1 60); do echo \"line $i\"; done; printf '\\033[31mred tail\\033[0m\\n'; sleep 60");
    await settle(() => /red tail/.test(tmux("capture-pane", "-p", "-t", wid)));
    const screen = await get("/api/pane/alpha");
    expect(screen.body).not.toContain("line 1\n");
    expect(screen.headers["X-Pane-History-Lines"]).toBeUndefined();          // a screen read says nothing about history
    const history = await get("/api/pane/alpha?history=1");
    expect(history.code).toBe(200);
    expect(history.body.split("\n")[0]).toBe("line 1");
    expect(history.body).toContain("\u001b[31mred tail");                    // colours kept (-e)
    expect([history.headers["X-Pane-Cols"], history.headers["X-Pane-Rows"], history.headers["X-Pane-Alternate"], Number(history.headers["X-Pane-History-Lines"]) > 0])
      .toEqual(["80", "10", "0", true]);
  });
  it("a full-screen CLI (the alternate screen) is said to keep nothing above its screen", async () => {
    if (!haveTmux) return;
    const wid = pane("printf '\\033[?1049h'; echo full-screen; sleep 60");
    await settle(() => tmux("display-message", "-p", "-t", wid, "#{alternate_on}").trim() === "1");
    const history = await get("/api/pane/alpha?history=1");
    expect(history.headers["X-Pane-Alternate"]).toBe("1");
  });
  it("scrolling can never affect delivery: only capture/display commands, and the pane is left as it was", async () => {
    if (!haveTmux) return;
    const wid = pane("for i in $(seq 1 40); do echo \"line $i\"; done; sleep 60");
    await settle(() => /line 40/.test(tmux("capture-pane", "-p", "-t", wid)));
    const verbs: string[] = [], files = new Set<string>();
    const real = tmuxExecHelper.exec.bind(tmuxExecHelper);
    vi.spyOn(tmuxExecHelper, "exec").mockImplementation(((file: string, args: string[], opts: any, direct: any) => {
      files.add(file);
      verbs.push(`${basename(file)} ${subcommand(args)}`);
      return real(file, args, opts, direct);
    }) as any);
    await get("/api/pane/alpha?history=1");
    await get("/api/pane/alpha");
    expect(files).toEqual(new Set([tmuxBinary()]));                          // AgEnD's own binary, never PATH's
    expect(new Set(verbs)).toEqual(new Set(["tmux capture-pane", "tmux display-message"]));
    expect(tmux("display-message", "-p", "-t", wid, "#{pane_in_mode}").trim()).toBe("0");
  });
});

describe("#2969 review: a scrollback read that cannot be made says so", () => {
  it("no pane yet, or a capture that failed: 503 — never the plain read's empty 200 (which the page would draw as history)", async () => {
    rmSync(join(getAgendHome(), "instances", "alpha", "window-id"), { force: true });
    const none = await get("/api/pane/alpha?history=1");                     // no window-id: no pane yet
    expect([none.code, none.body]).toEqual([503, JSON.stringify({ error: "scrollback_unavailable" })]);
    expect((await get("/api/pane/alpha")).code).toBe(200);                    // the plain read keeps its contract
    if (!haveTmux) return;
    pane("sleep 60");
    vi.spyOn(tmuxExecHelper, "exec").mockImplementation((() => Promise.reject(new Error("tmux went away"))) as any);
    const failed = await get("/api/pane/alpha?history=1");
    expect(failed.code).toBe(503);
  });
});

describe("bounded", () => {
  it("at most the last 2,000 lines of history; over the byte limit its end, from a whole line", () => {
    expect(VIEW_HISTORY).toEqual({ lines: 2000, maxBytes: 1024 * 1024 });
  });
  it("the history read asks tmux for at most VIEW_HISTORY.lines above the screen", async () => {
    if (!haveTmux) return;
    pane("sleep 60");
    const seen: string[][] = [];
    const real = tmuxExecHelper.exec.bind(tmuxExecHelper);
    vi.spyOn(tmuxExecHelper, "exec").mockImplementation(((file: string, args: string[], opts: any, direct: any) => { seen.push(args); return real(file, args, opts, direct); }) as any);
    await get("/api/pane/alpha?history=1");
    const capture = seen.find(a => a.includes("capture-pane"))!;
    expect(capture.slice(capture.indexOf("-S"), capture.indexOf("-S") + 2)).toEqual(["-S", "-2000"]);
  });
  it("a capture over the byte limit is cut to its end, from a whole line", async () => {
    if (!haveTmux) return;
    // 2,400 rows of 190 characters, each in its own colour: with the escapes -e keeps, far over 1 MB within 2,000 lines.
    const script = "import sys\nfor i in range(1,2401):\n  sys.stdout.write('row %05d ' % i + ''.join('\\x1b[3%dmx' % (j % 7 + 1) for j in range(180)) + '\\x1b[0m\\n')\nsys.stdout.flush()\n";
    const file = join(getAgendHome(), "rows.py");
    writeFileSync(file, script);
    const wid = pane(`python3 ${file}; sleep 60`, 200);
    await settle(() => /row 02400/.test(tmux("capture-pane", "-p", "-t", wid)));
    expect(tmux("capture-pane", "-p", "-t", wid)).toContain("row 02400");
    const history = await get("/api/pane/alpha?history=1");
    expect(Buffer.byteLength(history.body)).toBeLessThanOrEqual(VIEW_HISTORY.maxBytes);
    expect(Buffer.byteLength(history.body)).toBeGreaterThan(VIEW_HISTORY.maxBytes * 0.9);   // it was over: cut, not empty
    expect(history.body).toMatch(/^row \d{5} /);                             // starts on a whole line
    expect(history.body).toContain("row 02400");                             // …and ends with the newest
  }, 20_000);
  it("the history facts parse only as tmux gives them", () => {
    expect(parsePaneScrollback("0", "120")).toEqual({ alternate: false, lines: 120 });
    expect(parsePaneScrollback("1", "0")).toEqual({ alternate: true, lines: 0 });
    for (const [a, l] of [["", "1"], ["2", "1"], ["0", ""], ["0", "-1"], [undefined, undefined]] as const) expect(parsePaneScrollback(a, l)).toBeNull();
  });
});
