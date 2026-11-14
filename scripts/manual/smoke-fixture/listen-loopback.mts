import type { Server } from "node:net";

/** Bind once and retain the listener: never probe a free port and close it before use.
 *  Default is port 0 (OS-assigned). Pass `{ port }` for an override such as HUB_GATE_PORT.
 *  A second numeric argument is ignored so `servers.map(listenLoopback)` stays safe. */
export function listenLoopback(server: Server, opts?: { port?: number }): Promise<number> {
  const port = opts && typeof opts === "object" ? (opts.port ?? 0) : 0;
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => { server.removeListener("error", failed); reject(error); };
    server.once("error", failed);
    try {
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", failed);
        const address = server.address();
        if (!address || typeof address === "string") reject(new Error("Loopback listener has no TCP address"));
        else resolve(address.port);
      });
    } catch (error) { server.removeListener("error", failed); reject(error); }
  });
}
