' DeepSeek Agent launcher (hidden window) - 双击运行
'
' 2026-09-03：Electron 44.1.1 起不再随包外挂 node.exe，改用 Electron 二进制自身
' 以 ELECTRON_RUN_AS_NODE=1 运行 run-agent.js（无窗口、无 cmd 闪屏）。
Dim WshShell
Dim launcher
Dim exe
Dim cmdLine
Set WshShell = CreateObject("WScript.Shell")

launcher = "D:\DeepSeekAgent\run-agent.js"
exe = "D:\DeepSeekAgent\DeepSeekAgent.exe"

' 进程级环境变量：让 exe 本次以纯 Node 模式运行启动脚本
WshShell.Environment("Process").Item("ELECTRON_RUN_AS_NODE") = "1"

cmdLine = """" & exe & """ """ & launcher & """"
WshShell.Run cmdLine, 0, False
