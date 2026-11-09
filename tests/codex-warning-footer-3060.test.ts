import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {CodexBackend} from "../src/backend/codex.js";
const capture=readFileSync(new URL("./fixtures/codex-0165-native-warning-footer.pane.txt",import.meta.url),"utf8");
function backend(){const b=Object.create(CodexBackend.prototype) as CodexBackend;Object.assign(b,{configuredStatusLineItems:["context-remaining"],configuredStatusLinePattern:undefined});return b;}
const footer=(row:string)=>capture.replace(/^  \? for shortcuts[^\n]*$/m,row);
const passive=[
 "  ? for shortcuts                                      ⚠ 1 warning · f2 to view",
 "  ? for shortcuts                                      ⚠ 2 warnings · ctrl+f2 to view",
 "  ? for shortcuts                                      ⚠ 2 warnings · /warnings to view",
 "  ? for shortcuts                                      ⚠ 2 · f2",
 "  ? for shortcuts                                      ⚠ 2",
 "  ⚠ 1 warning · f2 to view", "  ⚠ 7 · f2", "  ⚠ 7",
 "  ← for agents · ? for shortcuts                       ⚠ 1 warning · f2 to view",
 "  ^x ^w for shortcuts                                  ⚠ 1 warning · alt+↑ to view",
 "  ? for shortcuts", "  ← for agents",
];
describe("#3060 audited passive Codex hint row follows an owned status footer",()=>{
 it.each(passive)("recognises %s",hint=>{const b=backend(),pane=footer(hint);expect(b.getReadyPattern().test(pane)).toBe(true);expect(b.isDeliveryInputReadyPane(pane)).toBe(true);expect(b.isPeriodicRedrawIdlePane(pane)).toBe(true);});
 it("keeps a draft's warning-only row and the provider's same-line status fields",()=>{const b=backend(),pane=footer("  ⚠ 2 warnings · f2 to view").replace("Ask Codex to do anything","my pending message").replace("Context 100% left","Context 100% left    Goal achieved");expect(b.getReadyPattern().test(pane)).toBe(true);expect(b.isDeliveryInputReadyPane(pane)).toBe(true);});
 it.each(["  ? for shortcuts   unknown", "  ? for shortcuts   ⚠ warning · f2 to view", "  ? for shortcuts   ⚠ 1 warning · arbitrary command to view", "  ? for shortcuts\n  Do you want to proceed?", "  Plan mode   ⚠ 1 warning · f2 to view", "  ? for shortcuts · Plan mode (shift+tab to cycle)", "  Press enter to confirm", "  tab to queue message", "  esc again to edit previous message", "  ctrl+c again to quit", "  ⚠ 1 warning · f2 to view\n  unknown", "  ? for shortcuts\n  ? for shortcuts"])("refuses non-passive or additional rows: %s",hint=>{const b=backend(),pane=footer(hint);expect(b.getReadyPattern().test(pane)).toBe(false);expect(b.isDeliveryInputReadyPane(pane)).toBe(false);expect(b.isPeriodicRedrawIdlePane(pane)).toBe(false);});
 it("does not manufacture a status/composer proof from a warning or historical prompt",()=>{const b=backend();for(const pane of [capture.replace("  Context 100% left\n",""),capture.replace("  Context 100% left","  arbitrary transcript output"),capture.replace("› Ask Codex to do anything","› 1. Update now"),capture+"  Would you like to proceed?\n"]){expect(b.getReadyPattern().test(pane)).toBe(false);expect(b.isDeliveryInputReadyPane(pane)).toBe(false);}});
 it("retains configured-status and non-first Context proof",()=>{for(const [items,status] of [[["run-state"],"Ready"],[["model-name","context-remaining"],"GPT-6-Luna · Context 100% left"]] as const){const b=backend();Object.assign(b,{configuredStatusLineItems:[...items],configuredStatusLinePattern:undefined});const pane=capture.replace("Context 100% left",status);expect(b.getReadyPattern().test(pane)).toBe(true);expect(b.isDeliveryInputReadyPane(pane)).toBe(true);expect(b.isPeriodicRedrawIdlePane(pane)).toBe(true);}});
 it("does not call a busy pane periodically idle",()=>{const b=backend(),pane=capture.replace("› Ask Codex to do anything","• Working (2s • esc to interrupt)\n› Ask Codex to do anything");expect(b.getBusyPattern().test(pane)).toBe(true);expect(b.isPeriodicRedrawIdlePane(pane)).toBe(false);});
});

