// #1519 P7 (docs/design/ux-onboarding-walkthrough.md §5.1): the first-run card. A fleet with no chat connection (a
// web-only fleet) opens Chat and Settings with it: "Connect a chat app" opens the setup wizard (in Settings, where its
// progress is shown), "Use the web only" hides it in this browser. It stays until a connection exists or it is dismissed.
import { html } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { appStore, createStore, useStore } from "/assets/app-store.js";
import { navigate } from "/assets/app-nav.js";
import { settingsPath } from "/assets/app-route.js";
import { Icon } from "/assets/ui-icons.js";

register("firstRun", {
  en: {
    title: "Connect a chat app",
    body: "AgEnD works in this browser on its own. To talk to your agents from Telegram or Discord too, add a bot: the setup wizard checks its token and connects it to an agent.",
    connect: "Connect a chat app", webOnly: "Use the web only",
  },
  "zh-TW": {
    title: "連接聊天應用程式",
    body: "AgEnD 只用這個瀏覽器也能運作。想同時從 Telegram 或 Discord 跟你的 agent 對話，就加一個機器人：設定精靈會檢查它的 token，並把它接到一個 agent。",
    connect: "連接聊天應用程式", webOnly: "只用網頁",
  },
});

export const DISMISS_KEY = "agend_firstrun_dismissed";
function readDismissed() { try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; } }
// `dismissed`: this page's own answer (it holds even when the browser keeps no storage); a stored one is read each time.
const local = createStore({ dismissed: false, wizard: false });

export function dismissFirstRun() {
  try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* this page only */ }
  local.set({ dismissed: true });
}

/** For the tests: a fresh page's state. */
export function resetFirstRun() { local.set({ dismissed: false, wizard: false }); }

/** Settings asks once, when it has its data: was it opened by "Connect a chat app" (open the wizard)? */
export function takeWizardRequest() {
  if (!local.get().wizard) return false;
  local.set({ wizard: false });
  return true;
}

/** Shown on a known web-only fleet (no connection) until dismissed. */
export function useFirstRun() {
  const app = useStore(appStore);
  const { dismissed } = useStore(local);
  return app.ready && app.connections === 0 && !dismissed && !readDismissed();
}

/** onConnect: Settings opens its wizard in place; elsewhere the card goes to Settings, which opens it. */
export function FirstRunCard({ onConnect }) {
  const shown = useFirstRun();
  if (!shown) return null;
  const connect = onConnect || (() => { local.set({ wizard: true }); navigate(settingsPath("bots")); });
  return html`<section class="card first-run" aria-labelledby="first-run-title">
    <h3 id="first-run-title"><${Icon} name="plug" size=${14} /> ${t("firstRun.title")}</h3>
    <p>${t("firstRun.body")}</p>
    <div class="dlg-inline-actions">
      <button type="button" class="btn btn-primary" onClick=${connect}>${t("firstRun.connect")}</button>
      <button type="button" class="btn btn-ghost" onClick=${dismissFirstRun}>${t("firstRun.webOnly")}</button>
    </div>
  </section>`;
}
