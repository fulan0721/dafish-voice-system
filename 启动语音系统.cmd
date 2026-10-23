@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 大肥鱼语音系统
echo 正在启动控制台...
node server.mjs
echo.
echo 控制台已退出。按任意键关闭。
pause >nul
