/** Research-only DOM projection into the actual Fleet web shell. Never starts a fleet/CLI. */
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {bootFixture,VIEWPORTS} from '../smoke-fixture/index.mts';
const out=process.env.OUT!;mkdirSync(out,{recursive:true});
const fx=await bootFixture({port:Number(process.env.HP??48762),instances:3,classic:false});
const css=readFileSync(new URL('./proposal.css',import.meta.url),'utf8');
const receipt:any={kind:'static proposal; not implemented',base:process.env.BASE_SHA,cases:[]};
try{
 for(const backend of ['claude','codex']){
  const name=backend==='claude'?'general':fx.instances[2].name;
  const displayName=backend==='claude'?'研究助理':'程式助理';
  const ts=new Date().toISOString();
  fx.fm.emitSseEvent('message',{instance:name,sender:name,role:'agent',text:backend==='claude'?'我已請兩位子 Agent分別核對範例資料。':'兩份範例資料都已核對完成。',ts});
  for(const device of ['desk','phone']as const){
   const c={device,theme:device==='desk'?'light':'dark',lang:'zh-TW'}as const;
   const {ctx,page}=await fx.page(c,{path:'/ui/chat/'+encodeURIComponent(name)});
   await page.waitForSelector('.msg.agent');
   // Static presentation names only; routing/instance identity stays unchanged.
   await page.evaluate(({name,displayName})=>{
    document.querySelector('.p-chat .panel-title h1')!.textContent=displayName;
    document.querySelectorAll('.msg.agent .sender').forEach(e=>e.textContent=displayName);
    const replacements=[[name,displayName],['General 總管','研究助理'],['General','研究助理']];
    const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let e;
    while(e=w.nextNode())for(const [from,to]of replacements)if(e.textContent?.includes(from))e.textContent=e.textContent.replaceAll(from,to);
    document.querySelectorAll('[placeholder],[title],[aria-label]').forEach(e=>{
     for(const attr of ['placeholder','title','aria-label']){let value=e.getAttribute(attr);if(!value)continue;for(const[from,to]of replacements)value=value.replaceAll(from,to);e.setAttribute(attr,value)}
    });
    // Whitespace inside this existing parenthesis is outside the proposed child feature.
    const tw=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let t;
    while(t=tw.nextNode())if(t.textContent)t.textContent=t.textContent.replace(/預設\s*（\s*啟動時偵測\s*）/g,'預設（啟動時偵測）');
   },{name,displayName});
   await page.screenshot({path:join(out,`${backend}-${device}-before.png`)});
   await page.route('**/assets/m2739-proposal.css',r=>r.fulfill({status:200,contentType:'text/css',body:css}));
   await page.evaluate(()=>{const e=document.createElement('link');e.rel='stylesheet';e.href='/assets/m2739-proposal.css';document.head.append(e)});
   const rows=backend==='claude'?[
    {name:'資料核對助手',type:'reader',task:'核對第一份範例資料',state:'已完成 · 8.5 秒',result:'已核對範例檔案，內容符合預期。',kind:''},
    {name:'結果複查助手',type:'checker',task:'核對第二份範例資料',state:'執行中 · 已經過 8 秒',result:'尚未回報結果',kind:'active'}]:[
    {name:'Descartes',type:'Codex',task:'核對第一份範例資料',state:'已完成 · 8.7 秒',result:'已核對範例資料，未發現問題。',kind:''},
    {name:'Kant',type:'Codex',task:'核對第二份範例資料',state:'已完成 · 8.4 秒',result:'已核對範例資料，未發現問題。',kind:''}];
   await page.evaluate(({rows,backend})=>{
    const panel=document.querySelector('.p-chat')!;
    const banner=document.createElement('div');banner.className='sa-proposal-banner';banner.textContent='設計提案｜尚未實作 · 隔離 mock 範例';
    document.querySelector('#main')!.prepend(banner);
    document.querySelector('#main')!.classList.add('sa-proposal-shell');
    // Unrelated General execution-location recovery card is omitted from this static proposal only.
    panel.querySelector('#general-location')?.remove();
    const msg=[...panel.querySelectorAll('.msg.agent')].at(-1)!;
    const d=document.createElement('details');d.open=true;d.className='sa-proposal';
    const s=document.createElement('summary');s.textContent='子 Agent';const count=document.createElement('span');count.className='sa-count';count.textContent=backend==='claude'?'· 1 執行中 · 1 完成':'· 2 完成';s.append(count);d.append(s);
    for(const row of rows){
     const item=document.createElement('div');item.className='sa-item';
     const head=document.createElement('div');head.className='sa-item-head';
     const who=document.createElement('span');who.className='sa-who';const n=document.createElement('strong');n.textContent=row.name;const type=document.createElement('span');type.className='sa-type';type.textContent=row.type;who.append(n,type);const st=document.createElement('span');st.className='sa-state '+row.kind;st.textContent=row.state;head.append(who,st);
     const task=document.createElement('div');task.className='sa-task';task.textContent=row.task;
     const result=document.createElement('div');result.className='sa-result';result.textContent=row.result;item.append(head,task,result);d.append(item);
    }
    const foot=document.createElement('div');foot.className='sa-foot';foot.textContent='子 Agent 的回報不是主 Agent 的最終答覆。';d.append(foot);msg.append(d);
   },{rows,backend});
   await page.locator('.sa-proposal').scrollIntoViewIfNeeded();
   if(device==='phone')await page.evaluate(()=>{const sc=document.querySelector('.p-chat .scroller');if(sc)sc.scrollTop=0});
   await page.screenshot({path:join(out,`${backend}-${device}-expanded.png`)});
   const layout=await page.evaluate(()=>{
    const boxes=[];for(const selector of ['.sa-proposal-banner','.sa-proposal','.composer-box']){const r=document.querySelector(selector)!.getBoundingClientRect();boxes.push({left:r.left,right:innerWidth-r.right,width:r.width})}
    const heading=document.querySelector('.p-chat h1')!;const h=heading as HTMLElement;const sc=document.querySelector('.p-chat .scroller')!.getBoundingClientRect();const foot=document.querySelector('.sa-foot')!.getBoundingClientRect();
    return {banner:boxes[0],card:boxes[1],composer:boxes[2],heading:heading.textContent,headingClipped:h.scrollWidth>h.clientWidth+1,footerVisible:foot.bottom<=sc.bottom+1&&foot.top>=sc.top-1,bannerParent:document.querySelector('.sa-proposal-banner')!.parentElement!.id,locationCard:!!document.querySelector('#general-location'),overflow:document.documentElement.scrollWidth>innerWidth};
   });
   const overflow=layout.overflow;
   if(device==='phone'){for(const b of [layout.banner,layout.card,layout.composer])if(Math.abs(b.left-16)>1||Math.abs(b.right-16)>1)throw Error('phone gutter mismatch '+JSON.stringify(layout));if(layout.headingClipped)throw Error('clipped mobile header');if(!layout.footerVisible)throw Error('phone footer clipped '+JSON.stringify(layout))}
   if(layout.bannerParent!=='main'||layout.locationCard)throw Error('proposal page framing mismatch');
   receipt.cases.push({backend,device,overflow,viewport:VIEWPORTS[device],expanded:true,displayName,layout});
   await page.locator('.sa-proposal>summary').click();
   await page.screenshot({path:join(out,`${backend}-${device}-collapsed.png`)});
   if(backend==='codex'&&device==='phone'){
    await page.locator('.sa-proposal>summary').click();
    await page.evaluate(()=>{
     const d=document.querySelector('.sa-proposal')!;const body=d.closest('.msg.agent')?.querySelector('.body');if(body)body.textContent='子 Agent 的範例工作已交辦。';d.querySelector('.sa-count')!.textContent='· 2 待確認';
     d.querySelectorAll('.sa-state').forEach(e=>{e.className='sa-state unknown';e.textContent='待確認'});
     d.querySelectorAll('.sa-result').forEach(e=>e.remove());
     const note=document.createElement('div');note.className='sa-status-note';note.textContent='尚未取得最新狀態，連線恢復後再確認。';d.querySelector('.sa-foot')!.before(note);
     d.querySelector('.sa-foot')!.textContent='子 Agent 的回報不是主 Agent 的最終答覆。';
    });await page.screenshot({path:join(out,'codex-phone-unknown.png')});
   }
   await ctx.close();
  }
 }
 writeFileSync(join(out,'receipt.json'),JSON.stringify(receipt,null,2));
}finally{await fx.close()}
process.exit(0);
