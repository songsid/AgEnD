import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { dateTimeText } from "/assets/clock-text.js";
register("hubIntro", {
  en: {title:"Introduction",hint:"One line about what this agent handles. Colleagues can see it. Up to 50 characters.",placeholder:"I handle…",save:"Save introduction",failed:"Could not save the introduction. Try again.",saved:"Saved. The agent can still change it later; this line shows who changed it last.",edit:"Edit",close:"Close",owner:"Last changed by the owner",agent:"Last changed by the agent",default:"From the Fleet description",review:"Colleagues will see this line. Check it and save.",cut:"Your earlier description was longer; only the first 50 characters are shown here.",assistant:"Hub assistant. Answers from this room's chat."},
  "zh-TW": {title:"自我介紹",hint:"用一句話說明這個 Agent 負責什麼，同仁會看到。最多 50 個字。",placeholder:"我負責…",save:"儲存自我介紹",failed:"無法儲存自我介紹，請再試一次。",saved:"已儲存。Agent 之後仍然可以更改；這一行會顯示最後是誰改的。",edit:"編輯",close:"關閉",owner:"最後由擁有者修改",agent:"最後由 Agent 修改",default:"來自 Fleet 說明",review:"同仁會看到這一行，請確認後儲存。",cut:"你之前的說明比較長，這裡只顯示前 50 個字。",assistant:"Hub 提供的助理，根據這個房間的對話回答。"}
});
export const hi=(key,...args)=>t(`hubIntro.${key}`,...args);
const split=value=>[...new Intl.Segmenter(undefined,{granularity:"grapheme"}).segment(String(value??""))].map(v=>v.segment);
export const introCount=value=>split(value).length;
export const introPreview=value=>split(value).slice(0,50).join("");
export function AgentIntroEditor({exposure,client,onSaved=()=>{},embedded=false}){
  const [text,setText]=useState(exposure.intro??""),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  const generation=useRef(0),pending=useRef(false);
  useEffect(()=>{generation.current++;setText(exposure.intro??"");setMessage("");return()=>{generation.current++;};},[exposure.id,exposure.intro,exposure.introAt]);
  const count=introCount(text);
  const save=async event=>{event.preventDefault();if(pending.current||count>50)return;const mine=generation.current;pending.current=true;setBusy(true);setMessage("");let result;
    try{result=await client.saveAgentIntro(exposure.id,exposure.revision,text);}catch{result={ok:false};}
    pending.current=false;if(mine!==generation.current)return;setBusy(false);setMessage(hi(result?.ok?"saved":"failed"));if(result?.ok)onSaved(result);
  };
  const Body=embedded?"div":"form";
  return html`<section class=${embedded?"hub-agent-intro":"card hub-agent-intro"}>${embedded?null:html`<h3>${hi("title")}</h3>`}<${Body} class="form" onSubmit=${embedded?undefined:save}>
    <label class="field"><span>${hi("title")}</span><input value=${text} placeholder=${hi("placeholder")} disabled=${busy} onInput=${e=>setText(e.target.value)} aria-invalid=${count>50?"true":null} /><small class="note">${`${hi("hint")} ${count}/50`}</small></label>
    ${exposure.introBy?html`<p class="note">${hi(exposure.introBy)}${exposure.introAt?html` · <time datetime=${new Date(exposure.introAt).toISOString()}>${dateTimeText(exposure.introAt)}</time>`:null}</p>`:null}
    <div class="field-row"><button type=${embedded?"button":"submit"} onClick=${embedded?save:undefined} class="btn btn-sm btn-primary" disabled=${busy||count>50||text===(exposure.intro??"")}>${hi("save")}</button></div>
    ${message?html`<p role="status">${message}</p>`:null}
  </${Body}></section>`;
}

/** Form-free: the sharing dialog already owns the grant form. */
export function AgentIntroSharingPreview({exposure,client,onSaved=()=>{}}){
 const [editing,setEditing]=useState(false),[saved,setSaved]=useState(null);
 const value={...exposure,...saved},text=value.introBy?value.intro:(value.introDefault??value.intro??"");
 return html`<div class="hub-intro-sharing-preview"><p class="note">${hi("title")}${text?`: ${text}`:""}</p><button type="button" class="btn btn-sm btn-ghost" onClick=${()=>setEditing(!editing)}>${hi(editing?"close":"edit")}</button>
 ${editing?html`<${AgentIntroEditor} embedded=${true} exposure=${{...value,intro:text}} client=${client} onSaved=${result=>{setSaved(result);setEditing(false);onSaved(result);}} />`:null}</div>`;
}
