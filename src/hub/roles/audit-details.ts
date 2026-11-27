/** Metadata-only historical labels. These values are presentation, never identity or authority. */
import {z} from "zod";
import {plain} from "../validation.js";
import {ROLE_PERMISSIONS} from "./model.js";
import type Database from "better-sqlite3";
import {personKeyString} from "../identity.js";
import type {HubRole,HubRoleAssignment,HubRolePolicy,RolePermission} from "./model.js";
export interface RoleAuditValue {
 roleName?:string;roleKind?:HubRole["kind"];systemRole?:"first-administrator-self-use";
 description?:string;permissions?:RolePermission[];defaultMaxFleets?:number;
 subject?:{kind:"person"|"group";personId?:string;name:string|null};scope?:{kind:"hub"|"group";name?:string};
 startsAt?:number;expiresAt?:number|null;maxFleets?:number|null;rolesActive?:boolean;state?:string;
}
export interface RoleAuditDetails {kind:"role"|"assignment"|"policy"|"root-self";before:RoleAuditValue|null;after:RoleAuditValue|null}
export function rolePersonLabel(db:Database.Database,id:string):string|null {
 // Labels are optional caches; old stores and missing people must render Unknown, never an opaque id.
 for(const table of ["hub_people","hub_room_people"]){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
  const row=db.prepare(`SELECT display_name FROM ${table} WHERE person=?`).get(id) as {display_name:string}|undefined;
  if(row?.display_name)return row.display_name;
 }
 return null;
}
export function roleAuditValue(role:HubRole):RoleAuditValue {
 return {roleName:role.name,roleKind:role.kind,...(role.id.startsWith("root-self:")?{systemRole:"first-administrator-self-use" as const}:{}),...(role.description!==undefined?{description:role.description}:{}),permissions:[...role.permissions],defaultMaxFleets:role.defaultMaxFleets};
}
export function assignmentAuditValue(assignment:HubRoleAssignment,policy:HubRolePolicy,label:(id:string)=>string|null):RoleAuditValue {
 const role=policy.roles.find(role=>role.id===assignment.roleId);
 return {...(role?roleAuditValue(role):{}),subject:assignment.subject.kind==="person"?{kind:"person",personId:personKeyString(assignment.subject.person),name:label(personKeyString(assignment.subject.person))}:{kind:"group",name:assignment.subject.dn},scope:assignment.scope.kind==="hub"?{kind:"hub"}:{kind:"group",name:assignment.scope.dn},startsAt:assignment.startsAt,expiresAt:assignment.expiresAt,maxFleets:assignment.maxFleets};
}

const valueSchema=z.strictObject({roleName:plain(120).optional(),roleKind:z.enum(["admin","manager","member","carried-over","custom"]).optional(),systemRole:z.literal("first-administrator-self-use").optional(),description:plain(500).optional(),permissions:z.array(z.enum(ROLE_PERMISSIONS)).max(ROLE_PERMISSIONS.length).optional(),defaultMaxFleets:z.number().int().min(0).max(8).optional(),subject:z.strictObject({kind:z.enum(["person","group"]),personId:plain(256).optional(),name:plain(4096).nullable()}).optional(),scope:z.strictObject({kind:z.enum(["hub","group"]),name:plain(4096).optional()}).optional(),startsAt:z.number().nonnegative().optional(),expiresAt:z.number().nonnegative().nullable().optional(),maxFleets:z.number().int().min(0).max(8).nullable().optional(),rolesActive:z.boolean().optional(),state:z.enum(["never-enabled","enabled","suspended"]).optional()});
export const roleAuditDetailsSchema=z.strictObject({kind:z.enum(["role","assignment","policy","root-self"]),before:valueSchema.nullable(),after:valueSchema.nullable()});
