/**
 * M-3278 (decision 7933bf90, the user's 「全開（只留技術限制）」) part 4: the privileged dashboard routes an admin session uses
 * on the local dashboard are on the public link's route list too. Each handler still admits an admin session only (guests
 * and read sessions are refused there, as before); the technical limits stay — the live stream only on the fixed link (part 5).
 */
import { describe, expect, it, vi } from "vitest";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
// M-3770: the update check also refreshes the pre-flight (#4480 §4); its probes are stubbed here (no npm or systemctl runs).
vi.mock("../src/update-readiness.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/update-readiness.js")>();
  return { ...real, runUpdatePreflight: vi.fn(async () => real.summarize([{ id: "P1", ok: true }, { id: "P3", ok: true }, { id: "P4", ok: true }, { id: "P9", ok: true }], Date.now())) };
});

const HEX = "0123456789abcdef0123456789abcdef";
const UUID = "01234567-89ab-cdef-0123-456789abcdef";
describe("M-3278 4/5: the public link routes each lifted group", () => {
  it.each([
    // the app icon
    ["GET", "/ui/app-icon"], ["PUT", "/ui/app-icon"], ["DELETE", "/ui/app-icon"],
    // AgEnD's own web update
    ["GET", "/ui/update"], ["POST", "/ui/update/check"], ["POST", "/ui/update/start"], ["POST", "/ui/update/answer"], ["GET", "/ui/update/log"],
    // owner CSS
    ["GET", "/ui/owner-css.css"], ["GET", "/ui/owner-css/state"], ["GET", `/ui/owner-css/asset/${HEX}`], ["POST", "/ui/owner-css"], ["POST", "/ui/owner-css/restore"],
    // mods
    ["GET", "/ui/mods"], ["GET", `/ui/mods/file/${HEX}`], ["POST", "/ui/mods/stage"], ["POST", "/ui/mods/commit"],
    // sign-ins and backend login
    ["GET", "/ui/browser-backend-signins"], ["POST", "/ui/browser-backend-signins"], ["GET", "/ui/backend-login"], ["POST", "/ui/backend-login/start"],
    // installing and updating a CLI on the host
    ["GET", "/ui/host-install"], ["POST", "/ui/host-install"], ["POST", "/ui/host-install/cancel"], ["POST", "/ui/host-update"],
    // AI accounts and keep-alive
    ["GET", "/ui/accounts"], ["POST", "/ui/accounts/claude-code"], ["DELETE", "/ui/accounts/claude-code/work"], ["POST", "/ui/accounts/claude-code/signout"], ["POST", "/ui/accounts/keep-alive"],
    // an agent's Files & changes
    ["GET", "/ui/workspace"],
    // Runtimes, the Windows CLI and an agent's runtime
    ["GET", "/ui/runtimes"], ["POST", "/ui/runtimes/pairing"], ["POST", `/ui/runtimes/machines/${UUID}/cli-install`], ["GET", "/ui/windows-cli/tasks"],
    ["GET", "/ui/instances/dev/runtime"], ["POST", "/ui/instances/dev/runtime"],
    // Settings: secrets and the fixed link's token, the Hub, Runtime's switches, General's location
    ["POST", "/api/settings/secrets/openai/verify"], ["POST", "/api/settings/public-tunnel-token/verify"], ["POST", "/api/settings/public-tunnel-token/apply"],
    ["GET", "/api/settings/hub/update-consent"], ["PUT", "/api/settings/hub/update-consent"], ["POST", `/api/settings/hub/fleet-updates/${UUID}/cancel`],
    ["GET", "/api/settings/hub/membership"], ["PUT", "/api/settings/hub/membership"], ["PUT", "/api/settings/hub/retention"],
    ["POST", "/api/settings/hub/browser-certificate/prepare"],
    ["GET", "/api/hub/member/pairing"], ["POST", "/api/hub/member/pairing/connect"], ["GET", "/api/hub/member/exposures"], ["POST", "/api/hub/member/contact-limit-notice"],
    ["GET", "/api/settings/runtimes"], ["PUT", "/api/settings/fleet/runtimes"], ["GET", "/api/settings/general-location"], ["POST", "/api/settings/general-location"],
    ["POST", "/api/settings/quickstart/probe"],
  ])("%s %s is routed", (method, path) => {
    expect(isPublicWebRoute(method, path)).toBe(true);
  });

  it("the technical limits and this-computer-only routes stay off the link", () => {
    for (const [m, p] of [
      ["POST", "/ui/events"],                                  // GET /ui/events: the fixed link only (part 5, link-sse-named-m3278)
      ["GET", "/runtime/v1/connect"],                          // the paired computers' own protocol
      ["POST", "/api/settings/hub/setup/commit"],              // the host owner's own D3 surfaces (this computer only)
      ["POST", "/api/settings/hub/directory/save"],
      ["POST", "/api/settings/hub/web-address/commit"],
      ["GET", "/ui/runtimes/../events"],                       // no dot segments
      ["PATCH", "/ui/app-icon"], ["GET", "/ui/update/start"], ["DELETE", "/ui/mods"],
    ] as const) {
      expect(isPublicWebRoute(m, p), `${m} ${p}`).toBe(false);
    }
  });
});
