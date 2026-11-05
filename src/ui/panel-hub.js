// AgEnD Hub P1, slice 3: the Hub workspace's pages — Ask, My exposures, Administration (/ui/hub, /ui/hub/exposures,
// /ui/hub/admin). Served only by a Hub's own listener (slice 1); placeholders over the stub client until slices 2, 3 and
// 5 bring sign-in, grants, rooms and audit. A lazy module: imports only names every shell has had since #1408.
import { html, useEffect, useState } from "/assets/app-html.js";
import { PanelHeader, setTitle } from "/assets/app-shell.js";
import { Empty } from "/assets/ui-states.js";
import { hubClient } from "./hub-client.js";
import { hw, linkHubCss } from "./hub-strings.js";

const TABS = {
  ask: { title: "askTitle", empty: "askEmpty", hint: "askHint", icon: "chat", read: (c) => c.askable() },
  exposures: { title: "exposuresTitle", empty: "exposuresEmpty", hint: "exposuresHint", icon: "globe", read: (c) => c.myExposures() },
  admin: { title: "adminTitle", empty: "adminEmpty", hint: "adminHint", icon: "key", read: (c) => c.administration().then((a) => [...(a.fleets || []), ...(a.grants || [])]) },
};

export function HubPanel({ route }) {
  const tab = TABS[route && route.tab] ? route.tab : "ask";
  const spec = TABS[tab];
  const [items, setItems] = useState(null);
  useEffect(() => { linkHubCss(); }, []);
  useEffect(() => { setTitle(hw(spec.title)); }, [tab]);
  useEffect(() => {
    let live = true;
    setItems(null);
    spec.read(hubClient()).then((v) => { if (live) setItems(Array.isArray(v) ? v : []); }, () => { if (live) setItems([]); });
    return () => { live = false; };
  }, [tab]);
  return html`<div data-effect-panel="hub" class=${`panel p-hub p-hub-${tab}`}>
    <${PanelHeader} title=${hw(spec.title)} />
    <div data-trust="panel-content" class="panel-body">
      ${hubClient().stub ? html`<p class="note hub-preview" role="note">${hw("preview")}</p>` : null}
      ${items && !items.length ? html`<div class="center hub-empty"><${Empty} icon=${spec.icon} title=${hw(spec.empty)} hint=${hw(spec.hint)} /></div>` : null}
    </div>
  </div>`;
}
