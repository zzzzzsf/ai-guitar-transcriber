@echo off
rem ============================================================
rem Run any command inside the MSVC build environment.
rem Why: in Git Bash, /usr/bin/link (coreutils) shadows MSVC link.exe
rem and cargo fails with "link: extra operand". This script calls
rem vcvars64.bat first, then executes its arguments.
rem Usage: scripts\msvc.cmd cargo check
rem        scripts\msvc.cmd npx @tauri-apps/cli build
rem ============================================================
setlocal
set "VCVARS="

rem 1) locate via vswhere (include prerelease channels)
if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" (
  for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -prerelease -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86x64 -property installationPath`) do (
    if exist "%%i\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%%i\VC\Auxiliary\Build\vcvars64.bat"
  )
)

rem 2) fallback: probe common install paths (VS 2026=18, VS2022=17)
if not defined VCVARS (
  for %%E in (18 17) do for %%P in (Enterprise Professional Community BuildTools) do (
    if exist "%ProgramFiles%\Microsoft Visual Studio\%%E\%%P\VC\Auxiliary\Build\vcvars64.bat" (
      set "VCVARS=%ProgramFiles%\Microsoft Visual Studio\%%E\%%P\VC\Auxiliary\Build\vcvars64.bat"
    )
  )
)

if not defined VCVARS (
  echo [msvc.cmd] vcvars64.bat not found. Install VS Build Tools with the C++ workload. 1>&2
  exit /b 1
)

call "%VCVARS%" >nul

rem ensure rustup cargo is reachable (rustup installs to %USERPROFILE%\.cargo\bin)
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

%*
