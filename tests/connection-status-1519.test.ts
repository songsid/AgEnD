/**
 * #1519 P6 (design §5.6): a connection row shows that connection's own state, not the fleet's "Connected" — a stopped one
 * says it is not running, a missing token, a refused token and the Message Content intent are named.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error — a JS module of the app, with no types
import { connectionState } from "../src/ui/settings-model.js";

describe("connectionState", () => {
  it.each([
    ["the fleet not answering", { status: "connected" }, false, { key: "problem", cls: "bad" }],
    ["no token (even if an old adapter says connected)", { token_present: false, status: "connected" }, true, { key: "connTokenMissing", cls: "bad" }],
    ["the intent refused", { token_present: true, status: "retrying", problem: "missing_intent" }, true, { key: "discordMissingIntent", cls: "bad" }],
    ["the token refused", { token_present: true, status: "failed", problem: "rejected" }, true, { key: "connRejected", cls: "bad" }],
    ["connected, its bot named", { token_present: true, status: "connected", identity: { username: "hhv_bot" } }, true, { key: "connConnectedAs", cls: "ok", bot: "@hhv_bot" }],
    ["connected, no name yet", { token_present: true, status: "connected" }, true, { key: "connected", cls: "ok", bot: "" }],
    ["reconnecting", { token_present: true, status: "retrying" }, true, { key: "connReconnecting", cls: "warn" }],
    ["starting", { token_present: true, status: "starting" }, true, { key: "connStarting", cls: "warn" }],
    ["gave up", { token_present: true, status: "failed" }, true, { key: "connFailed", cls: "bad" }],
    ["not running (a new connection before it starts)", { token_present: true, status: "stopped" }, true, { key: "connNotRunning", cls: "off" }],
    ["nothing known about it", undefined, true, { key: "connNotRunning", cls: "off" }],
  ])("%s", (_name, meta, fleetUp, want) => {
    expect(connectionState(meta, fleetUp)).toEqual(want);
  });
});
