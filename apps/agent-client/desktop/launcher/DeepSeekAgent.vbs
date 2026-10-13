Dim WshShell
Set WshShell = CreateObject("WScript.Shell")
rem 复用 Electron 内置 Node 启动（不再依赖 resources/node24 外挂 node.exe）
WshShell.Run """D:\DeepSeekAgent\DeepSeekAgent.cmd""", 0, False
