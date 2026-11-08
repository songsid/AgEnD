const a=globalThis.a9,out=[];
for(const device of ['desk','phone']){
 const fp=device==='desk'?a.hostFleet:await a.fleetPage(a.r.fm,a.r.fleetOrigin,'phone','dark');if(device==='phone')a.hostPhone=fp;const p=fp.page;
 await p.locator('#hubRunOn').waitFor();await p.locator('.hub-run-settings').scrollIntoViewIfNeeded();await p.locator('#hubRunOn').click();await p.locator('dialog[open]').waitFor();await a.shot(p,'A9-14-'+device+'-stop-confirm');
 await p.locator('dialog[open] .btn:not([data-confirm])').click();a.check(a.r.fm.getRawFleetConfig().hub.enabled===true,'Cancel stopped Hub');
 await p.locator('#hubRunOn').click();await p.locator('[data-confirm=yes]').waitFor();const response=p.waitForResponse(r=>new URL(r.url()).pathname==='/api/settings/hub/run'&&r.request().method()==='PUT');await p.locator('[data-confirm=yes]').click();const res=await response;const body=await res.json();
 await p.locator('.hub-run-settings [role=status]').waitFor();await a.shot(p,'A9-14-'+device+'-stop-refused');out.push({device,status:res.status(),body,enabled:a.r.fm.getRawFleetConfig().hub.enabled,text:await p.locator('.hub-run-settings').innerText()});
}
a.runFailure=out;return out;
