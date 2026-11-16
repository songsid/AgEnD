param([string]$Tag,[ValidateSet("chrome.exe","msedge.exe")][string]$BrowserProcess,[string]$Out)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class OwnWindow {
 public delegate bool Visitor(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor f,IntPtr p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int z,uint f);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
}
'@
$owned=@(Get-CimInstance Win32_Process -Filter "Name='$BrowserProcess'" | Where-Object {$_.CommandLine -like "*$Tag*"} | ForEach-Object {$_.ProcessId})
$chosen=[OwnWindow]::GetForegroundWindow();[uint32]$owner=0;[void][OwnWindow]::GetWindowThreadProcessId($chosen,[ref]$owner)
$title=New-Object Text.StringBuilder 512;[void][OwnWindow]::GetWindowText($chosen,$title,512)
if($owned -notcontains $owner -or $title.ToString() -notmatch 'AgEnD'){throw 'Foreground window is not the selected owned installed target'}
if($chosen -eq [IntPtr]::Zero){throw 'No owned installed AgEnD window'}
[void][OwnWindow]::SetWindowPos($chosen,[IntPtr]::Zero,30,30,1120,820,0x0040)
[void][OwnWindow]::SetForegroundWindow($chosen)
Start-Sleep -Milliseconds 700
if([OwnWindow]::GetForegroundWindow() -ne $chosen){throw 'Owned window is not foreground; refusing a screen capture'}
$r=New-Object OwnWindow+Rect;[void][OwnWindow]::GetWindowRect($chosen,[ref]$r)
$b=New-Object Drawing.Bitmap ($r.Right-$r.Left),($r.Bottom-$r.Top)
$g=[Drawing.Graphics]::FromImage($b)
try{$g.CopyFromScreen($r.Left,$r.Top,0,0,$b.Size);$b.Save($Out,[Drawing.Imaging.ImageFormat]::Png);$c=$b.GetPixel(300,20);@{width=$b.Width;height=$b.Height;captionColor=('#{0:x2}{1:x2}{2:x2}' -f $c.R,$c.G,$c.B);owned=$true}|ConvertTo-Json -Compress}finally{$g.Dispose();$b.Dispose()}
