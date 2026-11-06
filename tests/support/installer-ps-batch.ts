/** One isolated pwsh worker per file. Compile sliced production helpers once, then execute case tails. */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll } from "vitest";
import { InstallerPsStartGate, installerPsStartSlots, type InstallerPsStartTicket } from "./installer-ps-start.js";

export const hasPwsh = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["pwsh"]).status === 0;
// Startup keeps the old 10 s request allowance, independently of each case.
// Only setup START covers the bounded queue and cleanup/reporting headroom.
const STARTUP_MS = 30_000; // DIAGNOSTIC ONLY: observe censored cold starts, never merge this branch.
export class InstallerPsBatch {
  private child?: ChildProcessWithoutNullStreams;
  private dir?: string;
  private next = 0;
  private readiness?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (e: Error) => void;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private startTicket?: InstallerPsStartTicket;
  private closed = false;
  private queueMs = 0;
  private slots = 0;
  private terminalError?: Error;
  private pending = new Map<number, { resolve: (r: { out: string; status: number }) => void; reject: (e: Error) => void }>();
  private stderr = "";
  private consoleOutput = "";
  constructor(private templates: Record<string, string>, warmInSetup = true, private injectedGate?: InstallerPsStartGate) {
    // Lazy until fixture setup; every consumer (including adapters) gets a warm
    // worker before its first case. Inert lifecycle probes can drive ready() themselves.
    if (warmInSetup) beforeAll(async () => { if (hasPwsh) await this.ready(); }, 42_000); // START only: queue <=30 s + cold start <=10 s + cleanup headroom.
    afterAll(async () => {
      this.closed = true;
      if (this.child) {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          const done = new Promise<void>(resolve => this.child!.once("close", () => resolve()));
          this.child.stdin.end();
          await done;
        }
      }
      if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    });
  }
  ready(): Promise<void> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.readiness) return this.readiness;
    this.readiness = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve; this.readyReject = reject;
    });
    const queuedAt = performance.now();
    const launch = (ticket: InstallerPsStartTicket, slots: number) => {
      if (this.closed || this.terminalError) { ticket.release(); this.fail(this.terminalError ?? new Error("pwsh fixture closed before START")); return; }
      this.startTicket = ticket;
      this.queueMs = Math.round(performance.now() - queuedAt); this.slots = slots;
      if (process.env.CI) process.stderr.write(`[pwsh-queue] ${JSON.stringify({queueMs:Math.round(performance.now()-queuedAt), slots, cores:availableParallelism()})}\n`);
      this.startupTimer = setTimeout(() => {
        this.fail(new Error("pwsh startup observation exceeded 30 s"));
        this.child?.kill();
      }, STARTUP_MS);
      try { this.start(); } catch (e) { this.fail(e instanceof Error ? e : new Error(String(e))); this.child?.kill(); }
    };
    try {
      const runRoot = process.env.AGEND_TEST_GUARD_DIR;
      if (!runRoot && !this.injectedGate) throw Error("pwsh START requires a private test-run root");
      const gate = this.injectedGate ?? new InstallerPsStartGate(join(runRoot!, "pwsh-starts"), installerPsStartSlots(availableParallelism()));
      const ticket = gate.tryAcquire();
      if (ticket) launch(ticket, gate.slots);
      else void gate.acquire().then(t => launch(t, gate.slots), e => this.fail(e));
    } catch (e) { this.fail(e instanceof Error ? e : new Error(String(e))); }
    return this.readiness;
  }
  private start() {
    const started = performance.now();
    let bootstrapMs: number | undefined;
    let spawnAt = started;
    this.dir = mkdtempSync(join(tmpdir(), "agend-ps-batch-"));
    const workerId = basename(this.dir);
    const templates = join(this.dir, "templates.json"), driver = join(this.dir, "driver.ps1");
    writeFileSync(templates, JSON.stringify(this.templates));
    writeFileSync(driver, String.raw`
[Console]::WriteLine('__AGEND_BOOT__')
$compileClock = [Diagnostics.Stopwatch]::StartNew()
$ErrorActionPreference = 'Stop'
class BatchExit : System.Exception { [int]$Code; BatchExit([int]$code) : base('batch exit') { $this.Code = $code } }
# Parse only the already-sliced helper template, once. Exit becomes a typed unwind so a
# production exit still skips the tail and runs finally, without killing the batch worker.
function Compile-Batch([string]$text) {
  $t=$null; $e=$null
  $ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$t,[ref]$e)
  if ($e.Count) { throw ($e | Out-String) }
  foreach($x in @($ast.FindAll({param($n) $n -is [Management.Automation.Language.ExitStatementAst]},$true) | Sort-Object { $_.Extent.StartOffset } -Descending)) {
    $arg=if($x.Pipeline){$x.Pipeline.Extent.Text}else{'0'}
    $text=$text.Remove($x.Extent.StartOffset,$x.Extent.EndOffset-$x.Extent.StartOffset).Insert($x.Extent.StartOffset,('throw [BatchExit]::new([int]('+ $arg +'))'))
  }
  return [scriptblock]::Create($text)
}
$templates=@{}
(Get-Content -Raw -LiteralPath $args[0] | ConvertFrom-Json -AsHashtable).GetEnumerator() | ForEach-Object { $templates[$_.Key]=Compile-Batch $_.Value }
[Console]::WriteLine(('__AGEND_READY__'+$compileClock.ElapsedMilliseconds))
while($null -ne ($line=[Console]::ReadLine())) {
  $request=$line | ConvertFrom-Json -AsHashtable
  $saved=@{}; Get-ChildItem Env: | ForEach-Object { $saved[$_.Name]=$_.Value }
  $output=[Collections.Generic.List[string]]::new(); $status=0; $errorText=$null
  try {
    foreach($key in $request.env.Keys){[Environment]::SetEnvironmentVariable($key,[string]$request.env[$key])}
    & {
      . $templates[$request.template]
      $script:OnWindows=$false; $script:InstallLog=$null; $script:InstallLogShown=$false; $script:InstallLogFull=$false
      $script:WatchQuiet=$false
      $script:BatchAnswers=[Collections.Generic.Queue[string]]::new()
      foreach($answer in @($request.input -split "\n" | Select-Object -SkipLast 1)){ $script:BatchAnswers.Enqueue($answer.TrimEnd([char]13)) }
      function Read-Host { param($Prompt) if($Prompt){Write-Host $Prompt}; if($script:BatchAnswers.Count){return $script:BatchAnswers.Dequeue()}; return $null }
      function Read-Answer { return Read-Host }
      # No real WSL, COM, or waiting unless a case explicitly supplies an inert model.
      function wsl.exe { throw 'Unstubbed WSL forbidden' }
      function wsl { throw 'Unstubbed WSL forbidden' }
      function Start-Sleep { param($Seconds,$Milliseconds) }
      function Invoke-BatchScript([string]$name) { . $templates[$name] }
      . ([scriptblock]::Create($request.body))
    } *>&1 | ForEach-Object { $output.Add([string]$_) }
  } catch {
    if($_.Exception -is [BatchExit]){$status=$_.Exception.Code}else{$status=1; $errorText=($_ | Out-String)}
  } finally {
    Get-ChildItem Env: | Where-Object {-not $saved.ContainsKey($_.Name)} | ForEach-Object {[Environment]::SetEnvironmentVariable($_.Name,$null)}
    foreach($key in $saved.Keys){[Environment]::SetEnvironmentVariable($key,$saved[$key])}
  }
  [Console]::WriteLine(('__AGEND_BATCH__'+(@{id=$request.id;out=($output -join [char]10)+[char]10;status=$status;error=$errorText} | ConvertTo-Json -Compress)))
}
`);
    spawnAt = performance.now();
    if (process.env.CI) process.stderr.write(`[pwsh-prepare] ${JSON.stringify({workerId, at:Date.now(), prepareMs:Math.round(spawnAt-started), templateBytes:Object.values(this.templates).reduce((n,s)=>n+Buffer.byteLength(s),0)})}\n`);
    this.child = spawn("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", driver, templates], {
      // Linux pwsh's JIT profile and module analysis cache otherwise race with
      // every parallel fixture using the runner's shared home cache.
      env: { ...process.env, XDG_CACHE_HOME: join(this.dir, "cache"), PSModuleAnalysisCachePath: join(this.dir, "module-analysis") },
    });
    this.child.stdin.on("error", e => this.fail(e));
    this.child.stderr.on("data", (b: Buffer) => { this.stderr += b; });
    createInterface({ input: this.child.stdout }).on("line", line => {
      try {
        if (line === "__AGEND_BOOT__" && this.readyResolve) { bootstrapMs = performance.now() - started;
          if (process.env.CI) process.stderr.write(`[pwsh-bootstrap] ${JSON.stringify({workerId, at:Date.now(), bootstrapMs:Math.round(bootstrapMs), processMs:Math.round(performance.now()-spawnAt), templateBytes:Object.values(this.templates).reduce((n,s)=>n+Buffer.byteLength(s),0)})}\n`);
          return; }
        const ready = /^__AGEND_READY__(\d+)$/.exec(line);
        if (ready && this.readyResolve) {
          if (process.env.CI) process.stderr.write(`[pwsh-startup] ${JSON.stringify({ workerId, at:Date.now(), queueMs:this.queueMs, slots:this.slots, bootstrapMs: Math.round(bootstrapMs ?? 0), compileMs: Number(ready[1]), readyMs: Math.round(performance.now() - started), templateBytes: Object.values(this.templates).reduce((n, s) => n + Buffer.byteLength(s), 0) })}\n`);
          this.releaseStart();
          clearTimeout(this.startupTimer); this.startupTimer = undefined;
          const resolve = this.readyResolve; this.readyResolve = undefined; this.readyReject = undefined;
          resolve(); return;
        }
        const marker = line.indexOf("__AGEND_BATCH__");
        if (marker < 0) { this.consoleOutput += line + "\n"; return; }
        this.consoleOutput += line.slice(0, marker);
        const r = JSON.parse(line.slice(marker + "__AGEND_BATCH__".length)), p = this.pending.get(r.id);
        r.out = this.consoleOutput + r.out; this.consoleOutput = "";
        if (!p) throw new Error(`Unexpected batch output: ${line}`);
        this.pending.delete(r.id);
        if (r.error) p.reject(new Error(r.error)); else p.resolve(r);
      } catch (e) { this.fail(e instanceof Error ? e : new Error(String(e))); }
    });
    this.child.on("error", e => this.fail(e));
    this.child.on("close", code => { this.releaseStart(); this.fail(new Error(`pwsh batch exited ${code}: ${this.stderr}`)); });
  }
  private releaseStart() { this.startTicket?.release(); this.startTicket = undefined; }
  private fail(e: Error) {
    this.terminalError ??= e;
    if (!this.child) this.releaseStart();
    clearTimeout(this.startupTimer); this.startupTimer = undefined;
    this.readyReject?.(this.terminalError); this.readyResolve = undefined; this.readyReject = undefined;
    for (const p of this.pending.values()) p.reject(this.terminalError);
    this.pending.clear();
  }
  async run(template: string, body: string, options: { env?: Record<string, string>; input?: string; status?: number } = {}) {
    if (this.terminalError) throw this.terminalError;
    await this.ready();
    if (this.terminalError || this.closed) throw this.terminalError ?? new Error("pwsh fixture closed before case");
    const id = ++this.next;
    const result = await new Promise<{ out: string; status: number }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.fail(new Error("pwsh case exceeded the existing 10 s test budget"));
        this.child!.kill();
      }, 10_000);
      this.pending.set(id, {
        resolve: r => { clearTimeout(timeout); resolve(r); },
        reject: e => { clearTimeout(timeout); reject(e); },
      });
      this.child!.stdin.write(JSON.stringify({ id, template, body, env: options.env ?? {}, input: options.input ?? "" }) + "\n");
    });
    if (result.status !== (options.status ?? 0)) throw new Error(`pwsh status ${result.status}: ${result.out}`);
    return result.out;
  }
}

/** Inert native-shell boundary: execute only scratch stub/wrapper files in this worker.
 * Exit remains an exit code, rather than killing the worker or being caught as a tool error. */
export const INERT_PWSH_CHILD = String.raw`function pwsh {
  $childArgs=@($args); $at=[Array]::IndexOf($childArgs,'-File')
  if($at -lt 0){throw 'Expected a scratch -File invocation'}
  $file=$childArgs[$at+1]; $tail=@($childArgs | Select-Object -Skip ($at+2))
  $global:LASTEXITCODE=0
  $block=Compile-Batch ([IO.File]::ReadAllText($file))
  $parameters=@{}
  foreach($p in $block.Ast.ParamBlock.Parameters){$parameters[$p.Name.VariablePath.UserPath]=$p.StaticType}
  $named=@{}
  for($i=0;$i -lt $tail.Count;$i++){
    $name=([string]$tail[$i]).TrimStart('-')
    if($parameters.ContainsKey($name)){
      if($parameters[$name] -eq [switch]){$named[$name]=$true}else{$i++;$named[$name]=$tail[$i]}
    }
  }
  try { & $block @named }
  catch { if($_.Exception -is [BatchExit]){$global:LASTEXITCODE=$_.Exception.Code}else{throw} }
}`;
