/** Captures authenticated accepted Hub deliveries before their journal's input-intent boundary. */
import type {DeliveryOutbox} from "./delivery-outbox.js";
import {freezeHubRequestSnapshot,hubRequestInputIdentity,prepareHubRequestInput,type OwnedHubRequestDelivery} from "./request-hub-context.js";
import {RequestContextReferenceMap,type RequestContextRegistrationGate} from "./request-context-fence.js";
import {RequestContextInputDeferred,type RequestContextRuntimeOwner,type RequestContextTurnSnapshot,type PreparedRequestContextInput} from "./request-context-turns.js";
import {requestContextDigest} from "./request-context-store.js";
interface Captured {root:string;delivery:OwnedHubRequestDelivery;image:string;wire:string|null;owner:string|null}
export interface RequestHubResolverPorts {
 readonly instance:string;
 current():boolean;
 runtimeOwner():Readonly<RequestContextRuntimeOwner>|null;
 active():RequestContextTurnSnapshot|null;
 registration:RequestContextRegistrationGate;
}
export class RequestHubInputResolver {
 private readonly inputs=new RequestContextReferenceMap<string,Captured>(row=>row.root,(_row,key)=>`hub-input:${key}`);
 constructor(private readonly box:DeliveryOutbox,private readonly ports:RequestHubResolverPorts){this.inputs.installRegistration(ports.registration);}
 private prune():void {for(const [key,row]of this.inputs)if(!row.delivery.stillCurrent())this.inputs.delete(key);}
 get drainRevision():string{this.prune();return this.inputs.revision;}
 drainView(root:string){this.prune();return this.inputs.view(root);}
 private current(owner:Readonly<RequestContextRuntimeOwner>):void {
  if(!this.ports.current()||owner.instance!==this.ports.instance||requestContextDigest(this.ports.runtimeOwner())!==requestContextDigest(owner))throw Error("Hub request input owner changed");
 }
 /** Called by the accepted Hub delivery owner; never exposed as a tool or a metadata parser. */
 capture(input:OwnedHubRequestDelivery):Readonly<{inputId:string;beforeInput():void;waitBeforeInput():Promise<boolean>}> {
  const owner=this.ports.runtimeOwner();if(!owner)throw Error("Hub request input owner is unavailable");this.current(owner);
  if(input.agent!==this.ports.instance||!input.stillCurrent()||!input.acceptedHubRequest)throw Error("Hub accepted request is unavailable");
  const accepted=freezeHubRequestSnapshot(input.acceptedHubRequest),identity=hubRequestInputIdentity(accepted),actor={...accepted.actor};
  if("displayName"in actor)delete actor.displayName;
  const image=requestContextDigest({...accepted,actor});this.prune();
  const previous=this.inputs.get(identity.inputId);
  if(previous&&previous.image!==image)throw Error("Hub accepted request changed");
  if(!previous&&this.inputs.size>=16_384)throw Error("Hub request input capacity reached");
  const delivery={agent:input.agent,acceptedHubRequest:previous?.delivery.acceptedHubRequest??accepted,stillCurrent:()=>input.stillCurrent()&&this.ports.current()};
  this.inputs.set(identity.inputId,{root:identity.contextId,delivery,image,wire:previous?.wire??null,owner:previous?.owner??null});
  const beforeInput=()=>{
   this.current(owner);const row=this.inputs.get(identity.inputId);
   if(!row||row.image!==image||!row.delivery.stillCurrent())throw Error("Hub accepted request is no longer current");
   // Test before consuming the Hub's begin lease. Idle is not a permission to join another turn.
   if(this.ports.active())throw new RequestContextInputDeferred();
   this.ports.registration.assertRegistration(identity.contextId);this.current(owner);
  };
  const waitBeforeInput=async()=>{
   while(input.stillCurrent()){
    try{beforeInput();return true;}catch(error){if(!(error instanceof RequestContextInputDeferred))throw error;}
    // Polling schedules a recheck; elapsed time never proves that the owned turn ended.
    await new Promise<void>(resolve=>setTimeout(resolve,50));
   }
   return false;
  };
  return Object.freeze({inputId:identity.inputId,beforeInput,waitBeforeInput});
 }
 prepare(inputId:string,wireSha256:string,owner:Readonly<RequestContextRuntimeOwner>):PreparedRequestContextInput|null {
  if(!inputId.startsWith("hub-input:"))return null;this.current(owner);
  const row=this.inputs.get(inputId);if(!row||!row.delivery.stillCurrent())throw Error("Hub accepted request input is unavailable");
  const ownerImage=requestContextDigest(owner);
  if(row.wire!==null&&(row.wire!==wireSha256||row.owner!==ownerImage))throw Error("Hub accepted request wire changed");
  const prepared=prepareHubRequestInput(row.delivery,owner,wireSha256,{context:id=>this.box.requestContext(id),current:()=>this.ports.active()});
  this.current(owner);if(!row.delivery.stillCurrent())throw Error("Hub accepted request is no longer current");
  // First owned write fixes the exact final wire. Retries may never substitute a new message or runtime owner.
  this.inputs.set(inputId,{...row,wire:wireSha256,owner:ownerImage});return prepared;
 }
}
