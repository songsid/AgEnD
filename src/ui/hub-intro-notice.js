import {html,useEffect,useRef,useState} from "/assets/app-html.js";
import {register,t} from "/assets/app-i18n.js";
register("hubIntroNotice",{
 en:{title:"Agent introductions",body:"Introductions now show for {0} of your agents. Review them.",review:"Review {0}",ack:"Done",failed:"Could not load the introduction notice. Try again.",saveFailed:"Could not dismiss the notice. Try again.",retry:"Try again"},
 "zh-TW":{title:"Agent 自我介紹",body:"你的 {0} 個 Agent 現在會顯示自我介紹，請檢查內容。",review:"檢查 {0}",ack:"完成",failed:"無法載入自我介紹通知，請再試一次。",saveFailed:"無法關閉通知，請再試一次。",retry:"再試一次"}
});
const word=(key,...args)=>t(`hubIntroNotice.${key}`,...args);
export const introNoticeOffered=(session,client)=>session?.features?.includes("agent-intro-defaults-v1")&&client?.agentIntroDefaultsV1===true;
export function IntroNotice({client}){
 const [notice,setNotice]=useState(null),[failed,setFailed]=useState(false),[busy,setBusy]=useState(false),epoch=useRef(0);
 const load=async()=>{const mine=epoch.current;try{const out=await client.introNotice();if(mine!==epoch.current)return;if(!out.ok){setFailed(true);return;}setNotice(out.notice);setFailed(false);}catch{if(mine===epoch.current)setFailed(true);}};
 useEffect(()=>{epoch.current++;void load();return()=>{epoch.current++;};},[client]);
 const ack=async()=>{if(busy)return;const mine=epoch.current;setBusy(true);try{const out=await client.acknowledgeIntroNotice();if(mine!==epoch.current)return;if(out.ok)setNotice(null);else setFailed(true);}catch{if(mine===epoch.current)setFailed(true);}finally{if(mine===epoch.current)setBusy(false);}};
 if(!notice&&!failed)return null;
 return html`<section class="card hub-intro-notice"><h3>${word("title")}</h3>${failed?html`<p class="err" role="alert">${word(notice?"saveFailed":"failed")}</p><button class="btn btn-sm" onClick=${load}>${word("retry")}</button>`:null}${notice?html`<p>${word("body",notice.agents.length)}</p><ul>${notice.agents.map(agent=>html`<li key=${agent.id}><a href=${`/ui/hub/exposures?agent=${encodeURIComponent(agent.id)}`}>${word("review",agent.name)}</a></li>`)}</ul><button class="btn btn-sm" disabled=${busy} onClick=${ack}>${word("ack")}</button>`:null}</section>`;
}
