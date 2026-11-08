const a=globalThis.a9;a.outsiders=[];const out=[];
for(const device of ['desk','phone']){
 const m=await a.member(device,device==='phone'?'dark':'light');a.outsiders.push(m);await m.page.locator('#hubCompanyAddress').waitFor();await m.page.fill('#hubCompanyAddress',a.companyLink);await m.page.fill('#hubCompanyFleetName','外部部門 Fleet '+device);
 const next=m.ctx.waitForEvent('page');await m.page.getByRole('button',{name:'以公司帳號登入',exact:true}).click();const hp=await next;await hp.locator('#hubLogin').waitFor();await hp.fill('#hubLogin','dan');await hp.fill('#hubPassword','Dummy-dan-only');await hp.getByRole('button',{name:'登入並連接 Fleet',exact:true}).click();await hp.getByText('你的公司帳號沒有連接這個 Fleet 的權限',{exact:false}).waitFor();
 a.check(!a.currentBinding(m.fx.fm.dataDir),'Outsider got a binding');await a.shot(hp,'A9-09-'+device+'-outsider-refused');out.push({device,refused:true,binding:false,text:await hp.locator('main').last().innerText()});
}
a.first=await a.member('desk');await a.first.page.locator('#hubCompanyAddress').waitFor();await a.first.page.fill('#hubCompanyAddress',a.r.webOrigin);await a.first.page.fill('#hubCompanyFleetName','首次連接 Fleet');
const next=a.first.ctx.waitForEvent('page');await a.first.page.getByRole('button',{name:'以公司帳號登入',exact:true}).click();a.first.popup=await next;
return{outsiders:out,firstTrustText:await a.first.page.locator('main').last().innerText(),dialogs:await a.first.page.locator('dialog[open]').allTextContents()};
