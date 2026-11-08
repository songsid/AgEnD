await story('P2-A8-09-natural-expiry-and-new-code-recovery',async()=>{
 const x=globalThis.p2Expiry;if(!x)throw Error('natural expiry was not started');
 console.log('EXPIRY_OBSERVE_BEGIN',Date.now(),x.expiresAt);
 while(Date.now()<x.expiresAt+1500)await pauseMs(500);
 await x.e.p.getByText('This attempt expired or was replaced. It cannot connect a fleet. Start again.',{exact:true}).waitFor({timeout:20000});
 check('actual clock reached server expiry',Date.now()>=x.expiresAt);check('expired attempt issued no credential',x.ep.view().state!=='paired');
 await shot(x.e.p,'P2-A8-09-natural-expiry-Hub');
 fx.fm.attachHubMemberPairing(x.ep);const pending=await hostPage(cases[0]);await pending.p.locator('.hub-pending,.hub-held').first().waitFor();await shot(pending.p,'P2-A8-09-natural-expiry-local');await pending.ctx.close();
 for(const c of matrix('quick')){
  const h=join(scratch,'expired-retry-'+caseName(c));mkdirSync(h,{mode:0o700});const ep=createHubMemberPairingApi({home:h,enabled:()=>true});extraPairings.push(ep);fx.fm.attachHubMemberPairing(ep);const l=await hostPage(c);
  await l.p.fill('#hubAddress',memberOrigin);await l.p.fill('#hubCode',x.code);await l.p.locator('#hub-connect form button[type=submit]').click();
  const text=c.lang==='zh-TW'?'配對未完成。請在 Hub 重新開始配對，再將新的代碼填在這裡。':'Pairing did not finish. Start a new pairing on the Hub and use its new code here.';
  await l.p.getByText(text,{exact:true}).waitFor({timeout:20000});check('known expiry retires local waiting '+caseName(c),!/Waiting for your confirmation|等待你的確認/.test(await l.p.locator('body').innerText()));check('failed new connect remains unpaired',ep.view().state==='unpaired');await l.p.getByText(text,{exact:true}).scrollIntoViewIfNeeded();await shot(l.p,'P2-A8-09-expired-code-next-step-'+caseName(c));ep.cancel();await l.ctx.close();
 }
 receipt.naturalExpiry.finished=Date.now();await x.e.ctx.close();activateMount(globalThis.p2Primary);
});
