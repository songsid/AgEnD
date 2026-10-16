/** B2: legacy nullable CSS state remains compatible, but it never supplies false off evidence. Private FS only. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WebPrefsStore, OPERATOR } from "../src/web-prefs.js";
import { OwnerCssStore } from "../src/web-owner-css-store.js";
const dirs:string[]=[];
afterEach(()=>{for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true});});
function fixture(write?: (p:string,s:string)=>void) {
  const base=join(process.cwd(),'.artifacts');mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,'css-evidence-'));dirs.push(dir);
  const prefs=new WebPrefsStore(dir,{...(write?{write}:{})}),css=new OwnerCssStore(dir,prefs),person='person:discord:42';
  const path=join(dir,'web-owner-css',createHash('sha256').update(`person\0${person}`).digest('hex').slice(0,32),'index.json');
  const index=(s:string)=>{mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,s);};
  const raw=(values:unknown)=>writeFileSync(prefs.path,JSON.stringify({version:1,rev:1,identities:{[person]:{values,updated:{}}}}));
  return{dir,prefs,css,person,path,index,raw};
}
describe('owner-CSS positive admission evidence',()=>{
  it('a new readable empty preference and missing index prove off for that person',()=>{
    const f=fixture();expect(f.prefs.ownerCssSelection(f.person)).toEqual({known:true,active:null});expect(f.css.effectState(f.person)).toBe('off');expect(f.css.state(f.person).effectState).toBe('off');
  });
  it('legacy pointer providers have no proof, although nullable active remains null',()=>{
    const f=fixture();const css=new OwnerCssStore(f.dir,{ownerCssActive:()=>null,setOwnerCss:()=>({ok:true})});expect(css.active(f.person)).toBeNull();expect(css.effectState(f.person)).toBe('unknown');
  });
  it.each(['{','[]','{"version":1,"rev":1,"identities":null}'])('unreadable prefs %s never masquerade as off',text=>{
    const f=fixture();writeFileSync(f.prefs.path,text);expect(f.prefs.ownerCssActive(f.person)).toBeNull();expect(f.prefs.ownerCssSelection(f.person)).toEqual({known:false});expect(f.css.effectState(f.person)).toBe('unknown');
  });
  it.each(['css.active','css.trial'])('a filtered invalid %s only withholds its bucket proof',key=>{
    const f=fixture();f.raw({[key]:'broken',lang:'en'});expect(f.prefs.read(f.person).unreadable).toBeUndefined();expect(f.prefs.read(f.person).values.lang).toBe('en');expect(f.prefs.ownerCssSelection(f.person)).toEqual({known:false});expect(f.css.effectState(f.person)).toBe('unknown');expect(f.css.effectState('another-person')).toBe('off');
  });
  it('a successful existing full rewrite repairs dropped invalid CSS bytes before publishing off',()=>{
    const f=fixture();f.raw({'css.active':'broken'});expect(f.css.effectState(f.person)).toBe('unknown');expect(f.prefs.write(OPERATOR,new Map([['lang','en']])).ok).toBe(true);expect(f.css.effectState(f.person)).toBe('off');expect(readFileSync(f.prefs.path,'utf8')).not.toContain('broken');
  });
  it('a failed rewrite retains unknown proof and the original bytes',()=>{
    const f=fixture(()=>{throw Error('disk failed')});f.raw({'css.active':'broken'});const before=readFileSync(f.prefs.path,'utf8');expect(f.css.effectState(f.person)).toBe('unknown');expect(()=>f.prefs.write(OPERATOR,new Map([['lang','en']]))).toThrow('disk failed');expect(f.css.effectState(f.person)).toBe('unknown');expect(readFileSync(f.prefs.path,'utf8')).toBe(before);
  });
  it.each(['{','[]','{}','{"versions":[{"sha":"bad","at":1}],"assets":[]}','{"versions":[],"assets":[],"pending":{}}',JSON.stringify({versions:[],assets:[{id:'a'.repeat(32),kind:'png',bytes:-1}]}),JSON.stringify({versions:[{sha:['a'.repeat(32)],at:1}],assets:[]})])('an unknown CSS index %s never proves off',text=>{
    const f=fixture();f.index(text);expect(f.css.active(f.person)).toBeNull();expect(f.css.effectState(f.person)).toBe('unknown');
  });
  it('a non-ENOENT index read error is unknown',()=>{
    const f=fixture();mkdirSync(f.path,{recursive:true});expect(f.css.effectState(f.person)).toBe('unknown');
  });
  it('even an invalid internal value supplies no positive absence proof',()=>{
    const f=fixture();f.prefs.write(f.person,new Map([['css.active',false]]));expect(f.prefs.ownerCssSelection(f.person)).toEqual({known:false});expect(f.css.effectState(f.person)).toBe('unknown');
  });
  it('a known CSS pointer without the retained index/text is unknown, not off',()=>{
    const f=fixture();expect(f.prefs.setOwnerCss(f.person,{active:'a'.repeat(32)}).ok).toBe(true);expect(f.css.active(f.person)).toBeNull();expect(f.css.effectState(f.person)).toBe('unknown');
  });
  it('an actual saved and kept stylesheet proves on only for its own person; removal revokes it',()=>{
    const f=fixture();const saved=f.css.save(f.person,'.sample { color: red; }');expect(saved.ok).toBe(true);if(!saved.ok)throw Error(saved.error);expect(f.css.keep(f.person,saved.trial).ok).toBe(true);expect(f.css.effectState(f.person)).toBe('on');expect(f.css.state(f.person)).toMatchObject({active:saved.sha,effectState:'on'});expect(f.css.effectState('person:telegram:42')).toBe('off');
    unlinkSync(join(f.path,'..',saved.sha+'.css'));expect(f.css.effectState(f.person)).toBe('unknown');expect(f.css.state(f.person).active).toBe(saved.sha);
  });
  it('invalid retained CSS is unknown even when the pointer and index match',()=>{
    const f=fixture();const saved=f.css.save(f.person,'.sample{}');if(!saved.ok)throw Error(saved.error);expect(f.css.keep(f.person,saved.trial).ok).toBe(true);writeFileSync(join(f.path,'..',saved.sha+'.css'),'@import "https://invalid.example/x";');expect(f.css.effectState(f.person)).toBe('unknown');
  });
  it('host-side disabling produces off without deleting retained versions',()=>{
    const f=fixture();const saved=f.css.save(f.person,'.sample{}');if(!saved.ok)throw Error(saved.error);expect(f.css.keep(f.person,saved.trial).ok).toBe(true);expect(f.prefs.setOwnerCss(f.person,{active:null,trial:null}).ok).toBe(true);expect(f.css.effectState(f.person)).toBe('off');expect(readdirSync(join(f.path,'..'))).toContain(saved.sha+'.css');
  });
});
