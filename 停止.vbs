' AI IMG HUB —— 停止后台服务（配合 启动.vbs 使用）
' 按 PID 精确结束本项目的 node 进程，不会误杀别的 Node 程序
Option Explicit

Dim sh, fso, here, pidFile, ts, pid, tmp, txt, alive
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here     = fso.GetParentFolderName(WScript.ScriptFullName)
pidFile  = here & "\.server.pid"

pid = ""
If fso.FileExists(pidFile) Then
  Set ts = fso.OpenTextFile(pidFile, 1)
  pid = Trim(ts.ReadAll)
  ts.Close
End If

' 没有 PID 记录（例如上次是被强行结束的）就从监听端口反查
If Not IsNumeric(pid) Then pid = PidByPort(8788)

If Not IsNumeric(pid) Then
  If fso.FileExists(pidFile) Then fso.DeleteFile pidFile, True
  MsgBox "没有找到正在运行的服务。", 64, "AI IMG HUB"
  WScript.Quit 0
End If

' 确认这个 PID 还是 node.exe，避免误杀复用了同一 PID 的其它进程
tmp = fso.GetSpecialFolder(2) & "\aiimghub_tasklist.txt"
If fso.FileExists(tmp) Then fso.DeleteFile tmp, True
sh.Run "%COMSPEC% /c tasklist /FI ""PID eq " & pid & """ > """ & tmp & """ 2>nul", 0, True
txt = ""
If fso.FileExists(tmp) Then
  Set ts = fso.OpenTextFile(tmp, 1)
  txt = LCase(ts.ReadAll)
  ts.Close
  fso.DeleteFile tmp, True
End If
alive = InStr(1, txt, "node.exe", 0) > 0

If alive Then
  sh.Run "%COMSPEC% /c taskkill /PID " & pid & " /T /F >nul 2>nul", 0, True
  WScript.Sleep 600
End If

If fso.FileExists(pidFile) Then fso.DeleteFile pidFile, True

If PortOpen(8788) Then
  MsgBox "服务似乎还在运行（端口 8788 仍有响应）。", 48, "AI IMG HUB"
Else
  MsgBox "服务已停止。", 64, "AI IMG HUB"
End If

' 从监听端口反查 PID（netstat 结果写到临时文件再解析，隐藏窗口不闪屏）
Function PidByPort(p)
  Dim tmp, f, line, parts, k, s
  PidByPort = ""
  tmp = fso.GetSpecialFolder(2) & "\aiimghub_netstat.txt"
  If fso.FileExists(tmp) Then fso.DeleteFile tmp, True
  sh.Run "%COMSPEC% /c netstat -ano -p tcp > " & Qt(tmp) & " 2>nul", 0, True
  If Not fso.FileExists(tmp) Then Exit Function
  Set f = fso.OpenTextFile(tmp, 1)
  Do Until f.AtEndOfStream
    line = f.ReadLine
    If InStr(line, ":" & p & " ") > 0 And InStr(LCase(line), "listening") > 0 Then
      parts = Split(line, " ")
      For k = UBound(parts) To 0 Step -1
        s = Trim(parts(k))
        If s <> "" Then
          PidByPort = s
          Exit Do
        End If
      Next
    End If
  Loop
  f.Close
  fso.DeleteFile tmp, True
End Function

Function Qt(s)
  Qt = Chr(34) & s & Chr(34)
End Function

Function PortOpen(p)
  On Error Resume Next
  Dim h
  PortOpen = False
  Set h = Nothing
  Set h = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  If Err.Number <> 0 Then
    Err.Clear
    Set h = CreateObject("MSXML2.ServerXMLHTTP")
  End If
  If h Is Nothing Then Exit Function
  h.SetTimeouts 800, 800, 800, 800
  h.Open "GET", "http://127.0.0.1:" & p & "/", False
  h.Send
  If Err.Number = 0 Then PortOpen = (h.Status >= 100)
  Set h = Nothing
  On Error GoTo 0
End Function
