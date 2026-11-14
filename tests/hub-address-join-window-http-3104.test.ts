/** Actual D3 response adapters with an inert owned session/control; no listener, directory or Fleet. */
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, it } from "vitest";
import { handleHubWebAddressHttp } from "../src/hub/settings-web-address-http.js";
import { handleHubMemberAddressHttp } from "../src/hub/settings-member-address-http.js";
import { HubWebAddressError } from "../src/hub/settings-web-address-policy.js";
import { HubMemberAddressError } from "../src/hub/settings-member-address-policy.js";
import type { HubWebAddressControl } from "../src/hub/settings-web-address-control.js";
import type { HubMemberAddressControl } from "../src/hub/settings-member-address-control.js";
import type { HubInitHostOwner } from "../src/hub/init/types.js";

function response(kind: "web" | "member", error: Error): Promise<{ status: number; body: unknown }> {
  return new Promise(resolve => {
    const req = Object.assign(Readable.from([Buffer.from("{}")]), { method: "POST", headers: { "content-type": "application/json" } }) as unknown as IncomingMessage;
    let status = 0;
    const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false,
      writeHead(value: number) { status = value; }, end(text: string) { this.writableEnded = true; resolve({ status, body: JSON.parse(text) }); } }) as unknown as ServerResponse;
    const owner: HubInitHostOwner = { kind: "host-session", ownerKey: {}, sessionId: "owned", requestId: "request", authorityEpoch: 1, current: () => true };
    const control = { commit: async () => { throw error; } };
    const url = new URL(`http://127.0.0.1/api/settings/hub/${kind}-address/commit`);
    expect(kind === "web"
      ? handleHubWebAddressHttp(req, res, url, { hubSetupSession: () => owner, hubWebAddress: async () => control as unknown as HubWebAddressControl })
      : handleHubMemberAddressHttp(req, res, url, { hubSetupSession: () => owner, hubMemberAddress: async () => control as unknown as HubMemberAddressControl })).toBe(true);
  });
}

it.each(["web", "member"] as const)("%s: joining is 409 with the exact retry timestamp", async kind => {
  const ErrorClass = kind === "web" ? HubWebAddressError : HubMemberAddressError, retryAt = 600_000;
  expect(await response(kind, new ErrorClass("joining", retryAt))).toEqual({ status: 409, body: { ok: false, code: "joining", retryAt } });
});
it.each(["web", "member"] as const)("%s: an absent joining timestamp stays absent", async kind => {
  const ErrorClass = kind === "web" ? HubWebAddressError : HubMemberAddressError;
  expect(await response(kind, new ErrorClass("joining"))).toEqual({ status: 409, body: { ok: false, code: "joining" } });
});
it.each(["web", "member"] as const)("%s: ordinary busy has no joining metadata", async kind => {
  const ErrorClass = kind === "web" ? HubWebAddressError : HubMemberAddressError;
  expect(await response(kind, new ErrorClass("busy", 600_000))).toEqual({ status: 409, body: { ok: false, code: "busy" } });
});
