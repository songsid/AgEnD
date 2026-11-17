import {z} from "zod";
import {plain,uuid} from "./validation.js";
export const HUB_ROOM_MEMBERS_CAPABILITY="room-members-v2";
export const roomMemberOptions={query:plain(128).optional(),kind:z.enum(["agent","person"]).optional(),limit:z.number().int().min(1).max(50).optional(),cursor:z.string().max(200).regex(/^[A-Za-z0-9_-]+$/).optional()};
export type RoomMemberOptions={query?:string;kind?:"agent"|"person";limit?:number;cursor?:string};
export const boundedRoomMemberSchema=z.strictObject({id:plain(128),kind:z.enum(["agent","person","assistant"]),name:plain(256),presence:plain(32),owner:z.strictObject({name:plain(256)}).optional(),intro:plain(8192).optional(),mentionable:z.literal(false).optional()});
export const boundedRoomMembersSchema=z.strictObject({ok:z.literal(true),v2:z.literal(true),roomId:uuid,purpose:plain(8192),counts:z.strictObject({people:z.number().int().min(0),agents:z.number().int().min(0),assistant:z.boolean(),matched:z.number().int().min(0),returned:z.number().int().min(0)}),members:z.array(boundedRoomMemberSchema).max(50),next_cursor:z.string().max(200).optional(),hint:plain(128).optional()}).refine(v=>Buffer.byteLength(JSON.stringify(v))<=8192&&v.counts.returned===v.members.length&&v.members.every(m=>m.kind==="agent"?m.intro!==undefined&&m.owner!==undefined:m.kind==="assistant"?m.intro!==undefined&&m.owner===undefined&&m.mentionable===false:m.intro===undefined&&m.owner===undefined));
export type BoundedRoomMember=z.infer<typeof boundedRoomMemberSchema>;
