; Удаление Протоколиста: спрашиваем, удалить ли скачанные модели (≈ 2,7 ГБ) и настройки.
; Протоколы в «Документы\Протоколист» не трогаем никогда.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "Удалить скачанные модели (около 2,7 ГБ) и настройки Протоколиста?$\r$\n$\r$\nВаши протоколы в папке «Документы\Протоколист» останутся." /SD IDNO IDNO skipModels
      RMDir /r "$LOCALAPPDATA\Protokolist"
      ReadEnvStr $0 "ProgramData"
      RMDir /r "$0\Protokolist"
    skipModels:
  ${endIf}
!macroend
