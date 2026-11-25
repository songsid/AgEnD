// M-3757: Claude Code's usage-credits prompt in the standard Needs-you layout, in the UI's language. The server sends the card's
// `view` (the agent, the model the prompt is about, the model a switch would move to, and whether it is Claude's
// /model picker) and each option's `role`, read from Claude's own words; this module names them. Claude's own text
// stays available behind a toggle (the page's), never in the title or on the buttons.
import { register, t } from "/assets/app-i18n.js";

register("ucard", {
  en: {
    title: "{0}: {1} now costs extra. Switch model?", titleStay: "{0}: {1} now costs extra.", titlePicker: "{0}: switching to {1} costs extra.",
    titleShort: "{0} costs extra. Switch model?", titleStayShort: "{0} costs extra.", titlePickerShort: "Switching to {0} costs extra.",
    detail: "{0} uses your plan; keeping {1} bills usage credits.", detailStay: "Keeping {0} bills usage credits.", detailPicker: "Using {0} bills usage credits.",
    switch: "Switch to {0}", credits: "Keep {0}", creditsPicker: "Use {0}",
    notNow: "Not now", keep: "Keep current model", admin: "Ask admin for credits", upgrade: "Upgrade plan",
    showRaw: "Show Claude's text",
    confirmTitle: "Keep {0} on {1}?", confirmTitlePicker: "Move {0} to {1}?",
    confirmMessage: "{0}'s replies may be billed to usage credits, separate from your plan.", confirmLabel: "Continue on credits",
  },
  "zh-TW": {
    title: "{0}：{1} 要另外收費，要換模型嗎？", titleStay: "{0}：{1} 要另外收費。", titlePicker: "{0}：改用 {1} 要另外收費。",
    titleShort: "{0} 要另外收費，要換模型嗎？", titleStayShort: "{0} 要另外收費。", titlePickerShort: "改用 {0} 要另外收費。",
    detail: "{0} 用方案額度；繼續用 {1} 會另外扣點數。", detailStay: "繼續用 {0} 會另外扣點數。", detailPicker: "改用 {0} 會另外扣點數。",
    switch: "換成 {0}", credits: "繼續用 {0}", creditsPicker: "改用 {0}",
    notNow: "先不要", keep: "維持目前模型", admin: "向管理員申請點數", upgrade: "升級方案",
    showRaw: "看 Claude 原文",
    confirmTitle: "讓 {0} 繼續用 {1}？", confirmTitlePicker: "讓 {0} 改用 {1}？",
    confirmMessage: "{0} 之後的回覆可能會另外從用量點數扣款（不在方案內）。", confirmLabel: "繼續（用點數）",
  },
});
const tu = (k, ...a) => t(`ucard.${k}`, ...a);

/**
 * The card's one-line title. `named: false` where the agent is already named above it (Needs you's agent group): the
 * title then starts at the model, short enough for one line on a phone.
 */
export function usageCreditsTitle(view, { named = true } = {}) {
  const key = view.picker ? "titlePicker" : view.target ? "title" : "titleStay";
  return named ? tu(key, view.agent, view.model) : tu(`${key}Short`, view.model);
}

/** The one sentence under the title: what each choice means for the bill. */
export function usageCreditsDetail(view) {
  if (view.picker) return tu("detailPicker", view.model);
  return view.target ? tu("detail", view.target, view.model) : tu("detailStay", view.model);
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

/** A button's weight: the choice that stays on the plan is primary; asking an admin or upgrading is a ghost; the rest secondary. */
function kindOf(role) {
  if (role === "switch" || role === "keep") return "primary";
  if (role === "admin" || role === "upgrade") return "ghost";
  return "secondary";
}

/**
 * The card's actions as this page shows them: each named by its role (Claude's own label kept for any other), with
 * its weight (`kind`), and the credits choice confirmed in these words. The action ids are the server's, unchanged.
 */
export function usageCreditsActions(view, actions) {
  return (actions || []).map((a) => {
    const words = label(view, a.role);
    const confirmation = a.role === "credits"
      ? { title: tu(view.picker ? "confirmTitlePicker" : "confirmTitle", view.agent, view.model), message: tu("confirmMessage", view.agent), confirmLabel: tu("confirmLabel"), even: true }
      : a.confirmation;
    const { hint: _hint, ...rest } = a;
    return { ...rest, label: words || a.label, kind: kindOf(a.role), ...(confirmation ? { confirmation } : {}) };
  });
}

/** The button classes for an action's weight (the standard Needs-you and chat buttons). */
export const kindClass = (kind) => (kind === "primary" ? " btn-primary" : kind === "ghost" ? " btn-ghost" : "");

export const showRawLabel = () => tu("showRaw");
