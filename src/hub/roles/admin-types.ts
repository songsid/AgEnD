/** Server-owned role administration port. Browser presentation is never an operation permit. */
import type {HubRequestContext,PersonKey} from "../types.js";
import type {HubRolePolicy,RolePermission} from "./model.js";
import type {RolePreviewResponse,RoleApplyResponse} from "./writer.js";
export interface RoleAdminView {
  policy: HubRolePolicy | null;
  permissions: readonly RolePermission[];
  root: PersonKey; actor: PersonKey;
  management: readonly string[];
  rootSelfUsed: boolean;
}
export interface RoleDirectoryCandidate {kind:"person"|"group";key:PersonKey;name:string;login?:string;dn?:string}
export interface RoleAuditRow {id:string;at:number;actor:{id:string;name:string};action:string;result:string;summary:readonly string[]}
export interface RoleAuditPage {rows:readonly RoleAuditRow[];nextCursor:string|null}
export interface RoleAdminControl {
  presentation(ctx:HubRequestContext):Promise<{admin:boolean;management:readonly string[]}>;
  read(ctx:HubRequestContext):Promise<RoleAdminView>;
  search(ctx:HubRequestContext,input:unknown):Promise<readonly RoleDirectoryCandidate[]>;
  preview(ctx:HubRequestContext,input:unknown):Promise<RolePreviewResponse>;
  apply(ctx:HubRequestContext,input:unknown):Promise<RoleApplyResponse>;
  previewRootSelf(ctx:HubRequestContext):Promise<RolePreviewResponse>;
  applyRootSelf(ctx:HubRequestContext,input:unknown):Promise<RoleApplyResponse>;
  audit(ctx:HubRequestContext,input:unknown):Promise<RoleAuditPage>;
  notices(ctx:HubRequestContext):Promise<unknown>;
  acknowledge(ctx:HubRequestContext,id:string):Promise<unknown>;
}
