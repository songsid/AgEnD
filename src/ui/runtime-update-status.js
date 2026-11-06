import { html } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
export { runtimeFreshInstallCommand } from "./runtime-update-commands.js";

// Lazy-owned copy also works with a shell opened before this feature existed.
register("runtimeUpdate", {
  en: {
    unknown: "Update status unavailable", current: "Matches the paired AgEnD build", pending: "Update pending: {0} / bundle {1}",
    failed: "Update failed: {0} / bundle {1}", pendingHint: "Waiting for idle. Running panes and deliveries are kept.",
    failedHint: "The previous code is kept. This build will not be retried until the paired AgEnD offers a different hash.",
    unmanaged: "Reinstall once with the one-line command to enable automatic updates.",
    shared: "This installation is shared. Use a separate installation for each paired AgEnD before enabling automatic updates.",
    "another-runtime": "Updates are waiting for exclusive use of this installation. Close the other Runtime, or use a separate installation.",
    recovery: "An interrupted update needs a fresh separate installation. Keep the existing profile and pairing.",
    damaged: "This installation could not be verified. Reinstall into a fresh separate folder.",
    running: "Running: {0} / build {1}", last: "Last reported update status; this connection has not confirmed it.",
    repair: "Show reinstall command", repairTitle: "Enable automatic Runtime updates", repairHint: "Close this Runtime first. This command selects a fresh separate folder and verifies the installer from this AgEnD. Your existing pairing is kept. Then start the new Runtime using the full path the installer prints, with the same --profile you used before. No new pairing code is needed.",
    attention: "Runtime update needs attention", open: "Open Runtime settings",
  },
  "zh-TW": {
    unknown: "無法取得更新狀態", current: "與配對 AgEnD 的版本相符", pending: "更新待執行：{0}／套件 {1}",
    failed: "更新失敗：{0}／套件 {1}", pendingHint: "正在等待閒置，執行中的 pane 與傳遞會保留。",
    failedHint: "已保留原本程式。配對的 AgEnD 提供不同雜湊前，不會重試此套件。",
    unmanaged: "使用一行安裝指令重新安裝一次，即可啟用自動更新。",
    shared: "此安裝目錄由多個 AgEnD 共用。請為每個配對的 AgEnD 使用獨立安裝目錄，再啟用自動更新。",
    "another-runtime": "更新正在等待獨佔此安裝目錄。請關閉另一個 Runtime，或使用獨立安裝目錄。",
    recovery: "中斷的更新需要重新安裝到獨立目錄。請保留既有設定檔與配對。",
    damaged: "無法驗證此安裝。請重新安裝到全新的獨立目錄。",
    running: "執行中：{0}／組建 {1}", last: "這是上次回報的更新狀態，目前連線尚未確認。",
    repair: "顯示重新安裝指令", repairTitle: "啟用 Runtime 自動更新", repairHint: "請先關閉此 Runtime。指令會選擇全新的獨立目錄，並驗證來自這台 AgEnD 的安裝程式，既有配對會保留。完成後，請使用安裝程式顯示的完整路徑啟動新 Runtime，並沿用原本的 --profile，不需要新的配對碼。",
    attention: "Runtime 更新需要處理", open: "開啟 Runtime 設定",
  },
});
export const runtimeUpdateText = (key, ...args) => t(`runtimeUpdate.${key}`, ...args);
const reasons = new Set(["unmanaged", "shared", "another-runtime", "recovery", "damaged"]);
export function RuntimeUpdateNotice({ machine, onRepair }) {
  const report = machine.updateReport, status = report?.status;
  const fresh = machine.status === "online" && report?.bootId === machine.bootId && report?.generation === machine.generation;
  const state = ["current", "pending", "failed", "manual"].includes(status?.state) ? status.state : "unknown";
  const reason = state === "manual" && reasons.has(status.reason) ? status.reason : "";
  const target = (state === "pending" || state === "failed") && status.target;
  const label = state === "manual" ? reason ? runtimeUpdateText(reason) : runtimeUpdateText("unknown")
    : state === "current" && !fresh ? runtimeUpdateText("unknown")
    : target ? runtimeUpdateText(state, target.version, target.bundleSha256.slice(0, 8)) : runtimeUpdateText(state);
  const repair = reason && reason !== "another-runtime" || state === "unknown" && machine.status === "online" && !machine.runtimeInfo?.capabilities?.includes("managed-update-status-v1");
  return html`<section class="runtime-update-notice" role=${state === "failed" ? "alert" : "status"}>
    <p>${label}</p>
    ${report && !fresh ? html`<p class="note">${runtimeUpdateText("last")}</p>` : null}
    ${state === "pending" || state === "failed" ? html`<p class="note">${runtimeUpdateText(`${state}Hint`)}</p>` : null}
    ${target && machine.runtimeInfo ? html`<p class="note">${runtimeUpdateText("running", machine.runtimeInfo.version || "—", machine.runtimeInfo.buildId?.slice(0, 8) || "—")}</p>` : null}
    ${repair ? html`<button type="button" class="btn btn-sm" onClick=${onRepair}>${runtimeUpdateText("repair")}</button>` : null}
  </section>`;
}
