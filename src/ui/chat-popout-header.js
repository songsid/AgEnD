// One ordinary agent header in a pop-out. Only the InstanceSwitch gets a pane context; forms/composers stay single-pane.
import { html, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { useStore, appStore } from "/assets/app-store.js";
import { PaneScope } from "/assets/app-ctx.js";
import { navStore, navigate } from "/assets/app-nav.js";
import { PANE_VIEWS } from "/assets/chat-workspace-model.js";
import { routePath } from "/assets/app-route.js";
import { supportsInstanceFeature } from "/assets/instance-nav.js";
import { HeaderTools } from "/assets/header-tools.js";
import { Menu } from "/assets/ui-menu.js";
import { t } from "/assets/app-i18n.js";
export function PopoutHeader({ title, sub, headingRef, nav, notice, pageControls, pageActions }) {
  const ref = useRef(null), [width, setWidth] = useState(window.innerWidth);
  const app = useStore(appStore), state = useStore(navStore), route = state.route;
  const inst = app.instances.find(it => it.name === route?.instance);
  const tabs = PANE_VIEWS.filter(view => view === "chat" || supportsInstanceFeature(inst, view)), visibleTabs = tabs.slice();
  const keep = width >= 700 ? 4 : width >= 580 ? 3 : width >= 480 ? 2 : 1;
  for (let n = visibleTabs.length - 1; visibleTabs.length > keep && n >= 0; n--) if (visibleTabs[n] !== route?.panel) visibleTabs.splice(n, 1);
  useLayoutEffect(() => {
    const update = () => { if (ref.current) setWidth(ref.current.getBoundingClientRect().width); };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(ref.current); window.addEventListener("resize", update); update();
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); };
  }, []);
  const items = [...tabs.filter(view => !visibleTabs.includes(view)).map(view => ({ key: `tab-${view}`, label: t(`app.${view}`),
    onSelect: () => navigate(routePath({ panel: view, instance: route.instance })) })), ...(pageActions || [])];
  const Card = pageControls?.CardMenu;
  return html`<header ref=${ref} data-trust="header" class="panel-head ws-pane-head popup-pane-head">
    <div class="panel-title"><h1 ref=${headingRef} tabindex="-1" title=${typeof title === "string" ? title : route?.instance}>${title}</h1>${sub ? html`<div class="panel-sub">${sub}</div>` : null}</div>
    <${PaneScope} value=${{ visibleTabs, navigate }}>${nav}</${PaneScope}>
    <div class="panel-actions">${Card ? html`<${Card} card=${pageControls.card} ownerKey=${pageControls.navKey} />` : null}
      <${HeaderTools} navKey=${pageControls?.navKey} usage=${pageControls?.usage !== false} view=${route?.panel === "view"} />
      <${Menu} items=${items} ownerKey=${pageControls?.navKey} label=${t("app.more")} /></div>${notice || null}
  </header>`;
}
