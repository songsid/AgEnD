/** #1411: Grok has additive MCP discovery, not an exclusive config flag. The project holds only an identity-free
 * shell shim; this launch's directory and binding select a private, guarded wrapper. No Grok auth/home relocation. */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ensureInstanceDir } from "../private-dir.js";
import { atomicWriteFileSync } from "../atomic-write.js";
import { shellQuote, type CliBackendConfig } from "./types.js";

const PRIVATE = "grok-mcp.json";
const HEADER = "#!/bin/bash\n# AgEnD Grok MCP launch binding v1\n";
const WAIT = '# Wait for IPC socket to be ready (up to 10s)\nfor i in $(seq 1 20); do [ -S "$AGEND_SOCKET_PATH" ] && break; sleep 0.5; done\n';
const FAIL = 'printf "%s\\n" "AgEnD MCP: missing or conflicting Grok launch binding; no tools loaded." >&2; exit 78';
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const read = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } };
const fingerprint = (c: CliBackendConfig) => createHash("sha256").update(JSON.stringify([c.instanceName,c.workingDirectory,c.mcpServers])).digest("hex");
export function legacyGrokMcpKey(server: string, instance: string): string {
  const ascii=instance.replace(/[^\x20-\x7E]/g, ""); if (ascii===instance) return `${server}-${instance}`;
  const slug=ascii.replace(/[^A-Za-z0-9]+/g,"-").replace(/^-+|-+$/g,"");
  const hash=createHash("md5").update(instance).digest("hex").slice(0,8);
  return slug ? `${server}-${slug}-${hash}` : `${server}-${hash}`;
}
function shim(name: string) {
  return {command:"/bin/bash",args:["-c",`if [ -z "\${AGEND_GROK_MCP_DIR:-}" ] || [ -z "\${AGEND_GROK_MCP_BINDING:-}" ]; then ${FAIL}; fi\nexec "\${AGEND_GROK_MCP_DIR}/mcp-wrapper-${name}.sh"`]};
}

/** Retain each untouched JSON member's source bytes, including its spelling/whitespace. Reject duplicate keys. */
interface Member {key: string; raw: string; start: number; end: number}
function members(text: string, at=0): {items:Member[];close:number} {
  const ws=(i:number)=>{while (/\s/.test(text[i]??"") && i<text.length)i++;return i;};
  const stringEnd=(i:number)=>{for(let j=i+1;j<text.length;j++){if(text[j]==="\\")j++;else if(text[j]==='"')return j+1;}throw Error("Grok MCP: invalid JSON string");};
  const valueEnd=(i:number):number=>{
    if(text[i]==='"')return stringEnd(i);
    if(text[i]==="{"||text[i]==="["){const stack=[text[i]];for(let j=i+1;j<text.length;j++){if(text[j]==='"')j=stringEnd(j)-1;else if(text[j]==="{"||text[j]==="[")stack.push(text[j]);else if(text[j]==="}"||text[j]==="]"){stack.pop();if(!stack.length)return j+1;}}throw Error("Grok MCP: incomplete JSON");}
    let j=i;while(j<text.length&&!/[\s,}\]]/.test(text[j]))j++;return j;
  };
  let i=ws(at);if(text[i]!=="{")throw Error("Grok MCP: expected a JSON object");i++;
  const items:Member[]=[],seen=new Set<string>();
  while(true){const begin=i;i=ws(i);if(text[i]==="}")return{items,close:i};
    if(text[i]!=='"')throw Error("Grok MCP: expected a JSON member");const kEnd=stringEnd(i),key=JSON.parse(text.slice(i,kEnd));if(seen.has(key))throw Error("Grok MCP: duplicate JSON member");seen.add(key);
    i=ws(kEnd);if(text[i++]!==":")throw Error("Grok MCP: expected a JSON colon");const start=ws(i),end=valueEnd(start);i=ws(end);items.push({key,raw:text.slice(begin,i),start,end});
    if(text[i]===","){i++;continue;}if(text[i]!=="}")throw Error("Grok MCP: invalid JSON separator");
  }
}

/** A path/key alone is not provenance: require the old exact generated wrapper contour at its canonical path. */
function legacyOwner(key:string,value:unknown,instanceDir:string,cwd:string): "ours"|"foreign"|null {
  if(!record(value)||typeof value.command!=="string")return null;
  const cmd=value.command,match=/^mcp-wrapper-([A-Za-z0-9_-]+)\.sh$/.exec(basename(cmd));if(!match)return null;
  const absolute=resolve(cwd,cmd),name=basename(dirname(absolute)),server=match[1];
  let body:string;try {body=readFileSync(absolute,"utf8");}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw Error("Grok MCP: legacy wrapper cannot be verified; project kept unchanged");}
  // An unproven path/key to an old identity-bearing wrapper must not be left discoverable either: refuse it.
  if(!body.startsWith("#!/bin/bash\nexport ")||!body.includes("export AGEND_INSTANCE_NAME='")||!body.includes("export AGEND_SOCKET_PATH='")||!body.includes(WAIT)||!body.endsWith("\n"))return null;
  // Prove the whole generated grammar, not just a convenient path and a few matching substrings.
  const quoted = String.raw`'[^']*(?:'\\''[^']*)*'`;
  const generated = new RegExp("^#!/bin/bash\\n(?:export [A-Za-z_][A-Za-z0-9_]*=" + quoted + "\\n)+" + WAIT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "exec " + quoted + "(?: " + quoted + ")*\\n$");
  if(!generated.test(body))return "foreign";
  if(!Array.isArray(value.args)||value.args.length||Object.keys(value).some(k=>k!=="command"&&k!=="args")
    ||cmd!==absolute||!lstatSync(absolute).isFile()||realpathSync(absolute)!==absolute
    ||key!==legacyGrokMcpKey(server,name)&&key!==server||!body.includes(`export AGEND_INSTANCE_NAME=${shellQuote(name)}\n`))return "foreign";
  return dirname(dirname(absolute))===resolve(dirname(instanceDir))?"ours":"foreign";
}
function projectText(config:CliBackendConfig,instanceDir:string,old:string|null):string {
  const text=old??"{}\n",root:unknown=JSON.parse(text);if(!record(root))throw Error("Grok MCP: project config is not an object");
  const top=members(text),field=top.items.find(x=>x.key==="mcpServers");
  if(field&&!record(root.mcpServers))throw Error("Grok MCP: project mcpServers is not an object");
  const map=field?members(text,field.start):null,keep:Member[]=[],remaining=new Map<string,unknown>(); let changed=false;
  for(const item of map?.items??[]){const value=(root.mcpServers as Record<string,unknown>)[item.key];const owner=legacyOwner(item.key,value,instanceDir,config.workingDirectory);
    if(owner==="foreign")throw Error("Grok MCP: legacy AgEnD binding belongs to another fleet; project config kept unchanged");
    if(owner!=="ours"){keep.push(item);remaining.set(item.key,value);}else changed=true;
  }
  for(const name of Object.keys(config.mcpServers)){
    if(!/^[A-Za-z0-9_-]+$/.test(name))throw Error("Grok MCP: invalid managed server name");
    const expected=shim(name);if(remaining.has(name)){
      if(JSON.stringify(remaining.get(name))!==JSON.stringify(expected))throw Error(`Grok MCP: project server ${name} conflicts; user config kept unchanged`);
    }else{changed=true;keep.push({key:name,raw:`\n    ${JSON.stringify(name)}: ${JSON.stringify(expected)}`,start:0,end:0});remaining.set(name,expected);}
  }
  if(!changed)return text;
  const replacement="{"+keep.map(x=>x.raw).join(",")+"\n  }";
  if(field)return text.slice(0,field.start)+replacement+text.slice(field.end);
  if(!Object.keys(config.mcpServers).length)return text;
  return text.slice(0,top.close)+(top.items.length?",":"")+`\n  "mcpServers": ${replacement}\n`+text.slice(top.close);
}

export function writeGrokMcp(config:CliBackendConfig,instanceDir:string):void {
  const path=join(config.workingDirectory,".mcp.json"),old=read(path);
  if(existsSync(path)&&!lstatSync(path).isFile())throw Error("Grok MCP: project config must be a regular file");
  const next=projectText(config,instanceDir,old); // Validate conflicts/provenance before writing any private launch state.
  ensureInstanceDir(instanceDir);const binding=randomBytes(32).toString("hex");
  for(const[name,entry]of Object.entries(config.mcpServers)){
    const env={...entry.env,AGEND_INSTANCE_NAME:config.instanceName};
    if(Object.keys(env).some(k=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)||k.startsWith("AGEND_GROK_MCP_")))throw Error("Grok MCP: invalid or reserved server environment");
    const guard=`if [ "\${AGEND_GROK_MCP_DIR:-}" != ${shellQuote(instanceDir)} ] || [ "\${AGEND_GROK_MCP_BINDING:-}" != ${shellQuote(binding)} ]; then ${FAIL}; fi\n`;
    const exports=Object.entries(env).map(([k,v])=>`export ${k}=${shellQuote(String(v))}`).join("\n");
    atomicWriteFileSync(join(instanceDir,`mcp-wrapper-${name}.sh`),HEADER+guard+exports+"\n"+WAIT+`exec ${[entry.command,...entry.args].map(shellQuote).join(" ")}\n`,{mode:0o700});
  }
  if(next!==old)atomicWriteFileSync(path,next,{mode:old===null?0o600:lstatSync(path).mode&0o777,beforeRename:()=>{if(read(path)!==old||existsSync(path)&&!lstatSync(path).isFile())throw Error("Grok MCP: project config changed during preparation; launch refused");}});
  // Publish the binding only after the project transition commits; failed preparation must stay unbound.
  atomicWriteFileSync(join(instanceDir,PRIVATE),JSON.stringify({v:1,instance:config.instanceName,fingerprint:fingerprint(config),binding,servers:Object.keys(config.mcpServers)})+"\n",{mode:0o600});
}
export function grokMcpLaunchEnv(config:CliBackendConfig,instanceDir:string):string {
  let binding="";try {const v=JSON.parse(read(join(instanceDir,PRIVATE))??"null");if(v?.v===1&&v.instance===config.instanceName&&v.fingerprint===fingerprint(config)&&/^[a-f0-9]{64}$/.test(v.binding))binding=v.binding;}catch{ /* missing/unbound: shim refuses, never use another instance's environment */ }
  return `AGEND_GROK_MCP_DIR=${shellQuote(instanceDir)} AGEND_GROK_MCP_BINDING=${shellQuote(binding)}`;
}
export function cleanupGrokMcp(config:CliBackendConfig,instanceDir:string):void {
  // The identity-free discovery shim is shared. Never take it away from a peer when this instance stops.
  for(const name of Object.keys(config.mcpServers))if(/^[A-Za-z0-9_-]+$/.test(name)){
    const path=join(instanceDir,`mcp-wrapper-${name}.sh`);try {if(read(path)?.startsWith(HEADER))unlinkSync(path);}catch{ /* private cleanup is best effort */ }
  }
  const path=join(instanceDir,PRIVATE);try {const v=JSON.parse(read(path)??"null");if(v?.v===1&&v.instance===config.instanceName)unlinkSync(path);}catch{ /* keep unknown private files */ }
}
