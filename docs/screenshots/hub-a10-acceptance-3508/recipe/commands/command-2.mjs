const a=globalThis.a10;a.members=[];const out=[];
for(const device of ['desk','phone']){
 const m=await a.member(device,device==='phone'?'dark':'light');m.device=device;a.members.push(m);
 const ctx=await a.context(device,device==='phone'?'dark':'light'),p=await ctx.newPage();m.ordinary={ctx,p};
 const code=m.fx.fm.issueDashboardLogin().display;await p.goto(m.fx.base+'/signin');await p.fill('#code',code);await p.click('#go');await p.waitForURL(m.fx.base+'/ui');await p.goto(m.fx.base+'/settings/hub');
 await p.locator('#hubCompanyAddress').waitFor();await p.fill('#hubCompanyAddress',a.companyLink);await p.fill('#hubCompanyFleetName','普通工作階段 '+device);
 const response=p.waitForResponse(q=>new URL(q.url()).pathname.endsWith('/company-join/start')&&q.request().method()==='POST'),next=ctx.waitForEvent('page');await p.getByRole('button',{name:'以公司帳號登入',exact:true}).click();const hp=await next;m.hub=hp;hp.setDefaultTimeout(15000);const start=await response,body=await start.json();m.pendingId=body.pending_change?.id;
 a.check(start.status()===202&&m.pendingId,'ordinary start not pending');await hp.getByText('需要先完成本機確認，Hub 登入尚未開始。',{exact:true}).waitFor();await a.shot(hp,'A10-01-'+device+'-ordinary-wait');await hp.getByRole('button',{name:'開啟本機確認',exact:true}).click();await hp.locator('.pending-card[data-pending="'+m.pendingId+'"]').waitFor();await a.shot(hp,'A10-01-'+device+'-exact-review');
 await m.page.goto(m.fx.base+'/ui/needs');await m.page.locator('.pending-card[data-pending="'+m.pendingId+'"]').waitFor();await a.shot(m.page,'A10-01-'+device+'-host-confirmation');
 out.push({device,id:m.pendingId,waitText:await hp.locator('.s-company-join').innerText(),hostCard:await m.page.locator('.pending-card[data-pending="'+m.pendingId+'"]').innerText(),hostButtons:await m.page.locator('.pending-card[data-pending="'+m.pendingId+'"] button').allTextContents()});
}
return out;
