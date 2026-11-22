/**
 * M-3510 (#4327 review): the ui-gate smoke's control holds its old ports while its fixture boots on ephemeral ones. A port
 * counts as occupied only when this process now listens on it ("held") or another listener has it (EADDRINUSE, "taken").
 * Any other listen error (EACCES, EADDRNOTAVAIL) proves nothing and fails the control — and the sockets already held are
 * closed first.
 */
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { holdPorts, releasePorts } from "../scripts/manual/smoke-fixture/port-hold.mjs";

const open: Server[] = [];
afterEach(async () => { for (const s of open.splice(0)) await new Promise<void>((r) => s.close(() => r())); });
const listen = (port = 0) => new Promise<Server>((resolve) => { const s = createServer(); s.listen(port, "127.0.0.1", () => { open.push(s); resolve(s); }); });
const portOf = (s: Server) => (s.address() as { port: number }).port;

/** A server factory whose listen fails with `code` on the given port and succeeds elsewhere; records closes. */
function failing(code: string, failPort: number) {
  const closed: number[] = [];
  const create = () => {
    let handler: ((e: unknown) => void) | null = null, port = 0;
    const srv: any = {
      listening: false,
      once(ev: string, fn: (e: unknown) => void) { if (ev === "error") handler = fn; return srv; },
      removeAllListeners() { handler = null; return srv; },
      listen(p: number, _h: string, cb: () => void) { port = p; queueMicrotask(() => { if (p === failPort) handler?.(Object.assign(new Error(code), { code })); else { srv.listening = true; cb(); } }); return srv; },
      close() { srv.listening = false; closed.push(port); return srv; },
    };
    return srv;
  };
  return { create, closed };
}

describe("holdPorts (the smoke's old-port control)", () => {
  it("a free port is held by us; one another listener has is 'taken' (EADDRINUSE); both count as occupied", async () => {
    const other = await listen();                                    // another listener already has this one
    // The held case binds atomically (port 0: the system's free port), never a port picked, closed and bound again — a
    // competitor could take it in between. Its actual port is read back from the server.
    const holds = await holdPorts([portOf(other), 0]);
    try {
      expect(holds.map((h) => h.state)).toEqual(["taken", "held"]);
      const held = holds[1]!;
      expect(held.state === "held" && held.server.listening).toBe(true);
      const actual = held.state === "held" ? (held.server.address() as { port: number }).port : 0;
      expect(actual > 0 && actual !== portOf(other)).toBe(true);
    } finally { releasePorts(holds); }
  });
  it("any other error (EACCES, EADDRNOTAVAIL) proves nothing: it rejects, and the sockets already held are closed", async () => {
    for (const code of ["EACCES", "EADDRNOTAVAIL"]) {
      const f = failing(code, 2);
      await expect(holdPorts([1, 2, 3], f.create)).rejects.toMatchObject({ code });
      expect(f.closed, `${code}: port 1 was held, then released; port 3 never tried`).toEqual([1]);
    }
  });
  it("EADDRINUSE from the factory is 'taken', not a failure", async () => {
    const f = failing("EADDRINUSE", 2);
    const holds = await holdPorts([1, 2], f.create);
    expect(holds.map((h) => h.state)).toEqual(["held", "taken"]);
    releasePorts(holds);
    expect(f.closed).toEqual([1]);
  });
});
