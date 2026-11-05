import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {createNativePaneBackend} from "../src/backend/native-pane.js";
const capture=readFileSync(new URL("./fixtures/codex-0165-native-warning-footer.pane.txt",import.meta.url),"utf8");
const backend=()=>createNativePaneBackend("codex",()=>({sessionId:null,contextPercentage:null,statusLineItems:["context-remaining"],resumes:false}));
describe("native Codex warning footer capture",()=>{
 it.each([capture,capture.replace(/\? for shortcuts +/g,""),capture.replace("1 warning · f2 to view","2 · f2"),capture.replace("1 warning · f2 to view","2")])("readiness, composer ownership and periodic idle agree",pane=>{const b=backend();expect(b.getReadyPattern().test(pane)).toBe(true);expect(b.isDeliveryInputReadyPane!(pane)).toBe(true);expect(b.ownsComposerRows!(pane)).toBe(true);expect(b.isPeriodicRedrawIdlePane!(pane)).toBe(true);});
 it("recognised dialogs still match over the footer",()=>{const b=backend(),card=readFileSync(new URL("./fixtures/codex-0159-rate-limit-picker.pane.txt",import.meta.url),"utf8");const active=(b.getRuntimeDialogs?.()??[]).filter(d=>d.pattern.test(card)&&(!d.isActive||d.isActive(card)));expect(b.getReadyPattern().test(card)).toBe(false);expect(b.isDeliveryInputReadyPane!(card)).toBe(false);expect(active.length).toBeGreaterThan(0);expect(active.some(d=>d.blocksDelivery!==false)).toBe(true);});
});
