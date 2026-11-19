import { afterEach, expect, it, vi } from "vitest";
import { createServer, Server } from "node:net";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as identity from "../src/hub/tls.js";
import * as storage from "../src/hub/store.js";
import { HubServer } from "../src/hub/server.js";
import { hubRig } from "./helpers/hub-rig.js";
import { hubListenerPorts } from "./helpers/hub-listener-ports.js";

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

it("holds the default member socket against a competing bind during identity setup", async () => {
  const provision = identity.provisionHubIdentity, competitor = createServer();
  let root: string | undefined, port = 0, rig: Awaited<ReturnType<typeof hubRig>> | undefined;
  vi.spyOn(identity, "provisionHubIdentity").mockImplementation(async options => {
    root = options.home; port = Number(new URL(options.memberOrigin).port);
    const material = await provision(options);
    // Fails before DB setup on the base: the competitor can acquire its freed address.
    expect(await bind(competitor, port)).toBe("EADDRINUSE");
    return material;
  });
  try {
    rig = await hubRig();
    expect(rig.server.address()?.port).toBe(port);
    await rig.pair();
    const client = rig.client(); await client.value.start();
    expect(client.state.link?.current()).toBe(true);
    await rig.close(); await rig.close();
    expect(existsSync(root!)).toBe(false);
    const released = createServer();
    try { expect(await bind(released, port)).toBe("bound"); }
    finally { await close(released); }
  } finally {
    await rig?.close(); await close(competitor);
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

it("refuses an occupied explicit port without closing the caller's socket or leaking state", async () => {
  const parent = mkdtempSync(join(tmpdir(), "agend-member-port-conflict-")), competitor = createServer();
  const listen = Server.prototype.listen;
  try {
    expect(await bind(competitor, 0)).toBe("bound");
    const port = (competitor.address() as { port: number }).port;
    await expect(hubRig({ memberPort: port, parentDir: parent })).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(competitor.listening).toBe(true);
    expect(readdirSync(parent)).toEqual([]);
    expect(Server.prototype.listen).toBe(listen);
  } finally { await close(competitor); rmSync(parent, { recursive: true, force: true }); }
});

it("keeps a caller's spare lease held while default and explicitly leased rigs close", async () => {
  const ports = hubListenerPorts(), explicitPort = await ports.next(), spare = await ports.next();
  let automatic: Awaited<ReturnType<typeof hubRig>> | undefined, explicit: Awaited<ReturnType<typeof hubRig>> | undefined;
  try {
    automatic = await hubRig(); explicit = await hubRig({ memberPort: explicitPort });
    expect(explicit.server.address()?.port).toBe(explicitPort);
    expect(automatic.server.address()?.port).not.toBe(explicitPort);
    await automatic.close(); await explicit.close();
    const competitor = createServer();
    try { expect(await bind(competitor, spare)).toBe("EADDRINUSE"); }
    finally { await close(competitor); }
  } finally { await automatic?.close(); await explicit?.close(); await ports.close(); }
});

it("releases the owned port, database and state after an initial server start failure", async () => {
  const provision = identity.provisionHubIdentity, migrate = storage.migrateHubTransportStore;
  const listen = Server.prototype.listen, failure = new Error("Owned member start refused");
  let root: string | undefined, port = 0, db: Parameters<typeof migrate>[0] | undefined;
  vi.spyOn(identity, "provisionHubIdentity").mockImplementation(options => {
    root = options.home; port = Number(new URL(options.memberOrigin).port); return provision(options);
  });
  vi.spyOn(storage, "migrateHubTransportStore").mockImplementation(value => { db = value; return migrate(value); });
  vi.spyOn(HubServer.prototype, "start").mockRejectedValue(failure);
  const serverClose = vi.spyOn(HubServer.prototype, "close");
  try {
    await expect(hubRig()).rejects.toBe(failure);
    expect(db).toBeDefined(); expect(db!.open).toBe(false);
    expect(serverClose).toHaveBeenCalledTimes(1);
    expect(root).toBeDefined(); expect(existsSync(root!)).toBe(false);
    expect(Server.prototype.listen).toBe(listen);
    const probe = createServer();
    try { expect(await bind(probe, port)).toBe("bound"); }
    finally { await close(probe); }
  } finally {
    if (db?.open) db.close();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});
