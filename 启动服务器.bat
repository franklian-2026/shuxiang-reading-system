@echo off
chcp 65001 >nul
title 书香读书会 - 局域网服务器
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org
    pause
    exit /b
)

set IP=
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do set IP=%%a
set IP=%IP:~1%

cls
echo ================================================
echo.
echo     书香读书会 · 局域网服务器已启动
echo.
echo -----------------------------------------------
echo     本机访问:   http://localhost:8765
echo     局域网访问: http://%IP%:8765
echo.
echo     手机/平板请连接同一 WiFi 后用上方地址访问
echo     账户 · 签到 · 藏经阁 · 论坛数据全会实时共享
echo     关闭本窗口即停止服务
echo.
echo ================================================

start "" http://localhost:8765

node "%~dp0书会服务器.js"

pause
