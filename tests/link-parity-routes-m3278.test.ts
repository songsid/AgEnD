/**
 * M-3278 (decision 7933bf90, the user's 「全開（只留技術限制）」) part 2: routes the dashboard needs over the public link that
 * the gateway's list simply lacked — no handler refuses the link for them and none gave a reason (the M-3275 audit):
 * the model and effort pickers, an agent's export/import, the settings connector, and "Apply now" / the authenticator's
 * confirmation of one's own pending change (whose handler says "over a link too", AGEND-122). The handlers decide who may.
 */
import { describe, expect, it } from "vitest";
import { isPublicWebRoute } from "../src/public-web-gateway.js";

const ID = "0123456789abcdef0123456789abcdef";
describe("M-3278 2/5: the public link's route list carries what the page needs", () => {
  it.each([
    ["GET", "/ui/models"], ["POST", "/ui/models/refresh"], ["GET", "/ui/effort-options"],
    ["POST", "/ui/agent-export/build"], ["POST", "/ui/agent-export/parse"],
    ["GET", "/api/settings/connector"],
    ["POST", `/api/settings/pending/${ID}/confirm`], ["POST", `/api/settings/pending/${ID}/confirm-totp`],
  ])("%s %s is routed", (method, path) => {
    expect(isPublicWebRoute(method, path)).toBe(true);
  });
  it("only those shapes: other methods, longer paths and other pending suffixes stay off", () => {
    for (const [m, p] of [["DELETE", "/ui/models"], ["GET", "/ui/models/refresh"], ["POST", "/ui/agent-export/other"],
      ["POST", `/api/settings/pending/${ID}/confirm/x`], ["POST", `/api/settings/pending/${ID}/approve`], ["POST", "/api/settings/pending/abc/confirm"]] as const) {
      expect(isPublicWebRoute(m, p), `${m} ${p}`).toBe(false);
    }
  });
});
