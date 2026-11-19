import { afterEach, expect, it, vi } from "vitest";
import { createServer as netServer } from "node:net";
import { createServer as httpsServer, get } from "node:https";
import { readFileSync, rmSync } from "node:fs";
import * as rig from "./helpers/hub-rig.js";
import { hubComposePorts } from "./helpers/hub-compose-ports.js";
import { makeTestCerts } from "./support/hub-init-fixtures.js";
import { Server } from "node:net";
import * as network from "../src/hub/init/network.js";

afterEach(() => vi.restoreAllMocks());

it("isolates overlapping allocations and restores interception after the last close", async () => {
  const listen = Server.prototype.listen, checkHome = network.checkHubInitNetworkForHome, checkListeners = network.checkHubListeners;
  const first = await hubComposePorts(), second = await hubComposePorts();
  try {
    expect(new Set([first.memberPort, first.webPort, second.memberPort, second.webPort]).size).toBe(4);
    await first.close(); await first.close();
    await expectHeld(second.memberPort); await expectHeld(second.webPort);
  } finally { await first.close(); await second.close(); }
  expect(Server.prototype.listen).toBe(listen);
  expect(network.checkHubInitNetworkForHome).toBe(checkHome);
  expect(network.checkHubListeners).toBe(checkListeners);
});

async function expectHeld(port: number) {
  const competitor = netServer();
  try {
    const result = await new Promise<string>(resolve => {
      competitor.once("error", error => resolve((error as NodeJS.ErrnoException).code ?? "unknown"));
      competitor.listen(port, "127.0.0.1", () => resolve("stolen"));
    });
    expect(result).toBe("EADDRINUSE");
  } finally {
    if (competitor.listening) await new Promise<void>(resolve => competitor.close(() => resolve()));
  }
}

it("keeps distinct compose listeners when the legacy free-port picker repeats one address", async () => {
  vi.spyOn(rig, "freeHubPort").mockResolvedValue(31337);
  const ports = await hubComposePorts();
  try {
    expect(ports.memberPort).not.toBe(ports.webPort);
    await expectHeld(ports.memberPort);
    await expectHeld(ports.webPort);
  }
  finally { await ports.close(); }
});

it("hands both reserved sockets to real TLS listeners without releasing either address", async () => {
  const ports = await hubComposePorts();
  const certs = makeTestCerts();
  const options = { cert: readFileSync(certs.cert), key: readFileSync(certs.key) };
  const member = httpsServer(options, (_request, response) => response.end("member"));
  const web = httpsServer(options, (_request, response) => response.end("web"));
  const ca = readFileSync(certs.caCert);
  const read = (port: number) => new Promise<string>((resolve, reject) => {
    get({ host: "127.0.0.1", port, servername: "hub.example.test", ca }, response => {
      let text = ""; response.on("data", data => { text += data; }); response.on("end", () => resolve(text));
    }).on("error", reject);
  });
  try {
    await expectHeld(ports.memberPort);
    await expectHeld(ports.webPort);
    await new Promise<void>(resolve => member.listen(ports.memberPort, "127.0.0.1", resolve));
    await expectHeld(ports.webPort);
    await new Promise<void>(resolve => web.listen(ports.webPort, "127.0.0.1", resolve));
    expect(await read(ports.memberPort)).toBe("member");
    expect(await read(ports.webPort)).toBe("web");
    await expectHeld(ports.memberPort);
    await expectHeld(ports.webPort);
  } finally {
    for (const server of [member, web]) {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await ports.close();
    rmSync(certs.dir, { recursive: true, force: true });
  }
});
