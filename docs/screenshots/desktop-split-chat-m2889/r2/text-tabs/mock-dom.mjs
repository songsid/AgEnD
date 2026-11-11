/** Design only. Clone the real InstanceSwitch and original tools; never substitute tab icons. */
export function renderTextTabs({scene,headHTML,pageMenuHTML,agentIds}){
 const panes=[...document.querySelectorAll(".mock-pane")];
 if(scene==="narrow360"){
  panes[0].style.flex="0 0 360px";panes[0].style.width="360px";
  panes.forEach((p,i)=>p.classList.toggle("is-focused",i===0));
  const rows=[...document.querySelectorAll(".sidebar a.inst")].filter(x=>x.querySelector(".inst-name"));
  rows.forEach((x,i)=>x.classList.toggle("active",i===1));
 }
 const windows=[...document.querySelectorAll(".shell")];
 for(const w of document.querySelectorAll(".r2-workspace"))w.classList.add("text-tabs-workspace");
 for(const [i,pane] of panes.entries()){
  const ownWindow=pane.closest(".shell"),ownPanes=[...ownWindow.querySelectorAll(".mock-pane")];
  const focused=ownPanes.length===1||pane.classList.contains("is-focused");
  const savedHead=pane.querySelector(".panel-head");
  const split=savedHead.querySelector(".r2-split").cloneNode(true),close=savedHead.querySelector(".r2-close").cloneNode(true);
  const head=new DOMParser().parseFromString(headHTML,"text/html").body.firstElementChild;
  const title=head.querySelector(".panel-title"),h=title.querySelector("h1");
  h.textContent=i?"審查助理":"提案助理";
  if(scene==="narrow360"&&!i)h.textContent="提案助理：比較分割畫面與工作流程";
  h.title=h.textContent;
  title.querySelector(".panel-sub").innerHTML='<span class="status" title="閒置"><span class="dot ok" aria-hidden="true"></span><span>閒置</span></span>';
  const nav=head.querySelector(".inst-switch"),links=[...nav.querySelectorAll(".seg-item")];
  const current=pane.classList.contains("r2-log-pane")?2:0;
  links.forEach((link,j)=>{
   link.classList.toggle("active",j===current);
   if(j===current)link.setAttribute("aria-current","page");else link.removeAttribute("aria-current");
   link.dataset.originalIndex=String(j);
   const url=new URL(link.href,location.href),parts=url.pathname.split("/");
   parts[parts.length-1]=encodeURIComponent(agentIds[i]);url.pathname=parts.join("/");link.href=url.pathname+url.search;
  });
  const actions=head.querySelector(".panel-actions");
  const shared=document.createElement("div");shared.className="page-shared-tools";
  if(focused){
   shared.dataset.owner=h.textContent;
   for(const q of [".chat-card-menu",".hd-text",".hd-usage"]){
    const node=actions.querySelector(q);if(!node)throw Error("Missing original shared control "+q);
    shared.append(node);
   }
  }
  const originalMore=[...actions.querySelectorAll(":scope > .menu")].filter(x=>!x.classList.contains("chat-card-menu")).at(-1);
  if(!originalMore)throw Error("Missing original page menu");
  const more=originalMore.cloneNode(true);more.classList.add("pane-more");
  more.dataset.pageMenu=String(focused);
  more.querySelector(".menu-list")?.remove();
  const local=document.createElement("div");local.className="pane-actions";local.append(split,more,close);
  actions.replaceChildren(...(focused?[shared,local]:[local]));
  savedHead.replaceWith(head);
  const ids=new Map();
  head.querySelectorAll("[id]").forEach(e=>{const old=e.id,next="text-"+i+"-"+old;ids.set(old,next);e.id=next;});
  head.querySelectorAll("[for],[aria-controls],[aria-labelledby]").forEach(e=>{for(const k of ["for","aria-controls","aria-labelledby"])if(e.hasAttribute(k))e.setAttribute(k,e.getAttribute(k).split(" ").map(v=>ids.get(v)||v).join(" "));});
  // Let the title shrink to its minimum before moving any trailing inactive tab.
  const hidden=[];
  while(head.scrollWidth>head.clientWidth+1){
   const candidate=[...links].reverse().find(link=>!link.hidden&&!link.classList.contains("active"));
   if(!candidate)throw Error("Current text tab and controls cannot fit");
   candidate.hidden=true;hidden.push(candidate);
  }
  pane.dataset.hiddenTabs=JSON.stringify(links.filter(x=>x.hidden).map(x=>x.textContent));
  if(scene==="narrow360"&&!i){
   const list=document.createElement("div");list.className="menu-list";list.setAttribute("role","menu");
   const heading=document.createElement("div");heading.className="menu-heading";heading.textContent="此窗格 · 分頁";list.append(heading);
   for(const link of links.filter(x=>x.hidden)){
    const item=document.createElement("button");item.type="button";item.className="menu-item";item.setAttribute("role","menuitem");item.textContent=link.textContent;item.dataset.overflowTab=link.textContent;list.append(item);
   }
   const layout=document.createElement("div");layout.className="menu-heading";layout.textContent="此窗格 · 排列";list.append(layout);
   for(const label of ["左右並排","上下排列","交換位置","自訂移動","彈出成獨立視窗"]){const b=document.createElement("button");b.className="menu-item";b.textContent=label;list.append(b);}
   const original=new DOMParser().parseFromString(pageMenuHTML,"text/html").body.firstElementChild;
   const scope=document.createElement("div");scope.className="menu-heading";scope.textContent="目前 Agent · 原有操作";list.append(scope,...original.children);
   more.append(list);more.querySelector("button").setAttribute("aria-expanded","true");
  }
 }
 const active=document.querySelector(".text-tabs-workspace .mock-pane.is-focused h1");
 if(scene==="narrow360")document.querySelector(".sidebar a.inst.active .inst-name").textContent=active.textContent;
}

