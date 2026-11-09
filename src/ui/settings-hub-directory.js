/** This computer's D3 Settings adapter. The shared form imports no fleet module. */
import { html, useRef } from "/assets/app-html.js";
import { api } from "./settings-confirm.js";
import { HubDirectoryEditor } from "./hub-directory-editor.js";
const PREFIX = "/api/settings/hub/directory";
export function hubDirectoryMarked(doc = typeof document !== "undefined" ? document : null) {
  return doc?.body?.dataset.hubDirectorySettings === "1" && doc.body.dataset.publicLink !== "1" && doc.body.dataset.hub !== "hub";
}
export function createHostDirectoryClient() {
  const call = async (action, body, signal) => {
    const r = await api(PREFIX + action, { credentials: "same-origin", cache: "no-store", ...(signal ? { signal } : {}),
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    return r.ok ? { ...r.body, ok: true } : { ok: false, code: r.body?.code || "unavailable", status: r.status };
  };
  return { directoryEditorV1: true,
    directorySettings: signal => call("", undefined, signal),
    prepareDirectorySettings: (body, signal) => call("/prepare", body, signal),
    testDirectorySettings: (body, signal) => call("/test", body, signal),
    saveDirectorySettings: (body, signal) => call("/save", body, signal),
    cancelDirectorySettings: body => call("/cancel", body),
    inspectDirectoryCa: (body, signal) => call("/ca/inspect", body, signal),
    fetchDirectoryCa: (body, signal) => call("/ca/fetch", body, signal),
    onSignedOut: fn => typeof window !== "undefined" ? window.AgendAuth?.onSessionEnd?.(fn) : undefined,
  };
}
export function HubDirectorySettings() {
  const client = useRef(null); client.current ??= createHostDirectoryClient();
  return hubDirectoryMarked() ? html`<${HubDirectoryEditor} client=${client.current} offered=${true} host=${true} />` : null;
}
