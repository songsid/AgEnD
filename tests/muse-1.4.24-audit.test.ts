/** Exact offline 1.4.24-R9131.1 / 1.4.23-R8977.1 controls; SOURCES.md distinguishes live frames from static pooled text. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MuseBackend, museApprovalRequestIdentity } from "../src/backend/muse.js";
const root=join(process.cwd(),"tests/fixtures/muse-1.4.24");
const backend=new MuseBackend("/tmp/agend-muse-1424-audit");
const pane=(name:string,control=false)=>readFileSync(join(root,control?"control":"",name+".pane.txt"),"utf8");
const errors=(text:string)=>backend.getErrorPatterns().filter(p=>p.pattern.test(text)).map(p=>({type:p.type,action:p.action}));
const dialogs=(text:string)=>backend.getRuntimeDialogs().filter(p=>p.pattern.test(text)&&(!p.isActive||p.isActive(text)));
for(const control of [false,true])describe(`Muse ${control?"1.4.23 control":"1.4.24"}`,()=>{
 it.each(["echo-idle","echo-resumed","meta-idle"])("%s: header and empty composer stay ready, with no held dialog",name=>{
  const text=pane(name,control);
  expect(text).toContain(`Muse Code ${control?"1.4.23":"1.4.24"}`);
  expect(backend.getReadyPattern().test(text)).toBe(true);
  expect(backend.isPeriodicRedrawIdlePane(text)).toBe(true);
  expect(backend.inputDraft(text)?.rows).toEqual([]);
  expect(dialogs(text)).toEqual([]);expect(errors(text)).toEqual([]);
 });
 it("the live busy and cancelled-draft frames cannot be treated as idle",()=>{
  expect(backend.getBusyPattern().test(pane("echo-busy",control))).toBe(true);
  expect(backend.isPeriodicRedrawIdlePane(pane("echo-busy",control))).toBe(false);
  expect(backend.inputDraft(pane("echo-after-escape",control))?.rows).toEqual(["cancel me"]);
  expect(backend.isPeriodicRedrawIdlePane(pane("echo-after-escape",control))).toBe(false);
 });
 it("trust and logged-out screens block readiness; login is held without keys",()=>{
  const trust=pane("first-run-trust-dialog",control),login=pane("logged-out",control);
  expect(backend.getStartupDialogs().filter(d=>d.pattern.test(trust)).map(d=>d.keys)).toEqual([["1","Enter"]]);
  expect(backend.getReadyPattern().test(trust)).toBe(false);
  expect(backend.isPeriodicRedrawIdlePane(login)).toBe(false);
  const held=dialogs(login);expect(held.length).toBeGreaterThan(0);
  expect(held.every(d=>d.holdOnly===true&&d.blocksDelivery===true&&d.keys.length===0)).toBe(true);
 });
 it.each(["approval-escalated","approval-untrusted-active"])("%s remains a human-only permission request",name=>{
  const text=pane(name,control),held=dialogs(text);
  expect(held).toHaveLength(1);
  expect(held[0]).toMatchObject({holdOnly:true,blocksDelivery:true,inputBlocked:true,keys:[]});
  expect(museApprovalRequestIdentity(text)).toBe(name==="approval-escalated"?"echo hi":"ls -la");
 });
 it("the staged permission frame is busy; it does not make an empty idle composer",()=>{
  const text=pane("approval-untrusted-staged",control);
  expect(text).toContain("keys active in a moment");
  expect(backend.getBusyPattern().test(text)).toBe(true);
  expect(backend.isPeriodicRedrawIdlePane(text)).toBe(false);
 });
 it.each([120,80])("%s columns: 429 retry, 429 exhaustion and 402 quota remain distinct",width=>{
  const retry=pane(`rate-retrying-${width}`,control),end=pane(`rate-exhausted-${width}`,control),quota=pane(`quota-${width}`,control);
  expect(retry).toContain("429");expect(end).toMatch(/after 10\s+provider attempts/);
  expect(errors(retry)).toEqual([{type:"rate_limit",action:"failover"}]);
  expect(errors(end)).toEqual([{type:"rate_limit",action:"failover"}]);
  expect(backend.getBusyPattern().test(retry)).toBe(true);
  expect(backend.isPeriodicRedrawIdlePane(end)).toBe(true);
  expect(errors(quota)).toEqual([{type:"quota",action:"notify"}]);
 });
 it("quit/resume use the same session contract; a missing session is explicitly recognised",()=>{
  expect(pane("echo-quit",control)).toMatch(/To continue this session, run muse resume [a-f0-9-]{36}/);
  const text=readFileSync(join(root,control?"control":"","resume-missing.stderr"),"utf8");
  expect(backend.resumeMissingPattern().test(text)).toBe(true);
 });
});
describe("Muse 1.4.24 changed string/transition",()=>{
 it.each([120,80])("%s columns: the inter-retry row is still busy/rate-limited, not quota or completion",width=>{
  const text=pane(`rate-between-retries-${width}`);
  expect(text).toContain("Thinking");
  expect(backend.getBusyPattern().test(text)).toBe(true);
  expect(backend.isPeriodicRedrawIdlePane(text)).toBe(false);
  expect(errors(text)).toEqual([{type:"rate_limit",action:"failover"}]);
 });
 it("the binary's new pooled rate-limited-retry label is covered without broadening the detector (source control, not a TUI capture)",()=>{
  expect(errors("rate limited retry")).toEqual([{type:"rate_limit",action:"failover"}]);
  expect(errors("usage limit reached")).toEqual([{type:"quota",action:"notify"}]);
 });
});
