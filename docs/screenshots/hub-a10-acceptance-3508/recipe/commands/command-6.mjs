const a=globalThis.a10;a.members=[];const out=[];
for(const device of ['desk','phone']){
 const m=await a.member(device,device==='phone'?'dark':'light');m.device=device;a.members.push(m);await m.page.locator('#hubCompanyAddress').waitFor();
 await m.page.fill('#hubCompanyAddress',a.companyLink);await m.page.fill('#hubCompanyFleetName','驗收 Fleet '+device);await a.shot(m.page,'A10-18-'+device+'-fleet-start');
 const next=m.ctx.waitForEvent('page');await m.page.getByRole('button',{name:'以公司帳號登入',exact:true}).click();const hp=await next;m.hub=hp;hp.setDefaultTimeout(20000);await hp.locator('#hubLogin').waitFor();await a.shot(hp,'A10-18-'+device+'-hub-signin');
 await hp.fill('#hubLogin','carol');await hp.fill('#hubPassword','Dummy-carol-only');await hp.getByRole('button',{name:'登入並連接 Fleet',exact:true}).click();await m.page.locator('.hub-paired').waitFor({timeout:30000});await hp.locator('.p-hub-join').waitFor();
 a.check(m.fx.fm.hubMemberLink==='online','Joined member not online');await a.shot(m.page,'A10-18-'+device+'-connected');await a.shot(hp,'A10-18-'+device+'-joined');out.push({device,submissions:2,online:m.fx.fm.hubMemberLink,hubText:await hp.locator('main').last().innerText(),binding:!!a.currentBinding(m.fx.fm.dataDir)});
}
return out;
