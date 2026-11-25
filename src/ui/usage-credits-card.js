// M-3757: the compact form of Claude Code's usage-credits prompt, in the UI's language. The server sends the card's
// `view` (the agent, the model the prompt is about, the model a switch would move to, and whether it is Claude's
// /model picker) and each option's `role`, read from Claude's own words; this module names them. Claude's own text
// stays available behind a toggle (the page's), never in the title or on the buttons.
import { register, t } from "/assets/app-i18n.js";

register("ucard", {
  en: {
    title: "{0}: {1} now costs extra. Switch model?", titleStay: "{0}: {1} now costs extra.", titlePicker: "{0}: switching to {1} costs extra.",
    switch: "Switch to {0} (uses your plan)", credits: "Keep {0} (billed to credits)", creditsPicker: "Use {0} (billed to credits)",
    notNow: "Not now (nothing is sent)", keep: "Keep the current model (uses your plan)", admin: "Ask my admin for credits", upgrade: "Upgrade plan",
    showRaw: "Show Claude's text",
    confirmTitle: "Keep {0} on {1}?", confirmTitlePicker: "Move {0} to {1}?",
    confirmMessage: "{0}'s replies may be billed to usage credits, separate from your plan.", confirmLabel: "Continue on credits",
  },
  "zh-TW": {
    title: "{0}：{1} 要另外收費，要換模型嗎？", titleStay: "{0}：{1} 要另外收費。", titlePicker: "{0}：改用 {1} 要另外收費。",
    switch: "換成 {0}（用方案額度）", credits: "繼續用 {0}（另外扣點數）", creditsPicker: "改用 {0}（另外扣點數）",
    notNow: "先不要（不送出）", keep: "維持目前模型（用方案額度）", admin: "向管理員申請點數", upgrade: "升級方案",
    showRaw: "看 Claude 原文",
    confirmTitle: "讓 {0} 繼續用 {1}？", confirmTitlePicker: "讓 {0} 改用 {1}？",
    confirmMessage: "{0} 之後的回覆可能會另外從用量點數扣款（不在方案內）。", confirmLabel: "繼續（用點數）",
  },
});
const tu = (k, ...a) => t(`ucard.${k}`, ...a);

/** The card's one-line title. */
export function usageCreditsTitle(view) {
  if (view.picker) return tu("titlePicker", view.agent, view.model);
  return tu(view.target ? "title" : "titleStay", view.agent, view.model);
}

/** One option's button words, by its role; null for a role this page does not know (its own label is shown). */
function label(view, role) {
  switch (role) {
    case "switch": return view.target ? tu("switch", view.target) : null;
    case "credits": return tu(view.picker ? "creditsPicker" : "credits", view.model);
    case "not-now": return tu("notNow");
    case "keep": return tu("keep");
    case "admin": return tu("admin");
    case "upgrade": return tu("upgrade");
    default: return null;
  }
}

/**
 * The card's actions as this page shows them: each named by its role (Claude's own label kept for any other), the
 * switch first-class, and the credits choice confirmed in these words. The action ids are the server's, unchanged.
 */
export function usageCreditsActions(view, actions) {
  return (actions || []).map((a) => {
    const words = label(view, a.role);
    const confirmation = a.role === "credits"
      ? { title: tu(view.picker ? "confirmTitlePicker" : "confirmTitle", view.agent, view.model), message: tu("confirmMessage", view.agent), confirmLabel: tu("confirmLabel") }
      : a.confirmation;
    const { hint: _hint, ...rest } = a;
    return { ...rest, label: words || a.label, primary: a.role === "switch", ...(confirmation ? { confirmation } : {}) };
  });
}

export const showRawLabel = () => tu("showRaw");
