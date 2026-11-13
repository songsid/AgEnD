// Metadata-only presentation. New leaf module: retained shell modules need no new named exports.
import { register, t } from "./app-i18n.js";
register("app", { en: { needs_reason_model_switch: "Claude model switched" }, "zh-TW": { needs_reason_model_switch: "Claude 模型已切換" } });
register("modelObservation", {
  en: { safeguards: "Model switched by safeguards", availability: "Model switched due to availability", observed: "Different served model observed",
    turn: "turn", session: "session", unknown: "scope unknown", configured: "Configured model", selection: "Session model", served: "Last served model", unresolved: "Not resolved" },
  "zh-TW": { safeguards: "安全機制已切換模型", availability: "模型因供應狀況而切換", observed: "觀察到不同的回應模型",
    turn: "此回合", session: "此工作階段", unknown: "範圍未知", configured: "設定模型", selection: "工作階段模型", served: "最近回應模型", unresolved: "尚未確認" },
});
export const modelName = (value) => {
  const id = String(value || "").replace(/\[1m\]$/i, "").replace(/^claude-/i, "").replace(/-\d{8}$/, "");
  const m = /^(opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?$/i.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : id;
};
export const observationLabel = (key) => t(`modelObservation.${key}`);
export const modelSwitchText = (s) => s ? `${observationLabel(s.cause)}: ${modelName(s.original)} → ${modelName(s.served)} · ${observationLabel(s.scope)}` : "";
