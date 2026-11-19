/** Original wallpaper on shipped pages; synthetic content, owned listeners, serial Linux headless only. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bootFixture } from '../smoke-fixture/index.mts';
const out=resolve(process.env.OUT!),checks:any[]=[],shots:string[]=[],errors:string[]=[];
if(!process.env.OUT||process.platform!=='linux'||!process.env.CHROME||process.env.CHROME.includes('/mnt/'))throw Error('OUT and Linux headless CHROME required');
mkdirSync(out,{recursive:true});
const check=(name:string,ok:unknown,detail?:unknown)=>{checks.push({name,ok:!!ok,detail});if(!ok)throw Error(name+' '+JSON.stringify(detail));};
const fx=await bootFixture({port:Number(process.env.HP||19892),classic:false,roster:[{name:'release-helper',displayName:'Release helper',backend:'codex',status:'running'},{name:'notes-helper',displayName:'Notes helper',backend:'codex'}]});
try{
 for(const message of [{role:'user',sender:'Example person',text:'Please review this small change.'},{role:'agent',sender:'Release helper',text:'The example is ready.\n\n```ts\nconst message = "Hello, world";\nconsole.log(message);\n```\n\nPlease check the highlighted notice before sending.'}])fx.fm.emitSseEvent('message',{instance:'release-helper',...message,ts:new Date().toISOString()});
 for(const device of ['desk','phone'])for(const theme of ['light','dark']){
  const a=await fx.page({device,theme,lang:device==='desk'?'en':'zh-TW'},{path:'/settings/look',prefs:{'nav.density':'detailed'}}),p=a.page;
  try{
   p.on('pageerror',(e:any)=>errors.push(String(e).slice(0,160)));
   await p.locator('.s-theme-colours').click();await p.locator('input[value=meadow]').check();await p.locator(`input[name=builtin-appearance][value=${theme}]`).check();await p.locator('.theme-apply').click();await p.waitForTimeout(950);
   await p.goto(fx.base+'/ui/chat/release-helper');await p.locator('.p-chat .msg pre').waitFor();await p.locator('#msgIn').fill('Example reply ready to send.');fx.fm.getInstanceStatus=()=> 'running';fx.fm.emitSseEvent('activity',{instance:'release-helper',state:'stuck'});await p.locator('.dot.warn').first().waitFor({state:'attached'});
   const paint=await p.locator('.p-chat').evaluate((el:any)=>{const s=getComputedStyle(el);return {image:s.backgroundImage,size:s.backgroundSize,attachment:s.backgroundAttachment,theme:globalThis.AgendTheme.get(),palette:globalThis.AgendTheme.getPalette()};});
   check(`${device}-${theme}-wallpaper`,paint.image.includes('data:image/svg+xml,')&&paint.image.includes('linear-gradient(')&&paint.theme===theme&&paint.palette==='meadow',paint);
   const svgLoaded=await p.evaluate(async()=>{const url=getComputedStyle(document.querySelector('.p-chat')).getPropertyValue('--meadow-wallpaper-tile').trim().slice(5,-2);return await new Promise<boolean>(r=>{const img=new Image();img.onload=()=>r(img.naturalWidth>0);img.onerror=()=>r(false);img.src=url;});});check(`${device}-${theme}-tile-loaded`,svgLoaded);
   const stable=await p.evaluate(async()=>{const panel=document.querySelector('.p-chat'),scroller=panel.querySelector('.scroller');const before=panel.getBoundingClientRect(),image=getComputedStyle(panel).backgroundImage,pos=getComputedStyle(panel).backgroundPosition;const filler=document.createElement('div');filler.style.height='2000px';scroller.append(filler);scroller.scrollTop=120;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const after=panel.getBoundingClientRect(),result={scroll:scroller.scrollTop,stable:before.x===after.x&&before.y===after.y&&image===getComputedStyle(panel).backgroundImage&&pos===getComputedStyle(panel).backgroundPosition};filler.remove();scroller.scrollTop=0;return result;});check(`${device}-${theme}-stationary-pattern`,stable.scroll>0&&stable.stable,stable);
   const fit=await p.evaluate(()=>({w:innerWidth,body:document.documentElement.scrollWidth,unsafe:/-t\d+/.test(document.body.innerText)}));check(`${device}-${theme}-fit`,fit.body<=fit.w+1&&!fit.unsafe,fit);
   await p.evaluate(()=>document.fonts.ready);const name=`${device}-${theme}-chat.png`;await p.screenshot({path:join(out,name),animations:'disabled'});shots.push(name);
   const override=await p.locator('.p-chat').evaluate((el:any)=>{el.style.setProperty('--bg','#202020');const hidden=getComputedStyle(el).backgroundImage==='none';el.style.removeProperty('--bg');return hidden&&getComputedStyle(el).backgroundImage.includes('linear-gradient(');});check(`${device}-${theme}-agent-background-wins`,override);
  }finally{await a.ctx.close();}
 }
 check('all-cases-ran',shots.length===4);check('no-page-errors',errors.length===0,errors);
}finally{await fx.close();writeFileSync(join(out,'result.json'),JSON.stringify({checks,shots,errors},null,2));}
console.log(JSON.stringify({checks:checks.length,shots:shots.length}));
