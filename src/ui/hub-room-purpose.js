import {html,useState} from "/assets/app-html.js";
import {register,t} from "/assets/app-i18n.js";
import {Dialog} from "/assets/ui-dialog.js";
register("hubRoomPurpose",{
 en:{title:"Purpose",hint:"One line on what this room is for. Members see it, and agents asked here are told.",placeholder:"For example: release questions for the web team",add:"Add a purpose",tooLong:"Use 200 characters or fewer.",close:"Close",edit:"Edit"},
 "zh-TW":{title:"用途",hint:"用一句話說明這個房間做什麼。成員看得到，在這裡被問的 Agent 也會知道。",placeholder:"例如：網頁組的發版問題",add:"新增用途",tooLong:"最多 200 個字。",close:"關閉",edit:"編輯"}
});
export const rp=(key,...args)=>t(`hubRoomPurpose.${key}`,...args);
export const purposeCount=value=>[...new Intl.Segmenter(undefined,{granularity:"grapheme"}).segment(String(value??""))].length;
export function RoomPurposeField({id="hubRoomPurpose",value="",onValue,disabled=false}){
 const count=purposeCount(value);
 return html`<label class="field hub-room-purpose-field" for=${id}><span>${rp("title")}</span><input id=${id} value=${value} placeholder=${rp("placeholder")} disabled=${disabled} aria-invalid=${count>200?"true":null} aria-describedby=${`${id}Hint`} onInput=${e=>onValue(e.target.value)} /><small class="note" id=${`${id}Hint`}>${`${rp("hint")} ${count}/200`}</small>${count>200?html`<small class="err" role="alert">${rp("tooLong")}</small>`:null}</label>`;
}
export function RoomPurposeHeader({purpose="",onEdit}){
 const [open,setOpen]=useState(false);
 if(!purpose)return onEdit?html`<button type="button" class="hub-room-purpose-trigger" onClick=${onEdit}>${rp("add")}</button>`:null;
 return html`<button type="button" class="hub-room-purpose-trigger" title=${purpose} aria-haspopup="dialog" aria-expanded=${open?"true":"false"} aria-label=${`${rp("title")}: ${purpose}`} onClick=${()=>setOpen(true)}>${purpose}</button>
 ${open?html`<${Dialog} title=${rp("title")} onClose=${()=>setOpen(false)} actions=${html`<button type="button" class="btn" onClick=${()=>setOpen(false)}>${rp("close")}</button>`}><p class="hub-room-purpose-full">${purpose}</p></${Dialog}>`:null}`;
}

/**
 * M-3533 H1 (the user's approved r3, design §2.1a): the room's purpose as the strip under the header that an agent's chat
 * page uses for its identity card (`.chat-card` with `.id-card.card-c`): the room's square picture, "Purpose" and the text
 * beside it, wrapping as it needs; a manager has Edit at its right. No purpose: a manager sees the card with "Add a purpose";
 * a member sees no card. The same card on a phone, where the purpose was only in the members sheet before.
 */
export function RoomPurposeCard({initial="?",purpose="",onEdit}){
 if(!purpose&&!onEdit)return null;
 return html`<div class="chat-card open hub-room-card" data-trust="panel-content"><section class="id-card card-c" aria-label=${rp("title")}><div class="id-row">
  <span class="av av-square hub-room-card-av" aria-hidden="true"><span class="av-text">${initial}</span></span>
  <div class="id-text"><p class="id-tagline">${rp("title")}</p>${purpose?html`<p class="id-bio">${purpose}</p>`:null}</div>
  ${/* The card's one action is the same button with or without a purpose: Edit, or Add a purpose (Lumen, #4349). */ ""}
  ${onEdit?html`<button type="button" class=${`btn btn-sm hub-room-card-edit${purpose?"":" hub-room-card-add"}`} onClick=${onEdit}>${purpose?rp("edit"):rp("add")}</button>`:null}
 </div></section></div>`;
}
