/**
 * M-3166 (Argon 3, the user's OK of round 2): a phone's ⋯ on an agent's pages — a bottom sheet. It began as the chat's
 * (PR 2); PR 5 gives View, Log and Details the same header ("← name ● ⋯", no tab row), so the sheet is shared here.
 *   tiles — Chat (when not on it), View, Log (the ones you are not on), Search, Files & changes, Card, Usage
 *   rows  — Model & effort and CLI backend (the chat's own commands), Text size, Appearance (the page's colour, theme,
 *           effect and activity items, in place), Agent details (when not on it), Settings (Windows)
 *   This agent — start / restart / stop / pause / wake / delete, as the page offers them
 *   ✓ Verified at the foot, when the page knows it
 * Every entry is the page's own item or its header's own control (the header shows none of them on a phone). Static code,
 * no data: served from /assets/ like the other shared modules (an anonymous View reader never has the sheet).
 */
import { html, useEffect, useState } from "./app-html.js";
import { register, t } from "./app-i18n.js";
import { useStore } from "./app-store.js";
import { navigate } from "./app-nav.js";
import { chatPath, detailsPath, logPath, viewPath } from "./app-route.js";
import { openSearch } from "./app-shell.js";
import { Dialog } from "./ui-dialog.js";
import { Icon } from "./ui-icons.js";
import { setTextSize, textSizeStore, TEXT_SIZES, usageOffered } from "./header-tools.js";
import { UsageDialog } from "./usage-dialog.js";
import { supportsInstanceFeature } from "./instance-nav.js";
import { assetUrl } from "./asset-url.js";
import { timeText } from "./clock-text.js";

register("agentSheet", {
  en: { sheet: "{0}: more", search: "Search", files: "Files & changes", card: "Card", usage: "Usage", model: "Model & effort", backend: "CLI backend",
    textSize: "Text size", textSizes: "Small,Medium,Large", look: "Appearance", agent: "This agent", details: "Agent details",
    verifiedUntil: "Verified · speaks as you until {0}" },
  "zh-TW": { sheet: "{0}：更多", search: "搜尋", files: "檔案與變更", card: "卡片", usage: "用量", model: "模型與推理", backend: "CLI 後端",
    textSize: "文字大小", textSizes: "小,中,大", look: "外觀", agent: "這個 Agent", details: "Agent 詳細資料",
    verifiedUntil: "已驗證 · 以你的身分發言到 {0}" },
});

// The sheet's and the phone header's styles live with the chat's (chat-work-bar.css, linked fresh: an older app.css lacks
// them). View, Log or Details may be the first agent page a phone opens, so the sheet links it too (once, the chat's own mark).
(function linkSheetCss() {
  try {
    if (typeof document === "undefined" || !document.head || document.querySelector('link[data-chat-work-bar-css="1"]')) return;
    const link = document.createElement("link");
    link.setAttribute("rel", "stylesheet"); link.setAttribute("href", assetUrl("/assets/chat-work-bar.css")); link.setAttribute("data-chat-work-bar-css", "1");
    document.head.appendChild(link);
  } catch { /* the header keeps its desk look */ }
})();

/** A phone's width (the shell's own: max-width 899 px), kept current as the window is resized. */
export function usePhone() {
  const read = () => typeof matchMedia === "function" && matchMedia("(max-width: 899px), (pointer: coarse) and (max-height: 500px) and (max-width: 1023px)").matches;
  const [on, setOn] = useState(read);
  useEffect(() => {
    if (typeof matchMedia !== "function") return undefined;
    const mq = matchMedia("(max-width: 899px), (pointer: coarse) and (max-height: 500px) and (max-width: 1023px)"), changed = () => setOn(mq.matches);
    changed(); mq.addEventListener?.("change", changed);
    return () => mq.removeEventListener?.("change", changed);
  }, []);
  return on;
}

/** The item keys that are this agent's controls (their own heading), not its appearance. */
const CONTROLS = ["start", "restart", "stop", "pause", "wake", "delete"];
/** The item keys the sheet places itself (a tile or a row of its own), never under Appearance. */
const PLACED = ["details", "splitChat", "settings", "workspace", "fullWidth", "pins", ...CONTROLS];
const untilClock = (ms) => { try { return timeText(ms, { hour: "2-digit", minute: "2-digit" }, []); } catch { return ""; } };

/**
 * The header's ⋯ on a phone, and its sheet.
 * - `current`: the page it is on ("chat" | "view" | "log" | "details") — its own tile is left out, Chat's added elsewhere
 * - `items`: the page's own menu items (the desk's ⋯) — Files, Appearance, Agent details, Settings and This agent come from them
 * - `chat`: the chat's own extras, or null — { card, onCard, onModel, modelText, onBackend, backendText }
 * - `extra`: the page's own rows that are not appearance (View's help), after Agent details
 * - `verifiedUntil`: when this browser's ✓ Verified ends (ms), or null
 */
export function AgentSheetButton({ name, inst, current, items = [], extra = [], navKey = "", chat = null, verifiedUntil = null }) {
  const [open, setOpen] = useState(false), [usage, setUsage] = useState(false);
  return html`<button type="button" class="icon-btn chat-sheet-more" aria-haspopup="dialog" aria-label=${t("app.more")} title=${t("app.more")} onClick=${() => setOpen(true)}><${Icon} name="more" /></button>
    ${open ? html`<${AgentSheet} name=${name} inst=${inst} current=${current} items=${items} extra=${extra} chat=${chat} verifiedUntil=${verifiedUntil}
      onUsage=${() => { setOpen(false); setUsage(true); }} onClose=${() => setOpen(false)} />` : null}
    ${usage ? html`<${UsageDialog} owner=${navKey} onClose=${() => setUsage(false)} />` : null}`;
}

export function AgentSheet({ name, inst, current, items = [], extra = [], chat = null, verifiedUntil = null, onUsage, onClose, targetLabel = null }) {
  const [look, setLook] = useState(false);
  const size = useStore(textSizeStore).size;
  const by = (key) => items.find((i) => i && i.key === key);
  const pick = (fn) => () => { onClose(); fn(); };
  const tile = (icon, label, fn) => html`<button type="button" class="chat-sheet-tile" onClick=${pick(fn)}><${Icon} name=${icon} size=${20} /><span>${label}</span></button>`;
  const row = (item, extra) => item ? html`<button type="button" class=${`menu-item chat-sheet-row${item.danger ? " danger" : ""}`} disabled=${!!item.disabled}
    aria-checked=${item.checkbox ? (item.checked ? "true" : "false") : undefined} role=${item.checkbox ? "menuitemcheckbox" : undefined}
    onClick=${() => { if (item.checkbox) item.onSelect(); else { onClose(); item.onSelect(); } }}>${item.icon ? html`<${Icon} name=${item.icon} size=${18} />` : html`<span class="chat-sheet-gap"></span>`}
    <span>${item.label}</span>${extra || item.checkbox ? html`<small>${extra || (item.checked ? "✓" : "")}</small>` : null}</button>` : null;
  const words = t("agentSheet.textSizes").split(","), at = Math.max(0, TEXT_SIZES.indexOf(size));
  const looks = items.filter((i) => i && !PLACED.includes(i.key));
  const controls = CONTROLS.map(by).filter(Boolean);
  // Agent details: the page's own item (the chat's), else a way there from View and Log; none on Details itself.
  const details = by("details") || (current !== "details" && supportsInstanceFeature(inst, "details")
    ? { key: "details", icon: "info", onSelect: () => navigate(detailsPath(name)) } : null);
  return html`<${Dialog} title=${t("agentSheet.sheet", name)} onClose=${onClose} cls="chat-sheet">
    ${targetLabel ? html`<h3 class="menu-heading chat-sheet-head">${targetLabel}</h3>` : null}
    <div class="chat-sheet-tiles">
      ${current !== "chat" ? tile("chat", t("app.chat"), () => navigate(chatPath(name))) : null}
      ${current !== "view" && supportsInstanceFeature(inst, "view") ? tile("view", t("app.view"), () => navigate(viewPath(name))) : null}
      ${current !== "log" && supportsInstanceFeature(inst, "log") ? tile("file", t("app.log"), () => navigate(logPath(name))) : null}
      ${tile("search", t("agentSheet.search"), () => openSearch({ instance: name }))}
      ${by("workspace") ? tile("diff", t("agentSheet.files"), () => by("workspace").onSelect()) : null}
      ${by("pins") ? tile("pin", by("pins").label, () => by("pins").onSelect()) : null}
      ${chat?.card ? tile("idcard", t("agentSheet.card"), () => chat.onCard()) : null}
      ${supportsInstanceFeature(inst, "usage") && usageOffered() ? html`<button type="button" class="chat-sheet-tile" onClick=${onUsage}><${Icon} name="chart" size=${20} /><span>${t("agentSheet.usage")}</span></button>` : null}
    </div>
    ${chat?.onModel ? row({ key: "model", icon: "sliders", label: t("agentSheet.model"), onSelect: chat.onModel }, chat.modelText) : null}
    ${chat?.onBackend ? row({ key: "backend", icon: "bot", label: t("agentSheet.backend"), onSelect: chat.onBackend }, chat.backendText) : null}
    <button type="button" class="menu-item chat-sheet-row" onClick=${() => setTextSize(TEXT_SIZES[(at + 1) % TEXT_SIZES.length])}><${Icon} name="type" size=${18} /><span>${t("agentSheet.textSize")}</span><small>${words[at] || ""}</small></button>
    ${looks.length ? html`<button type="button" class="menu-item chat-sheet-row" aria-expanded=${look ? "true" : "false"} onClick=${() => setLook((v) => !v)}><${Icon} name="palette" size=${18} /><span>${t("agentSheet.look")}</span><small>${look ? "⌃" : "⌄"}</small></button>
      ${look ? html`<div class="chat-sheet-sub">${looks.map((i) => i.heading ? html`<div key=${i.key} class="menu-heading">${i.label}</div>` : html`<span key=${i.key}>${row(i)}</span>`)}</div>` : null}` : null}
    ${row(details ? { ...details, label: t("agentSheet.details") } : null)}${row(by("settings"))}${extra.map((i) => row(i))}
    ${controls.length ? html`<div class="menu-heading chat-sheet-head">${t("agentSheet.agent")}</div>` : null}
    ${row(by("start"))}${row(by("restart"))}${row(by("stop"))}${row(by("pause"))}${row(by("wake"))}${row(by("delete"))}
    ${verifiedUntil ? html`<div class="chat-sheet-foot">✓ ${t("agentSheet.verifiedUntil", untilClock(verifiedUntil))}</div>` : null}
  </${Dialog}>`;
}

AgentSheet.sidebarTargetVersion = 1;
