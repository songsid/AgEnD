/** Screenshot-only DOM adaptation. No live component or authority change. */
export function renderHeaderRow({scene}) {
 for(const w of document.querySelectorAll(".r2-workspace"))w.classList.add("header-row-workspace");
 for(const pane of document.querySelectorAll(".mock-pane")){
  const heading=pane.querySelector(".panel-title h1");heading.title=heading.textContent;
  const status=pane.querySelector(".panel-sub");
  status.innerHTML='<span class="status" title="閒置" aria-label="閒置"><span class="dot ok" aria-hidden="true"></span><span class="status-text">閒置</span></span>';
  for(const link of pane.querySelectorAll(".inst-switch .seg-item")){
   const label=link.textContent.trim();const svg=link.querySelector("svg");
   const span=document.createElement("span");span.className="r3-tab-label";span.textContent=label;
   link.replaceChildren(svg,span);link.title=label;link.setAttribute("aria-label",label);
   link.setAttribute("aria-current",link.classList.contains("active")?"page":"false");
  }
 }
 if(scene==="narrow360"){
  const pane=document.querySelector(".mock-pane");pane.style.flex="0 0 360px";pane.style.width="360px";
  const h=pane.querySelector("h1");h.textContent="提案助理：比較分割畫面與工作流程";h.title=h.textContent;
 }
}

