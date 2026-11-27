/** Read-only Go back disclosure. Settings binds this exact offer; it never accepts an offered id from the browser. */
import {readGoBackOffer,type GoBackOffer} from "./update-goback.js";
import {requestContextDigest} from "./request-context-store.js";
const attempt=/^\d{8}T\d{6}Z-[a-f0-9]{8}$/;
export interface RequestContextEnableOffer {
 readonly invalidates:readonly string[];
 readonly latestDeadline:number|null;
 readonly sha256:string;
 /** Re-read under the activation home lock, including immediately before its SQLite COMMIT. */
 current():boolean;
}
function image(value:GoBackOffer){
 if(value.unavailable.some(row=>!attempt.test(row.attemptId)))throw Error("Go back offer unavailable");
 const eligible=value.eligible.map(row=>({...row})).sort((a,b)=>a.attemptId.localeCompare(b.attemptId));
 if(new Set(eligible.map(row=>row.attemptId)).size!==eligible.length||eligible.some(row=>!attempt.test(row.attemptId)
  ||!Number.isSafeInteger(row.committedAt)||row.committedAt<0||!Number.isSafeInteger(row.expiresAt)||row.expiresAt<=row.committedAt
  ||!row.from||!row.version))throw Error("Go back offer unavailable");
 const deadline=eligible.length?Math.max(...eligible.map(row=>row.expiresAt)):null;
 if(deadline!==value.latestDeadline)throw Error("Go back offer unavailable");
 return {eligible,latestDeadline:deadline};
}
/** The optional reader/clock are fixture ports. The production reader verifies retained artifacts and writes nothing.
 * A missing retained file means no offer; unreadable/malformed history is not permission to close an undisclosed window.
 */
export function captureRequestContextEnableOffer(home:string,now:()=>number=Date.now,
 read:(home:string,now:number)=>GoBackOffer=readGoBackOffer):RequestContextEnableOffer {
 const first=image(read(home,now())),sha256=requestContextDigest(first);
 return Object.freeze({invalidates:Object.freeze(first.eligible.map(row=>row.attemptId)),latestDeadline:first.latestDeadline,sha256,
  current:()=>{try{return requestContextDigest(image(read(home,now())))===sha256;}catch{return false;}}});
}
