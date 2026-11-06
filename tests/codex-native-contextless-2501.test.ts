/** Retained real 0.165 mock-only captures; no provider, runner or account is opened. */
import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {CodexPaneDetectors} from '../src/backend/codex.js';
import {createNativePaneBackend} from '../src/backend/native-pane.js';
const native=readFileSync(new URL('./fixtures/codex-0165-native-limit-only-resume.pane.txt',import.meta.url),'utf8');
const linux=readFileSync(new URL('./fixtures/codex-0165-linux-limit-only-resume.pane.txt',import.meta.url),'utf8');
const backend=(resumes=true,items:readonly string[]=['context-remaining'])=>createNativePaneBackend('codex',()=>({sessionId:'owned',contextPercentage:null,statusLineItems:items,resumes}));
it.each([native,linux])('known empty contextless composer is ready only for the native resumed launch',pane=>{
 const b=backend();expect(b.getReadyPattern().test(pane)).toBe(true);expect(b.isDeliveryInputReadyPane!(pane)).toBe(true);expect(b.isPeriodicRedrawIdlePane!(pane)).toBe(true);expect(b.ownsComposerRows!(pane)).toBe(true);
 const host=new CodexPaneDetectors({statusLineItems:()=>['context-remaining'],launchMayResume:()=>true});expect(host.getReadyPattern().test(pane)).toBe(false);expect(host.isDeliveryInputReadyPane(pane)).toBe(false);
});
it('fresh or differently configured launches get no new contextless proof',()=>{
 for(const b of [backend(false),backend(true,['run-state']),backend(true,['model-name','context-remaining'])]){expect(b.getReadyPattern().test(native)).toBe(false);expect(b.isDeliveryInputReadyPane!(native)).toBe(false);expect(b.ownsComposerRows!(native)).toBe(false);}
});
it.each(['missing','unknown','double','trailing','numbered','historical'])('a %s footer/composer cannot become native contextless readiness',kind=>{
 const pane=kind==='missing'?native.replace(/^.*for shortcuts.*$/m,'')
 :kind==='unknown'?native.replace(/^.*for shortcuts.*$/m,'  arbitrary status')
 :kind==='double'?native.replace(/^(.*for shortcuts.*)$/m,'$1\n$1')
 :kind==='trailing'?native+'\nnot a footer'
 :kind==='numbered'?native.replace('› Ask Codex to do anything','› 1. Update now')
 :native.replace('› Ask Codex to do anything','› Ask Codex to do anything\n• subsequent output');
 const b=backend();expect(b.getReadyPattern().test(pane)).toBe(false);expect(b.isDeliveryInputReadyPane!(pane)).toBe(false);expect(b.isPeriodicRedrawIdlePane!(pane)).toBe(false);expect(b.ownsComposerRows!(pane)).toBe(false);
});
it('owned draft rows authorize their existing composer proof, not fresh-paste readiness',()=>{
 const pane=native.replace('› Ask Codex to do anything','› owned message\n  wrapped message');const b=backend();expect(b.getReadyPattern().test(pane)).toBe(false);expect(b.isDeliveryInputReadyPane!(pane)).toBe(false);expect(b.isPeriodicRedrawIdlePane!(pane)).toBe(false);expect(b.ownsComposerRows!(pane)).toBe(true);
 expect(b.ownsComposerRows!(pane.replace('  wrapped message','• transcript output'))).toBe(false);
});
it('live work and a disconnected app-server still veto contextless readiness',()=>{
 for(const pane of [native.replace('› Ask Codex','• Working (1s • esc to interrupt)\n› Ask Codex'),native.replace('› Ask Codex','• Reconnecting to app-server… (8s)\n› Ask Codex')]){const b=backend();expect(b.isDeliveryInputReadyPane!(pane)).toBe(false);expect(b.isPeriodicRedrawIdlePane!(pane)).toBe(false);}
});

it('a known selection dialog remains held without contextless readiness',()=>{
 const card=readFileSync(new URL('./fixtures/codex-0159-rate-limit-picker.pane.txt',import.meta.url),'utf8');const b=backend(),pane=card;
 expect(b.isDeliveryInputReadyPane!(pane)).toBe(false);expect(b.isPeriodicRedrawIdlePane!(pane)).toBe(false);
 expect(b.getRuntimeDialogs!().some(d=>d.pattern.test(pane)&&(!d.isActive||d.isActive(pane)))).toBe(true);
});

it('a currently active delivery-blocking dialog outranks the known contextless tail',()=>{
 const b=backend(),pane='MENU ACTIVE\n'+native;vi.spyOn(b,'getRuntimeDialogs').mockReturnValue([{pattern:/MENU ACTIVE/,keys:[],holdOnly:true,description:'active current fixture',isActive:()=>true}]);
 expect(b.isDeliveryInputReadyPane!(pane)).toBe(false);expect(b.isPeriodicRedrawIdlePane!(pane)).toBe(false);
});
