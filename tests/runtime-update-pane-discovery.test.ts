import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimePaneLink } from "../src/runtime-pane-link.js";
const roots: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "agend-update-discovery-")); roots.push(directory);
  return { directory, server: "http://127.0.0.1:19280", machineId: "12345678-1234-4321-abcd-123456789012", online: () => true, maxAgents: () => 4 };
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
it("proves a never-created host absent without creating any host or state directory", async () => {
  const f = fixture(); await RuntimePaneLink.drainExistingForUpdate(f, () => true);
  expect(existsSync(join(f.directory, "pane-host"))).toBe(false);
  mkdirSync(join(f.directory, "pane-host")); await RuntimePaneLink.drainExistingForUpdate(f, () => true);
  expect(existsSync(join(f.directory, "pane-host", "state"))).toBe(false);
});
it("refuses a missing descriptor with any retained lock rather than treating it as absence", async () => {
  const f = fixture(), host = join(f.directory, "pane-host"), lock = join(host, "runtime.lock"); mkdirSync(host);
  writeFileSync(lock, "unreadable-as-json", { mode: 0o600 });
  await expect(RuntimePaneLink.drainExistingForUpdate(f, () => true)).rejects.toThrow(/unconfirmed/);
  expect(readFileSync(lock, "utf8")).toBe("unreadable-as-json");
});
it("refuses malformed retained state and symlink host directories", async () => {
  const f = fixture(), host = join(f.directory, "pane-host"); mkdirSync(join(host, "state"), { recursive: true });
  writeFileSync(join(host, "state", "panes.json"), "{}", { mode: 0o600 });
  await expect(RuntimePaneLink.drainExistingForUpdate(f, () => true)).rejects.toThrow(/ledger/);
  const second = fixture(); symlinkSync(host, join(second.directory, "pane-host"));
  await expect(RuntimePaneLink.drainExistingForUpdate(second, () => true)).rejects.toThrow(/unconfirmed/);
});
it("does not establish absence after its calling fence expires", async () => {
  await expect(RuntimePaneLink.drainExistingForUpdate(fixture(), () => false)).rejects.toThrow(/expired/);
});
it("an older authenticated host without the stronger idle capability is never shut down", async () => {
  const server = createServer(), peers = new WebSocketServer({ server }), boot = randomUUID(), requests: unknown[] = [];
  peers.on("connection", socket => {
    socket.send(JSON.stringify({ type: "hello", hostBootId: boot }));
    socket.on("message", bytes => {
      const frame = JSON.parse(bytes.toString()); if (frame.type !== "request") return; requests.push(frame.request);
      socket.send(JSON.stringify({ type: "response", id: frame.id, ok: true, result: frame.request.action === "list" ? { hostBootId: boot, panes: [] } : { hostBootId: boot, shutdown: true } }));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const link = await RuntimePaneLink.attach({ version: 1, scope: "a".repeat(64), hostBootId: boot, pid: process.pid, port: (server.address() as { port: number }).port, token: "b".repeat(64) }, { online: () => true, maxAgents: () => 4 });
  try { await expect(link.drainForUpdate()).rejects.toThrow(/unavailable/); expect(requests).toEqual([]); }
  finally { await link.stop(); for (const peer of peers.clients) peer.terminate(); peers.close(); await new Promise<void>(done => server.close(() => done())); }
});
