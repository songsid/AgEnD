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
  const ts=new Date().toISOString();
  fx.fm.emitSseEvent('message',{instance:name,sender:'使用者',role:'user',text:'請核對兩份範例資料。',ts});
  fx.fm.emitSseEvent('message',{instance:name,sender:name,role:'agent',text:backend==='claude'?'我已請兩位子代理分別核對範例資料。':'兩份範例資料都已核對完成。',ts});
  for(const device of ['desk','phone']as const){
   const c={device,theme:device==='desk'?'light':'dark',lang:'zh-TW'}as const;
   const {ctx,page}=await fx.page(c,{path:'/ui/chat/'+encodeURIComponent(name)});
   await page.waitForSelector('.msg.agent');
   if(backend==='codex'){
    await page.locator('.p-chat .panel-title h1').evaluate((e:any)=>e.textContent='程式助理');
    await page.locator('.msg.agent .sender').evaluateAll((es:any[])=>es.forEach(e=>e.textContent='程式助理'));
    await page.evaluate(name=>{const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let e;while(e=w.nextNode()){if(e.textContent?.includes(name))e.textContent=e.textContent.replaceAll(name,'程式助理')}document.querySelectorAll('[placeholder]').forEach(e=>{const p=e.getAttribute('placeholder');if(p?.includes(name))e.setAttribute('placeholder',p.replaceAll(name,'程式助理'))})},name);
   }
   await page.screenshot({path:join(out,`${backend}-${device}-before.png`)});
   await page.route('**/assets/m2739-proposal.css',r=>r.fulfill({status:200,contentType:'text/css',body:css}));
   await page.evaluate(()=>{const e=document.createElement('link');e.rel='stylesheet';e.href='/assets/m2739-proposal.css';document.head.append(e)});
   const rows=backend==='claude'?[
    {name:'reader',task:'核對第一份範例資料',state:'已完成 · 8.5 秒',result:'已核對範例檔案，內容符合預期。',kind:''},
    {name:'checker',task:'核對第二份範例資料',state:'執行中 · 已過 8 秒',result:'尚未回報結果',kind:'active'}]:[
    {name:'Descartes',task:'核對第一份範例資料',state:'已完成 · 8.7 秒',result:'已核對範例資料，未發現問題。',kind:''},
    {name:'Kant',task:'核對第二份範例資料',state:'已完成 · 8.4 秒',result:'已核對範例資料，未發現問題。',kind:''}];
   await page.evaluate(({rows,backend})=>{
    const panel=document.querySelector('.p-chat')!;
    const banner=document.createElement('div');banner.className='sa-proposal-banner';banner.textContent='設計提案｜尚未實作 · 隔離 mock 範例';
    panel.querySelector('.panel-head')!.after(banner);
    const msg=[...panel.querySelectorAll('.msg.agent')].at(-1)!;
    const d=document.createElement('details');d.open=true;d.className='sa-proposal';
    const s=document.createElement('summary');s.textContent='子代理 · 2';const count=document.createElement('span');count.className='sa-count';count.textContent=backend==='claude'?'1 執行中 · 1 完成':'2 完成';s.append(count);d.append(s);
    for(const row of rows){
     const item=document.createElement('div');item.className='sa-item';
     const head=document.createElement('div');head.className='sa-item-head';
     const n=document.createElement('strong');n.textContent=row.name;const st=document.createElement('span');st.className='sa-state '+row.kind;st.textContent=row.state;head.append(n,st);
     const task=document.createElement('div');task.className='sa-task';task.textContent=row.task;
     const result=document.createElement('div');result.className='sa-result';result.textContent=row.result;item.append(head,task,result);d.append(item);
    }
    const foot=document.createElement('div');foot.className='sa-foot';foot.textContent='依 CLI 紀錄顯示；子代理回報不代表主代理的最終結論。';d.append(foot);msg.append(d);
   },{rows,backend});
   await page.locator('.sa-proposal').scrollIntoViewIfNeeded();
   if(device==='phone')await page.evaluate(()=>{const sc=document.querySelector('.p-chat .scroller');if(sc)sc.scrollTop=0});
   await page.screenshot({path:join(out,`${backend}-${device}-expanded.png`)});
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
   receipt.cases.push({backend,device,overflow,viewport:VIEWPORTS[device],expanded:true});
   await page.locator('.sa-proposal>summary').click();
   await page.screenshot({path:join(out,`${backend}-${device}-collapsed.png`)});
   if(backend==='codex'&&device==='phone'){
    await page.locator('.sa-proposal>summary').click();
    await page.evaluate(()=>{
     const d=document.querySelector('.sa-proposal')!;const body=d.closest('.msg.agent')?.querySelector('.body');if(body)body.textContent='子代理的範例工作已交辦，正在等待執行紀錄。';d.querySelector('.sa-count')!.textContent='2 狀態待確認';
     d.querySelectorAll('.sa-state').forEach(e=>{e.className='sa-state unknown';e.textContent='狀態待確認'});
     d.querySelectorAll('.sa-result').forEach(e=>e.textContent='尚未取得完成紀錄');
     d.querySelector('.sa-foot')!.textContent='連線或紀錄中斷時，不推測子代理仍在執行，也不當作完成。';
    });await page.screenshot({path:join(out,'codex-phone-unknown.png')});
   }
   await ctx.close();
  }
 }
 writeFileSync(join(out,'receipt.json'),JSON.stringify(receipt,null,2));
}finally{await fx.close()}
process.exit(0);
