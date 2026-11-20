/** Synthetic, owned, headless-only sidebar context menu rehearsal. No lifecycle/CLI operations. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {bootFixture, matrix, caseName} from '../smoke-fixture/index.mts';
const out=process.env.OUT!;mkdirSync(out,{recursive:true});
const a='example-alpha',b='example-beta';
const fx=await bootFixture({port:18288,host:true,classic:false,roster:[{name:'example-coordinator',displayName:'Example coordinator',backend:'codex',general:true},{name:a,displayName:'Example Alpha',backend:'codex'},{name:b,displayName:'Example Beta',backend:'codex'}]});
const checks:any[]=[];
try{
 for(const c of matrix()){
  const {page,ctx,csp}=await fx.page(c,{path:`/ui/chat/${a}`});
  const errors:string[]=[],writes:string[]=[];
  page.on('pageerror',(e:Error)=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const r=route.request(),u=new URL(r.url());
   if(u.origin!==fx.base&&!['data:','blob:'].includes(u.protocol))return route.abort();
   if(r.method()!=='GET'&&!['/ui/prefs','/api/settings/status-emojis/preview'].includes(u.pathname)){writes.push(u.pathname);return route.abort();}
   return route.continue();
  });
  const more=c.device==='phone'?page.locator('.p-chat .chat-sheet-more'):page.locator('.p-chat .panel-actions .menu > button[aria-label]').filter({has:page.locator('.icon')}).last();
  try { await more.waitFor(); } catch(e) { writeFileSync(`${out}/diagnostic.txt`,await page.locator("body").innerText()); await page.screenshot({path:`${out}/diagnostic.png`}); throw e; } await more.click();
  const headerItems=await page.locator('[role="menu"] button,dialog[open] .chat-sheet-row').allTextContents();
  await page.screenshot({path:`${out}/${caseName(c)}-header.png`});
  await page.keyboard.press('Escape');
  if(c.device==='phone'){await page.locator('#sbOpen').click();await page.waitForFunction(()=>document.querySelector('#sidebar')!.getBoundingClientRect().left>=-0.5);}
  const row=page.locator(`[data-agent-row="${b}"] a.inst`);await row.scrollIntoViewIfNeeded();
  const before=page.url();
  if(c.device==='phone'){
   const rect=await row.boundingBox();assert.ok(rect);const cd=await ctx.newCDPSession(page);
   await cd.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rect.x+rect.width/2,y:rect.y+rect.height/2}]});
   await page.waitForTimeout(600);
   await cd.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cd.detach();
  }else await row.click({button:'right'});
  await page.waitForSelector(c.device==='phone'?'dialog[open] .chat-sheet-row':'[role="menu"]');
  assert.equal(page.url(),before,'opening context menu must not navigate');
  const favoriteLabels=['Add to favorites','Remove from favorites','加到我的最愛','從我的最愛移除'];
  const splitLabel=c.lang==='en'?'Split chat':'分割對話';
  await page.waitForFunction(({expected,favorites,split}) => JSON.stringify([...document.querySelectorAll('[role="menu"] button,dialog[open] .chat-sheet-row')].map(el=>el.textContent).filter(text=>!favorites.includes(text) && (text!==split || expected.includes(text))))===JSON.stringify(expected),{expected:headerItems,favorites:favoriteLabels,split:splitLabel});
  const contextItems=await page.locator('[role="menu"] button,dialog[open] .chat-sheet-row').allTextContents();
  const geometry=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,menus:[...document.querySelectorAll('[role="menu"],dialog[open]')].map(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,clipped:r.left<0||r.right>innerWidth+1||r.top<0||r.bottom>innerHeight+1};})}));
  assert.equal(geometry.overflow,false);assert.ok(geometry.menus.length);assert.ok(geometry.menus.every(r=>!r.clipped));
  await page.screenshot({path:`${out}/${caseName(c)}-sidebar.png`});
  assert.ok(contextItems.includes(c.lang==='en'?'Add to favorites':'加到我的最愛'));
  const splitAvailable=await page.evaluate(async()=>!!(await import("/assets/app-store.js")).appStore.get().chatWorkspace);
  assert.equal(contextItems.includes(splitLabel),splitAvailable);
  await page.keyboard.press('Escape');await page.waitForSelector('dialog[open],[role="menu"]',{state:'hidden'});
  assert.equal(await row.evaluate((el:HTMLElement)=>document.activeElement===el),true,'Escape returns to row');
  if(c.device==='desk'){
   await row.focus();await page.keyboard.press('Shift+F10');await page.waitForSelector('[role="menu"]');
   await page.locator('.p-chat .panel-title h1').click();await page.waitForSelector('[role="menu"]',{state:'hidden'});
  }
  let splitProof=null;
  if(c.device==='desk' && c.lang==='en'){
    await row.click({button:'right'});await page.getByRole('menuitem',{name:'Add to favorites',exact:true}).click();
    await page.waitForFunction(name=>JSON.parse(localStorage.getItem('agend_favorites')||'[]').includes(name),b);
    const moved=page.locator(`[data-agent-row="${b}"] a.inst`);await moved.click({button:'right'});await page.getByRole('menuitem',{name:'Remove from favorites',exact:true}).waitFor();
    await page.screenshot({path:`${out}/${caseName(c)}-favorite-on.png`});await page.keyboard.press('Escape');
    await page.locator(`[data-agent-row="${b}"] .inst-row-menu > button`).click();await page.getByRole('menuitem',{name:'Remove from favorites',exact:true}).click();
    await moved.click({button:'right'});await page.getByRole('menuitem',{name:'Split chat',exact:true}).click();
    await page.waitForSelector('.ws-pane[data-pane="b"] .p-chat');
    splitProof=await page.evaluate(()=>[...document.querySelectorAll('.ws-pane .panel-title h1')].map(el=>el.textContent));
    assert.ok(splitProof.some((text:string)=>text?.includes('Alpha')||text?.includes('alpha')));assert.ok(splitProof.some((text:string)=>text?.includes('Beta')||text?.includes('beta')));
  }
  checks.push({case:caseName(c),splitProof,headerItems,contextItems,geometry,csp:await csp(),errors,writes});
  writeFileSync(`${out}/checks.json`,JSON.stringify(checks,null,2)+'\n');
  assert.deepEqual(contextItems.filter((text:string)=>!favoriteLabels.includes(text)&&(text!==splitLabel||headerItems.includes(text))),headerItems,'existing actions remain alongside requested sidebar additions');assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);await ctx.close();
 }
 writeFileSync(`${out}/checks.json`,JSON.stringify(checks,null,2)+'\n');
}finally{await fx.close();}
