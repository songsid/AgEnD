import {afterEach,expect,it} from "vitest";
import {setLocale} from "../src/locale.js";
import {prepareSettingsEffect} from "../src/settings-effect.js";
import type {RequestContextControlView} from "../src/request-context-control-api.js";
afterEach(()=>setLocale("en"));
it.each(["en","zh-TW"] as const)("the native/shared Stop confirmation discloses Go back loss in %s",locale=>{
 setLocale(locale);
 const view:RequestContextControlView={revision:1,enabled:false,everActivated:true,attempted:true,phase:"draining",canChange:true,
  blockers:[{id:"work:fixture",kind:"work",labels:["Demo worker"],action:"stop-work"}],
  goBack:{attemptIds:["20261126T010203Z-0a1b2c3d"],availableUntil:"2026-12-03T00:00:00Z",timeZone:"UTC"}};
 const input={revision:1,action:"resolve",blockerId:"work:fixture",resolution:"stop-work"},context={config:null,classic:{},requestContextControl:()=>view};
 const diff=prepareSettingsEffect("POST","/api/settings/request-context",input,context).diff!;
 const text=locale==="en"?"Stopping this work also ends Go back for this update.":"停止這項工作後，這次更新就不能再退回。";
 expect(diff.summary).toContain(text);expect(JSON.stringify(diff)).toContain("requestContextControl.stopGoBack");
 delete view.goBack;
 expect(prepareSettingsEffect("POST","/api/settings/request-context",input,context).diff!.summary).not.toContain(text);
});
it.each(["en","zh-TW"] as const)("legacy acknowledgement explicitly keeps the result unknown in %s",locale=>{
 setLocale(locale);
 const view:RequestContextControlView={revision:1,enabled:false,everActivated:false,attempted:true,phase:"blocked",canChange:true,
 blockers:[{id:"legacy-uncertain:fixture",kind:"legacy",labels:["Atlas → Beacon"],action:"acknowledge"}]};
 const diff=prepareSettingsEffect("POST","/api/settings/request-context",{revision:1,action:"resolve",blockerId:"legacy-uncertain:fixture",resolution:"acknowledge"},{config:null,classic:{},requestContextControl:()=>view}).diff!;
 expect(diff.summary).toContain(locale==="en"?"The result is still unknown. This marks the message as reviewed; it won't send it again.":"結果仍不明。這只會記錄你已看過，不會再次傳送。");
});
