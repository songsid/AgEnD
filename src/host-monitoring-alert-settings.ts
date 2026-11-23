import {hostAlertDefaultRule,detectMonitoringPlatform} from './host-monitoring-defaults.js';
import type {MonitoringPlatform} from './host-monitoring.js';
/** Separate rollback-safe alert preferences. No file read occurs on import or snapshot reads. */
import {openSync,closeSync,fstatSync,readSync,constants,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {atomicWriteFileSync} from './atomic-write.js';
import {noteSettingsWrite} from './settings-transaction.js';
import {HOST_ALERT_DEFAULTS,hostAlertKey,validateHostAlertRule,type HostAlertRule} from './host-monitoring-alert-policy.js';
export interface HostAlertSettings {version:1;needsYou:boolean;general:boolean;rules:Record<string,HostAlertRule>}
export const defaultHostAlertSettings=():HostAlertSettings=>({version:1,needsYou:true,general:false,rules:{}});
export const hostAlertSettingsPath=(dir:string)=>join(dir,'host-monitoring-alert-settings.json');
export function parseHostAlertSettings(value:unknown):HostAlertSettings {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_alert_settings');
 const v=value as HostAlertSettings;
 if(Object.keys(v).some(k=>!['version','needsYou','general','rules'].includes(k))||v.version!==1||typeof v.needsYou!=='boolean'||typeof v.general!=='boolean'||!v.rules||typeof v.rules!=='object'||Array.isArray(v.rules)||Object.keys(v.rules).length>64)throw Error('invalid_alert_settings');
 for(const [key,rule] of Object.entries(v.rules)){if(!hostAlertKey(key))throw Error('invalid_alert_key');validateHostAlertRule(rule);if((key==='cpu'&&rule.kind!=='cpu')||(key==='memory'&&rule.kind!=='memory')||(!['cpu','memory'].includes(key)&&!/^disk:[a-f0-9]{16}$/.test(key)))throw Error('invalid_alert_resource');if(key.startsWith('disk:')&&!['filesystem','backing-drive'].includes(rule.kind))throw Error('invalid_alert_resource');}
 return structuredClone(v);
}
export function parseHostAlertSettingsBytes(bytes:Buffer|null):HostAlertSettings {
 if(bytes===null)return defaultHostAlertSettings();
 if(bytes.length>32*1024)throw Error('invalid_alert_settings');
 return parseHostAlertSettings(JSON.parse(bytes.toString('utf8')));
}
export function readHostAlertSettings(dir:string):HostAlertSettings {
 let fd:number|undefined;
 try{fd=openSync(hostAlertSettingsPath(dir),constants.O_RDONLY|constants.O_NOFOLLOW);const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>32*1024||(stat.mode&0o777)!==0o600)throw Error('invalid_alert_settings');const bytes=Buffer.alloc(32*1024+1);let size=0,n:number;while(size<bytes.length&&(n=readSync(fd,bytes,size,bytes.length-size,null)))size+=n;return parseHostAlertSettingsBytes(bytes.subarray(0,size));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return defaultHostAlertSettings();throw error;}
 finally{if(fd!==undefined)closeSync(fd);}
}
export function writeHostAlertSettings(dir:string,value:HostAlertSettings):void {
 const next=parseHostAlertSettings(value),previous=readHostAlertSettings(dir);mkdirSync(dir,{recursive:true,mode:0o700});
 atomicWriteFileSync(hostAlertSettingsPath(dir),JSON.stringify(next)+'\n',{mode:0o600});noteSettingsWrite(hostAlertSettingsPath(dir),previous,next);
}
/** A legacy explicit memory rule predates criticalOnly and keeps its former warning behavior. */
export function hostAlertRuleFor(settings:HostAlertSettings,key:string,kind:HostAlertRule['kind'],platform:MonitoringPlatform=detectMonitoringPlatform()):HostAlertRule{
 const saved=settings.rules[key];return{...hostAlertDefaultRule(kind,platform),...saved,...(kind==='memory'&&saved&&!Object.hasOwn(saved,'criticalOnly')?{criticalOnly:false}:{})};
}
