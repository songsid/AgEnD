import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHostMemory, type HostMemory } from "../src/host-memory.js";
import { MemoryPressure } from "../src/memory-pressure.js";
import { SpawnGate } from "../src/spawn-gate.js";
import { StormWindow } from "../src/storm-window.js";
import { FleetManager } from "../src/fleet-manager.js";
import { getLocale, setLocale } from "../src/locale.js";

vi.mock("../src/sd-notify.js", () => ({ sdNotify: vi.fn(), sdNotifyBlocking: vi.fn() }));
// Give the ESM namespace configurable wrappers; the native reader stays inert in the default-path control.
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>() }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), platform: () => "linux" }));
const MiB = 1024 * 1024;
const measured = readFileSync(new URL("./fixtures/linux-memory-pressure/wsl2-low-psi.txt", import.meta.url), "utf8");
const text = (some = 15, full = 0) => `some avg10=${Math.max(some, full)} avg60=${some} avg300=0 total=123\nfull avg10=${full} avg60=0 avg300=0 total=12\n`;
function read(psi: () => string = () => measured, available = 17351, swap = 330): HostMemory {
  return readHostMemory({ platform: "linux", includePressure: true, psi,
    meminfo: () => `MemTotal: ${32098 * 1024} kB\nMemAvailable: ${available * 1024} kB\nSwapTotal: ${8192 * 1024} kB\nSwapFree: ${swap * 1024} kB\n`,
    totalmem: () => 32098 * MiB, freemem: () => available * MiB });
}
const absent = () => { throw Object.assign(new Error("missing PSI"), { code: "ENOENT" }); };
const policy = (value: HostMemory) => new MemoryPressure({ platform: "linux", read: () => value });

describe("#1707 Linux PSI policy", () => {
  const gates: SpawnGate[] = [];
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-12T00:00:00Z")); });
  afterEach(() => { gates.splice(0).forEach(g => g.shutdown()); vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each([[17351,330],[16171,384]])("reported RAM%s/swap%s with low PSI is normal", async (available, swap) => {
    const p = policy(read(() => measured, available, swap));
    expect(p.sample().level).toBe("normal");
    const gate = new SpawnGate({ storm: new StormWindow(), memoryPressure: p, concurrency: () => 3, staggerMs: () => 0 }); gates.push(gate);
    let finish!: () => void; const held = new Promise<void>(r => { finish = r; }); const run = vi.fn(() => held);
    const tasks = ["a","b","c"].map(instanceName => gate.run({ instanceName, workingDirectory: `/${instanceName}`, reason: "startup" }, run));
    // A reversed gate can reject queued promises after the direct assertion; keep cleanup owned.
    for (const task of tasks) void task.catch(() => {});
    expect(run).toHaveBeenCalledTimes(3); expect((gate as any).pressureHeld).toBe(false);
    finish(); await Promise.all(tasks);
  });

  it.each([[15,0,"elevated"],[0,5,"elevated"],[0,25,"critical"]] as const)("PSI some%s/full%s gives%s and actual admission", async (some, full, level) => {
    const p = policy(read(() => text(some, full), 17351, 4096)); expect(p.sample().level).toBe(level);
    const gate = new SpawnGate({ storm: new StormWindow(), memoryPressure: p, concurrency: () => 3, staggerMs: () => 0 }); gates.push(gate);
    const run = vi.fn(async () => 1);
    const work = gate.run({ instanceName: "a", workingDirectory: "/a", reason: "startup" }, run); void work.catch(() => {});
    expect(run).toHaveBeenCalledTimes(level === "critical" ? 0 : 1);
    expect((gate as any).pressureHeld).toBe(level === "critical");
    if (level === "critical") { gate.shutdown(); await expect(work).rejects.toThrow("shut down"); } else await work;
  });

  it.each([[1000,"critical"],[2000,"elevated"],[17351,"normal"]] as const)("no PSI: available%s plus tight swap is%s", (available, level) => {
    expect(policy(read(absent, available)).sample().level).toBe(level);
  });
  it("unreadable PSI falls back without a hold", async () => {
    const denied = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
    const p = policy(read(denied)); expect(p.sample().level).toBe("normal");
    const gate = new SpawnGate({ storm: new StormWindow(), memoryPressure: p, concurrency: () => 3, staggerMs: () => 0 }); gates.push(gate);
    const run = vi.fn(async () => 1); await gate.run({ instanceName:"a",workingDirectory:"/a",reason:"wake" },run);
    expect(run).toHaveBeenCalledOnce(); expect((gate as any).pressureHeld).toBe(false);
  });
  it("cold swap cannot pin elevated after PSI recovery", async () => {
    let value=read(() => text()); const p=new MemoryPressure({platform:"linux",read:()=>value}); expect(p.sample().level).toBe("elevated");
    value=read(); await vi.advanceTimersByTimeAsync(30000); expect(p.sample().level).toBe("normal");
  });
  it("critical PSI recovers with the existing30s ramp even while cold swap is full", async () => {
    let value=read(()=>text(0,25));const p=new MemoryPressure({platform:"linux",read:()=>value});expect(p.sample().level).toBe("critical");
    value=read();expect(p.sample()).toMatchObject({level:"elevated",recovering:true});await vi.advanceTimersByTimeAsync(30000);
    expect(p.sample()).toMatchObject({level:"normal",recovering:false});
  });
  it("the real reader preserves measured averages, rejects unknown PSI, and diagnostics don't request it", () => {
    expect(read()).toMatchObject({ linuxPsi: { someAvg60:0.08,fullAvg10:0.02 } });
    for(const raw of ["", "some avg60=99", text()+text(), text().replace("avg60=15","avg60=NaN"),text().replace("avg10=0", "avg10=101"), "x".repeat(4097)]) {
      expect(read(()=>raw)).toMatchObject({linuxPsi:null});
    }
    const psi=vi.fn(()=>text());readHostMemory({platform:"linux",psi,meminfo:()=>"MemTotal: 1000 kB\nMemAvailable: 900 kB\n"});
    expect(psi).not.toHaveBeenCalled();
  });
  it("snapshot PSI measurements are detached from the policy", () => {
    const p=policy(read());const s=p.sample();expect(s.memory).toMatchObject({linuxPsi:{someAvg60:0.08}});s.memory!.linuxPsi!.someAvg60=99;
    expect(p.snapshot().memory!.linuxPsi!.someAvg60).toBe(0.08);
  });
  it.each([[9.99,4.99,"normal"],[10,0,"elevated"],[0,5,"elevated"],[0,19.99,"elevated"],[0,20,"critical"]] as const)("exact PSI thresholds %s/%s -> %s", (some,full,level)=>{
    expect(policy(read(()=>text(some,full),17351,4096)).sample().level).toBe(level);
  });
  it("default Linux policy requests PSI through the real host reader; failure falls back",()=>{
    let failed=false;
    const readFile=vi.spyOn(fs,"readFileSync").mockImplementation(((path:unknown)=>{
      if(path==="/proc/meminfo")return `MemTotal: ${32098*1024} kB\nMemAvailable: ${17351*1024} kB\nSwapTotal: ${8192*1024} kB\nSwapFree: ${4096*1024} kB\n`;
      if(path==="/proc/pressure/memory"){if(failed)throw Object.assign(new Error("permission"),{code:"EACCES"});return text(15);}
      throw new Error("unexpected file read");
    }) as typeof fs.readFileSync);
    const p=new MemoryPressure({platform:"linux"});expect(p.sample()).toMatchObject({level:"elevated",signal:"psi-some"});
    expect(readFile).toHaveBeenCalledWith("/proc/pressure/memory","utf8");failed=true;expect(p.sample().level).toBe("normal");
  });
  it("RAM floors stay critical even with healthy PSI; invalid injected PSI cannot hold",()=>{
    expect(policy(read(()=>measured,1000)).sample()).toMatchObject({level:"critical",signal:"available-swap"});
    expect(policy(read(()=>measured,100,4096)).sample()).toMatchObject({level:"critical",signal:"available"});
    expect(policy({...read(),linuxPsi:{someAvg60:NaN,fullAvg10:25}}).sample().level).toBe("normal");
  });
  it("unavailable PSI releases a previous PSI hold, retaining only the bounded recovery ramp",async()=>{
    let value=read(()=>text(0,25));const p=new MemoryPressure({platform:"linux",read:()=>value});expect(p.sample().level).toBe("critical");
    value=read(absent);expect(p.sample()).toMatchObject({level:"elevated",recovering:true});await vi.advanceTimersByTimeAsync(30000);expect(p.sample().level).toBe("normal");
  });
  it("other non-Darwin policy ignores Linux PSI and retains its previous RAM/swap behavior",()=>{
    expect(new MemoryPressure({platform:"win32",read:()=>read()}).sample().level).toBe("elevated");
    expect(new MemoryPressure({platform:"win32",read:()=>read(()=>text(0,25),17351,4096)}).sample().level).toBe("normal");
  });
});

describe("#1707 real FleetManager notices with inert adapters",()=>{
  const original=getLocale();const roots:Array<{fm:FleetManager;dir:string}>=[];
  afterEach(()=>{for(const {fm,dir} of roots.splice(0)){fm.memoryPressure.stop();fm.spawnGate.shutdown();fm.stormWindow.shutdown();rmSync(dir,{recursive:true,force:true});}vi.restoreAllMocks();setLocale(original);});
  it.each(["en","zh-TW"] as const)("%s notice names PSI and stays once-per-rise",locale=>{
    setLocale(locale);const dir=mkdtempSync(join(tmpdir(),"agend-psi-1707-"));const fm=new FleetManager(dir);roots.push({fm,dir});const f=fm as any;
    let value=read();vi.spyOn(fm.memoryPressure as unknown as {read():HostMemory},"read").mockImplementation(()=>value);
    f.logger={debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn()};f.fleetConfig={defaults:{},channel:{group_id:"g"},instances:{general:{general_topic:true,topic_id:"t"}}};
    vi.spyOn(fm,"getInstanceStatus").mockReturnValue("running");const sendText=vi.fn().mockResolvedValue(undefined);f.adapter={id:"telegram",type:"telegram",sendText};f.adapters.set("telegram",f.adapter);
    fm.memoryPressure.start();expect(sendText).not.toHaveBeenCalled();value=read(()=>text());fm.memoryPressure.sample();
    expect(sendText).toHaveBeenCalledOnce();expect(String(sendText.mock.calls[0][1])).toContain("PSI some");expect(String(sendText.mock.calls[0][1])).toContain("15%");expect(String(sendText.mock.calls[0][1])).toContain("60");
    for(let i=0;i<10;i++)fm.memoryPressure.sample();expect(sendText).toHaveBeenCalledOnce();
    value=read();fm.memoryPressure.sample();expect(sendText).toHaveBeenCalledTimes(2);
  });
});
