import { register } from "/assets/app-i18n.js";
register("settings", {
  en: {
    defaultIdentityAffected: "Changes backend or model for {0} agents. Other backends keep their own model defaults.",
    defaultIdentityNames: "Affected: {0}",
    defaultIdentityRooms: "Also changes {0} ClassicBot room(s), with the same timing choice.",
    defaultModelCount: "{0}/{1} agents on this backend inherit its shared model.",
    defaultIdentityOtherEdits: "Other changes: {0}",
    defaultIdentityWhen: "When to use the new backend or model",
    defaultIdentityNext: "Next restart · no restart now",
    defaultIdentityRestart: "Restart running agents now",
    defaultIdentityChoiceHint: "Saved defaults wait for the next restart unless you choose to restart running agents now. Stopped and paused agents stay stopped. Other edited settings keep their own apply rules.",
    defaultIdentityRestartConfirm: "Restart the affected running agents to use saved shared backend/model changes now? This interrupts their current sessions. Stopped and paused agents stay stopped.",
    defaultIdentityPending: "Saved · applies on next restart",
  },
  "zh-TW": {
    defaultIdentityAffected: "{0} 個 Agent 的後端或模型會改變；其他後端保留各自的預設模型。",
    defaultIdentityNames: "受影響：{0}",
    defaultIdentityRooms: "另有 {0} 個 ClassicBot 房間受影響，沿用相同的套用時間選擇。",
    defaultModelCount: "此後端有 {0}/{1} 個 Agent 沿用共用模型。",
    defaultIdentityOtherEdits: "其他修改：{0}",
    defaultIdentityWhen: "何時使用新的後端或模型",
    defaultIdentityNext: "下次重啟時（現在不重啟）",
    defaultIdentityRestart: "立即重啟執行中的 Agent",
    defaultIdentityChoiceHint: "儲存的預設值會等到下次重啟才套用，除非你選擇立即重啟。已停止或暫停的 Agent 不會啟動；其他修改仍依各自的套用方式處理。",
    defaultIdentityRestartConfirm: "要立即重啟執行中的 Agent，套用已儲存的共用後端／模型嗎？這會中斷目前的工作階段。已停止或暫停的 Agent 不會啟動。",
    defaultIdentityPending: "已儲存 · 下次重啟時套用",
  },
});
