import type { Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";

export const WEB_DRAIN_MS = 1_000;
export const WEB_SHUTDOWN_RETRY_MS = 10_000;
const SHUTDOWN_FRAME = `event: shutdown\ndata: ${JSON.stringify({ retry_ms: WEB_SHUTDOWN_RETRY_MS })}\n\n`;

/** One listener owns its connections, including HTTP upgrades. Install before listen(). */
export function trackWebServer(server: Server) {
  const sockets = new Set<Socket>();
  const connected = (socket: Socket): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  server.on("connection", connected);
  let closing = false;
  let inFlight: Promise<void> | null = null;
  return {
    get closing(): boolean { return closing; },
    /** Stop accepts first; finish SSE and ordinary responses before the bounded forceful tail. */
    close(clients: Set<ServerResponse>): Promise<void> {
      if (inFlight) return inFlight;
      closing = true;
      inFlight = new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          server.closeAllConnections();
          // closeAllConnections excludes upgraded protocols and incomplete HTTP connections.
          for (const socket of sockets) socket.destroy();
        }, WEB_DRAIN_MS);
        server.close(() => {
          clearTimeout(timer);
          server.off("connection", connected);
          resolve();
        });
        for (const response of [...clients]) {
          const socket = response.socket;
          clients.delete(response);
          if (response.destroyed || response.writableEnded) continue;
          try {
            response.end(SHUTDOWN_FRAME, () => socket?.end());
          } catch {
            socket?.destroy();
          }
        }
      });
      return inFlight;
    },
  };
}
export type WebServerDrain = ReturnType<typeof trackWebServer>;
