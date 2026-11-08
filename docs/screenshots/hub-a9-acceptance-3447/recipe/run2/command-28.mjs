const a=globalThis.a9,m=a.members[0];a.mockInputs=[];a.mockReports=[];
m.fx.fm.hubAgentQuota=async()=>({band:'available'});
m.fx.fm.deliverHubQuestion=async(input)=>{if(!input.stillCurrent()||!(await input.beforeInput()))return false;a.mockInputs.push(input);if(!a.holdModelReply)setTimeout(async()=>{const q=await m.fx.fm.hubReport({correlationId:input.correlationId,caller:input.agent,text:'這是隔離模型的測試回答。',callerCurrent:()=>input.stillCurrent()});a.mockReports.push(q)},100);return true};
await m.page.reload();await m.page.locator('.hub-exposure-list').waitFor();return{exposures:await m.page.locator('.hub-exposures').innerText(),controls:await m.page.locator('.hub-exposure input').evaluateAll(es=>es.map(e=>({checked:e.checked,disabled:e.disabled,role:e.getAttribute('role')})))};
