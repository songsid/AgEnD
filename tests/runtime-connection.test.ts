import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBundledRuntimeServer, resolveRuntimeServer, RUNTIME_SERVER_FILE } from "../src/runtime-connection.js";
const roots:string[]=[];
function fixture(){const root=mkdtempSync(join(tmpdir(),"agend-runtime-connection-"));roots.push(root);return root;}
afterEach(()=>{for(const root of roots.splice(0)){if(!resolve(root).startsWith(resolve(tmpdir())+sep))throw Error("Unsafe test path");rmSync(root,{recursive:true,force:true});}});
describe("bundled Runtime connection information",()=>{
  it("reads a bounded public origin from the program directory and keeps missing information absent",()=>{
    const root=fixture();expect(readBundledRuntimeServer(root)).toBeUndefined();
    writeFileSync(join(root,RUNTIME_SERVER_FILE),JSON.stringify({server:"https://fleet.example.test:10443/"}));expect(readBundledRuntimeServer(root)).toBe("https://fleet.example.test:10443");
    writeFileSync(join(root,RUNTIME_SERVER_FILE),JSON.stringify({server:"http://localhost:19280"}));expect(readBundledRuntimeServer(root)).toBe("http://localhost:19280");
    for(const raw of ['{',JSON.stringify({server:"https://user:password@fleet.example"}),JSON.stringify({server:"http://192.0.2.5"}),JSON.stringify({server:"https://fleet.example/path"}),JSON.stringify({server:"https://fleet.example",credential:"SECRET"}),"x".repeat(4097)]){
      writeFileSync(join(root,RUNTIME_SERVER_FILE),raw);expect(()=>readBundledRuntimeServer(root)).toThrow("agend-server.json");
    }
  });
  it("resolves explicit, bundled and saved origins without sending an existing profile to another server",()=>{
    expect(resolveRuntimeServer(undefined,"https://fleet.example.test",undefined)).toBe("https://fleet.example.test");
    expect(resolveRuntimeServer(undefined,undefined,"https://fleet.example.test")).toBe("https://fleet.example.test");
    expect(resolveRuntimeServer("https://fleet.example.test","https://other.example.test","https://fleet.example.test")).toBe("https://fleet.example.test");
    expect(()=>resolveRuntimeServer(undefined,"https://other.example.test","https://fleet.example.test")).toThrow(/paired with https:\/\/fleet\.example\.test, but this connection is for https:\/\/other\.example\.test[^]*--profile[^]*disconnect/);
    expect(()=>resolveRuntimeServer(undefined,undefined,undefined)).toThrow("No AgEnD address");
  });
});
