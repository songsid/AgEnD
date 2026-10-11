/**
 * alpha.2 (user report): Settings → Connections → Discord → Status emojis showed every server custom emoji as a broken
 * image — the "received :emoji_43:" row and the whole server-emoji grid. The values and the URLs were right
 * (https://cdn.discordapp.com/emojis/<id>.png|gif); the panel's CSP said `img-src 'self' data: blob:`, so the browser
 * refused every one of them.
 *
 * The served panel policy is read off sendPanelHtml, and each URL the editor renders (the preview row and the
 * guild-emoji grid) is checked against its img-src with CSP's own source matching for the source kinds that policy
 * uses. That a browser then loads the image is checked by the real-browser sweep.
 *
 * #1630: the editor no longer loads Discord's CDN at all — its images come from the dashboard's own
 * /ui/img/emoji/<id> (cached on the host; emojiProxyUrl), which img-src 'self' admits; the CDN source is gone from the
 * panel policy, so Discord never sees a viewer's address.
 */
import { describe, expect, it } from "vitest";
import { WEB_CONTENT_SECURITY_POLICY, sendPanelHtml } from "../src/web-host-guard.js";
import { customEmojiValue, emojiProxyUrl, previewStatusEmojis } from "../src/status-emojis.js";

function servedPanelPolicy(): string {
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => { headers[k] = v; }, writeHead: () => {}, end: () => {} };
  sendPanelHtml(res as never, "<body></body>");
  return headers["Content-Security-Policy"]!;
}
const imgSrc = (csp: string) => csp.split(";").map(s => s.trim()).find(s => s.startsWith("img-src "))!.split(/\s+/).slice(1);

/**
 * CSP Level 3 "does url match source list" for what an img-src here can hold: 'self', a scheme-source (data: blob:),
 * and a host-source with scheme, exact host and an optional path — a path ending in "/" matches everything under it,
 * any other path only itself. Wildcards and ports are not supported here and fail loudly.
 */
function admits(sources: string[], url: string, self = "http://127.0.0.1:8080"): boolean {
  const u = new URL(url, self);
  return sources.some(src => {
    if (src === "'self'") return u.origin === new URL(self).origin;
    if (/^[a-z][a-z0-9+.-]*:$/.test(src)) return u.protocol === src;
    const m = /^(https?):\/\/([^/:*]+)(\/.*)?$/.exec(src);
    if (!m) throw new Error(`source kind not modelled: ${src}`);
    if (u.protocol !== `${m[1]}:` || u.hostname !== m[2] || u.port) return false;
    const path = m[3];
    if (!path) return true;
    return path.endsWith("/") ? u.pathname.startsWith(path) : u.pathname === path;
  });
}

const STATIC = "<:emoji_43:948546745376333844>";
const ANIMATED = "<a:party:948546745376339999>";

describe("a panel shows Discord's custom emoji images from its own origin, and nothing from Discord (#1630)", () => {
  it("the status-emoji preview row's images are the dashboard's own, admitted by the panel's img-src (static and animated)", () => {
    const preview = previewStatusEmojis({ platform: "discord", platformConfig: { received: STATIC, queued: ANIMATED }, imageUrl: emojiProxyUrl } as never);
    const urls = preview.entries.map(e => e.image_url).filter((u): u is string => !!u);
    expect(urls).toEqual(["/ui/img/emoji/948546745376333844", "/ui/img/emoji/948546745376339999"]);
    const sources = imgSrc(servedPanelPolicy());
    expect(urls.filter(u => !admits(sources, u)), "refused by the panel CSP").toEqual([]);
  });

  it("the server-emoji grid's images too (the guild list builds them the same way)", () => {
    const sources = imgSrc(servedPanelPolicy());
    for (const e of [{ name: "emoji_19", id: "948546745376333845" }, { name: "spin", id: "948546745376333846", animated: true }]) {
      const url = emojiProxyUrl(customEmojiValue(e))!;
      expect([url.startsWith("/ui/img/emoji/"), admits(sources, url)], url).toEqual([true, true]);
    }
  });

  it("all of Discord's CDN is refused now — the emoji path included — as are look-alikes and plain http", () => {
    const sources = imgSrc(servedPanelPolicy());
    for (const url of ["https://cdn.discordapp.com/emojis/948546745376333844.png", "https://cdn.discordapp.com/attachments/1/2/leak.png",
      "https://cdn.discordapp.com/avatars/1/a.png", "https://media.discordapp.net/emojis/948546745376333844.png",
      "https://cdn.discordapp.com.evil.example/emojis/1.png", "http://cdn.discordapp.com/emojis/948546745376333844.png",
      "https://evil.example/emojis/1.png"]) expect(admits(sources, url), url).toBe(false);
    // Still the page's own images, data: and blob:.
    expect(["http://127.0.0.1:8080/ui/avatar.png", "data:image/png;base64,AA==", "blob:http://127.0.0.1:8080/x"].every(u => admits(sources, u))).toBe(true);
  });

  it("the panel policy adds no image source at all, and nothing remote anywhere", () => {
    const panel = servedPanelPolicy();
    expect(imgSrc(panel)).toEqual(["'self'", "data:", "blob:"]);
    expect(panel).not.toMatch(/https?:|\*/);
    expect(WEB_CONTENT_SECURITY_POLICY).not.toMatch(/https?:|\*/);
  });
});
