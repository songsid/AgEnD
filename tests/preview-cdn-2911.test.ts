/**
 * #2911 (7), M-2216: CDN libraries in HTML previews (web.preview_cdn). Design: #2911 issuecomment-6561430534, approved
 * with amendments (6561437401): cdnjs /ajax/libs/ and jsDelivr /npm/ only (no unpkg), scripts/styles/fonts only,
 * connect-src stays 'none', default off, the public link follows the same setting. A blocked library is reported as a
 * "blocked" error (origin + path only) and the panel says where to allow it. What a browser does with the CSP (an
 * off-prefix URL refused) is the smoke in the PR.
 */
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { BLOCKED_PROLOGUE, PREVIEW_CDN_SOURCES, buildShim, createPreviewListener, previewFrameCsp, previewSettings } from "../src/web-preview.js";
import { createPublicPreviewGateway } from "../src/public-preview.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { parseWebSettingsBody } from "../src/web-settings-patch.js";

const ORIGIN = "http://127.0.0.1:19280";
/** The CSP as it was before #2911 (7) — off must stay byte-identical. */
const BEFORE = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; "
  + "connect-src 'none'; worker-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'; manifest-src 'none'; object-src 'none'; "
  + `webrtc 'block'; frame-ancestors ${ORIGIN}; sandbox allow-scripts`;
const directives = (csp: string) => Object.fromEntries(csp.split("; ").map(d => { const [k, ...v] = d.split(" "); return [k, v.join(" ")]; }));

describe("the frame's CSP", () => {
  it("off (the default): byte-identical to before", () => {
    expect(previewFrameCsp([ORIGIN])).toBe(BEFORE);
    expect(previewFrameCsp([ORIGIN], { cdn: false })).toBe(BEFORE);
  });
  it("on: exactly cdnjs /ajax/libs/ and jsDelivr /npm/ added to script-src, style-src and font-src — nothing else changes", () => {
    expect([...PREVIEW_CDN_SOURCES]).toEqual(["https://cdnjs.cloudflare.com/ajax/libs/", "https://cdn.jsdelivr.net/npm/"]);
    const on = directives(previewFrameCsp([ORIGIN], { cdn: true })), off = directives(BEFORE);
    const cdn = "https://cdnjs.cloudflare.com/ajax/libs/ https://cdn.jsdelivr.net/npm/";
    expect(on["script-src"]).toBe(`'unsafe-inline' ${cdn}`);
    expect(on["style-src"]).toBe(`'unsafe-inline' ${cdn}`);
    expect(on["font-src"]).toBe(`data: ${cdn}`);
    for (const k of Object.keys(off)) if (!["script-src", "style-src", "font-src"].includes(k)) expect(on[k], k).toBe(off[k]);
    expect(previewFrameCsp([ORIGIN], { cdn: true })).not.toMatch(/unpkg|\*|\/gh\//);
  });
});

/** GET /frame from a listener or gateway: its CSP header. */
function frameCsp(port: number, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/frame", headers: { Host: host } }, res => { res.resume(); resolve(String(res.headers["content-security-policy"])); });
    req.on("error", reject); req.end();
  });
}

describe("read per /frame response: a change applies to the next preview started", () => {
  it("the local preview listener", async () => {
    let cdn = false;
    const l = createPreviewListener({ settings: previewSettings({ preview_port: 0 }, 0), healthPort: 19280, config: {} as any, cdn: () => cdn });
    await new Promise<void>(r => l.server.listen(0, "127.0.0.1", () => r()));
    const port = (l.server.address() as any).port;
    try {
      expect(await frameCsp(port, `127.0.0.1:${port}`)).not.toContain("jsdelivr");
      cdn = true;
      expect(await frameCsp(port, `127.0.0.1:${port}`)).toContain("script-src 'unsafe-inline' https://cdnjs.cloudflare.com/ajax/libs/ https://cdn.jsdelivr.net/npm/");
      cdn = false;
      expect(await frameCsp(port, `127.0.0.1:${port}`)).not.toContain("jsdelivr");
    } finally { l.close(); }
  });
  it("the public link's preview gateway follows the same setting", async () => {
    let cdn = true;
    const g = createPublicPreviewGateway({ exposureId: "x", dashboardOrigin: () => "https://a.trycloudflare.com", isCurrent: () => true, cdn: () => cdn });
    const origin = await g.listen();
    const port = Number(new URL(origin).port);
    g.setHost("b.trycloudflare.com");
    try {
      expect(await frameCsp(port, "b.trycloudflare.com")).toContain("https://cdn.jsdelivr.net/npm/");
      cdn = false;
      expect(await frameCsp(port, "b.trycloudflare.com")).not.toContain("jsdelivr");
    } finally { await g.close(); }
  });
});

describe("config and the settings body", () => {
  it("web.preview_cdn: a boolean", () => {
    expect(validateFleetConfig({ instances: {}, web: { preview_cdn: true } } as any).errors).toEqual([]);
    expect(validateFleetConfig({ instances: {}, web: { preview_cdn: "yes" } } as any).errors.map((e: any) => e.path)).toContain("web.preview_cdn");
    expect(parseWebSettingsBody({ preview_cdn: true })).toMatchObject({ previewCdn: true });
    expect(parseWebSettingsBody({ preview_cdn: 1 })).toEqual({ error: "preview_cdn must be a boolean" });
  });
});

describe("the prologue reports a blocked library (kind blocked: origin + path only)", () => {
  function run(events: Array<Record<string, unknown>>) {
    const posted: unknown[][] = [];
    const listeners: Record<string, (e: unknown) => void> = {};
    new Function("addEventListener", "err", BLOCKED_PROLOGUE)((t: string, fn: (e: unknown) => void) => { listeners[t] = fn; }, (...a: unknown[]) => posted.push(a));
    for (const e of events) listeners.securitypolicyviolation!(e);
    return posted;
  }
  it("a blocked script, stylesheet or font: its origin and path — never the query, fragment or sample", () => {
    expect(run([
      { effectiveDirective: "script-src-elem", blockedURI: "https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.js?secret=1#x", sample: "page text" },
      { effectiveDirective: "style-src-elem", blockedURI: "https://cdnjs.cloudflare.com/ajax/libs/a.css" },
      { effectiveDirective: "font-src", blockedURI: "https://unpkg.com/f.woff2" },
    ])).toEqual([
      ["blocked", "https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.js", 0, 0],
      ["blocked", "https://cdnjs.cloudflare.com/ajax/libs/a.css", 0, 0],
      ["blocked", "https://unpkg.com/f.woff2", 0, 0],
    ]);
  });
  it("not reported: inline violations, other directives, other schemes", () => {
    expect(run([
      { effectiveDirective: "script-src-elem", blockedURI: "inline", sample: "alert(1)" },
      { effectiveDirective: "connect-src", blockedURI: "https://evil.example/x" },
      { effectiveDirective: "img-src", blockedURI: "https://cdn.jsdelivr.net/npm/x.png" },
      { effectiveDirective: "script-src-elem", blockedURI: "data:text/javascript,1" },
    ])).toEqual([]);
  });
  it("it is in the shim, inside the prologue that has err (the errors chip's caps)", () => {
    const shim = buildShim("b".repeat(32), [ORIGIN]);
    expect(shim).toContain(JSON.stringify(BLOCKED_PROLOGUE).slice(1, 60));
    expect(shim.indexOf("function err(")).toBeLessThan(shim.indexOf("securitypolicyviolation"));
  });
});
