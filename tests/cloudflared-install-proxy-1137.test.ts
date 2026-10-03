/**
 * #1141 review: with a proxy in the environment, the download goes through
 * undici's EnvHttpProxyAgent — and the agent made for it is closed, on
 * failure as on success.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const agents = vi.hoisted(() => ({ made: 0, closed: 0, status: 200, body: Buffer.from("cf") }));
vi.mock("undici", () => ({
  EnvHttpProxyAgent: class { constructor() { agents.made++; } async close() { agents.closed++; } },
  fetch: vi.fn(async (_url: string, init: { dispatcher?: unknown }) => {
    expect(init.dispatcher).toBeDefined();
    return new Response(new Uint8Array(agents.body), { status: agents.status });
  }),
}));

import { ensureCloudflared } from "../src/tunnel/cloudflared-install.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("a proxied download", () => {
  it("goes through the proxy agent, which is closed afterwards — on failure and on success", async () => {
    const pin = { version: "1", assets: { "linux-x64": { name: "cloudflared-linux-amd64", sha256: createHash("sha256").update(agents.body).digest("hex"), archive: "binary" as const } } };
    const opts = (dataDir: string) => ({ dataDir, env: { PATH: "/nonexistent", HTTPS_PROXY: "http://proxy.example:3128" }, platform: "linux" as const, arch: "x64", pin });
    const failing = mkdtempSync(join(tmpdir(), "agend-cf-proxy-")); dirs.push(failing);
    agents.status = 404;
    expect((await ensureCloudflared(opts(failing)).catch(e => e)).kind).toBe("download-failed");
    expect(agents).toMatchObject({ made: 1, closed: 1 });
    const ok = mkdtempSync(join(tmpdir(), "agend-cf-proxy-")); dirs.push(ok);
    agents.status = 200;
    expect((await ensureCloudflared(opts(ok))).source).toBe("downloaded");
    expect(agents).toMatchObject({ made: 2, closed: 2 });
  });
});
