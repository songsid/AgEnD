/** Keep this HTTP fixture's ports bound through setup, then give the real TLS listeners the same sockets. */
import { createServer, Server } from "node:net";
import { Server as TlsServer } from "node:tls";
import { vi } from "vitest";
import * as network from "../../src/hub/init/network.js";

// One interception serves all active allocators. Spying again would capture and
// overwrite the same mock, recursing on the next listen or network preflight.
function interceptListeners() {
  const leases = new Map<number, { server: Server; claimed: boolean }>();
  const listen = Server.prototype.listen;
  // server.listen(handle) is Node's bound-handle overload: no close/rebind window and no synthetic listener.
  const listenSpy = vi.spyOn(Server.prototype, "listen").mockImplementation(function(this: Server, ...args: any[]) {
    const lease = typeof args[0] === "number" && args[1] === "127.0.0.1" ? leases.get(args[0]) : undefined;
    if (lease && !lease.claimed && this instanceof TlsServer) {
      lease.claimed = true;
      return Reflect.apply(listen, this, [lease.server, args.filter(arg => typeof arg === "function").pop()]);
    }
    return Reflect.apply(listen, this, args);
  });
  const owned = (listeners: network.HubInitListeners, selected: readonly ("web" | "member")[]) =>
    selected.every(kind => {
      const { host, port } = listeners[`${kind}Listen`], lease = leases.get(port);
      return host === "127.0.0.1" && lease?.claimed === false && lease.server.listening;
    });
  const checkHome = network.checkHubInitNetworkForHome, checkListeners = network.checkHubListeners;
  // An owned socket already proves bind availability. Probing it would reject our own reservation. All other
  // endpoints (including deliberately occupied candidates) still use the actual network preflight.
  const homeSpy = vi.spyOn(network, "checkHubInitNetworkForHome").mockImplementation((home, listeners) =>
    owned(listeners, ["web", "member"]) ? Promise.resolve([]) : checkHome(home, listeners));
  const listenersSpy = vi.spyOn(network, "checkHubListeners").mockImplementation((listeners, options, selected) =>
    owned(listeners, selected) ? Promise.resolve([]) : checkListeners(listeners, options, selected));
  return { leases, users: 0, restore() {
    listenersSpy.mockRestore(); homeSpy.mockRestore(); listenSpy.mockRestore();
  } };
}
let active: ReturnType<typeof interceptListeners> | undefined;

export function hubListenerPorts() {
  const scope = active ??= interceptListeners();
  scope.users++;
  const leases = new Map<number, { server: Server; claimed: boolean }>();
  let closed = false;
  async function close(server: Server) {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error =>
      error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
  }
  return {
    async next(): Promise<number> {
      if (closed) throw Error("Listener port allocator is closed");
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
      });
      server.unref();
      const port = (server.address() as { port: number }).port;
      const lease = { server, claimed: false };
      leases.set(port, lease); scope.leases.set(port, lease);
      return port;
    },
    /** Only the two explicit bind-competitor cases abandon a reservation, to exercise real production refusal. */
    async release(port: number) {
      const lease = leases.get(port);
      if (!lease || lease.claimed) throw Error("Listener port is not reserved");
      leases.delete(port);
      scope.leases.delete(port);
      await close(lease.server);
    },
    async close() {
      if (closed) return;
      closed = true;
      try { for (const lease of leases.values()) await close(lease.server); }
      finally {
        for (const port of leases.keys()) scope.leases.delete(port);
        leases.clear();
        if (--scope.users === 0) { scope.restore(); active = undefined; }
      }
    },
  };
}
