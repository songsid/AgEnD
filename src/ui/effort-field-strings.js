// The reasoning-effort field's words (Settings → agent → Runtime & model), lazy and fixed: they live in a module of their
// own, registered with the field, so a tab opened before an upgrade — which may keep the old agent-page-strings module while
// the dialog module is fresh — never shows a raw key. (agent-page-strings keeps `note_effort` for the opposite mix: an old
// dialog with the new strings.)
import { register, t } from "/assets/app-i18n.js";
register("effortField", {
  en: {
    label: "Reasoning effort", modelDefault: "Model default", notOffered: "{0} (not offered by this model)", failed: "Could not change the reasoning effort.",
    tip: "How much the model thinks before it answers. The list is what the selected model accepts, and it is the same value as the effort chip above the chat box. A running agent applies it at once; some CLIs (such as Codex) restart the agent for it to take effect. Model default leaves it to the CLI; a new agent starts on it.",
    saveModelFirst: "Save the model change first, then choose its effort.",
  },
  "zh-TW": {
    label: "推理強度", modelDefault: "模型預設", notOffered: "{0}（此模型不提供）", failed: "無法變更推理強度。",
    tip: "模型回答前思考多少。清單是目前所選模型接受的強度，和對話輸入框上方的強度標籤是同一個值。執行中的 Agent 會立即套用；部分 CLI（例如 Codex）會自動重啟 Agent 才生效。「模型預設」表示交給 CLI 自己決定；新建的 Agent 從這裡開始。",
    saveModelFirst: "請先儲存模型的變更，再選擇它的強度。",
  },
});
export const ew = (key, ...values) => t(`effortField.${key}`, ...values);
