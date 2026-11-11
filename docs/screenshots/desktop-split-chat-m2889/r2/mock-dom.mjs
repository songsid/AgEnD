/** Static r2 overlay. All input is fixture/design data, passed as evaluate arguments. */
export function renderR2({scene, headHTML, logHTML, tabIcons}) {
  const single = scene === "single" || scene === "sidebar";
  let shell = document.querySelector(".shell");
  if (single) { const clone=shell.cloneNode(true); shell.replaceWith(clone); shell=clone; }
  shell.querySelectorAll(".mock-toolbar,.mock-popup,.mock-instruction,.mock-drag-shade").forEach(e=>e.remove());
  const rows=[...shell.querySelectorAll("a.inst")].filter(e=>e.querySelector(".inst-name"));
  rows.forEach((r,i)=>{
    const names=["General","提案助理","審查助理","文件助理"];
    r.querySelector(".inst-name").textContent=names[i]||"文件助理";
    r.classList.toggle("active",i===(single?1:2));
  });
  const icon=(name)=>{
    const paths={split:"M3 4h18v16H3zM13 4v16",more:"M5 12h.01M12 12h.01M19 12h.01",close:"M6 6l12 12M18 6 6 18"};
    return '<svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="'+paths[name]+'"/></svg>';
  };
  const makeButton=(name,label)=>{
    const e=document.createElement("button");e.className="icon-btn r2-"+name;e.innerHTML=icon(name);e.setAttribute("aria-label",label);e.title=label;return e;
  };
  if (single) {
    shell.querySelector(".panel-title h1").textContent="提案助理";
  } else {
    shell.querySelector(".mock-workspace").classList.add("r2-workspace");
    shell.querySelectorAll(".mock-pane").forEach((pane,i)=>{
      const parsed=new DOMParser().parseFromString(headHTML,"text/html").body.firstElementChild;
      const title=parsed.querySelector(".panel-title");
      title.querySelector("h1").textContent=i?"審查助理":"提案助理";
      title.querySelector(".panel-sub").innerHTML='<span class="status"><span class="dot ok"></span>閒置</span>';
      if (i) {const focus=document.createElement("span");focus.className="r2-focus";focus.textContent="目前";title.append(focus);}
      const nav=parsed.querySelector(".inst-switch");
      nav.replaceChildren();
      [["chat","聊天"],["view","視窗"],["log","紀錄"],["details","設定"]].forEach(([id,label])=>{
        const a=document.createElement("a"); a.className="seg-item"+(id===(scene==="log"&&!i?"log":"chat")?" active":"");
        a.innerHTML=tabIcons[id];a.append(document.createTextNode(label));a.setAttribute("data-label",label);a.href="#";nav.append(a);
      });
      const actions=parsed.querySelector(".panel-actions");actions.replaceChildren(makeButton("split","在右側分割；Alt＋點向下"),makeButton("more","窗格排列"),makeButton("close","收起此格"));
      pane.querySelector(".panel-head").replaceWith(parsed);
      pane.classList.toggle("is-focused",i===1);
      if (scene==="log"&&!i) {
        const log=new DOMParser().parseFromString(logHTML,"text/html").body.firstElementChild;
        log.querySelector(".panel-head")?.remove();
        pane.querySelector(".chat-split").replaceWith(...log.children);
        pane.classList.add("r2-log-pane","p-log");
        const body=pane.querySelector(".log-col");
        body.innerHTML='<p class="note log-start">目前可讀紀錄的開頭。</p>';
        const list=document.createElement("ol");list.className="log-list";
        [["14:30","你提出的要求","比較兩個方案，整理成可轉貼的重點。"],["14:31","讀取 · 提案.md","已讀取設計提案與現有 app shell。"],["14:32","搜尋 · 窗格所有權","找到共用 stream、各 Agent 草稿與預覽清理的接點。"],["14:33","回覆","先限制兩個不同 Agent，各自保留四個分頁。"]].forEach(([time,label,text])=>{
          const li=document.createElement("li");li.className="log-item k-assistant"; const head=document.createElement("div");head.className="log-head";
          const l=document.createElement("span");l.className="log-label";l.textContent=label;const g=document.createElement("span");g.className="grow";const t=document.createElement("span");t.className="log-time";t.textContent=time;head.append(l,g,t);
          const content=document.createElement("div");content.className="log-text";content.textContent=text;li.append(head,content);list.append(li);
        });body.append(list);
      }
      const ids=new Map();
      pane.querySelectorAll("[id]").forEach(e=>{const old=e.id,next="r2-"+i+"-"+old;ids.set(old,next);e.id=next;});
      pane.querySelectorAll("[for],[aria-controls],[aria-labelledby]").forEach(e=>{
        for(const key of ["for","aria-controls","aria-labelledby"])if(e.hasAttribute(key))e.setAttribute(key,e.getAttribute(key).split(" ").map(v=>ids.get(v)||v).join(" "));
      });
    });
  }
  if (scene==="sidebar") {
    const li=rows[2].closest("li"); li.querySelector(".inst-gear")?.remove();
    const button=document.createElement("button");button.className="icon-btn r2-sidebar-more";button.textContent="⋯";li.append(button);
    const menu=document.createElement("div");menu.className="mock-popup r2-sidebar-popup";
    menu.innerHTML='<div class="mock-popup-title">審查助理</div><button>開啟對話</button><button class="is-highlight">◫　在旁邊開啟</button>';
    shell.append(menu);const a=button.getBoundingClientRect();menu.style.left=(a.left-160)+"px";menu.style.top=(a.bottom+4)+"px";
  }
  if(scene==="menu"||scene==="header") {
    const pane=shell.querySelectorAll(".mock-pane")[1], anchor=pane.querySelector(".r2-"+(scene==="menu"?"more":"split"));
    const menu=document.createElement("div");menu.className="mock-popup r2-layout-popup";
    if(scene==="menu") menu.innerHTML='<div class="mock-popup-title">審查助理 · 窗格排列</div><button>◫　左右並排 <span>✓</span></button><button>⬒　上下排列</button><button>⇄　交換位置</button><hr><button class="is-highlight">▣　自訂移動</button><button>↗　彈出成獨立視窗</button><hr><button>×　收起此格</button>';
    else menu.innerHTML='<div class="mock-popup-title">在右側開啟 · 取代：提案助理</div><input class="input mock-search" placeholder="搜尋 Agent…"><button class="is-highlight">文件助理</button><p class="note r2-menu-note">Alt＋點分割按鈕，改向下開啟。</p>';
    pane.append(menu);const a=anchor.getBoundingClientRect(),p=pane.getBoundingClientRect();menu.style.top=(a.bottom-p.top+6)+"px";menu.style.right="12px";
  }
  if(scene.startsWith("drag-")) {
    const area=shell.querySelector(".mock-area");
    const overlay=document.createElement("div");overlay.className="r2-drag";
    const direction=scene.slice(5), preview=document.createElement("div");preview.className="r2-drop "+direction;overlay.append(preview);
    const labels=[["left","左側"],["right","右側"],["top","上方"],["bottom","下方"],["center","取代此格"]];
    labels.forEach(([where,label])=>{const e=document.createElement("div");e.className="r2-target "+where+(where===direction?" active":"");e.textContent=label;overlay.append(e);});
    const ghost=document.createElement("div");ghost.className="r2-ghost";ghost.textContent="⠿　文件助理";overlay.append(ghost);
    const hint=document.createElement("div");hint.className="r2-drop-caption";hint.textContent="放開以"+({right:"停靠右側",bottom:"停靠下方",center:"取代審查助理"}[direction])+"　·　Esc 取消";overlay.append(hint);area.append(overlay);
  }
  if(scene==="popout") {
    const a=shell.querySelectorAll(".mock-pane")[0], b=shell.querySelectorAll(".mock-pane")[1];
    rows.forEach((r,i)=>r.classList.toggle("active",i===1));
    const mainShell=shell, floating=document.createElement("div");floating.className="shell r2-pop-shell";
    const main=document.createElement("main");main.className="main";const work=document.createElement("div");work.className="mock-workspace r2-workspace";const area=document.createElement("div");area.className="mock-area";area.append(b);work.append(area);main.append(work);floating.append(main);
    mainShell.querySelector(".mock-separator")?.remove();
    mainShell.querySelector(".mock-pane").classList.remove("is-focused");
    const stage=document.createElement("div");stage.className="r2-desktop";
    const create=(kind,title,child)=>{
      const win=document.createElement("section");win.className="r2-window "+kind;const bar=document.createElement("div");bar.className="r2-browser-bar";bar.textContent="●　●　●　　"+title;
      const body=document.createElement("div");body.className="r2-browser-body";body.append(child);win.append(bar,body);stage.append(win);
    };
    shell.replaceWith(stage);create("r2-main-window","主視窗 · 提案助理",mainShell);create("r2-pop-window","彈出視窗 · 審查助理",floating);
    const label=document.createElement("p");label.className="r2-desktop-note";label.textContent="兩個瀏覽器視窗示意；實際外框與位置由瀏覽器／作業系統決定。";stage.append(label);
  }
  document.title="桌面雙對話 r2 · 設計提案";
}
