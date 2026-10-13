$ErrorActionPreference = 'Stop'
$target = "D:\WorkSpace\deepseek-harness-master\apps\agent-client\release\win-unpacked\resources\app.asar"

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class RmUtil {
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, StringBuilder strSessionKey);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  public static extern int RmRegisterResources(uint pSessionHandle, int nFiles, string[] rgsFilenames, int nApplications, IntPtr rgApplications, int nServices, IntPtr rgsServiceNames);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmGetList(uint pSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, IntPtr rgAffectedApps, out uint lpdwRebootReasons);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmEndSession(uint pSessionHandle);
}
'@
Add-Type -TypeDefinition $src

$sess = 0
$key = New-Object StringBuilder 255
$r = [RmUtil]::RmStartSession([ref]$sess, 0, $key)
Write-Host "RmStartSession=$r session=$sess"

$files = @($target)
[void][RmUtil]::RmRegisterResources($sess, $files.Length, $files, 0, [IntPtr]::Zero, 0, [IntPtr]::Zero)

$needed = 0
$info = 0
$reason = 0
[void][RmUtil]::RmGetList($sess, [ref]$needed, [ref]$info, [IntPtr]::Zero, [ref]$reason)
Write-Host "needed=$needed reason=$reason"

if ($needed -gt 0) {
  $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($needed * 1024)
  try {
    $info = $needed
    $ret = [RmUtil]::RmGetList($sess, [ref]$needed, [ref]$info, $buf, [ref]$reason)
    Write-Host "RmGetList=$ret returnedInfo=$info"
    for ($i = 0; $i -lt $info; $i++) {
      $off = $i * 1024
      $pid = [System.Runtime.InteropServices.Marshal]::ReadInt32($buf, $off)
      # 提取 appName (wchar[255]) 从 offset 16 起
      $name = [System.Runtime.InteropServices.Marshal]::PtrToStringUni([IntPtr]($buf.ToInt64() + $off + 16))
      Write-Host ("BLOCKER pid={0} appName={1}" -f $pid, $name)
      try {
        $p = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($p) { Write-Host ("  -> Name={0} Path={1} Cmd={2}" -f $p.Name, $p.Path, $p.CommandLine) }
      } catch { Write-Host ("  -> lookup failed: {0}" -f $_) }
    }
  } finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
  }
} else {
  Write-Host "No processes reported blocking the file at this moment."
}
[void][RmUtil]::RmEndSession($sess)
