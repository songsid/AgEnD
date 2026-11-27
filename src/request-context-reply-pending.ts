import type {RequestContextTurnSnapshot} from "./request-context-turns.js";
import type {TurnReplyRouteLease} from "./turn-reply-guard.js";

/** Scheduling only: never retained, never a receipt or permission. */
export interface PendingReplyDelivery {
  confirm(): void;
  arm(route:TurnReplyRouteLease):void;
  refuse():void;
  wait(budgetMs:number):Promise<TurnReplyRouteLease|undefined>;
}
const key=(snapshot:RequestContextTurnSnapshot,inputId:string,wireSha256:string)=>JSON.stringify([
  inputId,snapshot.token,wireSha256,snapshot.owner,
]);
/** A call captures this exact delivery before waiting. A later steer cannot retarget it. */
export class RequestContextPendingReplies {
  private readonly entries=new Map<string,PendingReplyDelivery>();
  stage(snapshot:RequestContextTurnSnapshot,inputId:string,wireSha256:string,current:()=>boolean):PendingReplyDelivery|undefined {
    const id=key(snapshot,inputId,wireSha256);
    // Optional scheduling must never fail an otherwise admitted input write.
    // A duplicate cannot replace an earlier waiter or lend it a new route.
    const previous=this.entries.get(id);
    if(previous){previous.refuse();return undefined;}
    if(this.entries.size>=128)return undefined;
    let confirmed=false,route:TurnReplyRouteLease|undefined,refused=false;
    const waiters=new Set<(route:TurnReplyRouteLease|undefined)=>void>();
    const live=()=>{try{return current()===true;}catch{return false;}};
    const ready=()=>{try{return !refused&&confirmed&&live()&&route?.binding===snapshot.token&&route.current()?route:undefined;}catch{return undefined;}};
    const notify=()=>{const value=ready();if(!refused&&!value)return;for(const resolve of [...waiters])resolve(value);};
    const record:PendingReplyDelivery=Object.freeze({
      confirm:()=>{if(!refused){confirmed=true;notify();}},
      arm:(next:TurnReplyRouteLease)=>{
        if(refused)return;
        if(next.binding!==snapshot.token||!live()){record.refuse();return;}
        route=next;notify();
      },
      refuse:()=>{refused=true;route=undefined;if(this.entries.get(id)===record)this.entries.delete(id);notify();},
      wait:(budgetMs:number)=>new Promise<TurnReplyRouteLease|undefined>(resolve=>{
        const value=ready();if(value||refused||!live()){resolve(value);return;}
        let timer:ReturnType<typeof setTimeout>;
        const finish=(value:TurnReplyRouteLease|undefined)=>{clearTimeout(timer);waiters.delete(finish);resolve(value);};
        timer=setTimeout(()=>{
          // Expiry is refusal, never evidence. A late confirmation cannot revive
          // this delivery for the timed-out call or a newly captured waiter.
          record.refuse();
        },Math.max(0,budgetMs));
        waiters.add(finish);
      }),
    });
    this.entries.set(id,record);return record;
  }
  capture(snapshot:RequestContextTurnSnapshot):PendingReplyDelivery|undefined {
    return this.entries.get(key(snapshot,snapshot.inputId,snapshot.wireSha256));
  }
  clear():void {for(const record of this.entries.values())record.refuse();}
}
