; Finish-page "Run DiskHound" must Exec the installed exe.
; electron-builder's default StartApp uses StdUtils.ExecShellAsUser, which only
; works when the installer is elevated (drop to the user token). Our per-user
; installer is not elevated, so that call is a silent no-op and the checkbox
; does nothing.
!macro customFinishPage
  Function StartApp
    HideWindow
    ${If} ${FileExists} "$appExe"
      Exec '"$appExe" --launched-from-installer'
    ${ElseIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --launched-from-installer'
    ${ElseIf} ${FileExists} "$launchLink"
      ExecShell "open" "$launchLink"
    ${EndIf}
  FunctionEnd
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend
