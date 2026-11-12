// #3637: optional presentation/data only. Every new window boots the existing authenticated chat independently.
import { appStore, guestPage } from "/assets/app-store.js";
import { agentRoute } from "/assets/chat-workspace-model.js";
import { parseRoute } from "/assets/app-route.js";
import { Shell, shellStore } from "/assets/app-shell.js";
import { register, t } from "/assets/app-i18n.js";
import { toast } from "/assets/ui-toast.js";
import { PopoutHeader } from "./chat-popout-header.js";
import { createPopoutTransport, receivePopoutDraft } from "./chat-popout-transport.js";
register("chatPopout", {
  en: { open: "Pop out into a separate window", blocked: "Your browser blocked the window. Allow pop-ups for this site, then try again. This pane and draft are unchanged.",
    retained: "The handoff was not completed. Your original pane and draft have been kept. Check the new window before trying again.", busy: "A window is already opening. Finish or close it first." },
  "zh-TW": { open: "彈出成獨立視窗", blocked: "瀏覽器封鎖了新視窗。請允許這個網站開啟彈出視窗，再試一次。目前窗格與草稿不變。",
    retained: "未能完成移交，原本的窗格與草稿已保留。請先查看新視窗，再試一次。", busy: "正在開啟視窗，請先完成或關閉它。" },
});
export const popoutText = key => t(`chatPopout.${key}`);
const supported = chat => chat?.popoutDraftVersion === 1 && chat.popoutDraftReady?.() === true && Shell.popoutVersion === 1
  && getComputedStyle(document.documentElement).getPropertyValue("--chat-popout-version").trim() === "1";
export function createPanePopout({ scope, chat, win = window, notify = reason => toast(popoutText(reason), false) }) {
  if (!supported(chat) || guestPage() || !scope) return null;
  let alive = true;
  const transport = createPopoutTransport({ win, scope, notify });
  return {
    open(controller, id) {
      const pane = controller.current()?.[id]; if (!pane || !agentRoute(pane.route)) return false;
      const draft = chat.capturePaneDraft(pane.route.instance); if (!draft) { notify("retained"); return false; }
      const current = () => alive && controller.current()?.[id] === pane && draft.current();
      return transport.open({ name: pane.route.instance, payload: draft.payload, current,
        complete() {
          if (!current()) return false;
          // Existing cooperative leave guards still own closure. A declined/held guard keeps the source draft too.
          controller.closePane(id);
          if (controller.current()?.[id] === pane) return false;
          return draft.clear();
        } });
    },
    close() { alive = false; transport.close(); },
  };
}

export function installPopout({ nav, chat, scope, win = window }) {
  const route = nav.navStore.get().route || parseRoute(win.location.pathname);
  if (!supported(chat) || guestPage() || !scope || !agentRoute(route) || new URL(win.location.href).searchParams.get("presentation") !== "popout") return null;
  let alive = true;
  const name = route.instance, stamp = nav.navStore.get(), draft = chat.capturePaneDraft(name);
  const current = () => alive && nav.navStore.get() === stamp && stamp.route?.panel === "chat" && stamp.route?.instance === name;
  const off = nav.installNavigation({
    resolve(url) {
      const route = parseRoute(url.pathname);
      if (agentRoute(route)) url.searchParams.set("presentation", "popout");
      return { route, path: url.pathname + url.search + url.hash };
    },
  });
  shellStore.set({ popout: true, popoutHeader: PopoutHeader, drawer: false });
  // No workspace entry, secondary stream, or second pane is installed in this document.
  const receive = receivePopoutDraft({ win, name, scope, current,
    ready: () => appStore.get().ready && chat.paneComposerReady(name),
    accept: data => current() && draft?.current() && chat.acceptPaneDraft(name, data),
    notify: reason => toast(popoutText(reason), false) });
  const close = () => { if (!alive) return; alive = false; receive(); off(); shellStore.set({ popout: false, popoutHeader: null }); };
  globalThis.AgendAuth?.onSessionEnd?.(close);
  return { close };
}
