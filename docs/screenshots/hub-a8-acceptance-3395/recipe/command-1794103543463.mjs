await story('A8-02-publication-grant-chat',async()=>{
 await apply(local.p,'.hub-exposure.is-shared');
 grantUrl=await local.p.locator('.hub-exposure.is-shared a').getAttribute('href');exposureId=new URL(grantUrl).searchParams.get('agent');
 await owner.p.goto(grantUrl);await owner.p.locator('.hub-grant input').fill('asker');await click(owner.p,'.dlg-actions .btn-primary','Allow Department A asker');await owner.p.locator('.hub-grant').waitFor({state:'detached'});await shot(owner.p,'A8-02-owner-grant');
 const o=await context(cases[0]);asker=o;await signIn(o.p,'asker');await o.p.locator('[data-entry=chat] button').click();await o.p.locator('.hub-pick-row button').first().click();await o.p.locator('#msgIn').waitFor();roomUrl=o.p.url();
 await o.p.fill('#msgIn','Department A acceptance question');await click(o.p,'#sendBtn','Send question');await waitFor(()=>deliveries.length===1,'question reaches representative');
 await new Promise(r=>setTimeout(r,200));receipt.answerResult=await reportHook({correlationId:deliveries[0].correlationId,caller:'general',text:'Recorded acceptance answer',callerCurrent:()=>memberLive});await o.p.getByText('Recorded acceptance answer',{exact:true}).waitFor();check('exact mock answer visible through full pipeline',true);await shot(o.p,'A8-02-answered');
});
