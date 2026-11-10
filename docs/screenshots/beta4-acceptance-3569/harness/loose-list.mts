import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {bootFixture,matrix,caseName} from '../smoke-fixture/index.mts';
const fx=await bootFixture({port:48878,instances:2,classic:false});
const text='3. 先確認設定\n\n4. 再檢查結果\n\n5. 最後回覆';
const name=fx.instances[1].name;
fx.fm.emitSseEvent('message',{instance:name,sender:name,role:'agent',text,ts:new Date().toISOString()});
const results=[];
try {for(const c of matrix()){
 const {ctx,page,csp}=await fx.page(c,{path:'/ui/chat/'+encodeURIComponent(name)});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 try {await page.locator('.msg .md ol').waitFor();
 const got=await page.locator('.msg .md').filter({hasText:'先確認設定'}).evaluate(el=>({lists:el.querySelectorAll('ol').length,start:el.querySelector('ol')?.getAttribute('start'),items:[...el.querySelectorAll('li')].map(x=>x.textContent)}));
 if(got.lists!==1||got.start!=='3'||got.items.length!==3)throw Error(JSON.stringify(got));
 await page.locator('.msg .md').filter({hasText:'先確認設定'}).evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(r)});
 await page.locator('.quote-pick').click();
 const value=await page.locator('#msgIn').inputValue();if(value!=='> 先確認設定\n> 再檢查結果\n> 最後回覆\n')throw Error(value);
 if(errors.length||(await csp()).length)throw Error(JSON.stringify(errors));
 await page.screenshot({path:join(process.env.OUT!,caseName(c)+'.png')});results.push({case:caseName(c),got,value,selectionScope:'browser Selection text excludes CSS list markers; preserves all three selected item texts',pass:true});
 }finally{await ctx.close()}
}}finally{await fx.close()}
writeFileSync(join(process.env.OUT!,'results.json'),JSON.stringify({scope:'real chat rendering and DOM selection; synthetic agent message; no model',results},null,2));console.log(JSON.stringify({pass:true,cases:results.length}));
