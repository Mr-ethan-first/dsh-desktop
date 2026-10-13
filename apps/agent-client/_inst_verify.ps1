$ErrorActionPreference = 'Continue'
$setup = 'D:\WorkSpace\deepseek-harness-master\apps\agent-client\release\DeepSeekAgent-Setup-0.1.0.exe'
$dir = 'C:\temp\dsh-inst-test'
if (Test-Path $dir) { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }
$p = Start-Process -FilePath $setup -ArgumentList '/S', "/D=$dir" -Wait -PassThru
'installer exit={0}' -f $p.ExitCode
$asar = Join-Path $dir 'resources\app.asar'
$maincjs = Join-Path $dir 'resources\app.asar.unpacked\electron\main.cjs'
$launcher = Join-Path $dir 'resources\app.asar.unpacked\electron\plugin-host\dsh-web-launcher.cjs'
'asar exists={0} size={1}' -f (Test-Path $asar), (Get-Item $asar -ErrorAction SilentlyContinue).Length
$b = [IO.File]::ReadAllBytes($asar)
$txt = [Text.Encoding]::ASCII.GetString($b)
foreach ($pat in '1d652041','EDXLXDY','CML53A1HXWSC7YUE','dashscope','aliyuncs','HARDCODED_ZHIPU_KEY') {
  '{0} in asar: {1}' -f $pat, ([regex]::Matches($txt, [regex]::Escape($pat))).Count
}
'test-files-in-package={0}' -f (@(Get-ChildItem -Recurse -Path (Join-Path $dir 'resources') -Include '*.test.ts','*.spec.ts' -ErrorAction SilentlyContinue).Count)
'maincjs sanitizer={0} shutdown={1}' -f ([bool](Select-String -Path $maincjs -Pattern 'DSH_TRUST_LAUNCH_ENV' -Quiet)), ([bool](Select-String -Path $maincjs -Pattern 'shutdownAllServices' -Quiet))
'launcher no-open={0}' -f ([bool](Select-String -Path $launcher -Pattern '\-\-no-open' -Quiet))
$nsi = 'D:\WorkSpace\deepseek-harness-master\apps\agent-client\installer\DeepSeekAgent.nsi'
'nsi nsExec={0}' -f ([bool](Select-String -Path $nsi -Pattern 'nsExec::Exec .robocopy' -Quiet))
$u = Join-Path $dir 'Uninstall.exe'
if (Test-Path $u) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $up = Start-Process -FilePath $u -ArgumentList '/S' -Wait -PassThru
  $sw.Stop()
  'uninstalled exit={0} elapsed={1}s' -f $up.ExitCode, [int]$sw.Elapsed.TotalSeconds
  Start-Sleep 2
  'install-dir-removed={0}' -f (-not (Test-Path $dir))
} else { 'uninstaller NOT FOUND' }
