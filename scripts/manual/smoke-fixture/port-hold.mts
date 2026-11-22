// M-3510: a smoke's control that holds loopback ports while its fixture boots elsewhere (ephemeral, read back). A port is
// "held" when this process now listens on it, or "taken" when another listener already has it (EADDRINUSE) — either way
// nobody can start on it. Any other error (EACCES, EADDRNOTAVAIL, …) proves nothing about the port: it fails the control,
// and the sockets this call already opened are closed first.
import { createServer as netCreateServer, type Server } from "node:net";

export type PortHold = { port: number; state: "held"; server: Server } | { port: number; state: "taken" };
type Factory = () => Pick<Server, "once" | "listen" | "close" | "removeAllListeners">;

function holdOne(port: number, create: Factory): Promise<PortHold> {
  return new Promise((resolve, reject) => {
    const srv = create();
    srv.once("error", (err: NodeJS.ErrnoException) => {
      srv.removeAllListeners();
      if (err && err.code === "EADDRINUSE") resolve({ port, state: "taken" });
      else reject(Object.assign(new Error(`could not hold port ${port}: ${err?.code ?? err}`), { code: err?.code }));
    });
    srv.listen(port, "127.0.0.1", () => resolve({ port, state: "held", server: srv as Server }));
  });
}

/** Hold each port in turn; on a non-EADDRINUSE error, close what was held and throw. */
export async function holdPorts(ports: readonly number[], create: Factory = netCreateServer): Promise<PortHold[]> {
  const out: PortHold[] = [];
  try {
    for (const p of ports) out.push(await holdOne(p, create));
    return out;
  } catch (err) {
    releasePorts(out);
    throw err;
  }
}

export function releasePorts(holds: readonly PortHold[]): void {
  for (const h of holds) if (h.state === "held") h.server.close();
}
