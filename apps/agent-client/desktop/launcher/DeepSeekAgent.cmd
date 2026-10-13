@echo off
setlocal
set "EXE=D:\DeepSeekAgent\DeepSeekAgent.exe"
set "LAUNCHER=D:\DeepSeekAgent\run-agent.js"
if not exist "%EXE%" ( echo [DeepSeekAgent] 未找到 %EXE% & exit /b 1 )
if not exist "%LAUNCHER%" ( echo [DeepSeekAgent] 未找到 %LAUNCHER% & exit /b 1 )
rem 复用 Electron 内置 Node：让 exe 以纯 Node 模式运行 run-agent.js（点火即退）
set ELECTRON_RUN_AS_NODE=1
"%EXE%" "%LAUNCHER%"
endlocal
