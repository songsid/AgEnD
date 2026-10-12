/**
 * #1723 (#1729 review r2, Prism's witness): the preview's stop failing EARLY — while the link's own stop, or its start's
 * end, is still pending — is an unproven result, observed at once: never an unhandled rejection the process-wide
 * handler sees later. Both entry points: the lane's reservation, and PublicWebLink.close().
 *
 * In a child Node (the built classes from dist/, as CI builds first) so the test runner's own rejection tracking does
 * not stand in for the process's. Every provider, manager and child is a fake: no tunnel, fleet or process starts.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

function child(boundary: "lane" | "exposure", reject: boolean): any {
  const lane = JSON.stringify(pathToFileURL(join(process.cwd(), "dist/tunnel/purpose-lane.js")).href);
  const link = JSON.stringify(pathToFileURL(join(process.cwd(), "dist/public-web-link.js")).href);
  const setup = `
    const { TunnelPurposeLane } = await import(${lane});
    const unhandled = [];
    process.on("unhandledRejection", e => unhandled.push(e.message));
    process.on("rejectionHandled", () => {});
    const companion = () => ${reject ? 'Promise.reject(new Error("preview stop failed"))' : 'Promise.resolve({ confirmed: false, reason: "unproven", pid: 7, identity: null })'};
  `;
  const body = boundary === "lane" ? `
    const lane = new TunnelPurposeLane({ start: async () => ({ ok: true, handle: {} }),
      stop: () => new Promise(resolve => setTimeout(() => resolve({ confirmed: true }), 35)) });
    const reservation = lane.reserve("dashboard", "A");
    await reservation.start({}, {});
    const result = await reservation.stop("close", companion());
    process.stdout.write(JSON.stringify({ unhandled, confirmed: result.confirmed, blocked: lane.reserve("login", "B") === null }));
  ` : `
    const { PublicWebLink } = await import(${link});
    let entered = false, release;
    const manager = { start: () => { entered = true; return new Promise(resolve => { release = () => resolve({ ok: false, errorKind: "cancelled", leaseHeld: false, message: "closed" }); }); }, stop: async () => ({ confirmed: true }) };
    const lane = new TunnelPurposeLane(manager);
    const preview = { start() {}, stop: companion, status: () => ({ state: "starting" }) };
    const owner = { adapterId: "a", chatId: "c", userId: "u", binding: {} };
    const link = new PublicWebLink({ dataDir: "/inert", web: () => ({}), permitted: () => true,
      reserve: id => lane.reserve("dashboard", id), createPreview: () => preview,
      ensure: async () => ({ path: "/inert", source: "agend" }), provider: () => ({ name: "fake" }),
      createGateway: () => ({ listen: async () => new URL("http://127.0.0.1:1234"), setHost() {}, close() {}, readinessMarker: "inert" }),
      revoke() {}, log() {} });
    const delivering = link.deliver(owner, async () => true);
    while (!entered) await new Promise(r => setImmediate(r));
    const closing = link.close("cancel during start");
    setTimeout(() => release(), 35);
    const result = await closing; await delivering;
    process.stdout.write(JSON.stringify({ unhandled, confirmed: result.confirmed, blocked: lane.reserve("login", "B") === null }));
  `;
  try { return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", setup + body], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] })); }
  catch (err: any) { return { harnessError: String(err.stderr ?? err.message) }; }
}

describe("#1723: a preview stop that fails early is an unproven result, never an unhandled rejection", () => {
  it.each(["lane", "exposure"] as const)("%s: an early rejection is observed before any wait", boundary => {
    const r = child(boundary, true);
    expect(r.harnessError, "child imports and inert setup must succeed").toBeUndefined();
    expect([r.confirmed, r.blocked]).toEqual([false, true]);
    expect(r.unhandled, "cleanup failure belongs to its own proof result, not the global handler").toEqual([]);
  });
  it.each(["lane", "exposure"] as const)("%s control: an early unproven result is held safely", boundary => {
    const r = child(boundary, false);
    expect(r.harnessError).toBeUndefined();
    expect([r.unhandled, r.confirmed, r.blocked]).toEqual([[], false, true]);
  });
});
