import { afterEach, describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import { request } from "node:http";
import type { Server } from "node:http";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { buildEffectShim, createPreviewListener, PREVIEW_HTML_MAX_BYTES, previewEffectResponse, previewFrameResponse } from "../src/web-preview.js";
import { EFFECT_MAX_ELEMENT_DEPTH, effectTemplateProblem } from "../src/web-effect-template.js";

// These tests may bind scratch loopback HTTP servers, never launch a fleet, tunnel or CLI.
vi.mock("node:child_process", () => {
  const denied = () => { throw new Error("process launch forbidden in effect tests"); };
  return { spawn: denied, spawnSync: denied, exec: denied, execSync: denied, execFile: denied, execFileSync: denied };
});

const BOOT = "a".repeat(32);
const ORIGINS = ["http://127.0.0.1:19280", "https://dashboard.example"];
const render = (html = "<p>effect</p>") => ({ v: 1, type: "render", ch: "0123456789abcdef", html });

function harness(options: { writeThrows?: boolean; encoderThrows?: boolean } = {}) {
  const html = buildEffectShim(BOOT, ORIGINS);
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  const parent = { postMessage: vi.fn() };
  const written: string[] = [];
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const tasks: Array<() => void> = [];
  let duringWrite = () => {};
  const executed: string[] = [];
  type Element = {
    localName: string; namespaceURI: string; attributes: Array<{ name: string; value: string }>;
    children: Element[];
    parentNode: object | null; textContent: string; type: string;
    getAttribute(name: string): string | null; hasAttribute(name: string): boolean;
    setAttribute(name: string, value: string): void; replaceWith(element: Element): void;
  };
  const element = (localName: string, attrs: Array<{ name: string; value: string }> = [], textContent = "", namespaceURI = "http://www.w3.org/1999/xhtml"): Element => ({
    localName, namespaceURI, attributes: attrs, children: [], parentNode: {}, textContent, type: "",
    getAttribute(name) { return this.attributes.find(a => a.name === name)?.value ?? null; },
    hasAttribute(name) { return this.attributes.some(a => a.name === name); },
    setAttribute(name, value) { this.attributes.push({ name, value }); },
    replaceWith(fresh) { if (localName === "script") executed.push(fresh.textContent); },
  });
  let originalHtml = "";
  const body = element("body");
  body.replaceWith = () => {
    written.push(originalHtml); duringWrite();
    if (options.writeThrows) throw new Error("inert DOM replacement failure");
  };
  const doc = {
    open: vi.fn(() => { listeners.clear(); }),
    write: vi.fn(), close: vi.fn(),
    head: element("head"), body, documentElement: element("html"),
    adoptNode: (node: Element) => node,
    createElement: (tag: string) => element(tag),
    addEventListener: vi.fn(), dispatchEvent: vi.fn(),
  };
  class Parser {
    parseFromString(value: string) {
      originalHtml = value;
      const elements: Element[] = [];
      const pending: Array<{ node: DefaultTreeAdapterMap["node"]; parent?: Element }> = [{ node: parse(value, { scriptingEnabled: false }) }];
      while (pending.length) {
        const { node, parent } = pending.pop()!;
        let current = parent;
        if ("tagName" in node) {
          const text = node.childNodes.map(child => "value" in child ? child.value : "").join("");
          current = element(node.tagName, node.attrs, text, node.namespaceURI);
          elements.push(current); parent?.children.push(current);
        }
        if ("childNodes" in node) for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push({ node: node.childNodes[i]!, parent: current });
      }
      return {
        head: elements.find(e => e.localName === "head")!, body: elements.find(e => e.localName === "body")!, documentElement: elements.find(e => e.localName === "html")!,
        querySelectorAll: (selector: string) => selector === "*" ? elements : elements.filter(e => e.localName === selector),
      };
    }
  }
  const win: Record<string, unknown> = {
    parent, document: doc, DOMParser: Parser, Event, MessageEvent,
    setTimeout: (fn: () => void) => { tasks.push(fn); return tasks.length; },
    TextEncoder: options.encoderThrows ? class { encode() { throw new Error("encoder unavailable"); } } : TextEncoder,
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => { listeners.get(type)?.delete(fn); },
    dispatchEvent: vi.fn(),
  };
  for (const key of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceTransport", "RTCSctpTransport"]) win[key] = function forbidden() {};
  win.window = win;
  const context = vm.createContext(win);
  vm.runInContext(script, context);
  const flush = () => { for (let i = 0; tasks.length && i < 100; i++) tasks.shift()!(); };
  const portListeners: Array<(event: { data: unknown }) => void> = [];
  const port = {
    postMessage: vi.fn(), close: vi.fn(), start: vi.fn(),
    addEventListener: vi.fn((type: string, fn: (event: { data: unknown }) => void) => { if (type === "message") portListeners.push(fn); }),
  };
  const send = (data: unknown, opts: { source?: unknown; origin?: string; ports?: unknown[] } = {}) => {
    const event = {
      source: "source" in opts ? opts.source : parent, origin: opts.origin ?? ORIGINS[0],
      data: vm.runInContext(`(${JSON.stringify(data)})`, context), ports: opts.ports ?? [port],
    };
    win.event = event;
    for (const fn of [...listeners.get("message") ?? []]) fn(event);
    delete win.event;
    flush();
  };
  const api = () => win.agend as { on(kind: string, callback: (event: unknown) => void): void; ready(): void };
  return { html, context, win, doc, written, executed, parent, port, api, send,
    duringWrite: (fn: () => void) => { duringWrite = fn; },
    event: (data: unknown) => {
      const event = new MessageEvent("message", { data });
      win.event = event;
      for (const fn of portListeners) fn(event);
      delete win.event;
      flush();
    },
  };
}

describe("#1629 effect shim: one render and a private read-only port facade", () => {
  it("announces only the exact boot-bound window ready", () => {
    const h = harness();
    expect(h.parent.postMessage.mock.calls).toEqual([[{ v: 1, type: "ready", ch: null, boot: BOOT }, "*"]]);
    expect(h.win.agend).toBeUndefined();
  });

  it.each([
    ["wrong window", (h: ReturnType<typeof harness>) => h.send(render(), { source: {} })],
    ["opaque parent", (h: ReturnType<typeof harness>) => h.send(render(), { origin: "null" })],
    ["unlisted origin", (h: ReturnType<typeof harness>) => h.send(render(), { origin: "https://other.example" })],
    ["origin suffix", (h: ReturnType<typeof harness>) => h.send(render(), { origin: `${ORIGINS[1]}.evil.example` })],
    ["extra field", (h: ReturnType<typeof harness>) => h.send({ ...render(), commands: [] })],
    ["wrong version", (h: ReturnType<typeof harness>) => h.send({ ...render(), v: 2 })],
    ["wrong type", (h: ReturnType<typeof harness>) => h.send({ ...render(), type: "ready" })],
    ["missing field", (h: ReturnType<typeof harness>) => h.send({ v: 1, type: "render", html: "" })],
    ["invalid channel", (h: ReturnType<typeof harness>) => h.send({ ...render(), ch: "x".repeat(16) })],
    ["non-object", (h: ReturnType<typeof harness>) => h.send(JSON.stringify(render()))],
    ["array", (h: ReturnType<typeof harness>) => h.send([])],
    ["null", (h: ReturnType<typeof harness>) => h.send(null)],
    ["non-string html", (h: ReturnType<typeof harness>) => h.send({ ...render(), html: {} })],
    ["no port", (h: ReturnType<typeof harness>) => h.send(render(), { ports: [] })],
    ["two ports", (h: ReturnType<typeof harness>) => h.send(render(), { ports: [h.port, h.port] })],
    ["malformed port", (h: ReturnType<typeof harness>) => h.send(render(), { ports: [{}] })],
    ["UTF-8 byte overflow", (h: ReturnType<typeof harness>) => h.send(render("界".repeat(Math.floor(PREVIEW_HTML_MAX_BYTES / 3) + 1)))],
  ])("drops %s without changing state; a later valid render still works", (_why, action) => {
    const h = harness();
    action(h);
    expect(h.written).toEqual([]);
    expect(h.port.start).not.toHaveBeenCalled();
    expect(h.port.postMessage).not.toHaveBeenCalled();
    expect(h.win.agend).toBeUndefined();
    expect(h.parent.postMessage).toHaveBeenCalledTimes(1);
    h.send(render());
    expect(h.written).toEqual(["<p>effect</p>"]);
  });

  it("defines the frozen facade before HTML executes, hides the port, and permits exactly one ready", () => {
    const h = harness();
    const renderEvents: unknown[] = [];
    h.duringWrite(() => {
      renderEvents.push(h.win.event);
      expect(Object.keys(h.api()).sort()).toEqual(["on", "ready"]);
      expect(Object.isFrozen(h.api())).toBe(true);
      expect(Object.getOwnPropertyDescriptor(h.win, "agend")).toMatchObject({ configurable: false, writable: false });
      expect(h.port.start).toHaveBeenCalledTimes(1);
      h.api().ready(); h.api().ready();
    });
    h.send(render());
    h.send(render("<p>second</p>"));
    expect(renderEvents).toEqual([undefined]);
    expect(h.written).toEqual(["<p>effect</p>"]);
    expect(h.port.postMessage.mock.calls).toEqual([[{ type: "ready" }]]);
    expect(h.parent.postMessage).toHaveBeenCalledTimes(1);
    for (const key of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceTransport", "RTCSctpTransport"]) expect(h.win[key]).toBeUndefined();
  });

  it("routes only recognized host events to subscribers, isolates callback errors and exposes no command API", () => {
    const h = harness(); h.send(render());
    const received = vi.fn();
    const callbackEvents: unknown[] = [];
    h.api().on("state", () => { callbackEvents.push(h.win.event); });
    h.api().on("state", () => { throw new Error("untrusted callback"); });
    h.api().on("state", received);
    h.api().on("command", received);
    h.api().on("__proto__", received);
    h.event({ v: 1, type: "state", state: "working", ts: 1 });
    h.event({ v: 1, type: "command" });
    h.event({ v: 2, type: "state" });
    h.event(null);
    expect(received.mock.calls).toEqual([[{ v: 1, type: "state", state: "working", ts: 1 }]]);
    expect(callbackEvents).toEqual([undefined]);
    expect(h.port.postMessage).not.toHaveBeenCalled();
  });

  it("fails closed if the byte counter fails", () => {
    const h = harness({ encoderThrows: true }); h.send(render());
    expect(h.written).toEqual([]);
  });

  it("closes a failed render's port and never retries the consumed render", () => {
    const h = harness({ writeThrows: true }); h.send(render());
    h.api().ready(); h.send(render());
    expect(h.port.close).toHaveBeenCalledTimes(1);
    expect(h.port.postMessage).not.toHaveBeenCalled();
    expect(h.written).toHaveLength(1);
  });

  it("rebuilds classic scripts in source order after the DOM and frozen API are installed", () => {
    const h = harness();
    h.send(render('<html lang="en"><head><script>first()</script></head><body><canvas></canvas><script type="text/javascript">second()</script></body></html>'));
    expect(h.executed).toEqual(["first()", "second()"]);
    expect(h.doc.documentElement.getAttribute("lang")).toBe("en");
    expect(() => h.doc.open()).toThrow("Unsupported effect document method");
    expect(() => h.doc.write()).toThrow("Unsupported effect document method");
    expect(h.doc.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(h.win.dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it("accepts the exact 1 MiB limit", () => {
    const h = harness(); h.send(render("a".repeat(PREVIEW_HTML_MAX_BYTES)));
    expect(h.written[0]).toHaveLength(PREVIEW_HTML_MAX_BYTES);
  });

  it("escapes server-supplied script delimiters without adding executable markup", () => {
    const html = buildEffectShim("</script><script>bad()</script>", ["https://example.test/</script>"]);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain("\\u003c/script>");
  });
});

describe("#1629 fixed effect template: upload and native parser agree", () => {
  it.each([
    ['<script type="module">x()</script>', "unsupported_script"],
    ['<script src="data:text/javascript,x()"></script>', "unsupported_script"],
    ['<script s&#114;c="x"></script>', "unsupported_script"],
    ['<script async>x()</script>', "unsupported_script"],
    ['<script defer>x()</script>', "unsupported_script"],
    ['<script type="application/json">{}</script>', "unsupported_script"],
    ['<svg><script>x()</script></svg>', "unsupported_script"],
    ['<meta http-equiv="refresh" content="0;url=about:blank">', "unsupported_meta"],
    ['<iframe srcdoc="x"></iframe>', "unsupported_element"],
    ['<noscript><iframe srcdoc="x"></iframe></noscript><script>agend.ready()</script>', "unsupported_element"],
    ['<template><script>x()</script></template>', "unsupported_element"],
    ['<link rel="stylesheet" href="x">', "unsupported_element"],
    ['<base href="https://example.test">', "unsupported_element"],
    ['<script>document.write("x")</script>', "document_write"],
    ['<script>document["open"]()</script>', "document_write"],
  ])("refuses unsupported template %s before render", (html, problem) => {
    expect(effectTemplateProblem(html)).toBe(problem);
    const h = harness(); h.send(render(html));
    expect(h.written).toEqual([]);
    expect(h.port.start).not.toHaveBeenCalled();
    expect(h.win.agend).toBeUndefined();
    h.send(render());
    expect(h.written).toEqual(["<p>effect</p>"]);
  });

  it("accepts fragments/full documents with inline styles, canvas and ordered classic scripts", () => {
    for (const html of ['<style>canvas{opacity:.5}</style><canvas></canvas><script>init()</script>', '<noscript>JavaScript needed</noscript><canvas></canvas><script>agend.ready()</script>', '<!doctype html><html><head><script type=" TEXT/JAVASCRIPT ">init()</script></head><body><p>effect</p></body></html>']) {
      expect(effectTemplateProblem(html)).toBeNull();
      const h = harness(); h.send(render(html)); expect(h.written).toEqual([html]);
    }
  });

  it("uses DOMParser's disabled-scripting mode, independently of the VM adapter", () => {
    const html = '<noscript><iframe srcdoc="x"></iframe></noscript><script>agend.ready()</script>';
    const containsFrame = (scriptingEnabled: boolean) => {
      const pending: DefaultTreeAdapterMap["node"][] = [parse(html, { scriptingEnabled })];
      while (pending.length) {
        const node = pending.pop()!;
        if ("tagName" in node && node.tagName === "iframe") return true;
        if ("childNodes" in node) pending.push(...node.childNodes);
      }
      return false;
    };
    expect(containsFrame(true)).toBe(false);
    expect(containsFrame(false)).toBe(true);
    expect(effectTemplateProblem(html)).toBe("unsupported_element");
  });

  it("bounds element depth iteratively without overflowing on legal-byte-sized HTML", () => {
    const html = "<div>".repeat(10_000) + "x" + "</div>".repeat(10_000);
    expect(Buffer.byteLength(html)).toBe(110_001);
    expect(() => effectTemplateProblem(html)).not.toThrow();
    expect(effectTemplateProblem(html)).toBe("unsupported_depth");
    const h = harness(); h.send(render(html)); expect(h.written).toEqual([]);
    const accepted = "<div>".repeat(EFFECT_MAX_ELEMENT_DEPTH - 2) + "x" + "</div>".repeat(EFFECT_MAX_ELEMENT_DEPTH - 2);
    expect(effectTemplateProblem(accepted)).toBeNull();
    const ok = harness(); ok.send(render(accepted)); expect(ok.written).toEqual([accepted]);
    const hundred = "<div>".repeat(100) + "x" + "</div>".repeat(100);
    expect(effectTemplateProblem(hundred)).toBeNull();
  });
});

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("scratch HTTP server did not bind");
  return address.port;
}
function get(port: number, path: string, host = `127.0.0.1:${port}`, method = "GET") {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { Host: host, Cookie: "do-not-use=secret", "X-Forwarded-Host": "attacker.example" } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end();
  });
}

describe("#1629 local-only /effect route", () => {
  it("shares every /frame security header, with the effect's own length", () => {
    const effect = previewEffectResponse(BOOT, ORIGINS), frame = previewFrameResponse(BOOT, ORIGINS);
    expect({ ...effect.headers, "Content-Length": "ignored" }).toEqual({ ...frame.headers, "Content-Length": "ignored" });
    expect(Number(effect.headers["Content-Length"])).toBe(effect.body.length);
    expect(effect.headers["Content-Security-Policy"]).toContain("sandbox allow-scripts");
    expect(effect.headers["Content-Security-Policy"]).not.toContain("allow-same-origin");
    for (const directive of ["connect-src 'none'", "worker-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"]) expect(effect.headers["Content-Security-Policy"]).toContain(directive);
  });

  it("serves exact GET only after Host admission; public extraOrigins widen /frame alone", async () => {
    let publicOrigin = "https://public.example";
    const listener = createPreviewListener({ settings: { enabled: true, port: 0, origin: null }, healthPort: 19280, config: {}, bootId: BOOT, extraOrigins: () => [publicOrigin] });
    const port = await listen(listener.server);
    const effect = await get(port, "/effect");
    expect(effect.status).toBe(200);
    expect(effect.body).toContain("<title>Effect</title>");
    expect(effect.headers["set-cookie"]).toBeUndefined();
    expect(effect.body).not.toContain("secret");
    expect(effect.body).not.toContain(publicOrigin);
    expect(effect.headers["content-security-policy"]).not.toContain(publicOrigin);
    expect((await get(port, "/frame")).headers["content-security-policy"]).toContain(publicOrigin);
    publicOrigin = "https://next-public.example";
    expect((await get(port, "/frame")).headers["content-security-policy"]).toContain(publicOrigin);
    expect((await get(port, "/effect")).headers["content-security-policy"]).not.toContain(publicOrigin);
    expect((await get(port, "/effect", "attacker.example")).status).toBe(403);
    for (const path of ["/effect?x=1", "/effect/", "/%65ffect"]) expect((await get(port, path)).status).toBe(404);
    for (const method of ["POST", "HEAD", "OPTIONS"]) expect((await get(port, "/effect", undefined, method)).status).toBe(404);
  });

  it("keeps the public-preview gateway /frame-only", async () => {
    const { createPublicPreviewGateway } = await import("../src/public-preview.js");
    const gateway = createPublicPreviewGateway({ exposureId: "private-test", dashboardOrigin: () => "https://dashboard.trycloudflare.com", isCurrent: () => true, bootId: BOOT });
    gateway.setHost("preview.trycloudflare.com");
    const port = await listen(gateway.server);
    expect((await get(port, "/effect", "preview.trycloudflare.com")).status).toBe(404);
    expect((await get(port, "/frame", "preview.trycloudflare.com")).status).toBe(200);
  });
});
