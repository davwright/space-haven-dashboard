@echo off
REM Build the agent jar. Requires Maven (>=3.8) and a JDK 8+ on PATH.
REM
REM Output: target\agent.jar (fat jar with WS client shaded in).
REM
REM If mvn is not on PATH, install Apache Maven and re-run, or set
REM MAVEN_HOME and run "%MAVEN_HOME%\bin\mvn package" from this folder.

setlocal
cd /d "%~dp0"

where mvn >nul 2>nul
if errorlevel 1 (
  echo [build] Maven not found on PATH.
  echo [build] Install from https://maven.apache.org/download.cgi or set MAVEN_HOME.
  exit /b 1
)

mvn -q -DskipTests package
if errorlevel 1 (
  echo [build] mvn package failed.
  exit /b 1
)

if exist target\agent.jar (
  echo [build] OK -^> %~dp0target\agent.jar
) else (
  echo [build] expected target\agent.jar not produced.
  exit /b 1
)
