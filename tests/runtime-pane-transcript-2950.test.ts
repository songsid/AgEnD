/** No provider launch or user store: exact-session fixtures under a private scratch tree. */
import { afterEach, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path"; import { tmpdir } from "node:os"; import { randomUUID, createHash } from "node:crypto";
import { NativePaneTranscriptReader, nativeClaudeProjectKey, validatePaneTranscriptCursor } from "../src/runtime-pane-transcript.js";
import { claudeProjectKey } from "../src/backend/claude-code.js";
import { validatePaneTranscriptWireBatch } from "../src/runtime-pane-transcript-protocol.js";
const roots: string[] = []; afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function rig(provider: "codex" | "claude-code" = "codex") {
 const root = mkdtempSync(join(tmpdir(), "agend-pane-transcript-")); roots.push(root);
 const cwd = join(root, "workspace-中文"), codex = join(root, "codex"), claude = join(root, "claude"), sessionId = randomUUID(); mkdirSync(cwd);
 const folder = provider === "codex" ? join(codex, "sessions", "2026", "11", "03") : join(claude, "projects", nativeClaudeProjectKey(cwd)); mkdirSync(folder, { recursive: true });
 const path = join(folder, provider === "codex" ? `rollout-2026-11-03T00-00-00-${sessionId}.jsonl` : `${sessionId}.jsonl`);
 const meta = provider === "codex" ? { type: "session_meta", payload: { id: sessionId, cwd } } : { type: "user", sessionId, cwd, message: { role: "user", content: "question" } };
 const line = (entry: unknown) => JSON.stringify(entry) + "\n";
 const reader = () => new NativePaneTranscriptReader(provider, cwd, sessionId, { codex, claude });
 return { root, cwd, codex, claude, sessionId, folder, path, meta, line, reader };
}
it("pins a fresh session while its deferred transcript is absent, then reads only that exact id", async () => {
 const f = rig(), reader = f.reader();
 writeFileSync(join(f.folder, `rollout-newer-${randomUUID()}.jsonl`), f.line({ ...f.meta, payload: { id: randomUUID(), cwd: f.cwd } }));
 const pending = await reader.read(); expect(pending).toMatchObject({ state: "pending", lines: [], complete: false, cursor: { fileId: null, offset: 0, sessionId: f.sessionId } });
 writeFileSync(f.path, f.line(f.meta) + f.line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "owned" }] } }));
 const found = await reader.read(pending.cursor); expect(found.state).toBe("ready"); expect(found.complete).toBe(true); expect(found.lines).toHaveLength(2);
 expect(JSON.stringify(found)).not.toContain(f.path); expect(found.cursor.fileId).toMatch(/^[a-f0-9]{64}$/);
});
it.each(["codex", "claude-code"] as const)("%s rejects another session or cwd, even in an exact-id filename", async provider => {
 const f = rig(provider);
 for (const change of ["session", "cwd"]) {
  const entry = provider === "codex" ? { ...f.meta, payload: { id: change === "session" ? randomUUID() : f.sessionId, cwd: change === "cwd" ? join(f.root, "other") : f.cwd } }
    : { ...f.meta, sessionId: change === "session" ? randomUUID() : f.sessionId, cwd: change === "cwd" ? join(f.root, "other") : f.cwd };
  writeFileSync(f.path, f.line(entry)); await expect(f.reader().read()).rejects.toThrow("metadata differs");
 }
});
it("Claude requires an exact cwd/session record and refuses sidechains", async () => {
 const f = rig("claude-code"); writeFileSync(f.path, f.line({ type: "summary", summary: "not ownership" })); await expect(f.reader().read()).rejects.toThrow("no exact session");
 writeFileSync(f.path, f.line({ ...f.meta, isSidechain: true })); await expect(f.reader().read()).rejects.toThrow("metadata differs");
 writeFileSync(f.path, f.line({ type: "queue-operation", operation: "enqueue" }) + f.line(f.meta)); expect((await f.reader().read()).state).toBe("ready");
});
it("uses Claude's bounded native project key, including a negative Java hash", () => {
 expect(nativeClaudeProjectKey("C:\\Users\\中文\\scratch")).toBe("C--Users----scratch");
 for (const path of ["/scratch/with.dots_and spaces", "/" + "a".repeat(250), "/" + "b".repeat(290)]) expect(nativeClaudeProjectKey(path)).toBe(claudeProjectKey(path));
});
it("refuses duplicate exact Codex ids instead of picking the newest", async () => {
 const f = rig(); writeFileSync(f.path, f.line(f.meta)); writeFileSync(join(f.folder, `rollout-other-${f.sessionId}.jsonl`), f.line(f.meta));
 await expect(f.reader().read()).rejects.toThrow("ambiguous");
});
it("continues bounded discovery across looks instead of repeatedly restarting a cold store scan", async () => {
 const f = rig(); for (let n = 0; n < 300; n++) writeFileSync(join(f.folder, `rollout-${n}-${randomUUID()}.jsonl`), "not ours, never read"); writeFileSync(f.path, f.line(f.meta));
 const reader = f.reader(); let result = await reader.read(), pending = result.state === "pending" ? 1 : 0, tries = 1;
 while (result.state === "pending" && tries++ < 10) { result = await reader.read(result.cursor); if (result.state === "pending") pending++; }
 expect(pending).toBeGreaterThan(0); expect(result.state).toBe("ready"); expect(result.lines).toEqual([JSON.stringify(f.meta)]); await reader.close(); await expect(reader.read()).rejects.toThrow("closed");
});
it("does not follow a matching transcript symlink or provider directory link", async () => {
 const f = rig(), target = join(f.root, "unrelated.jsonl"); writeFileSync(target, f.line(f.meta)); symlinkSync(target, f.path);
 await expect(f.reader().read()).rejects.toThrow("regular"); rmSync(f.path); const moved = f.codex + "-moved"; renameSync(f.codex, moved); symlinkSync(moved, f.codex, "dir");
 await expect(f.reader().read()).rejects.toThrow("real directory"); expect(readFileSync(target, "utf8")).toBe(f.line(f.meta));
});
it("carries only complete records, retries a partial UTF-8 line, and advances exactly once", async () => {
 const f = rig(), reader = f.reader(), start = f.line(f.meta); writeFileSync(f.path, start);
 const first = await reader.read(); const text = f.line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "中文" }] } });
 appendFileSync(f.path, text.slice(0, -1)); const partial = await reader.read(first.cursor); expect(partial.lines).toEqual([]); expect(partial.cursor.offset).toBe(first.cursor.offset); expect(partial.complete).toBe(false);
 appendFileSync(f.path, "\n"); const completed = await reader.read(partial.cursor); expect(completed.lines).toEqual([text.trimEnd()]); expect(completed.complete).toBe(true);
 expect((await reader.read(completed.cursor)).lines).toEqual([]);
});
it("rejects replacement, truncation and checkpoint-byte changes without advancing a caller's cursor", async () => {
 const f = rig(), reader = f.reader(); writeFileSync(f.path, f.line(f.meta) + f.line({ type: "system", content: "original" })); const first = await reader.read(); const saved = JSON.stringify(first.cursor);
 writeFileSync(f.path, f.line(f.meta) + f.line({ type: "system", content: "modified" })); await expect(reader.read(first.cursor)).rejects.toThrow("checkpoint bytes changed");
 writeFileSync(f.path, f.line(f.meta)); await expect(reader.read(first.cursor)).rejects.toThrow("truncated");
 renameSync(f.path, f.path + ".old"); writeFileSync(f.path, f.line(f.meta)); await expect(reader.read(first.cursor)).rejects.toThrow("identity changed"); expect(JSON.stringify(first.cursor)).toBe(saved);
});
it("skips an oversized record with an explicit gap and never parses its partial tail as a turn boundary", async () => {
 const f = rig(), reader = f.reader(); writeFileSync(f.path, f.line(f.meta)); const first = await reader.read();
 appendFileSync(f.path, "x".repeat(256 * 1024)); const skipped = await reader.read(first.cursor); expect(skipped).toMatchObject({ gap: true, complete: false, lines: [], cursor: { skipping: true } }); expect(skipped.cursor.offset).toBeGreaterThan(first.cursor.offset);
 appendFileSync(f.path, f.line({ type: "event_msg", payload: { type: "task_complete", turn_id: "forged-tail" } }) + f.line({ type: "event_msg", payload: { type: "task_started", turn_id: "real-new-turn" } }));
 const next = await reader.read(skipped.cursor); expect(next.gap).toBe(true); expect(next.cursor.skipping).toBeUndefined(); expect(next.lines).toHaveLength(1); expect(JSON.parse(next.lines[0]).payload.turn_id).toBe("real-new-turn"); expect(next.complete).toBe(true);
});
it("invalid UTF-8/JSON cannot manufacture a completed boundary or leak source text into an error", async () => {
 const f = rig();
 writeFileSync(f.path, Buffer.concat([Buffer.from(f.line(f.meta)), Buffer.from([0xff, 10])])); await expect(f.reader().read()).rejects.toThrow();
 writeFileSync(f.path, f.line(f.meta) + "not-json\n"); await expect(f.reader().read()).rejects.toThrow();
 writeFileSync(f.path, f.line(f.meta) + "PRIVATE_PROVIDER_OUTPUT\n"); const error = await f.reader().read().catch(e => e); expect(error.message).toBe("Pane transcript contains an invalid JSON record"); expect(error.message).not.toContain("PRIVATE_PROVIDER_OUTPUT");
});
it("keeps escaped transcript data below a runtime frame and validates the closed wire response", async () => {
 const f = rig(); writeFileSync(f.path, f.line(f.meta) + f.line({ type: "response_item", payload: { type: "message", role: "user", content: [{ text: "\\".repeat(64000) }] } }));
 const batch = await f.reader().read(); const { lines, ...wire } = batch; expect(lines).toHaveLength(2); expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(256 * 1024);
 expect(validatePaneTranscriptWireBatch(wire, f.sessionId)).toEqual(wire); expect(Buffer.from(wire.data, "base64").toString("utf8").trimEnd().split("\n")).toEqual(lines);
 for (const extra of [{ path: f.path }, { data: "not base64" }, { cursor: { ...wire.cursor, sessionId: randomUUID() } }, { state: "pending" }, { gap: "yes" }]) expect(() => validatePaneTranscriptWireBatch({ ...wire, ...extra }, f.sessionId)).toThrow();
});
it("validates a large initial metadata record once, then reports its skipped event bytes explicitly", async () => {
 const f = rig(); writeFileSync(f.path, f.line({ ...f.meta, payload: { ...(f.meta as any).payload, base_instructions: "x".repeat(200000) } }) + f.line({ type: "event_msg", payload: { type: "task_started", turn_id: "owned" } }));
 const reader = f.reader(), first = await reader.read(); expect(first.cursor.fileId).toMatch(/^[a-f0-9]{64}$/); expect(first.gap).toBe(true);
 const next = await reader.read(first.cursor); expect(next.lines).toHaveLength(1); expect(JSON.parse(next.lines[0]).payload.turn_id).toBe("owned");
});
it("a revoked read and concurrent look cannot publish late ownership evidence", async () => {
 const f = rig(), reader = f.reader(); writeFileSync(f.path, f.line(f.meta)); let current = true;
 const held = reader.read(reader.initial, () => current); const concurrent = reader.read(); current = false;
 await expect(concurrent).rejects.toThrow("already pending"); await expect(held).rejects.toThrow(); expect((await reader.read()).state).toBe("ready");
});
it("a bound file disappearing never degrades to an unbound pending session", async () => {
 const f = rig(), reader = f.reader(); writeFileSync(f.path, f.line(f.meta)); const first = await reader.read(); rmSync(f.path); await expect(reader.read(first.cursor)).rejects.toThrow("disappeared");
});
it("cursor validation accepts no host paths, foreign ids, unbound offsets or invented anchors", () => {
 const f = rig(), cursor = f.reader().initial; expect(validatePaneTranscriptCursor(cursor, f.sessionId)).toEqual(cursor);
 for (const extra of [{ path: f.path }, { sessionId: randomUUID() }, { offset: 1 }, { anchor: "a".repeat(64) }, { fileId: "not-a-hash" }]) expect(() => validatePaneTranscriptCursor({ ...cursor, ...extra }, f.sessionId)).toThrow();
 expect(cursor.anchor).toBe(createHash("sha256").update("").digest("hex"));
});
it('baselines a multi-megabyte owned history in one bounded look without returning old content',async()=>{
 const f=rig();writeFileSync(f.path,f.line(f.meta)+f.line({type:'event_msg',payload:{type:'task_started',turn_id:'old'}})+f.line({type:'padding',text:'x'.repeat(5*1024*1024)})+f.line({type:'event_msg',payload:{type:'task_started',turn_id:'current'}}));const reader=f.reader();
 const baseline=await reader.baseline();expect(baseline).toMatchObject({state:'ready',complete:true,turnKnown:true,openTurn:'current'});expect(baseline.cursor.offset).toBe(readFileSync(f.path).length);expect(JSON.stringify(baseline).length).toBeLessThan(512);expect(JSON.stringify(baseline)).not.toContain(f.path);expect(JSON.stringify(baseline)).not.toContain('old');
 appendFileSync(f.path,f.line({type:'event_msg',payload:{type:'task_complete',turn_id:'current',last_agent_message:'done'}}));const delta=await reader.read(baseline.cursor);expect(delta.lines).toHaveLength(1);expect(delta.lines[0]).toContain('task_complete');
});
it('a tail with no provable turn start cannot fabricate a closed Codex ledger',async()=>{
 const f=rig();writeFileSync(f.path,f.line(f.meta)+f.line({type:'event_msg',payload:{type:'task_started',turn_id:'beyond-tail'}})+f.line({type:'padding',text:'x'.repeat(5*1024*1024)})+f.line({type:'event_msg',payload:{type:'task_complete',turn_id:'beyond-tail',last_agent_message:'done'}}));
 expect(await f.reader().baseline()).toMatchObject({state:'ready',turnKnown:false,openTurn:null});
});
it.each(['codex','claude-code'] as const)('%s baseline keeps exact-session, workspace and replacement fences',async provider=>{
 const f=rig(provider);writeFileSync(f.path,f.line(f.meta));const reader=f.reader(),first=await reader.baseline();
 renameSync(f.path,f.path+'.old');writeFileSync(f.path,f.line(f.meta));await expect(reader.baseline({...first.cursor,offset:0,anchor:reader.initial.anchor})).rejects.toThrow('identity changed');
 const wrong=provider==='codex'?{...f.meta,payload:{id:f.sessionId,cwd:join(f.root,'other')}}:{...f.meta,cwd:join(f.root,'other')};writeFileSync(f.path,f.line(wrong));await expect(f.reader().baseline()).rejects.toThrow('metadata differs');
});
it('Claude tail baseline does not split a partial final record or replay earlier tool use',async()=>{
 const f=rig('claude-code');writeFileSync(f.path,f.line(f.meta)+f.line({type:'assistant',sessionId:f.sessionId,cwd:f.cwd,message:{content:[{type:'tool_use',name:'Read',input:{file:'old'}}]}})+'{"type":"assistant"');
 const reader=f.reader(),baseline=await reader.baseline();expect(baseline).toMatchObject({state:'ready',complete:false,openTurn:null});expect(baseline.cursor.offset).toBeLessThan(readFileSync(f.path).length);appendFileSync(f.path,',"message":{"content":"new"}}\n');const delta=await reader.read(baseline.cursor);expect(delta.lines).toHaveLength(1);expect(delta.lines[0]).toContain('new');
});
