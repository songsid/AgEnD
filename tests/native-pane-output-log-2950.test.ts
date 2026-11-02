import{afterEach,expect,it,vi}from'vitest';import{mkdtempSync,rmSync,readFileSync,writeFileSync,symlinkSync,existsSync,statSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{RuntimePaneOutputBuffer,validatePaneOutputBatch,PANE_OUTPUT_CHUNK}from'../src/runtime-pane-output.js';import{NativePaneOutputLog}from'../src/native-pane-output-log.js';
const clean:Array<()=>unknown>=[];afterEach(()=>{for(const stop of clean.splice(0).reverse())stop();});
function fixture(){const root=mkdtempSync(join(tmpdir(),'agend-native-output-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'output.log'),buffer=new RuntimePaneOutputBuffer(1024);let current=true;const read=vi.fn(async offset=>buffer.read(offset,false));const log=new NativePaneOutputLog(path,'a'.repeat(64),()=>current,read);clean.push(()=>log.stop());return{root,path,buffer,log,read,off:()=>{current=false;}};}
it('bounds raw output and explicitly reports retained gaps and invalid/future cursors',()=>{
 const buffer=new RuntimePaneOutputBuffer(8);buffer.append('012345');buffer.append('6789');const batch=buffer.read(0,false);expect(Buffer.from(batch.data,'base64').toString()).toBe('23456789');expect(batch).toMatchObject({from:2,next:10,gap:true});expect(validatePaneOutputBatch(batch,0)).toEqual(batch);expect(()=>buffer.read(11,false)).toThrow('cursor');expect(()=>validatePaneOutputBatch({...batch,gap:false},0)).toThrow();expect(()=>validatePaneOutputBatch({...batch,path:'C:\\private'},0)).toThrow();
 const large=new RuntimePaneOutputBuffer();large.append('x'.repeat(PANE_OUTPUT_CHUNK*3));expect(Buffer.from(large.read(0,false).data,'base64')).toHaveLength(PANE_OUTPUT_CHUNK);for(let n=0;n<2048;n++)large.append('');expect((large as any).chunks.length).toBe(1);
 const tiny=new RuntimePaneOutputBuffer();for(let n=0;n<2000;n++)tiny.append('x');expect((tiny as any).chunks.length).toBeLessThanOrEqual(1024);expect(tiny.read(0,false).gap).toBe(true);
});
it('writes raw native bytes and resumes a matching metadata cursor without duplicating output',async()=>{
 const f=fixture();f.buffer.append('\x1b[31m中文\x1b[0m\r\n');await f.log.start();expect(readFileSync(f.path,'utf8')).toBe('\x1b[31m中文\x1b[0m\r\n');f.log.stop();const next=new NativePaneOutputLog(f.path,'a'.repeat(64),()=>true,f.read);clean.push(()=>next.stop());await next.start();expect(readFileSync(f.path,'utf8')).toBe('\x1b[31m中文\x1b[0m\r\n');f.buffer.append('new\r\n');await(next as any).poll();expect(readFileSync(f.path,'utf8')).toContain('new\r\n');expect(JSON.parse(readFileSync(f.path+'.native-cursor','utf8')).offset).toBe(Buffer.byteLength('\x1b[31m中文\x1b[0m\r\nnew\r\n'));
});
it('logs an explicit gap without presenting its dropped bytes as delivery evidence',async()=>{
 const f=fixture();f.buffer.append('x'.repeat(3000));await f.log.start();const text=readFileSync(f.path,'utf8');expect(text).toContain('exceeded the retained buffer');expect(text.endsWith('x'.repeat(1024))).toBe(true);
});
it.each(['stop','owner'])('%s during a held read drops the late diagnostic bytes',async action=>{
 const f=fixture();let release!:(value:any)=>void;f.read.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));const pending=f.log.start();await vi.waitFor(()=>expect(release).toBeDefined());if(action==='stop')f.log.stop();else f.off();f.buffer.append('must not appear');release(f.buffer.read(0,false));await pending;expect(existsSync(f.path)).toBe(false);
});
it.each(['log','cursor'])('refuses a %s symlink before reading/writing or rotating its target',async kind=>{
 const f=fixture(),target=join(f.root,'unrelated');writeFileSync(target,'not an output log',{mode:0o600});symlinkSync(target,kind==='log'?f.path:f.path+'.native-cursor');f.buffer.append('no');await expect(f.log.start()).rejects.toThrow();expect(readFileSync(target,'utf8')).toBe('not an output log');expect(existsSync(target+'.1')).toBe(false);
});

it('a stale held read cannot rotate an existing diagnostic log before rejecting its result',async()=>{
 const f=fixture(),size=11*1024*1024;writeFileSync(f.path,Buffer.alloc(size,120),{mode:0o600});let release!:(value:any)=>void;f.read.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));const pending=f.log.start();await vi.waitFor(()=>expect(release).toBeDefined());f.off();f.buffer.append('stale');release(f.buffer.read(0,false));await pending;expect(statSync(f.path).size).toBe(size);expect(existsSync(f.path+'.1')).toBe(false);
});
