import { register, t } from "/assets/app-i18n.js";
register("hubPilotTrust", {
  en: {
    title: "This Hub uses a self-signed test certificate",
    body: "This computer can't confirm its identity by itself. If this is the Hub your team is piloting, you can trust it for now. If its certificate changes later, you'll be asked again.",
    fingerprint: "Certificate fingerprint", full: "Show the full fingerprint", trust: "Trust this Hub and continue", cancel: "Cancel",
    trusted: "You trusted this Hub's self-signed certificate (for testing).",
    changed: "{0}'s certificate is different from the one you trusted, so nothing was connected. If your Hub administrator confirms it was replaced, you can trust it again.",
    again: "Trust again and continue",
    setting: "Allow trusting a Hub with a self-signed certificate (for testing)",
    hint: "For pilots only. Turn it off once the Hub has a trusted certificate.",
    disabled: "{0} uses a self-signed certificate, and this AgEnD doesn't allow trusting one. Ask the Hub administrator for a trusted certificate.",
    failed: "The setting could not be saved. Try again.", retry: "Try again", pending: "Confirm this change in Needs you."
  },
  "zh-TW": {
    title: "這個 Hub 用的是測試用的自簽憑證",
    body: "這台電腦無法自動確認它的身分。如果這是你們團隊試行中的 Hub，可以先信任它；之後它的憑證若改變，會再問你一次。",
    fingerprint: "憑證指紋", full: "顯示完整指紋", trust: "信任這個 Hub 並繼續", cancel: "取消",
    trusted: "已信任這個 Hub 的自簽憑證（測試用）。",
    changed: "{0} 的憑證和你上次信任的不同，所以沒有連接。如果 Hub 管理員確認換過憑證，可以重新信任。",
    again: "重新信任並繼續",
    setting: "允許信任自簽憑證的 Hub（測試用）", hint: "只在試行期間使用。Hub 換上受信任的憑證後請關閉。",
    disabled: "{0} 用的是自簽憑證，這台 AgEnD 不允許信任它。請 Hub 管理員換上受信任的憑證。",
    failed: "設定未能儲存，請再試一次。", retry: "再試一次", pending: "請到「需要你」確認這項變更。"
  }
});
export const pt = (key, ...args) => t("hubPilotTrust." + key, ...args);
