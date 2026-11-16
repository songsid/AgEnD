/** Proof-output guard only. This module never starts Windows, a CLI, or a model. */
import {writeFileSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {isIP} from 'node:net';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const profile=/(?:\\\\\?\\)?[a-z]:[\\/]+Users[\\/]+[^\\/\r\n"'`<>]+|\/mnt\/[a-z]\/Users\/[^/\r\n"'`<>]+/gi;
const home=/(?:\/home|\/Users)\/[^/\s"'`<>]+/g;
const email=/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const sid=/\bS-1-5-21(?:-\d+)+\b/gi;
const mac=/\b(?:[a-f\d]{2}[:-]){5}[a-f\d]{2}\b/gi;
const ipv4=/\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const fields=new Map([
 ['hostname','%COMPUTERNAME%'],['computername','%COMPUTERNAME%'],['machinename','%COMPUTERNAME%'],
 ['domain','%DOMAIN%'],['userdomain','%DOMAIN%'],['email','%EMAIL%'],['username','%USERNAME%'],
 ['sid','%SID%'],['mac','%MAC%'],['macaddress','%MAC%'],['ip','%HOST_IP%'],['ipaddress','%HOST_IP%'],
]);
const escaped=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const loopback=ip=>ip==='::1'||isIP(ip)===4&&ip.startsWith('127.');

function context(options={}){
 const env=options.environment??process.env;
 return {repo:options.repo??process.cwd(),home:options.home??homedir(),profile:env.USERPROFILE,
  names:[['COMPUTERNAME','%COMPUTERNAME%'],['USERDOMAIN','%DOMAIN%'],['USERNAME','%USERNAME%']]
   .flatMap(([key,label])=>typeof env[key]==='string'&&env[key].length>=3?[[env[key],label]]:[])};
}
function text(value,c){
 for(const [path,label] of [[c.profile,'%USERPROFILE%'],[c.repo,'%REPO%'],[c.home,'%HOME%']])
  if(path&&path!=='/'&&!/^[a-z]:[\\/]?$/i.test(path))value=value.replace(new RegExp(escaped(path),'gi'),()=>label);
 value=value.replace(profile,'%USERPROFILE%').replace(home,'%HOME%');
 for(const [name,label] of c.names)value=value.replace(new RegExp(`(?<![\\w])${escaped(name)}(?![\\w])`,'gi'),()=>label);
 return value.replace(email,'%EMAIL%').replace(sid,'%SID%').replace(mac,'%MAC%')
  .replace(ipv4,ip=>isIP(ip)&&!loopback(ip)?'%HOST_IP%':ip);
}
export function publicEvidence(value,options={}){
 const c=context(options);
 const visit=v=>typeof v==='string'?text(v,c):Array.isArray(v)?v.map(visit):v&&typeof v==='object'
  ?Object.fromEntries(Object.entries(v).map(([key,item])=>[key,typeof item==='string'&&item&&fields.has(key.toLowerCase())?fields.get(key.toLowerCase()):visit(item)])):v;
 return visit(value);
}
export function assertPublicEvidence(value,options={}){
 const body=typeof value==='string'?value:JSON.stringify(value);
 // Never echo a rejected value in an error: the error itself may become a log.
 if(publicEvidence(body,options)!==body)throw Error('Private host identifier refused in proof evidence');
}
export function writePublicEvidence(path,value,options={}){
 const safe=publicEvidence(value,options);assertPublicEvidence(safe,options);
 writeFileSync(path,JSON.stringify(safe,null,2)+'\n',{mode:0o600});return safe;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv.includes('--stdin')){
 const value=publicEvidence(JSON.parse(readFileSync(0,'utf8')));assertPublicEvidence(value);
 process.stdout.write(JSON.stringify(value,null,2)+'\n');
}
