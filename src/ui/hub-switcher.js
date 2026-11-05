// AgEnD Hub P1, slice 3 (docs/design/hub.md §1 "Web entry"): a member fleet's "My fleet ↔ Hub" switcher, under the
// brand. Loaded only on a member page (the page's mark); shown only once this fleet is paired, and then it opens the
// Hub's own approved web origin in a new tab — never a token or identity in the URL, never a sign-in proxied here, never
// an origin offered after a key change.
import { html, useEffect, useState } from "/assets/app-html.js";
import { Icon } from "/assets/ui-icons.js";
import { hubClient, safeWebOrigin } from "./hub-client.js";
import { hw, linkHubCss } from "./hub-strings.js";

export function HubSwitcher() {
  const [pairing, setPairing] = useState(null);
  useEffect(() => {
    linkHubCss();
    const client = hubClient();
    let live = true;
    client.pairing().then((p) => { if (live) setPairing(p); }, () => {});
    const off = client.subscribe((p) => { if (live) setPairing(p); });
    return () => { live = false; off(); };
  }, []);
  const origin = safeWebOrigin(pairing);
  if (!origin) return null;
  const name = pairing.hub.name || hw("hub");
  return html`<div class="hub-switch" role="group" aria-label=${hw("switcher")} data-trust="navigation">
    <span class="hub-switch-item is-current" aria-current="true">${hw("myFleet")}</span>
    <a class="hub-switch-item" href=${origin} target="_blank" rel="noopener noreferrer" title=${hw("openHubTab", name)}>${name}<${Icon} name="external" size=${13} /></a>
  </div>`;
}
