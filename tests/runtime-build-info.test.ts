import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRuntimeInfo, RUNTIME_BUNDLE_MODULES } from "../src/runtime-build-info.js";
import { parseRuntimeInfo } from "../src/runtime-protocol.js";
const directories:string[]=[];
function fixture(){const root=mkdtempSync(join(tmpdir(),"agend-runtime-info-"));directories.push(root);const moduleDirectory=join(root,"dist"),packagePath=join(root,"package.json");mkdirSync(moduleDirectory);
  writeFileSync(packagePath,JSON.stringify({name:"@songsid/agend-runtime",version:"2.3.5-alpha"}));
  for(const name of RUNTIME_BUNDLE_MODULES)writeFileSync(join(moduleDirectory,name),`fixture program: ${name}`);
  return {root,moduleDirectory,packagePath,panes:false};}
afterEach(()=>{for(const root of directories.splice(0)){if(!resolve(root).startsWith(resolve(tmpdir())+sep))throw Error("Unsafe fixture path");rmSync(root,{recursive:true,force:true});}});
describe("runtime program version information",()=>{
  it("fingerprints the actual fixed program modules, distinguishes builds of the same version and ignores private files",()=>{
    const f=fixture(),first=readRuntimeInfo(f);expect(first).toMatchObject({version:"2.3.5-alpha",protocolVersions:[1],capabilities:["exec","mcp"]});expect(first.buildId).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(join(f.moduleDirectory,"credentials.json"),"PRIVATE_DATA");expect(readRuntimeInfo(f).buildId).toBe(first.buildId);
    writeFileSync(join(f.moduleDirectory,"runtime-client.js"),"changed runtime program");expect(readRuntimeInfo(f).buildId).not.toBe(first.buildId);expect(readRuntimeInfo(f).version).toBe(first.version);
    const changed=readRuntimeInfo(f);writeFileSync(f.packagePath,JSON.stringify({name:"@songsid/agend-runtime",version:"2.3.6"}));expect(readRuntimeInfo(f).buildId).not.toBe(changed.buildId);
  });
  it("keeps a known version when build assets are incomplete, and keeps absent or invalid package versions unknown",()=>{
    const f=fixture();rmSync(join(f.moduleDirectory,"runtime-client.js"));expect(readRuntimeInfo(f)).toEqual({version:"2.3.5-alpha",protocolVersions:[1],capabilities:["exec","mcp"]});
    for(const raw of ['{"name":"another-package","version":"9.9.9"}','{"name":"@songsid/agend-runtime","version":"not-semver"}','{']){
      writeFileSync(f.packagePath,raw);expect(readRuntimeInfo(f)).toEqual({protocolVersions:[1],capabilities:["exec","mcp"]});
    }
    rmSync(f.packagePath);expect(readRuntimeInfo(f).version).toBeUndefined();
  });
  it("bounds file and total program reads instead of fingerprinting oversized assets",()=>{
    const f=fixture();writeFileSync(join(f.moduleDirectory,"runtime-client.js"),Buffer.alloc(1024*1024+1));expect(readRuntimeInfo(f).buildId).toBeUndefined();
    for(const name of RUNTIME_BUNDLE_MODULES)writeFileSync(join(f.moduleDirectory,name),Buffer.alloc(512*1024));expect(readRuntimeInfo(f).buildId).toBeUndefined();
    writeFileSync(f.packagePath,Buffer.alloc(64*1024+1));expect(readRuntimeInfo(f).version).toBeUndefined();
  });
  it("bounds and normalizes optional reports without treating unknown capabilities as authorization",()=>{
    expect(parseRuntimeInfo(undefined)).toBeUndefined();
    expect(parseRuntimeInfo({version:"2.3.5-alpha",buildId:"a".repeat(64),protocolVersions:[1,2],capabilities:["exec","future-feature"],secret:"discard"})).toEqual({version:"2.3.5-alpha",buildId:"a".repeat(64),protocolVersions:[1,2],capabilities:["exec","future-feature"]});
    for(const bad of [null,[],{protocolVersions:[],capabilities:[]},{protocolVersions:[1,1],capabilities:[]},{protocolVersions:[1],capabilities:["shell; calc"]},{version:"1.2.3\nInjected",protocolVersions:[1],capabilities:[]},{buildId:"wrong",protocolVersions:[1],capabilities:[]},{protocolVersions:[1],capabilities:[],extra:"x".repeat(4096)}])expect(()=>parseRuntimeInfo(bad)).toThrow("Invalid runtime version information");
  });
});
