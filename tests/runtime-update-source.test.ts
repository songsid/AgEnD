import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ remote: "127.0.0.1" as string | undefined }));
vi.mock("node:http", async original => {
  const real = await original<typeof import("node:http")>();
  return { ...real, request: vi.fn((_url: URL, _options: unknown, onResponse: (res: import("node:http").IncomingMessage) => void) => {
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: () => queueMicrotask(() => {
      const response = Object.assign(Readable.from([Buffer.from(JSON.stringify({ version: "2.3.5", sha256: "a".repeat(64), bytes: 32 }))]), {
        statusCode: 200, socket: { remoteAddress: state.remote }, headers: { etag: `"2.3.5-${"a".repeat(64)}"` },
      });
      onResponse(response as unknown as import("node:http").IncomingMessage);
    }) });
    return request;
  }) };
});
import { fetchRuntimeUpdateMetadata } from "../src/runtime-update-artifact.js";
afterEach(() => { state.remote = "127.0.0.1"; });
describe("HTTP source binding after localhost resolution", () => {
  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("accepts an actual loopback peer %s", async remote => {
    state.remote = remote;
    await expect(fetchRuntimeUpdateMetadata("http://localhost")).resolves.toMatchObject({ version: "2.3.5", bytes: 32 });
  });
  it.each(["192.0.2.5", undefined])("refuses off-box or unknown peer %s even for a localhost URL and valid metadata", async remote => {
    state.remote = remote;
    await expect(fetchRuntimeUpdateMetadata("http://localhost")).rejects.toMatchObject({ reason: "transport" });
  });
});
