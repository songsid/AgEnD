/** A partial overview is disclosed only under its own operation permits, never a session display flag. */
import type {HubRequestContext} from "../types.js";
import {HubProtocolError} from "../validation.js";
import type {HubManagementAuthority,HubManagementPermit} from "./authority.js";
export async function hubAdminOverviewPermit(ctx:HubRequestContext,authority:Pick<HubManagementAuthority,"require">){
 const kinds=["fleets.manage","join.manage"] as const;
 const attempts=await Promise.allSettled(kinds.map(cap=>authority.require(ctx,cap)));
 const permits:HubManagementPermit[]=attempts.flatMap(result=>result.status==="fulfilled"?[result.value]:[]);
 if(!permits.length){
  const unavailable=attempts.some(result=>result.status==="rejected"&&(!(result.reason instanceof HubProtocolError)||result.reason.code!=="denied"));
  throw new HubProtocolError(unavailable?"unavailable":"denied");
 }
 const assertCurrent=()=>{for(const permit of permits)permit.assertCurrent();};assertCurrent();
 return{fleets:permits.some(p=>p.permission==="fleets.manage"),joining:permits.some(p=>p.permission==="join.manage"),assertCurrent};
}
