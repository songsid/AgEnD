// Lazy, fixed local-owner copy only. Wire reasons are never rendered as exception text or translation keys.
// A member switcher may retain the old hub-strings module before Settings loads. Own these new words here.
import { register } from "/assets/app-i18n.js";
register("hub", {
  en: {
    "provider_engine-unavailable": "Docker is unavailable. Start the local Docker engine and check access to its configured Unix socket, then reload the member configuration.",
    "provider_engine-unsupported": "This provider requires a Linux/amd64 Docker engine. Use a Linux/amd64 member environment, then reload its configuration.",
    "provider_image-unconfigured": "No provider image is selected. Set imageId to a reviewed local image's immutable SHA-256 ID in the member provider configuration, then reload it.",
    "provider_image-mismatch": "The selected image is missing or does not match this provider. Select the matching reviewed local image and reload the member configuration. Images are never pulled automatically.",
    "provider_credential-unconfigured": "No usable model API key is configured. Set credentialRef to this member's private model API key file, then reload the member configuration.",
    "provider_unavailable": "The isolated provider is unavailable. Review the local member provider configuration and the fleet log, then reload the configuration.",
  },
  "zh-TW": {
    "provider_engine-unavailable": "無法連接 Docker。請啟動本機 Docker 引擎，確認能存取設定的 Unix socket，再重新載入成員設定。",
    "provider_engine-unsupported": "此提供者需要 Linux/amd64 的 Docker 引擎。請改用 Linux/amd64 成員環境，再重新載入設定。",
    "provider_image-unconfigured": "尚未選取提供者映像檔。請在成員提供者設定的 imageId 填入已審查本機映像檔的不可變 SHA-256 識別碼，再重新載入設定。",
    "provider_image-mismatch": "選取的映像檔不存在或與此提供者不符。請選取相符且已審查的本機映像檔，再重新載入成員設定。系統不會自動下載映像檔。",
    "provider_credential-unconfigured": "尚未設定可用的模型 API 金鑰。請將 credentialRef 設為此成員的私密模型 API 金鑰檔案，再重新載入成員設定。",
    "provider_unavailable": "隔離提供者目前無法使用。請檢查本機成員提供者設定與 fleet 記錄，再重新載入設定。",
  },
});
const keys = new Map([
  ["engine-unavailable", "provider_engine-unavailable"],
  ["engine-unsupported", "provider_engine-unsupported"],
  ["image-unconfigured", "provider_image-unconfigured"],
  ["image-mismatch", "provider_image-mismatch"],
  ["credential-unconfigured", "provider_credential-unconfigured"],
  ["unavailable", "provider_unavailable"],
  ["provider-unavailable", "provider_unavailable"],
]);
export const guidanceFor = (reason) => keys.get(reason) ?? null;
