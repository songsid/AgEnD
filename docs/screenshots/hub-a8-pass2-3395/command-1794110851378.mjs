const used = (agents = [], fleetDefault = false) => ({ agents, classic: [], fleetDefault });
const machine = { kind: "machine", id: "m1", name: "Desk PC", online: true };
const VIEW = { clis: [
  { backend: "claude-code", profiles: true, installed: true, fleetDefault: null, agents: [{ name: "dev", profile: "work" }, { name: "ops", profile: null }],
    rows: [
      { scope: { kind: "host" }, backend: "claude-code", profile: null, state: "usable", signIn: true, identity: { maskedEmail: "ab***@example.com", plan: "max" }, usedBy: used(["ops"], true), usage: { percent: 37, windowMs: 604800000 } },
      { scope: { kind: "host" }, backend: "claude-code", profile: "personal", state: "not_signed_in", signIn: true, usedBy: used() },
      { scope: { kind: "host" }, backend: "claude-code", profile: "lab", state: "unknown", signIn: true, usedBy: used() },
      { scope: machine, backend: "claude-code", profile: "work", state: "usable", signIn: true, identity: { maskedEmail: "cd***@example.com", plan: "team" }, usedBy: used(["dev"]) },
      { scope: machine, backend: "claude-code", profile: "spare", state: "not_signed_in", signIn: true, usedBy: used() },
    ] },
] };

await story('P2-support-Accounts-leftbar-computed-style',async()=>{receipt.accountsBoundary='Only /ui/accounts inventory response is synthetic for state-colour visual coverage; not account/install/login acceptance.';for(const c of matrix('quick')){const o=await hostPage(c);await o.p.route(/\/ui\/accounts(\?.*)?$/,r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(VIEW)}));await o.p.goto(fx.base+'/settings/agents');await o.p.locator('.s-account-row').first().waitFor({state:'attached'});await o.p.evaluate(()=>document.querySelectorAll('.p-settings details').forEach(d=>d.open=true));await o.p.locator('.s-account-card').first().scrollIntoViewIfNeeded();const rows=await o.p.locator('.s-account-row').evaluateAll(rr=>rr.map(el=>{const s=getComputedStyle(el),b=getComputedStyle(el,'::before');return{lbar:el.classList.contains('lbar'),border:s.borderLeftWidth,width:b.width,radius:b.borderTopLeftRadius,color:b.backgroundColor};}));check('5 straight account-state bars '+caseName(c),rows.length===5&&rows.every(r=>r.border==='0px'&&r.width==='3px'&&r.radius==='0px')&&new Set(rows.map(r=>r.color)).size===3);receipt.accountsRows??=[];receipt.accountsRows.push({case:caseName(c),rows});await shot(o.p,'P2-accounts-leftbar-'+caseName(c));await o.ctx.close();}});
