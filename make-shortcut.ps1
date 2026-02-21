$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("Desktop")
$lnk = $shell.CreateShortcut($desktop + "\ContextKeeper.lnk")
$lnk.TargetPath = "C:\Users\tatsu\Desktop\context-keeper\node_modules\electron\dist\electron.exe"
$lnk.Arguments = "."
$lnk.WorkingDirectory = "C:\Users\tatsu\Desktop\context-keeper"
$lnk.IconLocation = "C:\Users\tatsu\Desktop\context-keeper\assets\icon.ico"
$lnk.Description = "ContextKeeper"
$lnk.Save()
Write-Host "Shortcut created at: $desktop\ContextKeeper.lnk"
