import type { IncomingMessage } from "node:http";
/** Byte-bounded, abort-aware reader. Socket/request deadlines belong to the listener. */
export function readBoundedWebBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      req.off("data", data); req.off("end", end); req.off("error", fail); req.off("aborted", aborted); req.off("close", closed);
      if (error) reject(error); else resolve(Buffer.concat(chunks));
    };
    const data = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      size += bytes.length;
      if (size > maxBytes) { finish(new Error("payload too large")); req.destroy(); }
      else chunks.push(bytes);
    };
    const end = (): void => finish();
    const fail = (error: Error): void => finish(error);
    const aborted = (): void => finish(new Error("request aborted"));
    const closed = (): void => { if (!settled) finish(new Error("request closed")); };
    req.on("data", data); req.on("end", end); req.on("error", fail); req.on("aborted", aborted); req.on("close", closed);
  });
}
