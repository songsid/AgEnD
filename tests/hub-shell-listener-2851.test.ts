import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenLoopback } from "../scripts/manual/smoke-fixture/listen-loopback.mjs";

const servers: ReturnType<typeof createServer>[] = [];
const makeServer = (body = "ready") => {
  const server = createServer((_req, res) => res.end(body)); servers.push(server); return server;
};
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe("the Hub shell gate's owned listener", () => {
  it("binds port zero once and returns the actual port without closing its reservation", async () => {
    const server = makeServer();
    const listen = vi.spyOn(server, "listen"), close = vi.spyOn(server, "close");
    const port = await listenLoopback(server);
    expect(port).toBeGreaterThan(0);
    expect(server.address()).toMatchObject({ address: "127.0.0.1", port });
    expect(listen).toHaveBeenCalledExactlyOnceWith(0, "127.0.0.1", expect.any(Function));
    expect(close).not.toHaveBeenCalled();
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("ready");
  });

  it("keeps occupied listeners and concurrent gate reservations distinct", async () => {
    const blocker = makeServer("occupied"), occupied = await listenLoopback(blocker);
    const candidates = Array.from({ length: 8 }, () => makeServer());
    const ports = await Promise.all(candidates.map((s) => listenLoopback(s)));
    expect(new Set([occupied, ...ports]).size).toBe(9);
    expect([blocker, ...candidates].every(server => server.listening)).toBe(true);
    expect(await (await fetch(`http://127.0.0.1:${occupied}`)).text()).toBe("occupied");
  });

  it("propagates asynchronous bind errors once without retrying", async () => {
    const server = makeServer(), error = new Error("owned bind refused");
    const listen = vi.spyOn(server, "listen").mockImplementation(() => {
      queueMicrotask(() => server.emit("error", error)); return server;
    });
    await expect(listenLoopback(server)).rejects.toBe(error);
    expect(listen).toHaveBeenCalledOnce();
    expect(server.listenerCount("error")).toBe(0);
  });

  it("propagates a synchronous refusal and leaves an existing listener intact", async () => {
    const server = makeServer(), port = await listenLoopback(server);
    const listen = vi.spyOn(server, "listen");
    await expect(listenLoopback(server)).rejects.toMatchObject({ code: "ERR_SERVER_ALREADY_LISTEN" });
    expect(listen).toHaveBeenCalledOnce();
    expect(server.listenerCount("error")).toBe(0);
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("ready");
  });

  it("an explicit port binds that port (HUB_GATE_PORT)", async () => {
    const probe = makeServer(), port = await listenLoopback(probe);
    probe.closeAllConnections();
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const server = makeServer();
    expect(await listenLoopback(server, { port })).toBe(port);
    expect(server.address()).toMatchObject({ address: "127.0.0.1", port });
  });

  it("an explicit occupied port fails once with EADDRINUSE", async () => {
    const blocker = makeServer("occupied"), port = await listenLoopback(blocker);
    const server = makeServer(), listen = vi.spyOn(server, "listen");
    await expect(listenLoopback(server, { port })).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(listen).toHaveBeenCalledOnce();
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("occupied");
  });

  it("the Hub UI gate binds through listenLoopback, not a fixed 48930", () => {
    const src = readFileSync(new URL("../scripts/manual/smoke/smoke-hub-ui-gate.mts", import.meta.url), "utf8");
    expect(src).toContain("listenLoopback");
    expect(src).not.toMatch(/\?\? 48930/);
  });
});
