!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing TauriView before installing..."
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM tauriview.exe'
  Sleep 800
!macroend
