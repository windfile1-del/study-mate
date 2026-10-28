@echo off
cd /d "%~dp0"
if exist "release\0.14.0\win-unpacked\Study Mate.exe" (
  if not exist ".cache\temp" mkdir ".cache\temp"
  set "TEMP=%~dp0.cache\temp"
  set "TMP=%~dp0.cache\temp"
  set "STUDYMATE_DATA_DIR=%~dp0.local\data"
  start "" "%~dp0release\0.14.0\win-unpacked\Study Mate.exe"
  exit /b 0
)
if exist "release\0.13.0\win-unpacked\Study Mate.exe" (
  if not exist ".cache\temp" mkdir ".cache\temp"
  set "TEMP=%~dp0.cache\temp"
  set "TMP=%~dp0.cache\temp"
  set "STUDYMATE_DATA_DIR=%~dp0.local\data"
  start "" "%~dp0release\0.13.0\win-unpacked\Study Mate.exe"
  exit /b 0
)
if exist "release\0.12.0\win-unpacked\Study Mate.exe" (
  if not exist ".cache\temp" mkdir ".cache\temp"
  set "TEMP=%~dp0.cache\temp"
  set "TMP=%~dp0.cache\temp"
  set "STUDYMATE_DATA_DIR=%~dp0.local\data"
  start "" "%~dp0release\0.12.0\win-unpacked\Study Mate.exe"
  exit /b 0
)
if exist "release\0.11.0\win-unpacked\Study Mate.exe" (
  if not exist ".cache\temp" mkdir ".cache\temp"
  set "TEMP=%~dp0.cache\temp"
  set "TMP=%~dp0.cache\temp"
  set "STUDYMATE_DATA_DIR=%~dp0.local\data"
  start "" "%~dp0release\0.11.0\win-unpacked\Study Mate.exe"
  exit /b 0
)
if exist "release\0.10.0\win-unpacked\Study Mate.exe" (
  if not exist ".cache\temp" mkdir ".cache\temp"
  set "TEMP=%~dp0.cache\temp"
  set "TMP=%~dp0.cache\temp"
  set "STUDYMATE_DATA_DIR=%~dp0.local\data"
  start "" "%~dp0release\0.10.0\win-unpacked\Study Mate.exe"
  exit /b 0
)
if exist "release\win-unpacked\Study Mate.exe" (
  if not exist ".cache\temp" mkdir ".cache\temp"
  set "TEMP=%~dp0.cache\temp"
  set "TMP=%~dp0.cache\temp"
  set "STUDYMATE_DATA_DIR=%~dp0.local\data"
  start "" "%~dp0release\win-unpacked\Study Mate.exe"
  exit /b 0
)
if not exist "out\main\index.js" (
  call npm run build
  if errorlevel 1 exit /b 1
)
call npm start
