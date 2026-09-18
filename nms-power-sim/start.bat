@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
set PORT=8900

echo ============================================
echo   无人深空 · 电力模拟器 本地服务
echo   （双击 index.html 因 file:// 同源策略无法加载 ES Module，请用本脚本）
echo ============================================
echo.

rem ---- 端口占用则自动 +1（8899 已被同目录其它项目占用，本项目默认 8900）----
:checkport
netstat -ano | findstr /c:":%PORT% " >nul 2>nul
if not errorlevel 1 (
  echo [提示] 端口 %PORT% 已被占用，尝试下一个端口…
  set /a PORT=%PORT%+1
  goto checkport
)

where python >nul 2>nul
if not errorlevel 1 goto use_python

where npx >nul 2>nul
if not errorlevel 1 goto use_npx

echo [错误] 未检测到 python 或 npx。
echo 请先安装 Python 3 或 Node.js，然后重新运行本脚本。
echo.
pause
exit /b 1

:use_python
start "" http://localhost:%PORT%/
echo 正在启动 Python 静态服务器： http://localhost:%PORT%/
echo 关闭此窗口即停止服务
echo.
python -m http.server %PORT%
exit /b 0

:use_npx
start "" http://localhost:%PORT%/
echo 正在启动 Node serve 静态服务器： http://localhost:%PORT%/
echo 关闭此窗口即停止服务
echo.
npx --yes serve -l %PORT% .
exit /b 0
