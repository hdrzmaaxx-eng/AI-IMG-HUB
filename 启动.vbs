' AI IMG HUB —— 无窗口启动
' 双击即可：后台起服务 -> 等服务就绪 -> 自动打开浏览器（全程不弹 CMD 窗口）
Option Explicit

Dim sh, fso, here, nodeExe, port, url, i, ok, major
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
port = 8788
url  = "http://127.0.0.1:" & port

' 服务已经在跑：直接开页面，不再重复启动
If PortOpen(port) Then
  sh.Run url, 1, False
  WScript.Quit 0
End If

nodeExe = FindNode()
If nodeExe = "" Then
  MsgBox "没有找到 Node.js。" & vbCrLf & vbCrLf & _
         "请先安装 Node.js 18 或更高版本：https://nodejs.org", 16, "AI IMG HUB"
  WScript.Quit 1
End If

' 版本不对就早说，不用干等 30 秒
Dim ver
ver = NodeVersion(nodeExe)
major = MajorFromVer(ver)
If major < 18 Then
  If ver = "" Then
    MsgBox "无法获取 Node.js 的版本号。" & vbCrLf & vbCrLf & _
           "请先双击 启动.bat 测试能否启动；若那里也失败，请到 https://nodejs.org 安装 LTS 版。", 16, "AI IMG HUB"
  Else
    MsgBox "Node.js 版本过低（" & ver & "）。" & vbCrLf & vbCrLf & _
           "本工具需要 18 或更高版本，请到 https://nodejs.org 安装 LTS 版。", 16, "AI IMG HUB"
  End If
  WScript.Quit 1
End If

' 上一次如果是被强行结束的，PID 记录会残留；这里先清掉，免得记错进程
If fso.FileExists(here & "\.server.pid") Then fso.DeleteFile here & "\.server.pid", True

' 0 = 隐藏窗口，所以不会有 CMD 窗口；页面由本脚本在端口就绪后再开，
' 因此给 server.js 传 --no-open，避免重复打开两个标签页
sh.CurrentDirectory = here
sh.Run """" & nodeExe & """ server.js --no-open", 0, False

ok = False
For i = 1 To 60
  WScript.Sleep 500
  If PortOpen(port) Then
    ok = True
    Exit For
  End If
Next

If ok Then
  sh.Run url, 1, False
Else
  MsgBox "服务没有启动起来（等待 30 秒仍无响应）。" & vbCrLf & vbCrLf & _
         "请双击 启动.bat 查看具体报错。", 16, "AI IMG HUB"
  WScript.Quit 1
End If

' ---------------------------------------------------------------- 辅助函数

' 探测端口是否已经有服务在响应
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

' 找 node.exe：常见安装位置 -> WorkBuddy 自带运行时 -> PATH
Function FindNode()
  Dim p, d, best, versions
  FindNode = ""

  For Each p In Array( _
      sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), _
      sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe"), _
      sh.ExpandEnvironmentStrings("%APPDATA%\nvm\node.exe"), _
      sh.ExpandEnvironmentStrings("%NVM_SYMLINK%\node.exe"), _
      sh.ExpandEnvironmentStrings("%USERPROFILE%\scoop\apps\nodejs\current\node.exe"))
    If p <> "" And fso.FileExists(p) Then
      FindNode = p
      Exit Function
    End If
  Next

  versions = sh.ExpandEnvironmentStrings("%USERPROFILE%\.workbuddy\binaries\node\versions")
  If fso.FolderExists(versions) Then
    Set best = Nothing
    For Each d In fso.GetFolder(versions).SubFolders
      If fso.FileExists(d.Path & "\node.exe") Then
        ' VB 的 Or 不短路，写成一行会在 best 还是 Nothing 时去读 best.Name 而报错
        If best Is Nothing Then
          Set best = d
        ElseIf d.Name > best.Name Then
          Set best = d
        End If
      End If
    Next
    If Not best Is Nothing Then
      FindNode = best.Path & "\node.exe"
      Exit Function
    End If
  End If

  FindNode = FindNodeInPath()
End Function

' 兜底：把 where node 的结果写到临时文件再读（Run 隐藏窗口，不闪屏）
Function FindNodeInPath()
  Dim tmp, line, f
  FindNodeInPath = ""
  line = ""
  tmp = fso.GetSpecialFolder(2) & "\aiimghub_where.txt"
  If fso.FileExists(tmp) Then fso.DeleteFile tmp, True
  sh.Run "%COMSPEC% /c where node > " & Qt(tmp) & " 2>nul", 0, True
  If fso.FileExists(tmp) Then
    Set f = fso.OpenTextFile(tmp, 1)
    If Not f.AtEndOfStream Then line = Trim(f.ReadLine)
    f.Close
    fso.DeleteFile tmp, True
  End If
  If line <> "" And fso.FileExists(line) Then FindNodeInPath = line
End Function

' 取 node 版本号（形如 v22.22.2）
Function NodeVersion(exe)
  Dim tmp, f, s
  NodeVersion = ""
  s = ""
  tmp = fso.GetSpecialFolder(2) & "\aiimghub_ver.txt"
  If fso.FileExists(tmp) Then fso.DeleteFile tmp, True
  ' cmd /c 的引号规则：整串引号超过一对时，cmd 会剥掉首尾引号导致路径断裂，
  ' 所以必须用 /s 并把整条命令再包一层引号（v26 也好 v18 也好都靠这句取版本）
  sh.Run "%COMSPEC% /s /c " & Qt(Qt(exe) & " -v > " & Qt(tmp) & " 2>nul"), 0, True
  If fso.FileExists(tmp) Then
    Set f = fso.OpenTextFile(tmp, 1)
    If Not f.AtEndOfStream Then s = Trim(f.ReadLine)
    f.Close
    fso.DeleteFile tmp, True
  End If
  If s <> "" Then NodeVersion = s
End Function

' 从版本号取主版本：v22.22.2 -> 22（VBScript 没有 Val，手动取数字）
Function MajorFromVer(s)
  Dim i, ch, num
  MajorFromVer = 0
  num = ""
  For i = 2 To Len(s)
    ch = Mid(s, i, 1)
    If ch >= "0" And ch <= "9" Then
      num = num & ch
    Else
      Exit For
    End If
  Next
  If num <> "" Then MajorFromVer = CLng(num)
End Function

' 给路径加英文双引号（统一处理，避免到处数引号）
Function Qt(s)
  Qt = Chr(34) & s & Chr(34)
End Function
