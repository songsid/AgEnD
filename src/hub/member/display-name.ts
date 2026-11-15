/** A bounded optional read over the current member connection's pinned origin. No credentials or redirects. */
import { request } from "node:https";
import { HUB_DISPLAY_NAME_PATH, hubDisplayNameSchema, readHubDisplayName, saveHubDisplayName } from "../display-name.js";
import { pinnedHubAgent, hubOrigin } from "../tls.js";
import type { HubMemberProfile } from "../profile.js";
import { parseStrictJson, validated } from "../validation.js";

export const HUB_DISPLAY_NAME_TIMEOUT_MS = 2_000;
export async function refreshHubDisplayName(input: { home: string; profile: HubMemberProfile; endpoint: string; current(): boolean; signal: AbortSignal }): Promise<boolean> {
  try {
    if (!input.current() || input.signal.aborted) return false;
    const endpoint = hubOrigin(input.endpoint);
    const value = await new Promise<unknown | null>(resolve => {
      let done = false;
      const agent = pinnedHubAgent({ memberOrigin: endpoint, spkiSha256: input.profile.hub.spkiSha256 }, input.current);
      const finish = (value: unknown | null = null) => {
        if (done) return; done = true;
        clearTimeout(deadline); input.signal.removeEventListener("abort", abort); req.destroy(); agent.destroy(); resolve(value);
      };
      const abort = () => finish();
      const req = request(new URL(HUB_DISPLAY_NAME_PATH, endpoint), { agent, method: "GET" }, res => {
        if (res.statusCode !== 200) { res.destroy(); finish(); return; }
        const chunks: Buffer[] = []; let length = 0;
        res.on("data", part => {
          const bytes = Buffer.from(part); length += bytes.length;
          if (length > 4096) { res.destroy(); finish(); return; }
          chunks.push(bytes);
        });
        res.on("error", abort); res.on("aborted", abort);
        res.on("end", () => {
          try { finish(validated(hubDisplayNameSchema, parseStrictJson(Buffer.concat(chunks), 4096))); }
          catch { finish(); }
        });
      });
      const deadline = setTimeout(abort, HUB_DISPLAY_NAME_TIMEOUT_MS); deadline.unref();
      input.signal.addEventListener("abort", abort, { once: true });
      req.on("error", abort); req.end();
    });
    if (value === null || !input.current() || input.signal.aborted) return false;
    const before = readHubDisplayName(input.home, input.profile);
    saveHubDisplayName(input.home, input.profile, value, () => input.current() && !input.signal.aborted);
    return before !== readHubDisplayName(input.home, input.profile);
  } catch { return false; } // Old Hubs, name/cache failures and stale links never hold the member.
}
