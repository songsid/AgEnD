/**
 * #2482: after the Discord adapter stops, every pending edit fails the same way ("Discord adapter is stopped") — one
 * line per stop in fleet.log, not one per edit. A running adapter's edit failures are each logged, as before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";

function makeAdapter(running: boolean) {
  const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
  Object.assign(adapter as object, {
    desiredRunning: running, stoppedEditFailures: 0, guildId: "g",
    _fetchTextChannel: async () => { throw new Error("Discord adapter is stopped"); },
    readyClient: async () => { throw new Error("Discord adapter is stopped"); },
  });
  return adapter;
}
afterEach(() => vi.restoreAllMocks());

describe("#2482 Discord edits refused after a stop: one line per stop", () => {
  it("stopped: three failed edits, one line saying the rest are not logged; each edit still rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = makeAdapter(false);
    for (let i = 0; i < 3; i++) await expect(adapter.editMessage("c", `m${i}`, "x")).rejects.toThrow("Discord adapter is stopped");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("(the adapter is stopped; further edits until it starts again are not logged)");
  });
  it("running: every failed edit is logged, as before", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = makeAdapter(true);
    for (let i = 0; i < 2; i++) await expect(adapter.editMessage("c", `m${i}`, "x")).rejects.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]![0])).not.toContain("adapter is stopped;");
  });
});
