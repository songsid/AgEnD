const a=globalThis.a9,out=[];
for(const{device,p}of a.admins){
 if(device==='phone'){await p.getByRole('button',{name:'打開側邊欄',exact:true}).click();await a.shot(p,'A9-04-phone-drawer');await p.getByRole('button',{name:'已登入',exact:true}).click();await a.shot(p,'A9-04-phone-session-menu');await p.keyboard.press('Escape');}
 out.push({device,nav:await p.locator('.sidebar a').evaluateAll(es=>es.map(e=>({text:e.textContent,href:e.getAttribute('href'),height:e.getBoundingClientRect().height}))),brand:await p.locator('.sidebar').innerText()});
 for(const [name,path] of [['shared','/ui/hub/owner'],['notices','/ui/hub/notices'],['admin','/ui/hub/admin'],['chats','/ui/hub']]){
  await p.goto(a.r.webOrigin+path);await p.locator('h1').waitFor();await p.waitForFunction(()=>!document.querySelector('[aria-busy=true]'));await a.shot(p,'A9-02-'+device+'-'+name);out.push({device,name,title:await p.locator('h1').allTextContents(),text:(await p.locator('main').last().innerText()).slice(0,900),overflow:await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});
 }
}
return out;
