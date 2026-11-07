import { Skeleton } from "/assets/ui-states.js";
// Host-owner Settings only. Own the copy here so an open tab's older Settings strings still work.
import { html, useEffect, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { api, confirmedWrite } from "./settings-confirm.js";
register("hubRetention", {
  en: {
    title: "Hub record retention", content: "Question and answer content (days)", events: "Event records (days)",
    hint: "Choose 1–3650 days. Shorter periods can permanently remove older records at the next daily cleanup. Increasing a period does not restore deleted records.",
    save: "Save retention", saved: "Retention saved.", failed: "Retention could not be saved. Reload and try again.",
    conflict: "Retention changed while this page was open. Reload before saving.", unavailable: "Start the initialized Hub to view or change retention.",
  },
  "zh-TW": {
    title: "Hub 紀錄保留期間", content: "提問與回答內容（天）", events: "事件紀錄（天）",
    hint: "請選擇 1 到 3650 天。縮短天數後，下次每日清理可能永久刪除較早的紀錄；延長天數無法還原已刪除的紀錄。",
    save: "儲存保留期間", saved: "已儲存保留期間。", failed: "無法儲存保留期間。請重新整理後再試。",
    conflict: "這個頁面開啟期間，保留設定已變更。請重新整理後再儲存。", unavailable: "請先啟動已初始化的 Hub，再查看或修改保留期間。",
  },
});
const copy = key => t(`hubRetention.${key}`);
export function HubRetentionSettings() {
  const [policy, setPolicy] = useState(null), [content, setContent] = useState(""), [events, setEvents] = useState("");
  const [busy, setBusy] = useState(false), [messageKey, setMessageKey] = useState("");
  useEffect(() => {
    let live = true;
    api("/api/settings/hub/retention").then(r => {
      if (!live) return;
      if (r.ok && r.body?.policy) { setPolicy(r.body.policy); setContent(String(r.body.policy.contentDays)); setEvents(String(r.body.policy.eventDays)); }
      else setMessageKey("unavailable");
    }, () => { if (live) setMessageKey("unavailable"); });
    return () => { live = false; };
  }, []);
  const valid = value => /^\d{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= 3650;
  const save = async e => {
    e.preventDefault();
    if (!policy || busy || !valid(content) || !valid(events)) return;
    setBusy(true); setMessageKey("");
    try {
      const r = await confirmedWrite("/api/settings/hub/retention", { method: "PUT", label: copy("title"),
        body: { contentDays: Number(content), eventDays: Number(events), revision: policy.revision } });
      if (r.ok && r.body?.policy) { setPolicy(r.body.policy); setMessageKey("saved"); }
      else setMessageKey(r.body?.error === "conflict" ? "conflict" : "failed");
    } catch { setMessageKey("failed"); } finally { setBusy(false); }
  };
  return html`<section class="card hub-retention"><h3>${copy("title")}</h3>
    <p class="note">${copy("hint")}</p>
    ${!policy && !messageKey ? html`<${Skeleton} variant="form" lines=${4} />` : null}
    ${policy ? html`<form class="form" onSubmit=${save}><div class="grid2">
      <label class="field">${copy("content")}<input type="number" min="1" max="3650" step="1" value=${content} disabled=${busy} onInput=${e => setContent(e.target.value)} /></label>
      <label class="field">${copy("events")}<input type="number" min="1" max="3650" step="1" value=${events} disabled=${busy} onInput=${e => setEvents(e.target.value)} /></label>
    </div><button class="btn" type="submit" disabled=${busy || !valid(content) || !valid(events)}>${copy("save")}</button></form>` : null}
    ${messageKey ? html`<p role="status">${copy(messageKey)}</p>` : null}
  </section>`;
}
