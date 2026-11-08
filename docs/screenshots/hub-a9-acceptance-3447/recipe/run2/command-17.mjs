const a=globalThis.a9,p=a.admins[0].p;await p.reload();await p.locator('#hubThisName').waitFor();a.check(await p.locator('#hubThisName').inputValue()==='','Clear did not persist');await p.locator('.hub-this-hub').scrollIntoViewIfNeeded();await a.shot(p,'A9-12-desk-cleared');
const phone=a.admins[1].p;await phone.reload();await phone.locator('.hub-this-hub').scrollIntoViewIfNeeded();await a.shot(phone,'A9-12-phone-cleared');
a.hostFleet=await a.fleetPage(a.r.fm,a.r.fleetOrigin,'desk');await a.hostFleet.page.locator('.hub-run-settings').waitFor();await a.shot(a.hostFleet.page,'A9-13-desk-host-settings');
return{clearPersisted:true,hostText:await a.hostFleet.page.locator('main').last().innerText(),port:await a.hostFleet.page.locator('#hubPreviewPort').count()};
