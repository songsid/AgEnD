// Safe Connect-account views only. The token never reaches this module.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { confirmDialog } from "/assets/ui-confirm.js";
register("claudeTokenFetch",{
 en:{unsupported:"This Claude sign-in step is not supported by the helper. Run claude setup-token on your own computer and paste the token below.",get:"Get a token for me",paste:"Or paste a setup-token below",hint:"AgEnD opens a private sign-in session. Sign in on Claude’s website; the token goes straight into encrypted storage and is never displayed.",open:"Open sign-in page",code:"Authorization code",submit:"Submit authorization code",cancel:"Cancel connecting",waiting:"Waiting for Claude’s sign-in page…",working:"Waiting for you to finish signing in…",done:"Token saved. No model request was made.",failed:"The token could not be confirmed saved. Read the account status before retrying here or pasting a token below.",expired:"Sign-in timed out after 10 minutes. Retry here or paste a token below.",revoked:"Your verified session changed. Open this computer’s local dashboard, verify again, and retry.",cleanup:"The private session could not be confirmed closed. Ask the host operator to check it before reconnecting.",confirm:"Get a token and replace the saved credential?",restart:"After sign-in, agents using this account restart only when idle:",go:"Continue",pending:"Saved; these agents still need a restart:"},
 "zh-TW":{unsupported:"這個 Claude 登入步驟尚不支援。請在自己的電腦執行 claude setup-token，再把 Token 貼到下方。",get:"幫我取得 Token",paste:"或在下方貼上 setup-token",hint:"AgEnD 會開啟私密登入工作階段。請在 Claude 網站登入；Token 會直接加密保存，不會顯示出來。",open:"開啟登入頁面",code:"授權碼",submit:"送出授權碼",cancel:"取消連接",waiting:"正在等候 Claude 登入頁面…",working:"正在等你完成登入…",done:"Token 已儲存，沒有發出模型請求。",failed:"無法確認 Token 是否已儲存。請先讀取帳號狀態，再在這裡重試或在下方貼上 Token。",expired:"登入已超過 10 分鐘。請重試，或在下方貼上 Token。",revoked:"已驗證的工作階段已變更。請在這台電腦開啟本機儀表板，重新驗證後再試。",cleanup:"無法確認私密工作階段已關閉。請先請主機操作者檢查，再重新連接。",confirm:"要取得 Token 並取代保存的憑證嗎？",restart:"登入後，使用這個帳號的 Agent 只會在空閒時重啟：",go:"繼續",pending:"已儲存，以下 Agent 仍需重啟："}
});
const text=k=>t("claudeTokenFetch."+k);
async function request(body){try{const r=await fetch("/ui/claude-credentials/setup-token",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const value=await r.json();return r.ok?value:{error:value.error||"credential_unavailable"};}catch{return {error:"credential_unavailable"};}}
export function ClaudeTokenFetch({profile,read,onBusy,onSaved}){
 const [run,setRun]=useState(null),[error,setError]=useState(""),[starting,setStarting]=useState(false);
 const current=useRef(null),alive=useRef(true),input=useRef(null),owned=useRef(null),pending=useRef(false);
 const ongoing=run&&!["done","failed"].includes(run.login.phase);
 const receive=value=>{if(!alive.current)return;if(value.error){setError(value.error.includes("session")||value.error.includes("verified")?"revoked":"failed");onBusy?.(false);setRun(previous=>previous?{...previous,login:{...previous.login,phase:"failed"}}:null);return;}current.current=value;setRun(value);if(value.login.phase==="done"){owned.current=null;onSaved?.(value);}if(value.login.phase==="done"||value.login.phase==="failed")onBusy?.(false);};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(input.current)input.current.value="";const id=owned.current;if(id)void request({operation:"cancel",id});onBusy?.(false);};},[]);
 useEffect(()=>{if(!ongoing)return;let stopped=false;const timer=setInterval(()=>{if(pending.current)return;pending.current=true;void request({operation:"read",id:run.login.id}).then(value=>{if(!stopped)receive(value);}).finally(()=>{pending.current=false;});},500);return()=>{stopped=true;clearInterval(timer);};},[ongoing,run?.login.id]);
 const start=async()=>{setError("");if(!read?.ok||!read.local)return;setStarting(true);try{
  const consumers=read.consumers;
  if(consumers?.users?.length&&!await confirmDialog({title:text("confirm"),message:[text("restart"),...consumers.users].join("\n\n"),confirmLabel:text("go")}))return;
  if(!alive.current)return;onBusy?.(true);
  const result=await request({operation:"start",profile:profile||null,revision:read.credential?.revision||0,...(consumers?.users?.length?{restart:true,consumersRevision:consumers.revision}:{})});
  if(result.started)owned.current=result.started;
  if(!alive.current){if(result.started)void request({operation:"cancel",id:result.started});return;}
  if(result.error)onBusy?.(false);receive(result);
 }finally{if(alive.current)setStarting(false);}};
 const cancel=async()=>{const id=owned.current||current.current?.login?.id;if(!id)return;owned.current=null;receive(await request({operation:"cancel",id}));};
 const submit=async()=>{const value=input.current?.value||"";if(!value||!current.current)return;const login=current.current.login;const result=await request({operation:"input",id:login.id,revision:login.revision,action:{kind:"code",value}});if(input.current)input.current.value="";receive(result);};
 const login=run?.login,reason=login?.reason,fail=reason==="unsupported_prompt"?"unsupported":reason==="expired"?"expired":reason==="revoked"?"revoked":reason==="cleanup_failed"?"cleanup":"failed";
 return html`<section class="field credential-token-fetch"><button type="button" class="btn" disabled=${starting||ongoing||!read?.ok||!read.local} onClick=${start}>${text("get")}</button><p class="note">${text("hint")}</p>
 ${ongoing?html`<p role="status">${text(login.url?"working":"waiting")}</p>${login.url?html`<a class="btn btn-primary" data-trust="navigation" href=${login.url} target="_blank" rel="noopener noreferrer">${text("open")}</a>`:null}
 ${login.phase==="code"&&login.canAct?html`<div class="field"><label for="claudeSetupTokenCode">${text("code")}</label><input ref=${input} id="claudeSetupTokenCode" type="password" autocomplete="off" spellcheck=${false} /><button type="button" class="btn" onClick=${submit}>${text("submit")}</button></div>`:null}
 <button type="button" class="btn danger" onClick=${cancel}>${text("cancel")}</button>`:null}
 ${error||login?.phase==="failed"?html`<p role="alert" class="err">${text(error||fail)}</p>`:null}${login?.phase==="done"?html`<p role="status">${text("done")}</p>`:null}
 ${run?.pending?.length?html`<p class="note">${text("pending")} ${run.pending.join(", ")}</p>`:null}<p class="note">${text("paste")}</p></section>`;
}
