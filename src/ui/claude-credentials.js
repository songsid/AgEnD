import { ClaudeTokenFetch } from "./claude-setup-token.js";
// Local verified credential management; no credential is read back or persisted by this page.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t, lang } from "/assets/app-i18n.js";
import { showDialog, closeDialog } from "/assets/app-shell.js";
import { Dialog } from "/assets/ui-dialog.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { Icon } from "/assets/ui-icons.js";
import { Skeleton, ErrorState } from "/assets/ui-states.js";
import { toast } from "/assets/ui-toast.js";
import { clockFormat } from "/assets/clock-text.js";
register("claudeCredentials", {
 en: {
  title: "Connect Claude Code", profile: "Account", default: "Default connection",
  help: "What’s this?", method: "Connection method", subscription: "Subscription login", oauth: "Token from setup-token", api: "Anthropic API key",
  subscriptionHint: "Continue to Claude’s official sign-in page.",
  oauthHint: "Paste a subscription token you already obtained with setup-token. This uses your Claude subscription; subscription limits still apply.",
  apiHint: "Create a key in Anthropic Console. API usage is billed separately from a Claude subscription.",
  tokenLabel: "Setup token", apiLabel: "API key", paste: "Paste the credential here", local: "Only on this AgEnD computer, with a verified administrator session.",
  saved: "Stored encrypted. This does not confirm that Anthropic accepts it. No model request is made on Save.",
  runtime: "Same-user access", runtimeHint: "An agent running as the same OS user can still obtain the credential at runtime. Encryption is not isolation.",
  cancel: "Cancel", close: "Close", continue: "Continue to sign in", save: "Save credential", done: "Saved · not verified. No model request was made.",
  usage: "No subscription meters for pasted credentials. Local usage, when available, is an estimate.",
  replace: "Replace credential", replacement: "Replacement keeps this account’s name and assignments. A confirmation lists the agents that must restart. If format or storage checks fail, the earlier credential stays unchanged.",
  remove: "Remove saved credential", removeTitle: "Remove this credential?", removeHint: "The account and conversation stay. Move or stop its agents first. This removes only AgEnD’s copy; revoke the credential at Anthropic to invalidate it elsewhere.",
  verified: "Verified", verifiedAt: "Verified at {0}", needsReplacement: "Needs replacement", requestUnknown: "Unknown · request not confirmed", authHint: "The last request was refused (401/403). Replace the saved credential, then continue normal work.", requestUnknownHint: "The last request could not be confirmed. A connection error does not mean the credential is invalid.",
  tokenTag: "Subscription token", apiTag: "API key · pay as you go", notChecked: "Saved · not verified", restriction: "Open this computer’s local dashboard to paste, replace or remove a credential. Public links are refused, even for a verified administrator."
 },
 "zh-TW": {
  title: "連接 Claude Code", profile: "帳號", default: "預設連接",
  help: "這是什麼？", method: "連接方式", subscription: "訂閱帳號登入", oauth: "貼上 setup-token", api: "貼上 Anthropic API key",
  subscriptionHint: "前往 Claude 官方網站完成登入。",
  oauthHint: "貼上你已透過 setup-token 取得的訂閱 token。這會使用 Claude 訂閱，仍受訂閱額度限制。",
  apiHint: "在 Anthropic Console 建立 API key。API 用量另行計費，不包含在 Claude 訂閱中。",
  tokenLabel: "Setup token", apiLabel: "API key", paste: "在這裡貼上憑證", local: "僅限在這台 AgEnD 電腦，以已驗證的管理員身分操作。",
  saved: "加密儲存不代表 Anthropic 已接受這組憑證。按儲存不會送出模型請求。",
  runtime: "同一使用者的存取範圍", runtimeHint: "以同一個作業系統使用者執行的 Agent，仍可能在執行時取得憑證。加密不代表隔離。",
  cancel: "取消", close: "關閉", continue: "繼續登入", save: "儲存憑證", done: "已儲存・尚未驗證，沒有送出模型請求。",
  usage: "貼上的憑證不顯示訂閱額度表；若有本機用量紀錄，會標明是估計值。",
  replace: "替換憑證", replacement: "替換後保留帳號名稱與 Agent 指派。確認畫面會列出需要重新啟動的 Agent；新憑證若未通過儲存檢查，原憑證保持不變。",
  remove: "移除儲存的憑證", removeTitle: "移除這組憑證？", removeHint: "保留帳號與對話。請先移走或停止使用它的 Agent。這只會移除 AgEnD 的副本；如要讓其他地方也無法使用，請到 Anthropic 撤銷憑證。",
  verified: "已驗證", verifiedAt: "驗證時間：{0}", needsReplacement: "需要替換憑證", requestUnknown: "未知・尚未確認請求", authHint: "上次請求被拒絕，錯誤碼：401/403。請替換儲存的憑證，再繼續原本的工作。", requestUnknownHint: "無法確認上次請求。連線錯誤不代表憑證失效。",
  tokenTag: "訂閱 token", apiTag: "API key · 按量付費", notChecked: "已儲存 · 尚未驗證", restriction: "請在這台電腦的本機儀表板貼上、替換或移除憑證。公開連結一律拒絕，即使已驗證的管理員也一樣。"
 }
});

register("claudeCredentialErrors", {
 en:{local:"Open the local dashboard on the AgEnD computer and verify your administrator session, then try again. Public links cannot manage saved credentials.",inUse:"This account is in use. Wait for its agents to finish, or stop paused sessions, then try again. No credential was changed.",conflict:"This account changed in another session. Reload its connection details and try again.",invalid:"Enter a single-line credential between 16 and 16,384 bytes.",failed:"The credential could not be saved. The previous credential is unchanged; retry from the local dashboard.",read:"Could not read this account’s connection details.",retry:"Retry",restart:"Agents using this account; running agents restart only when idle:",stop:"Agents using this account; running agents stop only when idle:",pending:"Saved, but these agents still need a restart from their page:",confirm:"Save and restart idle agents",removed:"Saved credential removed. The account and conversation remain.",managedPolicy:"Organization-managed Claude settings are not supported."},
 "zh-TW":{local:"請在執行 AgEnD 的電腦開啟本機儀表板、驗證管理員身分後再試。公開連結不能管理保存的憑證。",inUse:"這個帳號正在使用中。請等 Agent 完成工作，或先停止暫停的工作階段後再試；憑證尚未變更。",conflict:"其他工作階段已變更這個帳號。請重新讀取連接資訊後再試。",invalid:"請輸入單行憑證，長度須為 16 至 16,384 位元組。",failed:"無法儲存憑證。原憑證保持不變，請從本機儀表板重試。",read:"無法讀取這個帳號的連接資訊。",retry:"重試",restart:"使用這個帳號的 Agent；執行中的 Agent 只會在空閒時重啟：",stop:"使用這個帳號的 Agent；執行中的 Agent 只會在空閒時停止：",pending:"已儲存，以下 Agent 仍需從各自的頁面重新啟動：",confirm:"儲存並重啟空閒的 Agent",removed:"已移除保存的憑證，帳號與對話仍保留。",managedPolicy:"不支援由組織管理的 Claude 設定。"}
});
export const credentialText=(key,...args)=>t("claudeCredentials."+key,...args);
export function credentialRequestState(metadata){
 if(!metadata?.kind)return "not-connected";
 if(metadata.state==="verified")return typeof metadata.verifiedAt==="string"&&Number.isFinite(Date.parse(metadata.verifiedAt))?"verified":"unknown";
 return ["needs-replacement","unknown"].includes(metadata.state)?metadata.state:"saved-unverified";
}
export function credentialStatusText(metadata){const state=credentialRequestState(metadata);return credentialText(state==="verified"?"verified":state==="needs-replacement"?"needsReplacement":state==="unknown"?"requestUnknown":"notChecked");}
export function credentialVerificationTime(metadata){return credentialRequestState(metadata)==="verified"?credentialText("verifiedAt",clockFormat({year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit"}, lang()==="zh-TW"?"zh-TW":"en").format(new Date(metadata.verifiedAt))):null;}
export function credentialRequestHint(metadata){const state=credentialRequestState(metadata);return state==="needs-replacement"?credentialText("authHint"):state==="unknown"?credentialText("requestUnknownHint"):null;}

const e=key=>t("claudeCredentialErrors."+key);
export const credentialError=code=>{const key=String(code||"").replace(/-/g,"_");return e(["credential_local_verified_required","credential_session_changed","unauthorized","forbidden"].includes(key)?"local":key==="credential_in_use"?"inUse":key==="credential_conflict"?"conflict":key==="credential_invalid"||key==="credential_body_bound"?"invalid":"failed");};
export function credentialHelpUrl(method){return "https://songsid.github.io/AgEnD/"+(lang()==="zh-TW"?"zh-tw/":"")+"docs/claude-credentials/#"+method;}
async function api(profile,method="GET",body){
 const path="/ui/claude-credentials"+(method==="GET"&&profile?"?profile="+encodeURIComponent(profile):"");
 try{const r=await fetch(path,{method,credentials:"same-origin",cache:"no-store",...(body?{headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{})});const result=await r.json();return {ok:r.ok,...result};}
 catch{return {ok:false,error:"credential_unavailable"};}
}
async function loadConnection(profile){
 const result=await api(profile);if(result.ok)return {...result,local:true};
 if(result.error!=="credential_local_verified_required")return result;
 try{const response=await fetch("/ui/accounts",{credentials:"same-origin",cache:"no-store"});if(!response.ok)return result;
  const view=await response.json(),row=view.clis?.find(cli=>cli.backend==="claude-code")?.rows?.find(row=>row.scope?.kind==="host"&&(row.profile||null)===(profile||null));
  if(!row||row.credentialUnavailable)return result;return {ok:true,local:false,credential:row.credential||null};
 }catch{return result;}
}
const changed=()=>window.dispatchEvent(new Event("agend-credentials-changed"));
export function openClaudeCredentials(options){return showDialog(ClaudeCredentialsDialog,options);}
export async function removeClaudeCredential(profile){
 const result=await api(profile);if(!result.ok){toast(credentialError(result.error));return;}
 if(!await confirmDialog({title:credentialText("removeTitle"),message:[profile||credentialText("default"),credentialText("removeHint"),...(result.consumers?.users?.length?[e("stop"),...result.consumers.users]:[])].join("\n\n"),confirmLabel:credentialText("remove"),danger:true}))return;
 const saved=await api(profile,"DELETE",{profile:profile||null,revision:result.credential?.revision||0,confirm:true,...(result.consumers?.users?.length?{restart:true,consumersRevision:result.consumers.revision}:{})});
 if(!saved.ok){toast(credentialError(saved.error));return;}changed();toast(e("removed"),true);
}
export function ClaudeCredentialsDialog({profile,initial="subscription",continueSubscription,onClose}){
 const [method,setMethod]=useState(initial),[read,setRead]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[done,setDone]=useState(false),[pending,setPending]=useState([]),[hasInput,setHasInput]=useState(false),input=useRef(null),active=useRef(true);
 const inputRef=useRef(node=>{if(input.current&&input.current!==node)input.current.value="";input.current=node;});
 const close=()=>{if(input.current)input.current.value="";active.current=false;(onClose||closeDialog)();};
 const load=()=>{setRead(null);void loadConnection(profile).then(result=>{if(active.current)setRead(result);});};
 useEffect(()=>{active.current=true;load();return()=>{active.current=false;if(input.current)input.current.value="";};},[profile]);
 const save=async()=>{
  setError("");if(!read?.ok){setError(credentialError(read?.error));return;}
  if(!read.local){
   // Public/native sign-in retains its existing flow; changing a managed source remains local-only.
   if(method==="subscription"&&read.credential?.source!=="managed"){close();continueSubscription?.();return;}
   setError(e("local"));return;
  }
  const value=input.current?.value||"";
  if(method!=="subscription"&&(!value||/\s/.test(value)||new TextEncoder().encode(value).length<16||new TextEncoder().encode(value).length>16384)){setError(e("invalid"));return;}
  setBusy(true);
  try{
   const consumers=read.consumers;
   if(consumers?.users?.length&&!await confirmDialog({title:d(method==="subscription"?"continue":"replace"),message:[d("replacement"),e("restart"),...consumers.users].join("\n\n"),confirmLabel:e("confirm")}))return;
   if(!active.current)return;
   const result=await api(profile,method==="subscription"?"POST":"PUT",{profile:profile||null,revision:read.credential?.revision||0,...(consumers?.users?.length?{restart:true,consumersRevision:consumers.revision}:{}),...(method==="subscription"?{source:"subscription",confirm:true}:{kind:method==="oauth"?"setup-token":"api-key",value})});
   if(!active.current)return;
   if(!result.ok){setError(credentialError(result.error));return;}
   if(input.current)input.current.value="";setHasInput(false);changed();setPending(result.pending||[]);setRead({...read,ok:true,credential:result.credential});
   if(method==="subscription"){close();continueSubscription?.();}else setDone(true);
  }finally{if(active.current)setBusy(false);}
 };
 const d=credentialText;
 return html`<${Dialog} title=${d(initial==="subscription"?"title":"replace")} cls="credential-dialog" busy=${busy} onClose=${close} actions=${html`<button type="button" class="btn" disabled=${busy} onClick=${close}>${d(done?"close":"cancel")}</button><button type="button" class="btn btn-primary" disabled=${busy||!read?.ok||done||(method!=="subscription"&&(!hasInput||!read.local))} onClick=${save}>${d(method==="subscription"?"continue":"save")}</button>`}>
 <p><strong>${d("profile")}: ${profile||d("default")}</strong></p>
 <fieldset class="field" disabled=${busy}><legend>${d("method")}</legend><div class="checks">${["subscription","oauth","api"].map(kind=>html`<div class="credential-method-row"><label class="check"><input type="radio" name="claude-credential-method" value=${kind} checked=${method===kind} onChange=${()=>{if(input.current)input.current.value="";setMethod(kind);setHasInput(false);setDone(false);setError("");}} /><span>${d(kind)}</span></label><a class="btn btn-ghost credential-help" data-trust="navigation" href=${credentialHelpUrl(kind)} target="_blank" rel="noopener noreferrer">${d("help")}<${Icon} name="external" size=${14} /></a></div>`)}</div></fieldset>
 <p>${d(method+"Hint")}</p>
 ${!read?html`<${Skeleton} variant="rows" lines=${2} />`:!read.ok?html`<${ErrorState} title=${e("read")} message=${["credential_unavailable"].includes(read.error)?e("read"):credentialError(read.error)} onRetry=${load} />`:null}
 ${method==="oauth"?html`<${ClaudeTokenFetch} key=${profile?"profile:"+profile:"default"} profile=${profile} read=${read} onBusy=${setBusy} onSaved=${result=>{if(input.current)input.current.value="";setHasInput(false);changed();setRead({...read,credential:result.credential});setPending(result.pending||[]);setDone(true);}} />`:null}
 ${method!=="subscription"?html`<div class="field"><label for="claudeCredentialSecret">${d(method==="oauth"?"tokenLabel":"apiLabel")}</label><input ref=${inputRef.current} id="claudeCredentialSecret" type="password" onInput=${event=>setHasInput(!!event.target.value)} disabled=${busy||done||!read?.ok||!read.local} autocomplete="off" spellcheck=${false} placeholder=${d("paste")} /><p class="note">${d("saved")}</p></div><p class="note">${read?.local?d("local"):e("local")}</p>${initial!=="subscription"?html`<p class="note">${d("replacement")}</p>`:null}<details class="credential-disclosure"><summary><span>${d("runtime")}</span><${Icon} name="chevron" size=${16} /></summary><p class="note">${d("runtimeHint")}</p></details>`:null}
 <p class="note credential-managed-policy">${e("managedPolicy")}</p>
 ${pending.length?html`<p role="status" class="note">${e("pending")} ${pending.join(", ")}</p>`:null}
 ${error?html`<p role="alert" class="err">${error}</p>`:null}${done?html`<p role="status">${d("done")}</p>`:null}
 </${Dialog}>`;
}
