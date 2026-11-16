param([string]$Tag,[ValidateSet("chrome.exe","msedge.exe")][string]$BrowserProcess,[ValidateSet("Install","Uninstall")][string]$Action)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class MenuWindow {
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
if(!$owned.Count){throw 'No owned browser process'}
$script:chosen=[IntPtr]::Zero
[MenuWindow]::EnumWindows({param($h,$p) [uint32]$owner=0;[void][MenuWindow]::GetWindowThreadProcessId($h,[ref]$owner);$title=New-Object Text.StringBuilder 512;[void][MenuWindow]::GetWindowText($h,$title,512);if($owned -contains $owner -and [MenuWindow]::IsWindowVisible($h) -and ($title.ToString() -match 'AgEnD' -and (($Action -eq 'Install' -and $title.ToString() -match 'Google Chrome|Microsoft Edge') -or ($Action -eq 'Uninstall' -and $title.ToString() -notmatch 'Google Chrome|Microsoft Edge')))){$script:chosen=$h};return $true},[IntPtr]::Zero)|Out-Null
if($chosen -eq [IntPtr]::Zero){throw 'No owned AgEnD browser window'}
[void][MenuWindow]::SetForegroundWindow($chosen)
function Find-Control($pattern,$type){
 $end=[DateTime]::UtcNow.AddSeconds(10)
 do{
  $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
  foreach($w in $windows){if($owned -notcontains $w.Current.ProcessId){continue}
   $all=$w.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,$type))
   foreach($c in $all){if(!$c.Current.IsOffscreen -and $c.Current.Name -match $pattern){return $c}}
  }
  Start-Sleep -Milliseconds 100
 }while([DateTime]::UtcNow -lt $end)
 $rows=@();foreach($w in $windows){if($owned -notcontains $w.Current.ProcessId){continue};foreach($c in $w.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)){if($c.Current.Name){$rows+=@{name=$c.Current.Name;type=$c.Current.ControlType.ProgrammaticName;offscreen=$c.Current.IsOffscreen}}}}
 $rows|ConvertTo-Json -Depth 4|Set-Content -Encoding UTF8 (Join-Path $PSScriptRoot 'controls-private.json')
 throw "Owned browser control missing: $pattern"
}
$clicked=New-Object Collections.Generic.List[string]
function Invoke-Control($c){
 $name=$c.Current.Name;$clicked.Add($name)
 @{action=$Action;control=$name;stage='intent'}|ConvertTo-Json -Compress|Add-Content -Encoding UTF8 (Join-Path $PSScriptRoot 'menu-actions.jsonl')
 $p=$null
 if($c.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$p)){$p.Invoke()}
 elseif($c.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$p)){$p.Expand()}
 else{$c.GetCurrentPattern([Windows.Automation.LegacyIAccessiblePattern]::Pattern).DoDefaultAction()}
 @{action=$Action;control=$name;stage='applied'}|ConvertTo-Json -Compress|Add-Content -Encoding UTF8 (Join-Path $PSScriptRoot 'menu-actions.jsonl')
 Start-Sleep -Milliseconds 300
}
$button=[Windows.Automation.ControlType]::Button;$item=[Windows.Automation.ControlType]::MenuItem
${initial}=[Windows.Automation.AutomationElement]::FromHandle($chosen)
$menu=$initial.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,$button))|Where-Object {!$_.Current.IsOffscreen -and $_.Current.Name -match '^Chrome$|^AgEnD( M3214 .*)?$|自訂.*(管理|控管|控制)|Customize and control|設定及其他|Settings and more'}|Select-Object -First 1
if(!$menu){throw 'No menu on the selected owned window'}
Invoke-Control $menu
if($Action -eq 'Install'){
 Invoke-Control (Find-Control '投放.*儲存|Cast.*save|儲存.*分享|Save.*share' $item)
 Invoke-Control (Find-Control '安裝.*(網頁|AgEnD|應用)|Install.*(app|page|AgEnD)|將網頁.*應用' $item)
 $deadline=[DateTime]::UtcNow.AddSeconds(15);$pressed=New-Object 'Collections.Generic.HashSet[string]';$confirmed=$false;$complete=$false
 do{
  $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
  $dialog=$null
  foreach($w in $windows){if($owned -notcontains $w.Current.ProcessId){continue};foreach($d in $w.FindAll([Windows.Automation.TreeScope]::Subtree,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Window))){if($d.Current.Name -match '安裝應用程式|Install app'){$dialog=$d;break}};if($dialog){break}}
  if(!$dialog){if($confirmed){$complete=$true;break};Start-Sleep -Milliseconds 100;continue}
  $labels=$dialog.FindAll([Windows.Automation.TreeScope]::Subtree,[Windows.Automation.Condition]::TrueCondition)
  $testName='AgEnD M3214 '+$Tag.Substring($Tag.Length-8)
  @($labels|ForEach-Object {$_.Current.Name})|ConvertTo-Json|Set-Content -Encoding UTF8 (Join-Path $PSScriptRoot 'install-labels-private.json')
  if(!($labels|Where-Object {$_.Current.Name.Contains($testName)})){Start-Sleep -Milliseconds 100;continue}
  $confirm=$labels|Where-Object {$_.Current.ControlType -eq $button -and !$_.Current.IsOffscreen -and $_.Current.IsEnabled -and $_.Current.Name -match '^(繼續|Continue|安裝|Install|建立|Create)$'}|Select-Object -First 1
  if($confirm){$id=($confirm.GetRuntimeId() -join '-')+'|'+$confirm.Current.Name;if($pressed.Add($id)){Invoke-Control $confirm;$confirmed=$true}}
  Start-Sleep -Milliseconds 100
 }while([DateTime]::UtcNow -lt $deadline)
 if(!$complete){throw 'The owned install dialog did not complete'}
}else{
 Invoke-Control (Find-Control '解除安裝.*AgEnD|Uninstall.*AgEnD|移除.*AgEnD' $item)
 Invoke-Control (Find-Control '^(解除安裝|移除|Uninstall|Remove)$' $button)
}
@{action=$Action;clicked=@($clicked);owned=$true}|ConvertTo-Json -Compress
