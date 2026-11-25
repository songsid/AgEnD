/** Internal retirement gates; never a human receipt, permission or serialized authority. */
import type Database from "better-sqlite3";
export interface RequestContextRegistrationGate { assertRegistration(rootId:string):void }
export interface RequestContextDrainView {
  registration:RequestContextRegistrationGate|null; revision:string; references:string[]; unknown:boolean;
}
export function assertRequestContextRootOpen(db:Database.Database,rootId:string):void {
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_context_drain_v1'").get()
    &&db.prepare("SELECT 1 FROM request_context_drain_v1 WHERE root_id=?").get(rootId))throw Error("request-context root is draining");
}
/** Revisions cover inserts, replacements and deletions, even when a root returns to an empty state. */
export class RequestContextReferenceMap<K,V> extends Map<K,V> {
  private serial=0; private registration:RequestContextRegistrationGate|null=null;
  constructor(private readonly root:(value:V)=>string|null,private readonly reference:(value:V,key:K)=>string){super();}
  installRegistration(registration:RequestContextRegistrationGate|undefined):void {
    if(!registration)return;
    if(this.registration||this.size)throw Error("request-context drain registration must precede work");
    this.registration=registration;this.serial++;
  }
  get registrationGate():RequestContextRegistrationGate|null{return this.registration;}
  get revision():string{return String(this.serial);}
  override set(key:K,value:V):this {
    const root=this.root(value);if(root)this.registration?.assertRegistration(root);
    super.set(key,value);this.serial++;return this;
  }
  override delete(key:K):boolean {const deleted=super.delete(key);if(deleted)this.serial++;return deleted;}
  override clear():void {super.clear();this.serial++;}
  view(rootId:string):RequestContextDrainView {
    const references:string[]=[];let unknown=false;
    for(const [key,value]of this){const root=this.root(value);if(root===null)unknown=true;else if(root===rootId)references.push(this.reference(value,key));}
    return {registration:this.registration,revision:this.revision,references,unknown};
  }
}
