@echo off
REM Wrapper around scripts\dev.ps1 - see that file for the real logic.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev.ps1" -Action start %*
