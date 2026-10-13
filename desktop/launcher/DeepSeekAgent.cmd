@echo off
REM ============================================================
REM DeepSeek Agent launcher - double-click to run
REM
REM 2026-09-03：升级 Electron 44.1.1 后包内不再外挂 node.exe。
REM Electron 二进制设置 ELECTRON_RUN_AS_NODE=1 时等价于纯 Node，
REM 因此直接用 exe 自身运行 run-agent.js，由它再以 GUI 模式拉起真正的客户端：
REM
REM   1) ELECTRON_RUN_AS_NODE=1  DeepSeekAgent.exe run-agent.js   (当 node)
REM   2) run-agent.js 剔除该变量后 spawn DeepSeekAgent.exe        (真 GUI)
REM
REM 走启动器而非直接双击 exe 的价值：保证 cwd = exe 目录、统一收敛日志、
REM 便于单实例管理。若启动器异常，最后一行 fallback 直接启动 exe，保证可用。
REM ============================================================
setlocal
cd /d "D:\DeepSeekAgent"
set ELECTRON_RUN_AS_NODE=1
"D:\DeepSeekAgent\DeepSeekAgent.exe" "D:\DeepSeekAgent\run-agent.js"
if errorlevel 1 (
  set ELECTRON_RUN_AS_NODE=
  start "" "D:\DeepSeekAgent\DeepSeekAgent.exe"
)
endlocal
exit /b 0
