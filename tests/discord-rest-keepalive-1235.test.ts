/** #1235 part 2: the discord.js REST manager reuses one warm connection.
 * The real Client is constructed but never logged in — no Discord network.
 * Assertions read the REST manager's dispatcher and the ack timing logs. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent as UndiciAgent, EnvHttpProxyAgent, getGlobalDispatcher } from "undici";
import { DiscordAdapter, DISCORD_REST_KEEP_ALIVE_MS } from "../src/channel/adapters/discord.js";

const dirs: string[] = [];
const adapters: Array<{ client: { destroy(): void } }> = [];
afterEach(() => {
  for (const a of adapters.splice(0)) a.client.destroy();
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function adapter() {
  const dir = mkdtempSync(join(tmpdir(), "discord-rest-keepalive-"));
  dirs.push(dir);
  // No clientFactory: the real buildClient runs, but nothing logs in.
  const a = new DiscordAdapter({
    id: "d", botToken: "fake", accessManager: {} as never,
    inboxDir: dir, guildId: "g", registerCommands: false,
  }) as any;
  adapters.push(a);
  return a;
}

describe("discord REST keep-alive (#1235 part 2)", () => {
  it("hands the REST manager a dedicated agent with the configured keep-alive", () => {
    const a = adapter();
    const agent = a.client.rest.agent;
    expect(agent).toBeInstanceOf(UndiciAgent);
    expect(agent).not.toBe(getGlobalDispatcher());
    // The value the wiring passes: 60 s, under Cloudflare's ~100 s idle
    // close so we close first (see the constant's justification).
    expect(DISCORD_REST_KEEP_ALIVE_MS).toBe(60_000);
  });

  it("leaves the global dispatcher alone", () => {
    const before = getGlobalDispatcher();
    adapter();
    adapter();
    expect(getGlobalDispatcher()).toBe(before);
  });

  it("keeps the existing proxy behaviour: the env does not divert REST dispatch", () => {
    // The adapter has no HTTPS_PROXY handling today; the dedicated agent
    // must not introduce any either — the same direct agent either way.
    vi.stubEnv("HTTPS_PROXY", "http://proxy.invalid:8080");
    vi.stubEnv("ALL_PROXY", "http://proxy.invalid:8080");
    const a = adapter();
    const agent = a.client.rest.agent;
    expect(agent).toBeInstanceOf(UndiciAgent);
    expect(agent).not.toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("logs every acknowledgement split at debug level, slow ones still warn", () => {
    const a = adapter();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const created = Date.now() - 100;
    a.noteSlashAckTiming({ commandName: "status", createdTimestamp: created }, created + 50);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0]?.[0])).toContain("ms to acknowledge");
    expect(warn).not.toHaveBeenCalled();
    a.noteSlashAckTiming({ commandName: "status", createdTimestamp: Date.now() - 2_000 }, Date.now() - 1_900);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
