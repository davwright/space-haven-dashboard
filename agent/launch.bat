@echo off
REM Launch Space Haven with the dashboard streaming agent attached.
REM
REM Two -javaagent flags are required:
REM   1. agent.jar          -- our agent (Premain-Class + heartbeat aspect)
REM   2. aspectjweaver.jar  -- load-time weaver that activates the aspect
REM
REM AspectJ weaver lives wherever the modloader installs it; we look in a few
REM known places and fall back to a sibling .\lib\ folder. If you don't have
REM the modloader installed, drop aspectjweaver-1.9.19.jar into agent\lib\.

setlocal
set GAME_DIR=C:\Program Files (x86)\st\steamapps\common\SpaceHaven
set JAVA=%GAME_DIR%\jre\bin\java.exe
set AGENT=%~dp0target\agent.jar

if not exist "%AGENT%" (
  echo [launch] agent jar missing at %AGENT%
  echo [launch] run build.bat first.
  exit /b 1
)

REM Find aspectjweaver.jar. Order: modloader sibling, our own lib\.
set WEAVER=
if exist "%GAME_DIR%\aspectjweaver-1.9.19.jar" set WEAVER=%GAME_DIR%\aspectjweaver-1.9.19.jar
if "%WEAVER%"=="" if exist "%~dp0lib\aspectjweaver-1.9.19.jar" set WEAVER=%~dp0lib\aspectjweaver-1.9.19.jar

if "%WEAVER%"=="" (
  echo [launch] aspectjweaver-1.9.19.jar not found.
  echo [launch] Either install the spacehaven-modloader, or drop the jar at
  echo [launch]   %~dp0lib\aspectjweaver-1.9.19.jar
  exit /b 1
)

REM Main class: fi.bugbyte.spacehaven.MainClass for the non-Steam entry.
REM (Steam wrapper is fi.bugbyte.spacehaven.steam.SpacehavenSteam — that one
REM   requires the Steam DLL to be loadable.)
"%JAVA%" ^
  -javaagent:"%AGENT%" ^
  -javaagent:"%WEAVER%" ^
  -classpath "%GAME_DIR%\spacehaven.jar" ^
  fi.bugbyte.spacehaven.MainClass %*
