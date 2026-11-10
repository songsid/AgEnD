import type { Server } from "node:net";

/** Bind once and retain the listener: never probe a free port and close it before use. */
export function listenLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => { server.removeListener("error", failed); reject(error); };
    server.once("error", failed);
    try {
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", failed);
        const address = server.address();
        if (!address || typeof address === "string") reject(new Error("Loopback listener has no TCP address"));
        else resolve(address.port);
      });
    } catch (error) { server.removeListener("error", failed); reject(error); }
  });
}
