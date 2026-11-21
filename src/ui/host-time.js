import {lang} from '/assets/app-i18n.js';
/** Shared compact host timestamp: one local 24-hour format on cards and incident updates. */
export function hostTime(value){
 return new Date(value).toLocaleString(lang()==='zh-TW'?'zh-TW':'en-GB',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
}
