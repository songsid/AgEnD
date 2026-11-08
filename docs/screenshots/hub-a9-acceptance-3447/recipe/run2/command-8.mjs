const a=globalThis.a9,out=[];
for(const{device,p}of a.admins){
 for(const [name,label] of [['shared','我分享的 Agent'],['notices','通知'],['admin','管理'],['chats','對話']]){
  const link=p.locator('.sidebar').getByRole('link',{name:label,exact:true});if(!(await link.isVisible()))await p.getByRole('button',{name:'打開側邊欄',exact:true}).click();await link.click();await p.getByRole('heading',{level:1,name:label,exact:true}).waitFor();
  await p.waitForFunction(()=>!document.querySelector('main [aria-busy=true]'));if(name==='notices')await p.getByText('carol',{exact:false}).first().waitFor();
  await a.shot(p,'A9-02-'+device+'-'+name);out.push({device,name,url:p.url(),titles:await p.locator('h1').allTextContents(),text:(await p.locator('main').last().innerText()).slice(0,1800),overflow:await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});
 }
}
return out;
