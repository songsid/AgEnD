/** Local host's private target, loaded only inside Needs you. Never copied into the fleet's shared notices/SSE. */
import { html } from "/assets/app-html.js";
import { DirectoryNotices } from "./hub-directory-notices.js";
const PREFIX = "/api/settings/hub/security-notices/directory";
export function hostDirectoryNoticesOffered(doc = typeof document !== "undefined" ? document : null) {
  return doc?.body?.dataset.hubDirectoryNotices === "1" && doc.body.dataset.publicLink !== "1" && doc.body.dataset.hub !== "hub";
}
export function createHostDirectoryNoticeClient({ fetchImpl = (...args) => fetch(...args) } = {}) {
  const call = async (path, method = "GET") => {
    try {
      // AgendAuth's same-origin fetch wrapper supplies the fleet CSRF header on writes.
      const response = await fetchImpl(path, { method, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
      let body; try { body = await response.json(); } catch { body = null; }
      return response.ok ? { ...body, ok: true } : { ok: false, status: response.status, code: body?.error || "unavailable", retryAfter: Number(response.headers.get("Retry-After")) || 0 };
    } catch { return { ok: false, status: 0, code: "unreachable" }; }
  };
  return Object.freeze({
    directorySecurityNotices({ before, limit = 25 } = {}) {
      const query = new URLSearchParams({ limit: String(limit) }); if (before) query.set("before", before);
      return call(`${PREFIX}?${query}`);
    },
    acknowledgeDirectorySecurityNotice(id) { return call(`${PREFIX}/${encodeURIComponent(id)}/ack`, "POST"); },
  });
}
const client = createHostDirectoryNoticeClient();
export function HostDirectoryNotices() {
  return hostDirectoryNoticesOffered() ? html`<${DirectoryNotices} client=${client} host=${true} />` : null;
}
