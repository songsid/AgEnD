// #3637 PR2: the existing panels, router and page services in two bounded hosts. No transport or authority here.
import { html, render, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { appStore, useStore } from "/assets/app-store.js";
import { PaneScope, usePane } from "/assets/app-ctx.js";
import * as paneState from "/assets/app-ctx.js";
import { Outlet, PanelHeader, shellStore, showDialog, isMacLike, toggleSidebar } from "/assets/app-shell.js";
import { HeaderTools } from "/assets/header-tools.js";
import { Menu } from "/assets/ui-menu.js";
import { Icon } from "/assets/ui-icons.js";
import { Dialog } from "/assets/ui-dialog.js";
import { register, t } from "/assets/app-i18n.js";
import { toast } from "/assets/ui-toast.js";
import { routePath, detailsPath } from "/assets/app-route.js";
import { supportsInstanceFeature } from "/assets/instance-nav.js";
import { agentRoute, PANE_VIEWS, twoPaneFits } from "/assets/chat-workspace-model.js";
import { workspaceMemory } from "/assets/chat-workspace-memory.js";
import { installWorkspaceNavigation } from "./chat-workspace-navigation.js";

register("chatWorkspace", {
  en: { beside: "Open beside", replace: "Replace: {0}", split: "Split chat", choose: "Choose a second agent", current: "Focused pane", currentShort: "Active",
    right: "Side by side", stack: "Top and bottom", swap: "Swap positions", close: "Close this pane", other: "Focus the other pane",
    unavailable: "Split chat could not load. Your current chat is unchanged. Reload this page to try again.", pane: "{0} · {1}", quote: "Quote into the other pane: {0}", quoteAgain: "Finish or discard the other pane's settings, then quote again." },
  "zh-TW": { beside: "在旁邊開啟", replace: "取代：{0}", split: "分割對話", choose: "選擇第二個 Agent", current: "目前窗格", currentShort: "目前",
    right: "左右排列", stack: "上下排列", swap: "交換位置", close: "收起此格", other: "切換到另一窗格",
    unavailable: "未能載入分割對話。目前對話不變；請重新整理頁面再試。", pane: "{0}・{1}", quote: "引用到另一窗格：{0}", quoteAgain: "請先完成或放棄另一窗格的設定變更，再次引用。" },
});
export const tw = (key, ...values) => t(`chatWorkspace.${key}`, ...values);
const viewLabel = view => t(`app.${view === "details" ? "details" : view}`);

/** Keep the optional dependency graph out of the public boot path; validate the actual cached exports before entry. */
export async function verifyWorkspaceDependencies({ chat, details, log, view }) {
  const [fields, native, quote, tabs, menu, roster, composer, image, preview, runtime, templates, session] = await Promise.all([
    import("./settings-dialogs.js"), import("./native-instance-settings.js"), import("./chat-quote.js"),
    import("/assets/instance-switch.js"), import("/assets/ui-menu.js"), import("/assets/view-roster-store.js"),
    import("/assets/chat-composer.js"), import("./image-lightbox.js"), import("/assets/preview-panel.js"),
    import("./agent-runtime-settings.js"), import("./agent-export-dialog.js"), import("/assets/app-session.js")]);
  if (!paneState.usePaneState || !chat.ChatPanel.workspaceVersion || !details.DetailsPanel.workspaceVersion || !log.LogPanel.workspaceVersion || !view.ViewPanel.workspaceVersion
    || !fields.AgentFields.paneIds || !fields.ClassicFields.paneIds || !native.NativeFields.paneIds
    || !quote.installQuoteSelection.workspaceVersion || !tabs.InstanceSwitch.workspaceVersion || !menu.Menu.workspaceVersion || !roster.followRoster
    || !composer.ComposerInput.paneIds || !composer.WorkBarView.paneIds || !image.LightboxHost.paneOwner
    || !preview.PreviewPanel.workspaceVersion || !runtime.AgentRuntimeSettings.workspaceVersion || !templates.AgentTemplateTools.workspaceVersion
    || !session.SessionMenu.workspaceVersion) throw new Error("old pane dependency");
  return { stopPreview: () => preview.closePanel() };
}

/** One persistent Preact root, moved as a whole to the focused header; no cloned usage readers or live DOM children. */
export function createPageControls(doc = document) {
  const node = doc.createElement("span"); node.className = "ws-page-tools";
  let owner = null;
  const move = (token, slot, asMenu = false) => {
    if (owner !== token || !slot) return;
    if (node.parentNode !== slot) slot.appendChild(node);
    for (const button of node.querySelectorAll(".hd-text, .hd-usage, .chat-card-menu > button")) {
      if (asMenu) button.setAttribute("role", "menuitem"); else button.removeAttribute("role");
    }
  };
  return {
    node, move,
    show(token, slot, meta = {}, asMenu = false) {
      owner = token;
      const Card = meta.CardMenu;
      render(html`${Card ? html`<${Card} card=${meta.card} ownerKey=${meta.navKey} />` : null}<${HeaderTools}
        navKey=${meta.navKey} view=${meta.view === true} usage=${meta.usage !== false} />`, node);
      move(token, slot, asMenu);
    },
    release(token) { if (owner === token) { owner = null; node.remove(); } },
    close() { owner = null; render(null, node); node.remove(); },
  };
}

function AgentPicker({ controller, layout, currentName, onClose }) {
  const app = useStore(appStore), w = controller.current();
  const focused = w ? w[w.focus].route.instance : currentName;
  return html`<${Dialog} title=${w ? tw("replace", w[w.focus === "a" ? "b" : "a"].route.instance) : tw("choose")} onClose=${onClose}><div class="ws-agent-choices">
    ${app.instances.filter(it => it.name !== focused).map(it => html`<button type="button" class="btn" key=${it.name}
      onClick=${() => { onClose(); controller.open(it.name, layout); }}>${it.display_name || it.name}</button>`)}
  </div></${Dialog}>`;
}
function choose(controller, event, owner) { if (owner) controller.focus(owner); showDialog(AgentPicker, { controller, currentName: controller.focusedName(), layout: event?.altKey ? "stack" : "right" }); }

export function PaneHeader({ title, sub, headingRef, nav, notice, pageControls, pageActions }) {
  const pane = usePane(), slot = useRef(null), menuSlot = useRef(null), token = useRef({});
  const shell = useStore(shellStore);
  const foldTools = pane.width < 700 && typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  useLayoutEffect(() => {
    if (pane.focused && slot.current) pane.controls.show(token.current, (foldTools && menuSlot.current) || slot.current,
      { ...pageControls, navKey: `${pageControls?.navKey || ""}|fold:${foldTools}` }, foldTools && !!menuSlot.current);
    else pane.controls.release(token.current);
  }, [pane.focused, pageControls, foldTools]);
  useLayoutEffect(() => () => pane.controls.release(token.current), []);
  const tabs = pane.tabs.filter(tab => !pane.visibleTabs.includes(tab));
  const items = [
    ...tabs.map(view => ({ key: `tab-${view}`, label: viewLabel(view), onSelect: () => pane.navigate(routePath({ panel: view, instance: pane.name })) })),
    { key: "right", label: tw("right"), checked: pane.layout === "right", onSelect: () => pane.controller.layout("right") },
    { key: "stack", label: tw("stack"), checked: pane.layout === "stack", onSelect: () => pane.controller.layout("stack") },
    { key: "swap", label: tw("swap"), onSelect: () => pane.controller.swap() },
    { key: "other", label: tw("other"), onSelect: () => pane.controller.focus(pane.id === "a" ? "b" : "a", { moveFocus: true }) },
    { key: "split", label: tw("split"), icon: "sidebar", onSelect: () => choose(pane.controller, undefined, pane.id) },
    { key: "close", label: tw("close"), icon: "close", onSelect: () => pane.controller.closePane(pane.id) },
    ...(pane.focused ? pageActions || [] : []),
  ];
  return html`<header data-trust="header" class="panel-head ws-pane-head">
    ${shell.collapsed && pane.focused ? html`<button type="button" id="sbOpen" class="icon-btn sb-open" aria-label=${t("app.expand")}
      title=${t("app.expand")} aria-controls="sidebar" onClick=${toggleSidebar}><${Icon} name="menu" /></button>` : null}
    <div class="panel-title">${pane.focused ? html`<span class="tag ws-focus-label">${tw("currentShort")}</span>` : null}<h1 ref=${headingRef} tabindex="-1" title=${typeof title === "string" ? title : pane.name}>${title}</h1>
      ${sub ? html`<div class="panel-sub">${sub}</div>` : null}</div>
    ${nav}
    <div class="panel-actions"><span class=${`ws-tools-slot${foldTools ? " ws-tools-folded" : ""}`} ref=${slot}></span>
      <button type="button" class="icon-btn ws-pane-split" title=${tw("split")} aria-label=${tw("split")} onClick=${event => choose(pane.controller, event, pane.id)}><${Icon} name="sidebar" /></button>
      <${Menu} ownerKey=${`${pane.name}:${pane.route.panel}`} inactive=${!pane.focused} onOpen=${() => pane.controller.focus(pane.id)} items=${items} label=${t("app.more")}
        leading=${foldTools && pane.focused ? html`<div class="ws-menu-tools" role="presentation" ref=${el => { menuSlot.current = el; pane.controls.move(token.current, el || slot.current, !!el); }}></div>` : null} />
      <button type="button" class="icon-btn ws-pane-close" title=${tw("close")} aria-label=${tw("close")} onClick=${() => pane.controller.closePane(pane.id)}><${Icon} name="close" /></button>
    </div>${notice || null}
  </header>`;
}

function Pane({ id, w, focused, compact, width, controller, controls, panels }) {
  const pointer = useRef(false);
  useEffect(() => {
    const reset = () => { pointer.current = false; };
    window.addEventListener("pointerup", reset); window.addEventListener("pointercancel", reset); window.addEventListener("blur", reset);
    return () => { window.removeEventListener("pointerup", reset); window.removeEventListener("pointercancel", reset); window.removeEventListener("blur", reset); };
  }, []);
  const p = w[id], app = useStore(appStore), inst = app.instances.find(it => it.name === p.route.instance);
  const tabs = PANE_VIEWS.filter(view => view === "chat" || supportsInstanceFeature(inst, view));
  const keep = width >= 700 ? 4 : width >= 580 ? 3 : width >= 480 ? 2 : 1;
  // The selected text tab always remains. Remove inactive trailing tabs first, never replace text with icons.
  const visibleTabs = tabs.slice();
  for (let n = visibleTabs.length - 1; visibleTabs.length > keep && n >= 0; n--) if (visibleTabs[n] !== p.route.panel) visibleTabs.splice(n, 1);
  const value = { ...controller.pane(id), id, name: p.route.instance, route: p.route, search: p.search, hash: p.hash, focused,
    tabs, visibleTabs: compact ? tabs : visibleTabs, width, controller, controls, layout: w.layout, Header: compact ? null : PaneHeader };
  return html`<section class=${`ws-pane${focused ? " ws-focused" : ""}`} data-pane=${id} role="region"
    aria-label=${tw("pane", p.route.instance, viewLabel(p.route.panel))} aria-current=${focused ? "true" : undefined}
    onPointerDown=${event => {
      pointer.current = true;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.button !== 0) return;
      // Moving the one tools host can move a text tab. Finish that click before moving its target under the pointer.
      if (!event.target.closest("a,button,input,textarea,select,[contenteditable]")) controller.focus(id);
    }} onPointerUp=${() => { pointer.current = false; }} onPointerCancel=${() => { pointer.current = false; }}
    onClick=${event => { pointer.current = false; if (!event.defaultPrevented && !event.target.closest(".menu, .ws-page-tools") && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.button === 0) controller.focus(id); }}
    onFocusIn=${() => { if (!pointer.current) controller.focus(id); }}>
    <${PaneScope} value=${value}><${Outlet} route=${p.route} seq=${p.seq} panels=${panels} /></${PaneScope}>
    ${focused && !compact ? html`<span class="sr-only">${tw("current")}</span>` : null}
  </section>`;
}

export function createWorkspaceHost(controller) {
  return function WorkspaceHost({ nav, panels }) {
    const ref = useRef(null), [size, setSize] = useState({ width: 0, height: 0, viewport: 0 });
    const controls = useMemo(() => createPageControls(), []);
    const w = nav.workspace;
    const compact = !w || !twoPaneFits(size.viewport, size.width, size.height, w.layout);
    useLayoutEffect(() => {
      if (!ref.current) return;
      const update = () => { const r = ref.current?.getBoundingClientRect(); if (r) setSize({ width: r.width, height: r.height, viewport: window.innerWidth }); };
      const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
      observer?.observe(ref.current); window.addEventListener("resize", update); update();
      return () => { observer?.disconnect(); window.removeEventListener("resize", update); };
    }, [!!w]);
    // The fallback uses the original header's tools. Detached roots must not keep a second usage reader alive.
    useLayoutEffect(() => { if (compact) controls.close(); }, [compact]);
    useLayoutEffect(() => () => controls.close(), []);
    if (!w) return html`<${Outlet} route=${nav.route} seq=${nav.seq} panels=${panels} />`;
    const ids = compact ? [w.focus] : w.flipped ? ["b", "a"] : ["a", "b"];
    return html`<div ref=${ref} class=${`chat-workspace ws-${compact ? "compact" : w.layout}`} data-layout=${compact ? "single" : w.layout}>
      ${compact ? html`<nav class="ws-agent-tabs seg" aria-label=${tw("choose")}>${["a", "b"].map(id => html`<span class="ws-agent-tab">
        <button type="button" class=${`seg-item${w.focus === id ? " active" : ""}`} aria-current=${w.focus === id ? "page" : undefined}
          title=${w[id].route.instance} onClick=${() => controller.focus(id)}><span class="ws-agent-name">${w[id].route.instance}</span></button>
        <button type="button" class="icon-btn ws-agent-close" aria-label=${`${tw("close")}: ${w[id].route.instance}`}
          title=${tw("close")} onClick=${() => controller.closePane(id)}><${Icon} name="close" /></button></span>`)}</nav>` : null}
      ${ids.map(id => html`<${Pane} key=${id} id=${id} w=${w} focused=${w.focus === id} compact=${compact}
        width=${w.layout === "stack" ? size.width : (size.width - 8) / 2} controller=${controller} controls=${controls} panels=${panels} />`)}
    </div>`;
  };
}

/** Entry is offered only by a new server/CSS. Every required cached module must prove the pane contract before mount. */
export function installWorkspaceEntry({ nav, ready, landing = false, scope = "", chat }) {
  let controller = null, pending = null;
  let alive = true;
  let storage = null;
  try { storage = localStorage; } catch { /* memory-only */ }
  const memory = workspaceMemory(storage, scope);
  const retire = () => {
    if (!alive) return; alive = false; memory.clear();
    controller?.close();
    window.removeEventListener("resize", refresh); document.removeEventListener("keydown", key);
    appStore.set({ chatWorkspace: null, chatWorkspaceSessionEnd: null });
  };
  async function open(name, layout = "right") {
    if (!alive) return;
    const attempt = nav.navStore.get();
    try {
      if (!controller) {
        const services = await (pending ??= ready().finally(() => { pending = null; }));
        if (!alive || nav.navStore.get() !== attempt) return; // a later navigation retires this loading intent
        if (!controller) {
          if (!nav.installNavigation || !PanelHeader.workspaceVersion) throw new Error("old shell");
          controller = installWorkspaceNavigation(nav, { beforeLayout: services?.stopPreview,
            onWorkspace: () => { if (!shellStore.get().workspaceHost) shellStore.set({ workspaceHost: createWorkspaceHost(controller) }); } });
          let previous = null;
          nav.navStore.subscribe(next => {
            if (!alive) return;
            if (next.workspace) memory.write(next.workspace);
            else if (previous && agentRoute(next.route)) memory.clear();
            previous = next.workspace;
          });
          controller.restoreAddress();
          if (landing && !controller.current()) controller.restore(memory.read());
          if (controller.current()) memory.write(controller.current());
        }
      }
      if (name) controller.open(name, layout);
    } catch { toast(tw("unavailable"), false); }
  }
  const entry = { open, pick: event => showDialog(AgentPicker, { controller: { current: () => controller?.current(), open }, currentName: nav.navStore.get().route?.instance, layout: event?.altKey ? "stack" : "right" }),
    settings: name => nav.navigate(`${detailsPath(name)}?cat=basic`),
    quoteTargets(source) {
      const w = controller?.current(); if (!w) return [];
      const from = ["a", "b"].find(id => w[id].route.instance === source); if (!from) return [];
      const id = from === "a" ? "b" : "a", name = w[id].route.instance, sourcePane = w[from];
      return [{ label: tw("quote", name), async insert(text) {
        const current = () => { const now = controller.current(); return alive && !!now && now[from] === sourcePane && now[id].route.instance === name; };
        if (!current()) return;
        if (controller.current()[id].route.panel !== "chat") controller.pane(id).navigate(routePath({ panel: "chat", instance: name }));
        if (!current() || controller.current()[id].route.panel !== "chat") { toast(tw("quoteAgain"), false); return; }
        const target = controller.current()[id];
        const valid = () => current() && controller.current()[id] === target;
        // B may have been on Log. Wait only for that exact Chat mount; a changed destination permanently cancels.
        const start = performance.now();
        while (valid() && !chat.paneComposerReady(name) && performance.now() - start < 2000) await new Promise(resolve => setTimeout(resolve, 16));
        if (valid() && performance.now() - start < 2000 && chat.insertPaneQuote(name, source, text, valid)) controller.focus(id);
      } }];
    },
    label(name) { const w = controller?.current(); return w && ![w.a.route.instance, w.b.route.instance].includes(name)
      ? tw("replace", w[w.focus === "a" ? "b" : "a"].route.instance) : tw("beside"); } };
  const available = () => window.innerWidth >= 1200 && (document.getElementById("main")?.getBoundingClientRect().width || window.innerWidth) >= 760;
  const refresh = () => appStore.set({ chatWorkspace: available() ? entry : null });
  window.addEventListener("resize", refresh); refresh();
  const key = e => {
    if (!alive || e.defaultPrevented || e.isComposing || e.getModifierState?.("AltGraph") || e.key !== "\\" || !agentRoute(nav.navStore.get().route) || !available() || document.querySelector("dialog[open]")) return;
    const mac = isMacLike(), split = mac ? e.metaKey && !e.ctrlKey && !e.altKey : e.ctrlKey && !e.metaKey && !e.altKey;
    const focus = mac ? e.ctrlKey && e.metaKey && !e.altKey : e.ctrlKey && e.altKey && !e.metaKey;
    if (e.shiftKey || (!split && !focus)) return;
    if (focus) { const w = controller?.current(); if (!w) return; e.preventDefault(); controller.focus(w.focus === "a" ? "b" : "a", { moveFocus: true }); }
    else { e.preventDefault(); entry.pick(); }
  };
  document.addEventListener("keydown", key);
  appStore.set({ chatWorkspaceSessionEnd: retire });
  // Explicit two-pane deep links ask for the same capabilities. Ordinary deep links remain single.
  if (new URLSearchParams(location.search).has("compare")) void open();
  else if (landing && memory.read()) void open();
  globalThis.AgendAuth?.onSessionEnd?.(retire);
  return entry;
}
