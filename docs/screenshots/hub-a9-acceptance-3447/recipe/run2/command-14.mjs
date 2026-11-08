const a=globalThis.a9,out=[];
for(const{device,p}of a.admins){
 await p.goto(a.r.webOrigin+'/ui/hub');await p.locator('.hub-home').waitFor();
 for(const[name,label]of [['shared','我分享的 Agent'],['notices','通知'],['admin','管理'],['chats','對話']]){
  const link=p.locator('.sidebar').getByRole('link',{name:label,exact:true});if(!(await link.isVisible()))await p.getByRole('button',{name:'打開側邊欄',exact:true}).click();await link.click();await p.getByRole('heading',{level:1,name:label,exact:true}).waitFor();
  if(name==='notices')await p.getByRole('button',{name:'撤銷此 Fleet',exact:true}).first().waitFor();
  else if(name==='admin')await p.locator('.hub-company-join input').waitFor();
  else if(name==='shared')await p.getByText('還沒有分享的 Agent',{exact:false}).waitFor().catch(()=>{});
  else await p.getByText('與 Agent 對話',{exact:false}).first().waitFor();
  await a.shot(p,'A9-02-'+device+'-'+name);out.push({device,name,url:p.url(),titles:await p.locator('h1').allTextContents(),noticeLeadVisible:await p.getByText('有新的 Fleet 連接到這個 Hub 時，會在這裡通知你。如果你不認得它，請撤銷。',{exact:true}).count(),overflow:await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});
 }
}
return out;
