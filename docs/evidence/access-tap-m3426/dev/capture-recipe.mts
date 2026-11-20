import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const REPO=process.env.REPO??process.cwd();
const {bootFixture}=await import(REPO+'/scripts/manual/smoke-fixture/index.mts');
const out=process.env.OUT!;mkdirSync(out,{recursive:true});
const candidate=readFileSync(REPO+'/src/ui/shared/app.css','utf8');
const added='  /* Grow the clickable label around its text without moving the surrounding layout. */\n  .p-settings .s-setting-copy > label { display: block; min-height: var(--tap); padding-block: max(0px, calc((var(--tap) - 1lh) / 2)); margin-block: min(0px, calc((1lh - var(--tap)) / 2)); }\n';
if(candidate.split(added).length!==2)throw Error('expected one candidate label rule');
const before=candidate.replace(added,'');
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const matchCss=(url:URL)=>/^\/assets\/(?:v-[^/]+\/)?app\.css$/.test(url.pathname);
const fx=await bootFixture({port:47530,instances:12});
const results=[];
try{
 for(const lang of ['en','zh-TW'] as const){
  const snapshots:any[]=[];
  for(const stage of ['before','after']){
   const {ctx,page}=await fx.page({device:'phone',theme:lang==='en'?'light':'dark',lang},{path:'/settings/web-dashboard'});
   const input=stage==='before'?before:candidate;
   let intercepted=0;let requestedPath='';
   await page.route(matchCss,route=>{intercepted++;requestedPath=new URL(route.request().url()).pathname;return route.fulfill({contentType:'text/css',headers:{'x-agend-capture-css':sha(input)},body:input});});
   const [response]=await Promise.all([page.waitForResponse(r=>matchCss(new URL(r.url()))),page.reload()]);
   const delivered=await response.body();
   if(intercepted!==1||sha(delivered)!==sha(input)||response.headers()['x-agend-capture-css']!==sha(input))throw Error('stylesheet input did not bind exactly once');
   const binding={intercepted,requestedPath,inputSha256:sha(input),deliveredSha256:sha(delivered),containsLabelRule:input.includes(added)};
   await page.waitForSelector('#webLogThinking');
   await page.locator('.s-dashboard-features').scrollIntoViewIfNeeded();
   await page.evaluate(()=>document.fonts.ready);
   const metrics=await page.evaluate(()=>{
    const card=document.querySelector('.s-dashboard-features')!,cb=card.getBoundingClientRect();
    const rows=[...card.querySelectorAll('.s-setting-row')].map(row=>{
     const b=row.getBoundingClientRect(),copy=row.querySelector('.s-setting-copy')!,label=copy.querySelector('label')!,input=row.querySelector('input')!,note=copy.querySelector('.note')!;
     const range=document.createRange();range.selectNodeContents(label);const text=range.getBoundingClientRect(),ib=input.getBoundingClientRect(),lb=label.getBoundingClientRect(),nb=note.getBoundingClientRect();
     const style=getComputedStyle(label);
     return {id:input.id,labelStyle:{display:style.display,minHeight:style.minHeight,paddingTop:style.paddingTop,paddingBottom:style.paddingBottom,marginTop:style.marginTop,marginBottom:style.marginBottom},rowTop:b.top-cb.top,rowHeight:b.height,textTop:text.top-cb.top,textHeight:text.height,noteTop:nb.top-cb.top,inputTop:ib.top-cb.top,inputHeight:ib.height,labelWidth:lb.width,labelHeight:lb.height};
    });return {height:cb.height,rows};
   });
   const thinking=metrics.rows.find(r=>r.id==='webLogThinking');
   if(thinking?.labelStyle.display!==(stage==='before'?'inline':'block'))throw Error('computed label rule did not match stage');
   snapshots.push({stage,binding,...metrics});
   await page.screenshot({path:`${out}/phone-${lang}-dashboard-${stage}.png`});
   await ctx.close();
  }
  const [a,b]=snapshots;
  const differences=[];
  for(let i=0;i<a.rows.length;i++)for(const key of ['rowTop','rowHeight','textTop','textHeight','noteTop','inputTop','inputHeight'])if(Math.abs(a.rows[i][key]-b.rows[i][key])>1)differences.push({id:a.rows[i].id,key,before:a.rows[i][key],after:b.rows[i][key]});
  if(Math.abs(a.height-b.height)>1)differences.push({key:'cardHeight',before:a.height,after:b.height});
  const hit=b.rows.find(r=>r.id==='webLogThinking');if(!hit||hit.labelHeight<44||hit.labelWidth<44)throw Error('thinking label below44');
  results.push({lang,snapshots,differences});
 }
 writeFileSync(`${out}/label-geometry.json`,JSON.stringify(results,null,2));
 console.log(JSON.stringify(results.map(r=>({lang:r.lang,differences:r.differences,bindings:r.snapshots.map(s=>s.binding)}))));
}finally{await fx.close()}
