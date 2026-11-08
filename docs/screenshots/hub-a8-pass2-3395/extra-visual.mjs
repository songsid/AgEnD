await story('P2-connected-phone-and-local-zh',async()=>{
 await owner.p.setViewportSize({width:390,height:844});await owner.p.getByText('Connected',{exact:true}).waitFor();await owner.p.locator('[data-quick-pairing]').scrollIntoViewIfNeeded();await geometry(owner.p,'connected phone');await shot(owner.p,'P2-connected-phone-en');await owner.p.setViewportSize({width:1366,height:900});
 const o=await hostPage(matrix('quick')[1]);await o.p.locator('.hub-paired').waitFor();check('phone paired no stale confirmation',!/等待你的確認/.test(await o.p.locator('body').innerText()));await o.p.locator('.hub-paired').scrollIntoViewIfNeeded();await shot(o.p,'P2-local-online-phone-zh');await o.ctx.close();
});
