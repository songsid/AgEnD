import { afterEach, describe, expect, it } from "vitest";
import { createHubPreviewHandler, hubPreviewReloadKey, hubPreviewSettings, hubPreviewView } from "../src/hub/preview.js";
import { previewFrameResponse } from "../src/web-preview.js";
import { effectiveHubView, HubRuntime } from "../src/hub/runtime.js";
import { hubPlanDigest } from "../src/hub/init/plan-digest.js";
import { hubPreviewRig } from "./helpers/hub-preview-rig.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sockets = { webOrigin: "https://hub.example.test:9443", memberOrigin: "https://hub.example.test:9444",
  webListen: { host: "127.0.0.1", port: 9443 }, memberListen: { host: "127.0.0.1", port: 9444 } };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
describe("the Hub's optional preview setting", () => {
  it("is off when absent; uses the Hub's hostname/listen address when enabled", () => {
    expect(hubPreviewSettings(sockets)).toBeNull(); expect(hubPreviewSettings({ ...sockets, web: {} })).toBeNull();
    expect(hubPreviewSettings({ ...sockets, web: { preview_port: 9445 } })).toEqual({ host: "127.0.0.1", port: 9445, origin: "https://hub.example.test:9445" });
    expect(hubPreviewSettings({ ...sockets, webOrigin: "https://[::1]:9443", web: { preview_port: 9445 } })?.origin).toBe("https://[::1]:9445");
  });
  it.each([null, "9445", true, 0, -1, 65536, 1.5, 9443, 9444])("refuses invalid or clashing port %s", preview_port => {
    expect(() => hubPreviewSettings({ ...sockets, web: { preview_port } })).toThrow();
  });
  it("rejects an origin clash despite a differently mapped internal listener or explicit default port", () => {
    expect(() => hubPreviewSettings({ ...sockets, webOrigin: "https://hub.example.test:443", web: { preview_port: 443 } })).toThrow();
    expect(() => hubPreviewSettings({ ...sockets, memberOrigin: "https://hub.example.test:9445", web: { preview_port: 9445 } })).toThrow();
    expect(() => hubPreviewSettings({ ...sockets, webOrigin: "http://hub.example.test:9443", web: { preview_port: 9445 } })).toThrow();
  });
  it("distinguishes invalid values from off in reload admission", () => {
    expect(hubPreviewReloadKey(undefined)).toBe(hubPreviewReloadKey({}));
    for (const web of [null, [], "invalid", { preview_port: null }, { preview_port: "9445" }, { preview_port: 9445 }])
      expect(hubPreviewReloadKey(web)).not.toBe(hubPreviewReloadKey(undefined));
  });
  it("uses the browser's canonical origin in the shell and shim handshake", () => {
    const origin = "https://HUB.example.test:443/", settings = hubPreviewSettings({ ...sockets, webOrigin: origin, web: { preview_port: 9445 } })!;
    expect(hubPreviewView(origin, settings, "a".repeat(32)).dashboardOrigin).toBe("https://hub.example.test");
    const req = { method: "GET", url: "/frame", headers: { host: "hub.example.test:9445" } };
    let body = "", csp = "";
    const res = { writeHead: (_status: number, headers: Record<string, string>) => { csp = headers["Content-Security-Policy"] ?? headers["content-security-policy"]!; return res; }, end: (bytes: Buffer) => { body = bytes.toString(); } };
    createHubPreviewHandler(settings, origin, "a".repeat(32), () => true)(req as IncomingMessage, res as unknown as ServerResponse);
    expect(csp).toContain("frame-ancestors https://hub.example.test;");
    expect(body).toContain('ORIGINS = ["https://hub.example.test"]');
  });
});
describe.skipIf(process.platform === "win32")("real Hub HTTPS preview lifecycle", () => {
  it("shares the browser certificate, exact fleet response, shell attributes and narrow framing policy", async () => {
    const r = await hubPreviewRig(); cleanup.push(r.close);
    const frame = await r.call(null, "GET", "/frame", undefined, {}, "preview"), shell = await r.call(null, "GET", "/ui/hub");
    expect(frame.status).toBe(200); expect(shell.status).toBe(200); expect(frame.fingerprint).toBe(shell.fingerprint);
    const boot = /data-preview-boot="([a-f0-9]{32})"/.exec(shell.text)![1]!;
    const expected = previewFrameResponse(boot, [r.webOrigin], { cdn: false });
    expect(frame.bytes).toEqual(expected.body);
    for (const [name, value] of Object.entries(expected.headers)) expect(frame.headers[name.toLowerCase()]).toBe(value);
    expect(frame.headers["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(frame.headers["content-security-policy"]).not.toContain("allow-same-origin");
    expect(frame.headers["content-security-policy"]).toContain("connect-src 'none'");
    expect(shell.text).toContain(`data-preview-origin="${r.previewOrigin}"`);
    expect(shell.text).toContain(`data-dashboard-origin="${r.webOrigin}"`);
    expect(shell.headers["content-security-policy"]).toContain(`frame-src ${r.previewOrigin}/frame`);
  });
  it("ignores poisoned cookies, serves no files/API/other methods, and fences immediately", async () => {
    const r = await hubPreviewRig(); cleanup.push(r.close);
    const plain = await r.call(null, "GET", "/frame", undefined, {}, "preview");
    const poisoned = await r.call(null, "GET", "/frame", undefined, { Cookie: "__Host-agend_hub_bad=secret; malformed; agend_session=private" }, "preview");
    expect(poisoned.bytes).toEqual(plain.bytes); expect(poisoned.headers["set-cookie"]).toBeUndefined();
    for (const [method, path] of [["GET", "/"], ["GET", "/hub/v1/session"], ["GET", "/p/token"], ["GET", "/frame?file=x"], ["POST", "/frame"], ["HEAD", "/frame"]]) {
      const got = await r.call(null, method!, path!, undefined, {}, "preview"); expect(got.status).toBe(404); expect(got.bytes.length).toBe(0);
    }
    expect((await r.call(null, "GET", "/frame", undefined, { Host: "wrong.example.test" }, "preview")).status).toBe(404);
    r.fence(); expect((await r.call(null, "GET", "/frame", undefined, {}, "preview")).status).toBe(503);
  });
  it("never even reads a Cookie header", () => {
    const req = { method: "GET", url: "/frame", headers: { host: "hub.example.test:9445", get cookie(): never { throw Error("cookie read"); } } };
    const res = { writeHead: () => res, end: () => undefined };
    expect(() => createHubPreviewHandler({ host: "127.0.0.1", port: 9445, origin: "https://hub.example.test:9445" }, sockets.webOrigin, "a".repeat(32), () => true)(req as unknown as IncomingMessage, res as unknown as ServerResponse)).not.toThrow();
  });
  it("renews the browser certificate on both listeners", async () => {
    const r = await hubPreviewRig(); cleanup.push(r.close);
    const before = await r.call(null, "GET", "/frame", undefined, {}, "preview");
    const control = r.certificate()!;
    writeFileSync(join(r.home, "renew.pem"), readFileSync(r.certs.selfSigned), { mode: 0o600 });
    writeFileSync(join(r.home, "renew.key"), readFileSync(r.certs.selfSignedKey), { mode: 0o600 });
    const proposal = await control.prepare({ mode: "import", revision: control.read().revision,
      certificateFile: "renew.pem", keyFile: "renew.key" }, "test-owner", () => true);
    const applied = control.apply({ reference: proposal.reference, revision: proposal.revision }, "test-owner", () => true);
    expect(applied.restartRequired).toBe(false);
    const frame = await r.call(null, "GET", "/frame", undefined, {}, "preview"), shell = await r.call(null, "GET", "/ui/hub");
    expect(frame.fingerprint).not.toBe(before.fingerprint);
    expect(frame.fingerprint).toBe(shell.fingerprint); expect(frame.fingerprint).toBe(applied.selected.fingerprint256);
  });
  it("cleans a partial start when the preview port cannot bind", async () => {
    const r = await hubPreviewRig({ start: false }); cleanup.push(r.close);
    const occupied = createServer(); await new Promise<void>(done => occupied.listen(r.previewPort, "127.0.0.1", done));
    cleanup.push(() => new Promise<void>(done => occupied.close(() => done())));
    const service = await r.factory(r.config, () => true); cleanup.push(() => service.close());
    await expect(service.start()).rejects.toThrow(); await service.close();
    for (const port of [r.memberPort, r.webPort]) {
      const probe = createServer(); await new Promise<void>((done, fail) => { probe.once("error", fail); probe.listen(port, "127.0.0.1", done); });
      await new Promise<void>(done => probe.close(() => done()));
    }
  });
  it("does not advertise or start a preview by default", async () => {
    const r = await hubPreviewRig({ preview: false }); cleanup.push(r.close);
    const shell = await r.call(null, "GET", "/ui/hub");
    expect(shell.text).not.toContain("data-preview-origin="); expect(shell.text).toContain('data-preview-reason-code="notOffered"');
    expect(shell.headers["content-security-policy"]).not.toContain(r.previewOrigin);
    expect((r.service as any).previewAddress()).toBeNull();
  });
  it("reloads the local opt-in without changing existing sealed initialization", async () => {
    const r = await hubPreviewRig({ preview: false, start: false }); cleanup.push(r.close);
    const original = hubPlanDigest(r.config), before = effectiveHubView({ hub: r.config });
    const runtime = new HubRuntime({ home: r.home, log: () => {}, createServer: r.factory }); cleanup.push(() => runtime.close());
    await runtime.apply({ hub: r.config }); expect(runtime.serverHealth(r.config)).toBe("ready");
    const on = { ...r.config, web: { preview_port: r.previewPort } };
    expect(hubPlanDigest(on)).toBe(original); expect(effectiveHubView({ hub: on })).not.toBe(before);
    expect(runtime.serverHealth(on)).toBe("starting"); await runtime.apply({ hub: on });
    expect(runtime.serverHealth(on)).toBe("ready"); expect((await r.call(null, "GET", "/frame", undefined, {}, "preview")).status).toBe(200);
    await runtime.apply({ hub: r.config }); expect((await r.call(null, "GET", "/ui/hub")).text).not.toContain("data-preview-origin=");
  });
  it("keeps HTML behind D's session, exact room/file and read-own-room authorization", async () => {
    const r = await hubPreviewRig(); cleanup.push(r.close);
    const w = await r.htmlWorld("<!doctype html><h1>Only the asker sees this</h1>");
    expect((await r.call(w.asker, "GET", w.file.url)).status).toBe(200);
    expect((await r.call(w.other, "GET", w.file.url)).status).toBe(404);
    expect((await r.call(null, "GET", w.file.url)).status).toBe(401);
    r.people.get("owner")!.eligible = false;
    expect((await r.call(w.asker, "GET", w.file.url)).status).toBe(403);
    r.people.get("owner")!.eligible = true;
    w.owner = await r.signIn("owner"); // Eligibility failure also revokes the owner's old session.
    expect((await r.call(w.asker, "GET", w.file.url.replace(w.file.id, "00000000-0000-4000-8000-000000000000"))).status).toBe(404);
    const second = await r.htmlWorld("<!doctype html><h1>Another granted room</h1>");
    expect((await r.call(second.asker, "GET", second.file.url)).status).toBe(200);
    expect((await r.call(second.asker, "GET", w.file.url.replace(w.room.id, second.room.id))).status).toBe(404);
    expect((await r.call(w.owner, "DELETE", `/hub/v1/grants/${w.grant.id}?revision=${w.grant.revision}`)).status).toBe(200);
    expect((await r.call(w.asker, "GET", w.file.url)).status).toBe(403);
    const frame = await r.call(null, "GET", "/frame", undefined, {}, "preview");
    expect(frame.text).not.toContain("Only the asker sees this"); expect(frame.text).not.toContain(w.file.id);
  });
});
