const a=globalThis.a9;const out=[];a.admins=[];
for(const device of ['desk','phone']){
 const c=await a.context(device,device==='phone'?'dark':'light'),p=await c.newPage();p.setDefaultTimeout(15000);
 await p.goto(a.r.webOrigin+'/ui/hub');await p.locator('#hubLogin').waitFor();await a.shot(p,'A9-01-'+device+'-signed-out');
 await p.fill('#hubLogin','alice');await p.fill('#hubPassword','Dummy-alice-only');await p.locator('.hub-signin button[type=submit]').click();await p.locator('.hub-home').waitFor();await p.getByText('與 Agent 對話',{exact:false}).first().waitFor();await p.getByText('你的 Hub 管理員會幫你配對 Fleet。請向他索取配對碼。',{exact:true}).waitFor();
 await a.shot(p,'A9-02-'+device+'-home-settled');
 await p.goto(a.r.webOrigin+'/ui/hub/admin');await p.locator('.hub-company-join input[type=checkbox]').waitFor();a.check(!(await p.locator('.hub-company-join input[type=checkbox]').isChecked()),'Company join is not default off');await a.shot(p,'A9-06-'+device+'-default-off');
 out.push({device,titles:await p.locator('h1').allTextContents(),overflow:await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});a.admins.push({device,c,p});
}
const p=a.admins[0].p;await p.goto(a.r.webOrigin+'/ui/hub/admin?view=groups');await p.locator('.hub-groups-list').waitFor();await p.getByRole('button',{name:'開啟',exact:true}).click();await p.getByRole('textbox',{name:'群組（辨別名稱）',exact:true}).fill('CN=Owners,DC=example,DC=test');await p.getByRole('button',{name:'新增群組',exact:true}).click();await p.locator('.hub-group-row').waitFor();
const row=p.locator('.hub-group-row');for(let n=0;n<3;n++)await row.locator('input[type=checkbox]').nth(n).check();await row.locator('input[type=number]').fill('8');await p.getByRole('button',{name:'開啟並儲存',exact:true}).waitFor();await a.shot(p,'A9-07-desk-policy-preview');await p.getByRole('button',{name:'開啟並儲存',exact:true}).click();await p.locator('.hub-groups-state h3').getByText('開啟',{exact:true}).waitFor();await a.shot(p,'A9-07-desk-policy-saved');
await p.goto(a.r.webOrigin+'/ui/hub/admin');await p.locator('.hub-company-join input[type=checkbox]').waitFor();await p.locator('.hub-company-join input[type=checkbox]').click();await p.waitForFunction(()=>document.querySelector('.hub-company-join input')?.checked===true);a.companyLink=await p.locator('.hub-company-join textarea').first().inputValue();await a.shot(p,'A9-06-desk-enabled');
const phone=a.admins[1].p;await phone.reload();await phone.waitForFunction(()=>document.querySelector('.hub-company-join input')?.checked===true);await a.shot(phone,'A9-06-phone-enabled');
return {pages:out,policyUI:'saved',companyEnabledUI:true};
