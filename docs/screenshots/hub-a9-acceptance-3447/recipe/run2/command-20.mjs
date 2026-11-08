const a=globalThis.a9,p=a.hostFleet.page;
a.r.fm.logger.warn=(meta,msg)=>{(a.diagnosticLogs??=[]).push({msg,error:meta?.error,err:meta?.err?.message??meta?.err})};
const next=p.waitForResponse(r=>new URL(r.url()).pathname==='/api/settings/hub/preview'&&r.request().method()==='PUT');await p.locator('.hub-preview-settings button[type=submit]').click();const res=await next;const body=await res.json();await a.shot(p,'A9-13-desk-preview-refusal');return{status:res.status(),body,logs:a.diagnosticLogs};
