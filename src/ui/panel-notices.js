// #2910 D2: a web-only fleet's Notices (/ui/notices) — what General would have said: fleet errors, an agent's crash,
// quota or sign-in notice, a schedule that could not run, an available update. Behind the session gate (/ui/js/),
// loaded the first time it is opened. The list is the app store's `notices` (read from GET /ui/notices/list, then each
// new one from SSE `notice`); opening the page marks what it shows as read (POST /ui/notices/seen).
import { html, useEffect, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { useLease } from "/assets/app-ctx.js";
import { PanelHeader, setTitle } from "/assets/app-shell.js";
import { chatPath } from "/assets/app-route.js";
import { Empty } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";

register("notices", {
  en: {
    title: "Notices", sub: "What General would have said", empty: "No notices yet",
    emptyHint: "This fleet has no Discord or Telegram connection, so what its General would say — errors, an agent that crashed or ran out of quota, a sign-in, an available update — is kept here.",
    unread: "New", open: "Open chat",
    kind_fleet: "Fleet", kind_instance: "Agent", kind_update: "Update", kind_schedule: "Schedule", kind_summary: "Daily summary",
    ageNow: "just now", ageMin: "{0} min ago", ageHour: "{0} h ago", ageDay: "{0} d ago",
  },
  "zh-TW": {
    title: "通知", sub: "原本會發到 General 的訊息", empty: "還沒有通知",
    emptyHint: "這個 fleet 沒有 Discord 或 Telegram 連線，所以原本會由 General 說的事——錯誤、agent 當掉或額度用完、登入、新版本——都會留在這裡。",
    unread: "新", open: "開啟聊天",
    kind_fleet: "Fleet", kind_instance: "Agent", kind_update: "更新", kind_schedule: "排程", kind_summary: "每日摘要",
    ageNow: "剛剛", ageMin: "{0} 分鐘前", ageHour: "{0} 小時前", ageDay: "{0} 天前",
  },
});
const tn = (k, ...v) => t(`notices.${k}`, ...v);
const ICON = { fleet: "alert", instance: "bot", update: "download", schedule: "clock", summary: "chart" };

/** "3 min ago": a notice's age, refreshed by a display timer. */
export function noticeAge(at, nowMs) {
  const minutes = Math.max(0, Math.floor((nowMs - at) / 60_000));
  if (minutes < 1) return tn("ageNow");
  if (minutes < 60) return tn("ageMin", minutes);
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? tn("ageHour", hours) : tn("ageDay", Math.floor(hours / 24));
}

/** Everything up to `id` is read: the server's mark, then the store's (a failure leaves both as they were). */
export async function markNoticesSeen(id) {
  try {
    const r = await fetch("/ui/notices/seen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    const d = r.ok ? await r.json() : null;
    const cur = appStore.get().notices;
    if (d && cur && typeof d.seen === "number") appStore.set({ notices: { ...cur, seen: Math.max(cur.seen | 0, d.seen), unread: d.unread | 0 } });
  } catch { /* stays unread; the next visit marks it */ }
}

export function NoticesPanel({ navKey }) {
  const lease = useLease(navKey);
  const { notices, instances } = useStore(appStore);
  const items = notices && Array.isArray(notices.items) ? notices.items : [];
  // What was unread when the page opened stays marked "New" while it is open (it is marked read on the server at once).
  const [seenAtOpen] = useState(() => (notices ? notices.seen | 0 : 0));
  const [, tick] = useState(0);
  useEffect(() => { setTitle(tn("title")); const read = appStore.get().readNotices; if (read) read(); }, [navKey]);
  useEffect(() => { lease.interval(() => tick((n) => n + 1), 30_000); }, [lease]);
  // Shown → read: the newest one on the page, whenever a newer one arrives while it is open and visible.
  const newest = items.length ? items[0].id : 0;
  useEffect(() => {
    if (!newest || (notices && newest <= (notices.seen | 0))) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    markNoticesSeen(newest);
  }, [newest]);
  const known = new Set((instances || []).map((i) => i && i.name));
  const nowMs = Date.now();
  return html`<div data-effect-panel="notices" class="panel p-notices">
    <${PanelHeader} title=${tn("title")} sub=${tn("sub")} />
    <div data-trust="panel-content" class="panel-body"><div class="col">
      ${!items.length ? html`<${Empty} icon="bell" title=${tn("empty")} hint=${tn("emptyHint")} />`
        : items.map((n) => html`<article key=${n.id} class=${`n-item notice${n.id > seenAtOpen ? " unread" : ""}${n.kind === "fleet" ? " bad" : ""}`}>
          <span class="n-icon"><${Icon} name=${ICON[n.kind] || "info"} size=${18} /></span>
          <div class="n-body">
            <div class="n-title"><strong>${tn(`kind_${n.kind}`)}${n.instance ? ` · ${n.instance}` : ""}</strong>
              ${n.id > seenAtOpen ? html`<span class="notice-new">${tn("unread")}</span>` : null}
              <span class="n-age" title=${new Date(n.at).toLocaleString()}>${noticeAge(n.at, nowMs)}</span></div>
            <p class="n-detail notice-text">${n.text}</p>
            ${n.instance && known.has(n.instance) ? html`<div class="n-actions"><a class="btn btn-sm btn-ghost" href=${chatPath(n.instance)}>${tn("open")}</a></div>` : null}
          </div>
        </article>`)}
    </div></div>
  </div>`;
}
