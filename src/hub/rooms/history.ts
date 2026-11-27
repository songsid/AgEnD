import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {HubHttpMigration} from '../http/schema.js';
import {HubProtocolError} from '../validation.js';
import {ROOM_HISTORY_HOURLY_CALLS} from '../room-history-model.js';
export const HUB_ROOM_HISTORY_MIGRATION:HubHttpMigration=Object.freeze({component:'s3-room-history',version:1,up(db:Database.Database){
 db.exec('CREATE TABLE hub_room_history_budgets(exposure_id TEXT PRIMARY KEY, window INTEGER NOT NULL, used INTEGER NOT NULL)');
}});
/** One durable bucket per immutable exposure, shared across rooms, links and process restarts. */
export function spendRoomHistory(db:Database.Database,exposure:string,now:number):boolean{
 if(!Number.isSafeInteger(now)||now<0)throw new HubProtocolError('unavailable');
 const window=Math.floor(now/3600_000)*3600_000;
 const old=db.prepare('SELECT window,used FROM hub_room_history_budgets WHERE exposure_id=?').get(exposure) as {window:number;used:number}|undefined;
 if(old&&old.window>window)throw new HubProtocolError('unavailable');
 if(old?.window===window&&old.used>=ROOM_HISTORY_HOURLY_CALLS)return false;
 db.prepare('INSERT INTO hub_room_history_budgets VALUES(?,?,1) ON CONFLICT(exposure_id) DO UPDATE SET window=excluded.window, used=CASE WHEN window=excluded.window THEN used+1 ELSE 1 END').run(exposure,window);
 return true;
}
export const historyBinding=(exposure:string,owner:string,room:string,member:string,floor:number)=>createHash('sha256').update(JSON.stringify(['room-history-v1',exposure,owner,room,member,floor])).digest('hex');
export const historyCursor=(binding:string,before:string)=>Buffer.from(JSON.stringify({binding,before})).toString('base64url');
export function readHistoryCursor(cursor:string,binding:string):string|null{
 try{const v=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));return v.binding===binding&&typeof v.before==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v.before)?v.before:null;}catch{return null;}
}
