import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeBundle, RUNTIME_BUNDLE_MODULES } from "../src/runtime-bundle.js";
import { RUNTIME_PANE_ASSETS, PANE_NATIVE_SHA256 } from "../src/runtime-pane-assets.js";
import { GENERAL_KNOWLEDGE_FILES } from "../src/general-role.js";

const homes: string[] = [];
function fixture(version = "8.22.0") {
  const root = mkdtempSync(join(tmpdir(), "agend-runtime-download-")); homes.push(root);
  const moduleDirectory = join(root,"dist"), wsDirectory = join(root,"ws"), licensePath = join(root,"LICENSE");
  mkdirSync(moduleDirectory); cpSync(dirname(createRequire(import.meta.url).resolve("ws/package.json")),wsDirectory,{recursive:true});
  for(const name of RUNTIME_BUNDLE_MODULES)writeFileSync(join(moduleDirectory,name),`// isolated fixture ${name}\nexport {};\n`);
  for(const name of GENERAL_KNOWLEDGE_FILES){const file=join(moduleDirectory,"general-knowledge",name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,"# Fixed bundled General fixture\n");}
  writeFileSync(join(moduleDirectory,"runtime-cli.js"),"123456789");
  const ws = JSON.parse(readFileSync(join(wsDirectory,"package.json"),"utf8"));ws.version=version;writeFileSync(join(wsDirectory,"package.json"),JSON.stringify(ws));
  writeFileSync(licensePath,"MIT License\nRuntime fixture\n");
  for (const pkg of RUNTIME_PANE_ASSETS) for (const file of pkg.files) {
    const target = join(moduleDirectory,"runtime-assets",pkg.name,file);mkdirSync(dirname(target),{recursive:true});
    writeFileSync(target, pkg.name === "node-pty" && PANE_NATIVE_SHA256[file] ? readFileSync(join("node_modules/node-pty",file)) : file === "package.json" ? JSON.stringify({name:pkg.name,version:pkg.version}) : "verified fixed program fixture");
  }
  return {root,moduleDirectory,wsDirectory,licensePath,packageVersion:"2.3.5-preview.1"};
}
/** Parse through the standard end-of-central-directory offsets, independently of the producer's file list. */
function unzip(bytes:Buffer):Map<string,Buffer> {
  const end=bytes.length-22;expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  const count=bytes.readUInt16LE(end+10),directorySize=bytes.readUInt32LE(end+12),directoryStart=bytes.readUInt32LE(end+16);
  expect(bytes.readUInt16LE(end+8)).toBe(count);expect(directoryStart+directorySize).toBe(end);
  const files=new Map<string,Buffer>();let at=directoryStart;
  for(let i=0;i<count;i++){
    expect(bytes.readUInt32LE(at)).toBe(0x02014b50);expect(bytes.readUInt16LE(at+10)).toBe(0);
    expect(bytes.readUInt16LE(at+8)&0x0800).toBe(0x0800);
    const size=bytes.readUInt32LE(at+24),length=bytes.readUInt16LE(at+28),extra=bytes.readUInt16LE(at+30),comment=bytes.readUInt16LE(at+32),local=bytes.readUInt32LE(at+42);
    const name=bytes.subarray(at+46,at+46+length).toString("utf8");
    expect(name).toMatch(/^agend-runtime\/[a-zA-Z0-9/_.@-]+$/);expect(name).not.toContain("..");expect(files.has(name)).toBe(false);
    expect(bytes.readUInt32LE(local)).toBe(0x04034b50);expect(bytes.readUInt16LE(local+8)).toBe(0);
    const localLength=bytes.readUInt16LE(local+26),localExtra=bytes.readUInt16LE(local+28);
    expect(bytes.subarray(local+30,local+30+localLength).toString("utf8")).toBe(name);
    expect(bytes.readUInt32LE(local+14)).toBe(bytes.readUInt32LE(at+16));
    expect(bytes.readUInt32LE(local+18)).toBe(size);expect(bytes.readUInt32LE(local+22)).toBe(size);
    files.set(name,bytes.subarray(local+30+localLength+localExtra,local+30+localLength+localExtra+size));
    at+=46+length+extra+comment;
  }
  expect(at).toBe(end);return files;
}
afterEach(()=>{
  for(const root of homes.splice(0)){
    if(!resolve(root).startsWith(resolve(tmpdir())+sep))throw Error("Unsafe runtime bundle fixture cleanup");
    rmSync(root,{recursive:true,force:true});
  }
});

describe("Windows runtime download archive",()=>{
  it.each(["8.22.0","8.22.1"])("contains a complete fixed runtime using verified ws %s, with no user data or coordinator modules",version=>{
    const f=fixture(version),canary="PRIVATE_PROFILE_MUST_NOT_BE_INCLUDED";
    writeFileSync(join(f.moduleDirectory,".env"),canary);writeFileSync(join(f.moduleDirectory,"fleet-manager.js"),canary);
    mkdirSync(join(f.root,".agend-runtime"));writeFileSync(join(f.root,".agend-runtime","credentials.json"),canary);
    writeFileSync(join(f.wsDirectory,"lib","private-extra.js"),canary);
    const bundle=createRuntimeBundle(f),files=unzip(bundle.bytes);
    expect(bundle.filename).toBe("agend-runtime-windows-2.3.5-preview.1.zip");
    expect(bundle.sha256).toBe(createHash("sha256").update(bundle.bytes).digest("hex"));
    expect([...files.keys()].filter(name=>name.startsWith("agend-runtime/dist/"))).toEqual([...RUNTIME_BUNDLE_MODULES.map(name=>"agend-runtime/dist/"+name), ...GENERAL_KNOWLEDGE_FILES.map(name=>"agend-runtime/dist/general-knowledge/"+name)]);
    expect(files.get("agend-runtime/agend-runtime.cmd")?.toString()).toBe('@echo off\r\nnode.exe "%~dp0dist\\runtime-cli.js" %*\r\n');
    const pkg=JSON.parse(files.get("agend-runtime/package.json")!.toString());expect(pkg.dependencies).toEqual({ws:version,"node-pty":"1.1.0","@xterm/headless":"6.0.0","@xterm/addon-serialize":"0.14.0"});expect(pkg.type).toBe("module");
    expect(files.has("agend-runtime/dist/runtime-pane-boot.js")).toBe(true);
    expect(JSON.parse(files.get("agend-runtime/bundle-manifest.json")!.toString())).toMatchObject({nativeDependencies:[{name:"node-pty",version:"1.1.0",platforms:["win32-x64","win32-arm64"],backend:"ConPTY"}],modules:RUNTIME_BUNDLE_MODULES});
    expect(files.get("agend-runtime/README.txt")!.toString()).toContain("one-time code");expect(files.get("agend-runtime/LICENSE")!.toString()).toContain("MIT License");
    expect(files.get("agend-runtime/node_modules/ws/LICENSE")!.toString()).toContain("Permission is hereby granted");
    expect(bundle.bytes.includes(Buffer.from(canary))).toBe(false);
    expect([...files.keys()]).not.toContain("agend-runtime/node_modules/ws/lib/private-extra.js");
  });
  it("embeds only an explicit public server address, using a data file instead of shell interpolation",()=>{
    const f=fixture(),first=unzip(createRuntimeBundle({...f,serverOrigin:"https://fleet.example.test:10443"}).bytes),other=createRuntimeBundle({...f,serverOrigin:"https://other.example.test"});
    expect(first.has("agend-runtime/agend-server.json")).toBe(true);expect(JSON.parse(first.get("agend-runtime/agend-server.json")!.toString())).toEqual({server:"https://fleet.example.test:10443"});
    const launcher=first.get("agend-runtime/connect-agend.bat")!.toString();expect(launcher).toContain('node.exe "%~dp0dist\\runtime-cli.js" connect');expect(launcher).not.toContain("fleet.example");
    expect(JSON.parse(first.get("agend-runtime/bundle-manifest.json")!.toString()).buildId).toBe(JSON.parse(unzip(other.bytes).get("agend-runtime/bundle-manifest.json")!.toString()).buildId);
    expect(unzip(createRuntimeBundle(f).bytes).has("agend-runtime/agend-server.json")).toBe(false);
    for(const bad of ["http://192.0.2.5","https://user:password@fleet.example","https://fleet.example/path","https://fleet.example/?code=secret"])expect(()=>createRuntimeBundle({...f,serverOrigin:bad})).toThrow();
  });
  it("refuses a modified native prebuild before offering the runtime download",()=>{
    const f=fixture(),file=Object.keys(PANE_NATIVE_SHA256)[0];
    writeFileSync(join(f.moduleDirectory,"runtime-assets/node-pty",file),"changed native program");
    expect(()=>createRuntimeBundle(f)).toThrow("checksum");
  });
  it("uses standard ZIP CRC32 for the known check vector and deterministic package bytes",()=>{
    const f=fixture(),a=createRuntimeBundle(f),b=createRuntimeBundle(f);
    expect(a.bytes.equals(b.bytes)).toBe(true);expect(a.sha256).toBe(b.sha256);
    // The first member is runtime-cli.js containing the standard CRC32 check string.
    expect(a.bytes.readUInt32LE(14)).toBe(0xcbf43926);
    writeFileSync(join(f.moduleDirectory,"runtime-client.js"),"// changed installed runtime\n");
    expect(createRuntimeBundle(f).sha256).not.toBe(a.sha256);
  });
  it("reads version and license from the installed package beside compiled modules",()=>{
    const f=fixture();writeFileSync(join(f.root,"package.json"),JSON.stringify({version:"2.3.3"}));
    const bundle=createRuntimeBundle({moduleDirectory:f.moduleDirectory,wsDirectory:f.wsDirectory});
    expect(bundle.filename).toBe("agend-runtime-windows-2.3.3.zip");
    const files=unzip(bundle.bytes);
    expect(JSON.parse(files.get("agend-runtime/package.json")!.toString()).version).toBe("2.3.3");
    expect(files.get("agend-runtime/LICENSE")!.toString()).toContain("Runtime fixture");
  });
  it("fails clearly when compiled runtime assets are missing, without generating a partial download",()=>{
    const f=fixture();rmSync(join(f.moduleDirectory,"windows-native-mcp.js"));
    expect(()=>createRuntimeBundle(f)).toThrow();expect(existsSync(join(f.root,"bundle.zip"))).toBe(false);
  });
  it("rejects directories and oversized files instead of reading arbitrary or unbounded assets",()=>{
    const f=fixture(),file=join(f.moduleDirectory,"runtime-cli.js");rmSync(file);mkdirSync(file);
    expect(()=>createRuntimeBundle(f)).toThrow(/unsafe|large/);rmSync(file,{recursive:true});writeFileSync(file,Buffer.alloc(1024*1024+1));
    expect(()=>createRuntimeBundle(f)).toThrow(/large/);
  });
  it("bounds total archive size even when each individual asset is within its limit",()=>{
    const f=fixture();for(const name of RUNTIME_BUNDLE_MODULES)writeFileSync(join(f.moduleDirectory,name),Buffer.alloc(512*1024));
    expect(()=>createRuntimeBundle(f)).toThrow(/archive size/);
  });
  it("does not package unverified dependency versions or unsafe version-derived filenames",()=>{
    const f=fixture("99.0.0");expect(()=>createRuntimeBundle(f)).toThrow(/WebSocket version/);
    expect(()=>createRuntimeBundle({...f,packageVersion:"1.2.3\r\nInjected"})).toThrow(/bundle version/);
  });
});
