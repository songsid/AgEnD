await story('A8-11-revoke-completion',async()=>{
 if(await owner.p.locator('.hub-grant').count())await owner.p.locator('.dlg-actions button').first().click();
 await owner.p.getByRole('button',{name:'More for asker',exact:true}).click();await owner.p.getByRole('menuitem',{name:'Revoke…',exact:true}).click();await owner.p.locator('.dlg-actions .btn-danger').click();await owner.p.getByRole('button',{name:'More for asker',exact:true}).waitFor({state:'detached'});await shot(owner.p,'A8-11-grant-revoked');
 receipt.heldAnswerResult=await reportHook({correlationId:deliveries.at(-1).correlationId,caller:'general',text:'HELD_SECRET_MUST_NOT_APPEAR',callerCurrent:()=>memberLive});check('late answer refuses',receipt.heldAnswerResult.ok===false);
 await asker.p.reload();await asker.p.locator('.hub-chat').waitFor();await shot(asker.p,'A8-11-stale-room-after-revoke');check('late protected answer absent',await asker.p.getByText('HELD_SECRET_MUST_NOT_APPEAR',{exact:true}).count()===0);
 await local.p.reload();await local.p.locator('.hub-exposure.is-shared input').click();await local.p.locator('.hub-exposure.is-shared').waitFor({state:'detached'});await shot(local.p,'A8-11-local-withdrawn');check('withdraw saved locally',true);
});
await story('A8-08-connected-matrix',async()=>{for(const c of matrix('full')){const o=await context(c);await signIn(o.p,'owner');await o.p.getByText(c.lang==='en'?'Connected':'已連接',{exact:true}).waitFor();await shot(o.p,`A8-08-connected-${caseName(c)}`);await geometry(o.p,caseName(c)+' connected');await o.ctx.close();}});
