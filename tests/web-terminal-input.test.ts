import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

/**
 * The browser side of the web terminal's input, as it is served. A user at the login page of `claude auth login`
 * pressed Ctrl+C to copy the link (xterm sent ^C: the login died, exit 130), pasted the sign-in code (the CLI echoes
 * nothing, so it looked like nothing happened) and pressed Enter (a rejected code ends the command: "Ended"). The
 * decisions are pure functions in terminal-input.js; terminal.js is run here against a fake page, a fake xterm and a fake
 * socket — no real xterm, DOM or network.
 */
const DIR = join(process.cwd(), "src", "ui", "web-terminal");
const source = (file: string) => readFileSync(join(DIR, file), "utf8");

interface Api {
  classifyKey(ev: unknown, ctx: { hasSelection: boolean; kind: string }): "copy" | "swallow" | "pass";
  showCodeRow(kind: string): boolean;
  showCtrlCButton(kind: string): boolean;
  submitCode(raw: unknown, send: (s: string) => void): { sent: boolean; clear: boolean; notice: string };
  NOTICES: Record<string, string>;
  MAX_CODE_LENGTH: number;
}

/** As a classic <script>: the context's global object is `this`, there is no `module`. */
function loadAsScript(): Api {
  const context = vm.createContext({});
  vm.runInContext(source("terminal-input.js"), context);
  return (context as { AgendTerminalInput: Api }).AgendTerminalInput;
}
/** As a CommonJS module: what a test (or a bundler) gets. */
function loadAsModule(): Api {
  const module = { exports: {} as Api };
  vm.runInContext(source("terminal-input.js"), vm.createContext({ module }));
  return module.exports;
}

const key = (over: Record<string, unknown> = {}) => ({ type: "keydown", key: "c", code: "KeyC", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over });
const ctrl = (over: Record<string, unknown> = {}) => key({ ctrlKey: true, ...over });

describe.each([["a classic script", loadAsScript], ["a CommonJS module", loadAsModule]])("terminal-input.js as %s", (_name, load) => {
  const api = load();

  describe("classifyKey", () => {
    // [event, hasSelection, kind] → decision, written out by hand.
    it.each([
      // copy: a selection makes Ctrl/Cmd+C a copy, in every kind of terminal
      [ctrl(), true, "login", "copy"], [ctrl(), true, "install", "copy"], [ctrl(), true, "", "copy"],
      [key({ metaKey: true }), true, "login", "copy"], [key({ metaKey: true }), true, "install", "copy"],
      [ctrl({ shiftKey: true, key: "C" }), true, "login", "copy"],
      [ctrl({ key: "Unidentified" }), true, "install", "copy"],                  // identified by `code` alone
      [ctrl({ code: "", key: "C" }), true, "install", "copy"],                   // identified by `key` alone, upper case
      // swallow: no selection on the login page — a stray ^C would kill the sign-in
      [ctrl(), false, "login", "swallow"], [ctrl({ shiftKey: true, key: "C" }), false, "login", "swallow"],
      // pass: every other terminal keeps its ^C (an installer must be stoppable), and so does an unknown kind
      [ctrl(), false, "install", "pass"], [ctrl(), false, "", "pass"], [ctrl(), false, "something-new", "pass"],
      // login: Cmd+C (and Ctrl+Cmd+C) with nothing selected goes the way Ctrl+C does — the same on every platform (xterm sends no ^C for it)
      [key({ metaKey: true }), false, "login", "swallow"], [ctrl({ metaKey: true }), false, "login", "swallow"],
      // pass: everywhere else Cmd+C with nothing selected is left alone
      [key({ metaKey: true }), false, "install", "pass"], [key({ metaKey: true }), false, "", "pass"], [ctrl({ metaKey: true }), false, "install", "pass"],
      // pass: nothing but Ctrl/Cmd+C is ever touched
      [key(), false, "login", "pass"], [key(), true, "login", "pass"],                                   // a plain "c"
      [ctrl({ key: "d", code: "KeyD" }), true, "login", "pass"], [ctrl({ key: "z", code: "KeyZ" }), false, "login", "pass"],
      [ctrl({ key: "v", code: "KeyV" }), false, "login", "pass"], [ctrl({ key: "x", code: "KeyX" }), true, "login", "pass"],
      [key({ key: "Enter", code: "Enter" }), true, "login", "pass"], [key({ key: "Escape", code: "Escape" }), false, "login", "pass"],
      [ctrl({ altKey: true }), true, "login", "pass"], [ctrl({ altKey: true }), false, "login", "pass"],      // Ctrl+Alt+C is not Ctrl+C
      [null, true, "login", "pass"], [undefined, false, "login", "pass"], [{}, true, "login", "pass"],
    ])("%j selection=%s kind=%j → %s", (ev, hasSelection, kind, expected) => {
      expect(api.classifyKey(ev, { hasSelection: hasSelection as boolean, kind: kind as string })).toBe(expected);
    });

    it("treats keypress and keyup of the same chord like its keydown (xterm asks about all three)", () => {
      for (const type of ["keydown", "keypress", "keyup"]) {
        expect(api.classifyKey(ctrl({ type }), { hasSelection: true, kind: "login" }), type).toBe("copy");
        expect(api.classifyKey(ctrl({ type }), { hasSelection: false, kind: "login" }), type).toBe("swallow");
        expect(api.classifyKey(ctrl({ type }), { hasSelection: false, kind: "install" }), type).toBe("pass");
      }
    });

    it("a missing context is the ordinary terminal: nothing is copied, swallowed or changed", () => {
      expect(api.classifyKey(ctrl(), undefined as never)).toBe("pass");
    });
  });

  it("only the login page has the code row, and only the other kinds have the Ctrl-C button", () => {
    expect([api.showCodeRow("login"), api.showCodeRow("install"), api.showCodeRow("")]).toEqual([true, false, false]);
    expect([api.showCtrlCButton("login"), api.showCtrlCButton("install"), api.showCtrlCButton("")]).toEqual([false, true, true]);
  });

  describe("submitCode", () => {
    const run = (raw: unknown) => { const sent: string[] = []; return { result: api.submitCode(raw, s => { sent.push(s); return true; }), sent }; };

    it("sends the code once, followed by Enter, and says to clear the box", () => {
      const { result, sent } = run("AbC123_-x#stateYZ");
      expect(sent).toEqual(["AbC123_-x#stateYZ\r"]);
      expect(result).toEqual({ sent: true, clear: true, notice: "sent" });
    });

    it.each([
      ["  AbC#xyz  ", "AbC#xyz"], ["AbC#xyz\n", "AbC#xyz"], ["AbC#xyz\r\n", "AbC#xyz"], ["\tAbC#xyz", "AbC#xyz"],
      ["AbCdEf\n123#xy\nz", "AbCdEf123#xyz"],                 // a copy that wrapped across lines
      ["AbC #xyz", "AbC#xyz"],
    ])("drops all whitespace from %j", (raw, code) => {
      expect(run(raw).sent).toEqual([`${code}\r`]);
    });

    it.each([[""], ["   "], ["\n\r\n"], [null], [undefined]])("sends nothing for %j, and does not clear the box", raw => {
      const { result, sent } = run(raw);
      expect(sent).toEqual([]);
      expect(result).toEqual({ sent: false, clear: false, notice: "empty" });
    });

    it("refuses a code longer than any real one, and sends nothing", () => {
      const { result, sent } = run("x".repeat(api.MAX_CODE_LENGTH + 1));
      expect(sent).toEqual([]);
      expect(result).toEqual({ sent: false, clear: false, notice: "too-long" });
      expect(run("x".repeat(api.MAX_CODE_LENGTH)).sent).toHaveLength(1);
    });

    it("a second click, or a second Enter, has nothing to send once the box was cleared (the page empties it on `clear`)", () => {
      let box = "AbC#xyz";
      const sent: string[] = [];
      for (let i = 0; i < 3; i++) { const r = api.submitCode(box, s => { sent.push(s); return true; }); if (r.clear) box = ""; }
      expect(sent).toEqual(["AbC#xyz\r"]);
    });

    it("keeps the code out of everything it returns, and never logs", () => {
      const spies = (["log", "info", "warn", "error", "debug"] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}));
      try {
        const secret = "SeCrEt-CoDe-1234#state";
        const { result } = run(secret);
        expect(JSON.stringify(result)).not.toContain("SeCrEt");
        expect(JSON.stringify(api.NOTICES)).not.toContain("SeCrEt");
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally { for (const spy of spies) spy.mockRestore(); }
    });

    it.each([
      ["a connection that is down (send says false)", () => false],
      ["a send that says nothing", () => undefined],
      ["a send that says something else", () => 1],
      ["a socket that throws", () => { throw new Error("INVALID_STATE_ERR"); }],
    ])("%s: not sent, the box keeps the code, nothing is replayed, and no exception escapes", (_name, send) => {
      const calls: string[] = [];
      let result: ReturnType<Api["submitCode"]> | undefined;
      expect(() => { result = api.submitCode("AbC#xyz", s => { calls.push(s); return (send as (s: string) => unknown)(s) as boolean; }); }).not.toThrow();
      expect(result).toEqual({ sent: false, clear: false, notice: "not-sent" });
      expect(calls, "tried exactly once").toEqual(["AbC#xyz\r"]);
      expect(api.NOTICES["not-sent"]).toMatch(/Not sent/);
      expect(api.NOTICES["not-sent"]).toMatch(/still in the box/);
    });

    it("has fixed wording for every notice it can return", () => {
      expect(Object.keys(api.NOTICES).sort()).toEqual(["empty", "not-sent", "sent", "too-long"]);
    });

    it("the largest frame it can produce stays far under the server's 4096-byte limit", () => {
      expect(run("x".repeat(api.MAX_CODE_LENGTH)).sent[0]!.length).toBeLessThan(4096);
    });
  });
});

// ── terminal.js against a fake page ───────────────────────────────────────────────────────────────────────────────

interface Fake {
  [k: string]: any;
}
function page(opts: { resizeObserver?: boolean } = {}) {
  const elements: Record<string, Fake> = {};
  const el = (id: string): Fake => (elements[id] ??= { id, hidden: false, textContent: "", value: "", className: "", listeners: {} as Record<string, Array<(ev: unknown) => void>>,
    addEventListener(type: string, fn: (ev: unknown) => void) { (this.listeners[type] ??= []).push(fn); },
    getAttribute() { return null; }, closest() { return null; },
  });
  for (const id of ["gate", "gate-form", "gate-msg", "token", "term", "keys", "ttl", "done", "btn-close", "code-row", "code", "code-msg", "key-ctrlc", "title"]) el(id);
  for (const id of ["term", "keys", "ttl", "done", "btn-close", "code-row"]) elements[id]!.hidden = true;      // `hidden` in terminal.html
  elements["gate"]!.hidden = false;
  const sockets: Array<Fake & { sent: Array<Uint8Array | string> }> = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1; binaryType = ""; sent: Array<Uint8Array | string> = [];
    onopen?: () => void; onmessage?: (ev: { data: unknown }) => void; onclose?: (ev: unknown) => void;
    constructor(public url: string) { sockets.push(this as unknown as never); }
    throwOnSend = false;
    send(data: Uint8Array | string) { if (this.throwOnSend) throw new Error("InvalidStateError"); this.sent.push(data); }
    close() { this.readyState = 3; }
  }
  const terminals: Array<{ keyHandler?: (ev: unknown) => boolean; selection: boolean; onData?: (s: string) => void; written: unknown[] }> = [];
  class FakeTerminal {
    state: (typeof terminals)[number] = { selection: false, written: [] };
    options: Record<string, unknown> = {};
    constructor() { terminals.push(this.state); }
    loadAddon() {} open() {} focus() {} reset() {} writeln() {} write(d: unknown) { this.state.written.push(d); }
    hasSelection() { return this.state.selection; }
    attachCustomKeyEventHandler(fn: (ev: unknown) => boolean) { this.state.keyHandler = fn; }
    onData(fn: (s: string) => void) { this.state.onData = fn; } onBinary() {} onResize() {}
  }
  let fits = 0;
  const observers: Array<{ callback: () => void; observed: unknown[] }> = [];
  class FakeResizeObserver {
    observed: unknown[] = [];
    constructor(public callback: () => void) { observers.push(this); }
    observe(target: unknown) { this.observed.push(target); }
  }
  const windowListeners: Record<string, Array<() => void>> = {};
  const input = vm.runInContext(`${source("terminal-input.js")}\n;this.AgendTerminalInput`, vm.createContext({}));
  const consoleSpy = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const context = vm.createContext({
    document: { getElementById: (id: string) => elements[id] ?? null },
    window: { AgendTerminalInput: input, addEventListener(type: string, fn: () => void) { (windowListeners[type] ??= []).push(fn); } },
    ...(opts.resizeObserver === false ? {} : { ResizeObserver: FakeResizeObserver }),
    location: { pathname: "/t/abc/", protocol: "https:", host: "x.trycloudflare.com" },
    WebSocket: FakeSocket, Terminal: FakeTerminal,
    FitAddon: { FitAddon: class { fit() { fits++; } } }, WebLinksAddon: { WebLinksAddon: class {} },
    TextEncoder, Uint8Array, JSON, Date, Math, setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, fetch: async () => ({}),
    console: consoleSpy,
  });
  vm.runInContext(source("terminal.js"), context);
  const socket = sockets[0] as unknown as FakeSocket;
  const open = (kind: string) => {
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ t: "hello", kind, backend: "claude-code", ttlRemainingMs: 600_000 }) });
    return terminals[0]!;
  };
  const emit = (id: string, type: string, ev: unknown = { preventDefault() {} }) => elements[id]!.listeners[type]!.forEach((fn: (e: unknown) => void) => fn(ev));
  const bytesSent = () => socket.sent.filter((d): d is Uint8Array => typeof d !== "string").map(d => new TextDecoder().decode(d));
  return { elements, socket, open, emit, bytesSent, consoleSpy, terminals, observers, windowListeners, fits: () => fits };
}

describe("terminal.js on the login page", () => {
  it("shows the code row and hides the Ctrl-C button once the server says it is a login", () => {
    const p = page();
    p.open("login");
    expect(p.elements["code-row"]!.hidden).toBe(false);
    expect(p.elements["key-ctrlc"]!.hidden).toBe(true);
    expect(p.elements["title"]!.textContent).toBe("AgEnD · login · claude-code");
  });

  it("Ctrl+C: with a selection it is left to the browser to copy; without one it is swallowed — no ^C is sent either way", () => {
    const p = page();
    const term = p.open("login");
    term.selection = true;
    expect(term.keyHandler!(ctrl()), "selected → xterm does not handle it, the browser copies").toBe(false);
    term.selection = false;
    expect(term.keyHandler!(ctrl()), "not selected → swallowed").toBe(false);
    expect(term.keyHandler!(key({ metaKey: true })), "Cmd+C not selected → swallowed too").toBe(false);
    expect(p.bytesSent()).toEqual([]);
  });

  it("every other key still reaches xterm", () => {
    const p = page();
    const term = p.open("login");
    for (const ev of [key({ key: "a", code: "KeyA" }), ctrl({ key: "v", code: "KeyV" }), ctrl({ key: "d", code: "KeyD" }), key({ key: "Enter", code: "Enter" }), ctrl({ altKey: true })]) {
      expect(term.keyHandler!(ev), JSON.stringify(ev)).toBe(true);
    }
  });

  it("sends the pasted code and Enter in ONE frame, clears the box, and a second submit sends nothing", () => {
    const p = page();
    p.open("login");
    p.elements["code"]!.value = "  AbC123#sta\nteXYZ \n";
    p.emit("code-row", "submit");
    expect(p.bytesSent()).toEqual(["AbC123#stateXYZ\r"]);
    expect(p.elements["code"]!.value).toBe("");
    expect(p.elements["code-msg"]!.textContent).toMatch(/^Sent\./);
    p.emit("code-row", "submit");
    expect(p.bytesSent(), "the empty box sends nothing").toEqual(["AbC123#stateXYZ\r"]);
    expect(p.elements["code-msg"]!.textContent).toMatch(/Paste the code/);
  });

  it("a paste that is far too long is refused WITHOUT being thrown away: nothing is sent, the box keeps it, the user is told", () => {
    const p = page();
    p.open("login");
    const long = "y".repeat(2000);
    p.elements["code"]!.value = long;
    p.emit("code-row", "submit");
    expect(p.bytesSent()).toEqual([]);
    expect(p.elements["code"]!.value).toBe(long);
    expect(p.elements["code-msg"]!.textContent).toMatch(/far longer/);
  });

  describe("while the connection is down the code is NOT lost and NOT reported as sent", () => {
    it.each([[0, "connecting"], [2, "closing"], [3, "closed"]])("readyState %s (%s): nothing sent, the box keeps the code, the user is told to try again", (state) => {
      const p = page();
      p.open("login");
      (p.socket as unknown as { readyState: number }).readyState = state as number;
      p.elements["code"]!.value = "AbC123#stateXYZ";
      p.emit("code-row", "submit");
      expect(p.bytesSent()).toEqual([]);
      expect(p.elements["code"]!.value).toBe("AbC123#stateXYZ");
      expect(p.elements["code-msg"]!.textContent).toMatch(/^Not sent/);
      expect(p.elements["code-msg"]!.textContent).not.toMatch(/^Sent/);
      expect(p.elements["code-msg"]!.textContent).not.toContain("AbC123");
    });

    it("a socket that throws on send: nothing escapes the handler, the box keeps the code", () => {
      const p = page();
      p.open("login");
      (p.socket as unknown as { throwOnSend: boolean }).throwOnSend = true;
      p.elements["code"]!.value = "AbC123#stateXYZ";
      expect(() => p.emit("code-row", "submit")).not.toThrow();
      expect(p.elements["code"]!.value).toBe("AbC123#stateXYZ");
      expect(p.elements["code-msg"]!.textContent).toMatch(/^Not sent/);
    });

    it("nothing is replayed on its own when the connection comes back; pressing Send again sends it once", () => {
      const p = page();
      p.open("login");
      const socket = p.socket as unknown as { readyState: number };
      socket.readyState = 3;
      p.elements["code"]!.value = "AbC123#stateXYZ";
      p.emit("code-row", "submit");
      socket.readyState = 1;
      expect(p.bytesSent(), "reconnecting alone sends nothing").toEqual([]);
      p.emit("code-row", "submit");
      expect(p.bytesSent()).toEqual(["AbC123#stateXYZ\r"]);
      expect(p.elements["code"]!.value).toBe("");
      expect(p.elements["code-msg"]!.textContent).toMatch(/^Sent\./);
    });
  });

  it("an empty box is told so, and nothing is sent", () => {
    const p = page();
    p.open("login");
    p.emit("code-row", "submit");
    expect(p.bytesSent()).toEqual([]);
  });

  it("never logs, whatever is submitted", () => {
    const p = page();
    p.open("login");
    p.elements["code"]!.value = "TopSecretCode#state";
    p.emit("code-row", "submit");
    for (const spy of Object.values(p.consoleSpy)) expect(spy).not.toHaveBeenCalled();
  });

  it("the code row goes away with the session", () => {
    const p = page();
    p.open("login");
    p.socket.onmessage?.({ data: JSON.stringify({ t: "exit", ok: false, detail: "exited with code 1", exitCode: 1 }) });
    expect(p.elements["code-row"]!.hidden).toBe(true);
    expect(p.elements["done"]!.textContent).toContain("exit 1");
  });

  it("a reconnect (a second hello) keeps the page as it was", () => {
    const p = page();
    p.open("login");
    p.socket.onmessage?.({ data: JSON.stringify({ t: "hello", kind: "login", backend: "claude-code", ttlRemainingMs: 500_000 }) });
    expect([p.elements["code-row"]!.hidden, p.elements["key-ctrlc"]!.hidden]).toEqual([false, true]);
  });
});

// #1242: the code row appears on "hello", after the first fit. A terminal that only re-fitted on a window resize kept
// the taller size, ran under the row and covered the code box until the user changed the zoom.
describe("terminal.js re-fits when the terminal's own box changes", () => {
  it("watches the terminal element, and every change re-fits it", () => {
    const p = page();
    p.open("login");
    expect(p.elements["code-row"]!.hidden).toBe(false);
    expect(p.observers.map(o => o.observed)).toEqual([[p.elements["term"]]]);
    const before = p.fits();
    p.observers[0]!.callback();                              // the code row took its height from the terminal
    expect(p.fits()).toBe(before + 1);
  });

  it("one watcher however many times the socket reconnects", () => {
    const p = page();
    p.open("login");
    p.socket.onopen?.();
    expect(p.observers).toHaveLength(1);
  });

  it("a browser without ResizeObserver still re-fits on a window resize", () => {
    const p = page({ resizeObserver: false });
    p.open("login");
    const before = p.fits();
    p.windowListeners["resize"]!.forEach(fn => fn());
    expect(p.fits()).toBe(before + 1);
  });

  it("the terminal never draws past its own box onto the code row (overflow hidden)", () => {
    expect(source("terminal.css")).toMatch(/^#term \{[^}]*\boverflow: hidden;[^}]*\}/m);
  });
});

describe("terminal.js on any other terminal (the installer): nothing taken away", () => {
  it("has no code row and keeps the Ctrl-C button", () => {
    const p = page();
    p.open("install");
    expect(p.elements["code-row"]!.hidden).toBe(true);
    expect(p.elements["key-ctrlc"]!.hidden).toBe(false);
  });

  it("Ctrl+C with nothing selected still reaches xterm (and so the command); with a selection it copies", () => {
    const p = page();
    const term = p.open("install");
    expect(term.keyHandler!(ctrl()), "no selection: xterm sends ^C").toBe(true);
    term.selection = true;
    expect(term.keyHandler!(ctrl()), "selection: a copy").toBe(false);
  });

  it("before the server has said what it is, Ctrl+C is an ordinary ^C", () => {
    const p = page();
    p.socket.onopen?.();                                   // connected, no hello yet: the kind is not known
    expect(p.terminals[0]!.keyHandler!(ctrl())).toBe(true);
    expect(p.elements["code-row"]!.hidden).toBe(true);
  });

  it("typed input: an empty chunk sends no frame, and a socket that throws does not throw out of xterm's handler", () => {
    const p = page();
    const term = p.open("install");
    term.onData!("");
    expect(p.socket.sent).toEqual([]);
    (p.socket as unknown as { throwOnSend: boolean }).throwOnSend = true;
    expect(() => term.onData!("ls\r")).not.toThrow();
  });

  it("typed input still goes out as bytes, untouched", () => {
    const p = page();
    const term = p.open("install");
    term.onData!("ls\r");
    term.onData!("\x03");
    expect(p.bytesSent()).toEqual(["ls\r", "\x03"]);
  });
});

describe("the page and its served files", () => {
  const html = source("terminal.html");

  it("loads terminal-input.js before terminal.js, and has the code row and the Ctrl-C button's id", () => {
    expect(html.indexOf("assets/terminal-input.js")).toBeGreaterThan(-1);
    expect(html.indexOf("assets/terminal-input.js")).toBeLessThan(html.indexOf("assets/terminal.js"));
    expect(html).toMatch(/<form id="code-row" hidden/);
    expect(html).toMatch(/<input id="code" type="password" autocomplete="off"/);
    expect(html).toMatch(/<button id="key-ctrlc" data-seq="\\u0003"/);
  });

  it("the code row starts hidden, so no other kind of terminal ever shows it before the server speaks", () => {
    expect(html).toMatch(/<form id="code-row" hidden/);
  });

  it("neither script reads or logs the code: no console, no storage, no network of its own", () => {
    for (const file of ["terminal-input.js", "terminal.js"]) {
      const text = source(file);
      expect(text, file).not.toMatch(/console\./);
      expect(text, file).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    }
    expect(source("terminal-input.js")).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket/);
  });
});
