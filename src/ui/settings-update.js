// M-2738 (the leader's D4): Settings → Advanced → "Version and update" — the running version, its update line, the last
// check and its offer, with Update now (the app-wide confirmation) and Check for updates. An alpha told of a newer stable
// sees it with no Update (D2). Admins only (a read session sees the version alone); hidden on a server without
// /ui/update. The search registry's "advanced.update" entry finds it.
import { html, useEffect, useState } from "/assets/app-html.js";
import { register, t, lang } from "/assets/app-i18n.js";
import { useStore } from "/assets/app-store.js";
import { toast } from "/assets/ui-toast.js";
import { checkUpdateNow, hubNeed, openHubUpdateDialog, openUpdateDialog, refreshUpdate, updateActive, updateStore } from "/assets/app-update.js";
import { dateTimeText } from "/assets/clock-text.js";
// M-3770 1.4: the update card's Settings part (a module of its own; its deps are passed, never imported back).
import { UpdateCardSettings, cardActions } from "/assets/update-card-ui.js";

register("supdate", {
  en: { title: "Version and update", current: "Current version", line: "Update line", latest: "Latest", checked: "Last checked",
    newer: "v{0} is available", upToDate: "Up to date", stableNewer: "v{0} (stable) is available", notYet: "Not checked yet",
    failed: "The last check could not reach the update source", check: "Check for updates", checking: "Checking…",
    alphaNote: "Updating from the web stays on the Alpha preview line; switching to stable is not offered here.",
    recently: "Checked less than a minute ago.", checkFailed: "The check could not finish.", pillNew: "New version",
    recommendedBy: "Recommended by {0}" },
  "zh-TW": { title: "版本與更新", current: "目前版本", line: "更新管道", latest: "最新", checked: "上次檢查",
    newer: "v{0} 已推出", upToDate: "已是最新版", stableNewer: "v{0}（穩定版）已推出", notYet: "還沒檢查過",
    failed: "上次檢查連不上更新來源", check: "檢查更新", checking: "檢查中…",
    alphaNote: "網頁更新會留在 Alpha 預覽版，不提供切換到穩定版。",
    recently: "一分鐘內剛檢查過。", checkFailed: "檢查沒有完成。", pillNew: "有新版",
    recommendedBy: "{0} 建議的版本" },
});

const LINE = { latest: "update.channel_latest", beta: "update.channel_beta", alpha: "update.channel_alpha" };
function channelOf(version) {
  const pre = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(version || "");
  return !pre ? "latest" : pre[1] === "alpha" ? "alpha" : "beta";
}
function when(ms) {
  try { return dateTimeText(ms, { dateStyle: "medium", timeStyle: "short" }, lang() === "zh-TW" ? "zh-TW" : "en-US"); } catch { return ""; }
}

export function UpdateSection() {
  const { info, starting } = useStore(updateStore);
  const [checking, setChecking] = useState(false);
  useEffect(() => { refreshUpdate(); }, []);
  if (!info || !info.admin) return null;
  const channel = channelOf(info.current);
  const offer = info.offer;
  // M-3140 (spec §3.3): the Hub's advice, a row of its own; its Update is pinned when it is the higher need (hubNeed).
  const rec = info.hubRecommendation && typeof info.hubRecommendation.version === "string" ? info.hubRecommendation : null, need = hubNeed(info);
  const latest = offer ? (offer.installable ? t("supdate.newer", offer.version) : t("supdate.stableNewer", offer.version))
    : info.check_failed ? t("supdate.failed") : info.checked_at ? t("supdate.upToDate") : t("supdate.notYet");
  const check = async () => {
    setChecking(true);
    const r = await checkUpdateNow();
    setChecking(false);
    if (!r.ok) toast(r.status === 429 ? t("supdate.recently") : t("supdate.checkFailed"), false);
  };
  return html`<section class="card s-update" id="settings-update">
    <h3>${t("supdate.title")}</h3>
    <dl>
      <dt>${t("supdate.current")}</dt><dd>v${info.current}</dd>
      <dt>${t("supdate.line")}</dt><dd>${t(LINE[channel])}</dd>
      <dt>${t("supdate.latest")}</dt><dd class=${offer && offer.installable ? "new" : ""}>${latest}</dd>
      <dt>${t("supdate.checked")}</dt><dd>${info.checked_at ? when(info.checked_at) : t("supdate.notYet")}</dd>
      ${rec ? html`<dt>${t("supdate.recommendedBy", rec.hubName)}</dt><dd class=${need ? "new" : ""}>v${rec.version}</dd>` : null}
    </dl>
    ${offer && !offer.installable ? html`<p class="s-update-note">${t("supdate.alphaNote")}</p>` : null}
    <div class="s-update-row">
      ${need ? html`<button type="button" class="btn btn-primary" disabled=${starting || updateActive(info)} onClick=${() => { void openHubUpdateDialog(); }}>${t("update.now")}</button>`
        : info.card !== undefined ? cardButtons(info, starting)
        : offer && offer.installable ? html`<button type="button" class="btn btn-primary" disabled=${starting || updateActive(info)} onClick=${openUpdateDialog}>${t("update.now")}</button>` : null}
      <button type="button" class="btn" disabled=${checking || starting || updateActive(info)} onClick=${check}>${checking ? t("supdate.checking") : t("supdate.check")}</button>
    </div>
    ${info.card !== undefined ? html`<${UpdateCardSettings} info=${info} deps=${CARD_DEPS} />` : null}
  </section>`;
}
/** M-3770 1.4: what update-card-ui.js needs from app-update.js, passed in. */
const CARD_DEPS = { refresh: () => refreshUpdate(), setInfo: (i) => updateStore.set({ info: i }), getInfo: () => updateStore.get().info };
/** M-3770 1.4: with the card, the banner's answers in every state (#4487 review P2: the banner is hidden on this page, so
 *  waiting and scheduled keep Cancel and Update now here; Pick a time only where a schedule is taken). One policy: cardActions. */
function cardButtons(info, starting) {
  const busy = starting || updateActive(info);
  const actions = cardActions(info, CARD_DEPS);
  return actions.length ? actions.map((a) => html`<button type="button" key=${a.key} class=${`btn${a.primary ? " btn-primary" : ""}`} disabled=${busy} onClick=${() => { void a.run(); }}>${a.label}</button>`) : null;
}

/** The "new version" mark beside Settings' version pill (admins, an installable offer). */
export function UpdatePillMark() {
  const { info } = useStore(updateStore);
  if (!info || !info.admin || !((info.offer && info.offer.installable) || hubNeed(info))) return null;
  return html` <span class="pill ver-new">${t("supdate.pillNew")}</span>`;
}
