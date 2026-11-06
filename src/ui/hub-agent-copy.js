// Lazy, fixed local-owner copy for the representative-agent share (docs/design/hub-representative-agent.md).
// A member switcher may retain the old hub-strings module before Settings loads. Own these new words here.
import { register } from "/assets/app-i18n.js";
register("hub", {
  en: {
    agentLead: "Every agent is private unless you share it. A shared agent answers Hub questions in its own conversation, with its own folder and the tools its Settings allow. Actions that need approval still come to you.",
    agentShared: "Shared: Hub questions go to this agent's own conversation.",
    republishRequired: "Shared under the older restricted mode. Hub questions are refused until you share this agent again.",
    shareAgain: "Share again",
    agentNotShareable: "This agent can't be shared right now. Reload the page and try again.",
    agentDeliveryUnavailable: "Sharing isn't available on this fleet yet: Hub questions can't reach an agent here.",
  },
  "zh-TW": {
    agentLead: "每個 Agent 預設都不公開。公開後，Agent 會在自己的對話中回答 Hub 的提問，使用它自己的資料夾和設定允許的工具。需要核准的動作仍會交給你。",
    agentShared: "已公開：Hub 的提問會送到這個 Agent 自己的對話。",
    republishRequired: "這是舊的受限模式公開。重新公開這個 Agent 之前，Hub 的提問都會被拒絕。",
    shareAgain: "重新公開",
    agentNotShareable: "目前無法公開這個 Agent。請重新整理頁面後再試一次。",
    agentDeliveryUnavailable: "這個 Fleet 還不能公開：Hub 的提問目前無法送到這裡的 Agent。",
  },
});
/** What a Share sends: the agent itself, no Hub tools (agent-mode.ts on the member). */
export const AGENT_CHOICE = Object.freeze({ dataViewId: "agent", tools: Object.freeze([]) });
