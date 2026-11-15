/** Exact owner/exposure suggestions; the server re-resolves the selected immutable identity at commit. */
import { html, useEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { Dialog } from "/assets/ui-dialog.js";
import { SubjectPicker } from "./hub-subject-picker.js";
import { hubClient } from "./hub-client.js";
register("hubGrantPicker", {
  en: {
    title: "Allow access to {0}", kind: "Allow", person: "A person", group: "An AD security group", team: "A team", teamPick: "Choose a team", teamHint: "The team's current members may ask. Removing someone from the team ends that permission. The grant's expiry keeps running.", findPerson: "Find a person", query: "Name or login", hint: "Type 2 to 64 characters.",
    searching: "Searching…", none: "No matching people. Try more of their name or login.", more: "More people match. Type more of the name.", pick: "Choose {0}", choose: "Choose", change: "Choose someone else",
    failed: "The directory could not be searched just now. Try again.", unsupported: "This directory does not support that search.", limited: "Too many searches. Try again shortly.", retry: "Search again",
    days: "Access lasts", day: "{0} days", expiry: "Choose up to 90 days. Access expires automatically; removing the grant also ends access to its chats.",
    groupHint: "Direct members are checked again for every action. Nested and primary groups are not included. Whoever manages this AD group can change who may ask. Each person has a private chat.",
    save: "Allow", cancel: "Cancel", refused: "The selected person or group changed or is no longer available. Search and choose again.", saveFailed: "Access could not be saved. Check the current agent and try again.",
  },
  "zh-TW": {
    title: "允許向 {0} 提問", kind: "允許對象", person: "個人", group: "AD 安全性群組", team: "團隊", teamPick: "選擇團隊", teamHint: "依團隊目前的成員允許提問；成員離開團隊後就不再適用這份權限，授權的到期時間照常計算。", findPerson: "尋找同仁", query: "姓名或登入帳號", hint: "請輸入 2 到 64 個字。",
    searching: "搜尋中…", none: "找不到符合的同仁。請多輸入幾個姓名或帳號的字。", more: "還有更多同仁符合，請多輸入幾個字。", pick: "選擇 {0}", choose: "選擇", change: "重新選擇對象",
    failed: "目前無法搜尋目錄，請再試一次。", unsupported: "這個目錄不支援這項搜尋。", limited: "搜尋太多次了，請稍後再試。", retry: "重新搜尋",
    days: "允許多久", day: "{0} 天", expiry: "最長 90 天，到期自動失效；移除授權也會結束其聊天存取權。",
    groupHint: "每次操作都會重新檢查直接成員，不含巢狀或主要群組。能管理這個 AD 群組的人，也能改變誰可以提問。每個人都有自己的私人對話。",
    save: "允許提問", cancel: "取消", refused: "選取的同仁或群組已變更或無法使用，請重新搜尋選擇。", saveFailed: "無法儲存授權，請確認目前的 Agent 後再試。",
  },
});
const g = (key, ...args) => t(`hubGrantPicker.${key}`, ...args);
/** Fresh lazy picker rules must not depend on the shell's retained app.css. */
export function linkHubGrantPickerCss(doc = typeof document !== "undefined" ? document : null) {
  try {
    if (!doc?.head || doc.querySelector('link[data-hub-grant-picker-css="1"]')) return;
    const link = doc.createElement("link");
    link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/hub-grant-picker.css"); link.setAttribute("data-hub-grant-picker-css", "1");
    doc.head.appendChild(link);
  } catch { /* The form's existing controls still work if the stylesheet cannot be linked. */ }
}
export function HubGrantPicker({ x, client, act, onClose }) {
  const [kind, setKind] = useState("person"), [selected, setSelected] = useState(null), [days, setDays] = useState(7), [busy, setBusy] = useState(false), [error, setError] = useState(null), [unsupported, setUnsupported] = useState(false);
  const life = useRef(0), writing = useRef(false), controllers = useRef(new Set());
  const search = useMemo(() => async (kind, q) => {
    const controller = new AbortController(); for (const old of controllers.current) old.abort(); controllers.current.add(controller);
    const timer = setTimeout(() => controller.abort(), 10_000);
    try { return await client.searchGrantSubjects(x.id, x.revision, kind, q, controller.signal); }
    finally { clearTimeout(timer); controllers.current.delete(controller); }
  }, [client, x.id, x.revision]);
  useEffect(() => {
    linkHubGrantPickerCss();
    const mine = life.current;
    const end = client.onSignedOut?.(() => { if (life.current === mine) { life.current++; onClose(); } });
    return () => { life.current++; end?.(); for (const c of controllers.current) c.abort(); controllers.current.clear(); };
  }, [client, x.id, x.revision]);
  const change = () => { setSelected(null); setError(null); setUnsupported(false); };
  const submit = async event => {
    event?.preventDefault?.(); if (writing.current || !selected || client !== hubClient()) return;
    writing.current = true; setBusy(true); setError(null); const mine = life.current;
    const subject = kind === "team" ? { kind: "team", teamId: selected.id } : kind === "group" ? { kind: "group", group: { realm: selected.realm, objectId: selected.objectId }, dn: selected.dn }
      : { kind: "person", person: { ...selected.person } };
    const input = { exposureId: x.id, exposureRevision: x.revision, days, subject, ...(kind === "person" ? { login: selected.login } : {}) };
    try {
      const out = await act(() => client.grant(input), undefined, () => { if (mine === life.current) setError(g("refused")); });
      if (mine === life.current && client === hubClient()) { if (out?.ok) onClose(); else setError(g("refused")); }
    } catch { if (mine === life.current) setError(g("saveFailed")); }
    finally { if (mine === life.current) { writing.current = false; setBusy(false); } }
  };
  return html`<${Dialog} title=${g("title", x.displayName)} onClose=${onClose} actions=${html`<button type="button" class="btn" onClick=${onClose}>${g("cancel")}</button><button type="button" class="btn btn-primary" disabled=${busy || !selected} onClick=${submit}>${g("save")}</button>`}>
    <form class="form hub-grant" data-grant-picker onSubmit=${submit}>
      ${error ? html`<p class="err" role="alert">${error}</p>` : null}
      <${SubjectPicker} client=${client} search=${search} kind=${kind} onKind=${next => { change(); setKind(next); }} selected=${selected} onClear=${change}
        disabled=${busy} id="hubGrant" label=${g("kind")} onUnsupported=${() => setUnsupported(true)} onPick=${(type, row) => setSelected(type === "group" ? { ...row, realm: x.owner?.realm || "" } : row)} />
      ${unsupported ? html`<p class="err" role="status">${g("unsupported")}</p>` : null}
      ${kind === "group" ? html`<p class="note">${g("groupHint")}</p>` : null}
      ${kind === "team" ? html`<p class="note">${g("teamHint")}</p>` : null}
      <label class="field"><span>${g("days")}</span><select data-grant-days value=${String(days)} disabled=${busy} onChange=${e => setDays(Number(e.target.value))}>${[1, 7, 30, 90].map(d => html`<option value=${String(d)}>${g("day", d)}</option>`)}</select></label>
      <p class="note">${g("expiry")}</p>
    </form>
  </${Dialog}>`;
}
