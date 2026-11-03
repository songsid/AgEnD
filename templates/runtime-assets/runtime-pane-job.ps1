param(
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$WorkerPath,
  [Parameter(Mandatory=$true)][string]$StateDirectory,
  [Parameter(Mandatory=$true)][string]$LaunchId,
  [Parameter(Mandatory=$true)][string]$PaneId,
  [Parameter(Mandatory=$true)][string]$AgentId,
  [Parameter(Mandatory=$true)][int]$OwnerPid,
  [Parameter(Mandatory=$true)][int]$ReceiptPid
)
$ErrorActionPreference = 'Stop'
# Built-in Windows APIs only. The helper receives no stdin until its process HANDLE is assigned to the job.
# https://learn.microsoft.com/windows/win32/procthread/job-objects
Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
public static class AgendPaneJob {
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long ProcessTime,JobTime; public uint Flags; public UIntPtr MinWorking,MaxWorking;
    public uint ProcessLimit; public UIntPtr Affinity; public uint Priority,Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Limits Basic; public Io Io; public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long A,B,C,D; public uint Faults,Total,Active,Terminated; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Extended value,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,ref Accounting value,uint size,IntPtr length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string Quote(string value) {
    var result=new StringBuilder("\"");int slashes=0;
    foreach(char c in value) { if(c=='\\'){slashes++;continue;} if(c=='\"')result.Append('\\',slashes*2+1);else result.Append('\\',slashes);result.Append(c);slashes=0; }
    result.Append('\\',slashes*2);return result.Append('"').ToString();
  }
  static void Check(bool ok) { if(!ok)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  static uint Active(IntPtr job) { var value=new Accounting();Check(QueryInformationJobObject(job,1,ref value,(uint)Marshal.SizeOf(value),IntPtr.Zero));return value.Active; }
  static void Receipt(string directory,string launch,string pane,string agent,int receiptPid,long code) {
    Guid parsed; if(!Guid.TryParse(launch,out parsed)||!Guid.TryParse(pane,out parsed)||!Guid.TryParse(agent,out parsed))throw new InvalidOperationException();
    var json=new JavaScriptSerializer().Serialize(new {version=1,launchId=launch,paneId=pane,agentId=agent,pid=receiptPid,code=code});
    string exits=Path.Combine(directory,"exits");Directory.CreateDirectory(exits);
    string file=Path.Combine(exits,launch+".json"),temp=file+"."+Guid.NewGuid().ToString("N")+".tmp";
    byte[] bytes=new UTF8Encoding(false).GetBytes(json);
    using(var stream=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)){stream.Write(bytes,0,bytes.Length);stream.Flush(true);}
    for(int attempt=0;;attempt++){
      try{File.Move(temp,file);break;}
      catch(IOException){if(attempt>=4)throw;Thread.Sleep(10*(attempt+1));}
      catch(UnauthorizedAccessException){if(attempt>=4)throw;Thread.Sleep(10*(attempt+1));}
    }
  }
  public static int Run(string node,string worker,string directory,string launch,string pane,string agent,int ownerPid,int receiptPid) {
    IntPtr job=IntPtr.Zero;Process child=null,owner=null;bool assigned=false;string phase="create";
    var clock=Stopwatch.StartNew();long closeAt=-1,cliCode=1;
    var output=new StreamWriter(Console.OpenStandardOutput(),new UTF8Encoding(false)){AutoFlush=true};
    var outputLock=new object();bool outputOpen=true;
    Action<string> write=line=>{lock(outputLock){if(!outputOpen)return;try{output.WriteLine(line);}catch(IOException){outputOpen=false;}catch(ObjectDisposedException){outputOpen=false;}}};
    try {
      owner=Process.GetProcessById(ownerPid);var ownerHandle=owner.Handle;
      if(owner.HasExited)throw new InvalidOperationException();
      job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero);
      var limits=new Extended();limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE; breakaway is deliberately not enabled.
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits)));
      phase="start-helper";
      var start=new ProcessStartInfo(node,Quote(worker)){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,
        StandardOutputEncoding=new UTF8Encoding(false),StandardErrorEncoding=new UTF8Encoding(false)};
      child=Process.Start(start);
      phase="assign";Check(AssignProcessToJobObject(job,child.Handle));assigned=true;
      // No provider can launch before this assignment: runtime-pane-worker waits for its first stdin command.
      var inputWriter=new StreamWriter(child.StandardInput.BaseStream,new UTF8Encoding(false)){AutoFlush=true};
      var input=Task.Factory.StartNew(()=>{
        try { using(var reader=new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false))){string line;
          while((line=reader.ReadLine())!=null){
            if(line.Length>256*1024)break;
            try {var value=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(line);if(value.ContainsKey("type")&&(string)value["type"]=="close")Interlocked.CompareExchange(ref closeAt,clock.ElapsedMilliseconds,-1);}catch{}
            inputWriter.WriteLine(line);
          }
        }}catch{}finally{Interlocked.CompareExchange(ref closeAt,clock.ElapsedMilliseconds,-1);try{inputWriter.Close();}catch{}}
      },TaskCreationOptions.LongRunning);
      var stdout=Task.Factory.StartNew(()=>{string line;while((line=child.StandardOutput.ReadLine())!=null){
        try {var value=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(line);
          string type=value.ContainsKey("type")?value["type"] as string:null;
          if(type=="tree.exit")continue; // Only this job owner can attest whole-tree exit.
          if(type=="exit"&&value.ContainsKey("code"))cliCode=Convert.ToInt64(value["code"]);
        }catch{}write(line);
      }},TaskCreationOptions.LongRunning);
      var stderr=Task.Factory.StartNew(()=>{child.StandardError.ReadToEnd();},TaskCreationOptions.LongRunning);
      phase="running";
      while(!child.WaitForExit(50)){long requested=Interlocked.Read(ref closeAt);if(owner.HasExited||(requested>=0&&clock.ElapsedMilliseconds-requested>=5000)){Check(TerminateJobObject(job,1));break;}}
      phase="helper-exit";if(!child.WaitForExit(10000))throw new TimeoutException();
      if(!stdout.Wait(10000))throw new TimeoutException();stderr.Wait(1000);
      child.Dispose();child=null;
      // A CLI may have left a background descendant. Retire only members of this exact owned job.
      phase="tree-exit";if(Active(job)>0)Check(TerminateJobObject(job,1));
      long deadline=clock.ElapsedMilliseconds+10000;while(Active(job)!=0){if(clock.ElapsedMilliseconds>deadline)throw new TimeoutException();Thread.Sleep(20);}
      phase="receipt";Receipt(directory,launch,pane,agent,receiptPid,cliCode);
      write(new JavaScriptSerializer().Serialize(new {type="tree.exit",code=cliCode}));
      return 0;
    } catch(Exception error) {
      int code=error is System.ComponentModel.Win32Exception?((System.ComponentModel.Win32Exception)error).NativeErrorCode:0;
      try{string exits=Path.Combine(directory,"exits");Directory.CreateDirectory(exits);File.WriteAllText(Path.Combine(exits,launch+".error.json"),new JavaScriptSerializer().Serialize(new {launchId=launch,paneId=pane,agentId=agent,stage=phase,code=code}),new UTF8Encoding(false));}catch{}
      Console.Error.WriteLine("Windows pane ownership helper failed at "+phase+" (win32 "+code+"); process outcome is unconfirmed.");
      // A direct child handle is safe even if job assignment failed. No discovered PID is ever signalled.
      if(child!=null&&!assigned){try{child.Kill();child.WaitForExit(10000);}catch{}}
      return 1;
    } finally { if(job!=IntPtr.Zero)CloseHandle(job);if(child!=null)child.Dispose();if(owner!=null)owner.Dispose(); }
  }
}
'@
exit [AgendPaneJob]::Run($NodePath,$WorkerPath,$StateDirectory,$LaunchId,$PaneId,$AgentId,$OwnerPid,$ReceiptPid)
