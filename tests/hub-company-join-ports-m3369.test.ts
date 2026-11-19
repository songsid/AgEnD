import { afterEach, expect, it, vi } from "vitest";
import { createServer, Server } from "node:net";

const dc = vi.hoisted(() => ({ port: 0 }));
vi.mock("node:tls", async original => {
  const real = await original<typeof import("node:tls")>();
  return { ...real, connect: (options: import("node:tls").ConnectionOptions) => real.connect({
    ...options, ...(options.host === "127.0.0.1" && options.port === 636 ? { port: dc.port } : {}),
  }) };
});
import * as factory from "../src/hub/compose/server.js";
import * as network from "../src/hub/init/network.js";
import { companyJoinRig } from "./support/hub-company-join-rig.js";

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

it("holds both company-join ports against a competing bind until the real TLS listeners take over", async () => {
  const create = factory.createHubServerFactory;
  const competitors: Server[] = [], outcomes: string[] = [], ports: number[] = [];
  vi.spyOn(factory, "createHubServerFactory").mockImplementation(options => {
    const mount = create(options);
    return Object.assign(async (...args: Parameters<typeof mount>) => {
      const service = await mount(...args), start = service.start.bind(service);
      service.start = async () => {
        for (const listener of [args[0].memberListen, args[0].webListen] as { port: number }[]) {
          const competitor = createServer(); competitors.push(competitor); ports.push(listener.port);
          outcomes.push(await bind(competitor, listener.port));
        }
        // At the old close/rebind gap both competitors own the ports, so the actual start fails.
        await start();
      };
      return service;
    }, { drain: mount.drain });
  });
  let rig: Awaited<ReturnType<typeof companyJoinRig>> | undefined;
  try {
    rig = await companyJoinRig(port => { dc.port = port; });
    expect(ports[0]).not.toBe(ports[1]);
    expect(outcomes).toEqual(["EADDRINUSE", "EADDRINUSE"]);
    expect((await rig.call(null, "GET", "/hub/v1/session")).status).toBe(200);
    const admin = await rig.signIn("alice");
    expect((await rig.call(admin, "PUT", "/hub/v1/admin/company-join", { enabled: true, expectedRevision: 1 })).status).toBe(200);
    expect((await rig.call(null, "POST", "/hub/v1/join/challenge", {}, { Origin: undefined })).status).toBe(400);
    await rig.close(); await rig.close();
    for (const port of ports) {
      const released = createServer();
      try { expect(await bind(released, port)).toBe("bound"); }
      finally { await close(released); }
    }
  } finally {
    await rig?.close();
    for (const server of competitors) await close(server);
  }
});

it("can create consecutive company-join rigs without restoring mocks between lifetimes", async () => {
  const listen = Server.prototype.listen, checkHome = network.checkHubInitNetworkForHome, checkListeners = network.checkHubListeners;
  for (let index = 0; index < 2; index++) {
    const rig = await companyJoinRig(port => { dc.port = port; });
    try { expect((await rig.call(null, "GET", "/hub/v1/session")).status).toBe(200); }
    finally { await rig.close(); }
    expect(Server.prototype.listen).toBe(listen);
    expect(network.checkHubInitNetworkForHome).toBe(checkHome);
    expect(network.checkHubListeners).toBe(checkListeners);
  }
});
