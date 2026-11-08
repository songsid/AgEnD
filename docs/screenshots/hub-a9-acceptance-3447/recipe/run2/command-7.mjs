const a=globalThis.a9,out=[];
for(const{device,p}of a.admins){await p.goto(a.r.webOrigin+'/ui/hub');await p.locator('.hub-home').waitFor();
 if(device==='phone'){await p.getByRole('button',{name:'打開側邊欄',exact:true}).click();await a.shot(p,'A9-04-phone-drawer');await p.getByRole('button',{name:'已登入',exact:true}).click();await a.shot(p,'A9-04-phone-session-menu');await p.keyboard.press('Escape');}
 out.push({device,nav:await p.locator('.sidebar a').evaluateAll(es=>es.map(e=>({text:e.textContent,href:e.getAttribute('href'),height:e.getBoundingClientRect().height}))),body:await p.locator('main').last().innerText()});}
return out;
