import { afterEach, expect, it, vi } from "vitest";
import { createServer, Server } from "node:net";
import { existsSync, rmSync } from "node:fs";
import { hubPreviewRig } from "./helpers/hub-preview-rig.js";
import * as factory from "../src/hub/compose/server.js";
import * as certificates from "./support/hub-init-fixtures.js";

afterEach(() => vi.restoreAllMocks());

async function bind(server: Server, port: number) {
  return new Promise<string>(resolve => {
    server.once("error", error => resolve((error as NodeJS.ErrnoException).code ?? "unknown"));
    server.listen(port, "127.0.0.1", () => resolve("bound"));
  });
}
async function close(server: Server) {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

it("holds all three preview-rig addresses through deferred real TLS startup", async () => {
  const r = await hubPreviewRig({ start: false });
  const ports = [r.memberPort, r.webPort, r.previewPort];
  const competitors: Server[] = [], results: string[] = [];
  let service: Awaited<ReturnType<typeof r.factory>> | undefined;
  try {
    expect(new Set(ports).size).toBe(3);
    for (const port of ports) {
      const competitor = createServer(); competitors.push(competitor);
      results.push(await bind(competitor, port));
    }
    // On the old fixture the competitors own all three freed addresses.
    service = await r.factory(r.config, () => true);
    await service.start();
    expect(results).toEqual(["EADDRINUSE", "EADDRINUSE", "EADDRINUSE"]);
    expect((await r.call(null, "GET", "/ui/hub")).status).toBe(200);
    expect((await r.call(null, "GET", "/frame", undefined, {}, "preview")).status).toBe(200);
    await service.close(); await r.close(); await r.close();
    for (const port of ports) {
      const released = createServer();
      try { expect(await bind(released, port)).toBe("bound"); }
      finally { await close(released); }
    }
  } finally {
    await service?.close(); await r.close();
    for (const competitor of competitors) await close(competitor);
  }
});

it("cleans reservations, generated certificates and state after an initial start failure", async () => {
  const create = factory.createHubServerFactory, makeCerts = certificates.makeTestCerts;
  const roots: string[] = [], ports: number[] = [], services: Awaited<ReturnType<ReturnType<typeof create>>>[] = [];
  const listen = Server.prototype.listen, failure = new Error("Owned fixture start refused");
  vi.spyOn(certificates, "makeTestCerts").mockImplementation((...args) => {
    const certs = makeCerts(...args); roots.push(certs.dir); return certs;
  });
  vi.spyOn(factory, "createHubServerFactory").mockImplementation(options => {
    roots.push(options.home);
    const mount = create(options);
    return Object.assign(async (...args: Parameters<typeof mount>) => {
      const config = args[0] as { memberListen: { port: number }; webListen: { port: number }; web: { preview_port: number } };
      ports.push(config.memberListen.port, config.webListen.port, config.web.preview_port);
      const service = await mount(...args); services.push(service);
      service.start = async () => { throw failure; };
      return service;
    }, { drain: mount.drain });
  });
  try {
    await expect(hubPreviewRig()).rejects.toBe(failure);
    expect(ports).toHaveLength(3); expect(roots).toHaveLength(2);
    for (const root of roots) expect(existsSync(root)).toBe(false);
    expect(Server.prototype.listen).toBe(listen);
    for (const port of ports) {
      const probe = createServer();
      try { expect(await bind(probe, port)).toBe("bound"); }
      finally { await close(probe); }
    }
  } finally {
    for (const service of services) await service.close();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
