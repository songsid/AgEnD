/** #1235 part 2: the discord.js REST manager reuses one warm connection.
 * The real Client is constructed but never logged in — no Discord network.
 * Assertions read the REST manager's dispatcher and the ack timing logs. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent as UndiciAgent, EnvHttpProxyAgent, getGlobalDispatcher } from "undici";
import type { Client } from "discord.js";
import { DiscordAdapter, DISCORD_REST_KEEP_ALIVE_MS } from "../src/channel/adapters/discord.js";

const dirs: string[] = [];
const adapters: Array<{ client: { destroy(): void } }> = [];
afterEach(() => {
  for (const a of adapters.splice(0)) a.client.destroy();
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function adapter(factory?: () => Client) {
  const dir = mkdtempSync(join(tmpdir(), "discord-rest-keepalive-"));
  dirs.push(dir);
  // No clientFactory: the real buildClient runs, but nothing logs in.
  const a = new DiscordAdapter({
    id: "d", botToken: "fake", accessManager: {} as never,
    inboxDir: dir, guildId: "g", registerCommands: false,
    ...(factory ? { clientFactory: factory } : {}),
  }) as any;
  adapters.push(a);
  return a;
}

/**
 * Pinned to the locked undici 6.24.1: the Agent keeps its construction
 * options on a Symbol(options) own-property. Reading them back proves the
 * 60 s is actually passed to `new Agent()`, not just exported next to it.
 */
function agentOptions(agent: object): Record<string, unknown> {
  const sym = Object.getOwnPropertySymbols(agent).find(s => s.toString() === "Symbol(options)");
  expect(sym, "undici Agent stores its options on Symbol(options)").toBeDefined();
  return (agent as any)[sym!] as Record<string, unknown>;
}

describe("discord REST keep-alive (#1235 part 2)", () => {
  it("hands the REST manager a dedicated agent with the configured keep-alive", () => {
    const a = adapter();
    const agent = a.client.rest.agent;
    expect(agent).toBeInstanceOf(UndiciAgent);
    expect(agent).not.toBe(getGlobalDispatcher());
    // The value the wiring passes: 60 s idle fallback when the server
    // sends no Keep-Alive hint (see the constant's justification).
    expect(DISCORD_REST_KEEP_ALIVE_MS).toBe(60_000);
    // And the instance really carries it — dropping the option from the
    // `new Agent()` call fails here even though the constant still exists.
    expect(agentOptions(agent).keepAliveTimeout).toBe(60_000);
  });

  it("shares one process-lifetime agent across adapters and generations", () => {
    // Leader decision R5 option (b): a single shared dispatcher, never
    // closed — no per-adapter teardown to get wrong, no worse than the
    // pre-PR global dispatcher that was likewise never closed on stop.
    const a = adapter();
    const b = adapter();
    expect(b.client.rest.agent).toBe(a.client.rest.agent);
    // buildClient is the exact allocation site loginFreshClient uses per
    // generation; driving it directly rebuilds clients without Discord login.
    const rebuilt = a.buildClient() as { rest: { agent: unknown }; destroy(): void };
    try {
      expect(rebuilt.rest.agent).toBe(a.client.rest.agent);
    } finally {
      rebuilt.destroy();
    }
  });

  it("adapter stop never closes the shared dispatcher", async () => {
    const a = adapter();
    const agent = a.client.rest.agent as UndiciAgent;
    await a.stop();
    expect(agent.closed).toBe(false);
    expect(agent.destroyed).toBe(false);
    expect(getGlobalDispatcher()).not.toBe(agent);
  });

  it("an injected client factory is untouched by stop: shared dispatcher stays open", async () => {
    const a = adapter();
    const agent = a.client.rest.agent as UndiciAgent;
    const made: unknown[] = [];
    const f = adapter(() => {
      const client = { isReady: () => true, on: () => {}, once: () => {}, destroy: () => {} };
      made.push(client);
      return client as unknown as Client;
    });
    expect(made).toHaveLength(1);
    await f.stop();
    expect(agent.closed).toBe(false);
    expect(agent.destroyed).toBe(false);
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
