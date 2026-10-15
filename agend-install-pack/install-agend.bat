@echo off
chcp 65001 >nul
title AgEnD 安裝程式 (Windows WSL)
echo.
echo ═══════════════════════════════════════════
echo   AgEnD 安裝程式 — Telegram AI 艦隊
echo ═══════════════════════════════════════════
echo.

:: 檢查 WSL 是否可用
echo [1/4] 檢查 WSL 環境...
wsl --status >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ✗ 未偵測到 WSL。AgEnD 需要 WSL 環境。
    echo.
    echo   請先安裝 WSL：
    echo   1. 以管理員身份開啟 PowerShell
    echo   2. 執行：wsl --install
    echo   3. 重新開機後再執行此安裝程式
    echo.
    pause
    exit /b 1
)
echo √ WSL 可用

:: 檢查 WSL 發行版
echo.
echo [2/4] 檢查 WSL 發行版...
wsl -l -q >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ✗ 尚未安裝任何 WSL 發行版
    echo   請執行：wsl --install -d Ubuntu
    pause
    exit /b 1
)
echo √ WSL 發行版已安裝

:: 複製安裝腳本到 WSL
echo.
echo [3/4] 準備安裝環境...
set "SCRIPT_DIR=%~dp0"

:: 將 install.sh 複製到 WSL 的 home 目錄
wsl cp "%SCRIPT_DIR:\=/%install.sh" ~/agend-install.sh 2>nul
if %ERRORLEVEL% NEQ 0 (
    :: 嘗試用另一種方式複製
    copy "%SCRIPT_DIR%install.sh" "\\wsl$\Ubuntu\tmp\agend-install.sh" >nul 2>&1
    if %ERRORLEVEL% NEQ 0 (
        echo ✗ 無法複製安裝腳本到 WSL
        echo   請手動在 WSL 終端機中執行：
        echo   curl -fsSL https://songsid.github.io/AgEnD/install.sh ^| bash
        pause
        exit /b 1
    )
    wsl cp /tmp/agend-install.sh ~/agend-install.sh
)
echo √ 安裝腳本已就緒

:: 啟動安裝
echo.
echo [4/4] 啟動 AgEnD 安裝...
echo.
echo ─────────────────────────────────────────
echo   接下來會進入 WSL 環境執行安裝。
echo   安裝過程中會問你幾個問題：
echo   • Telegram Bot Token
echo   • Group ID
echo   • User ID
echo   • 選擇 AI 後端
echo ─────────────────────────────────────────
echo.
pause

wsl bash ~/agend-install.sh

echo.
echo ═══════════════════════════════════════════
if %ERRORLEVEL% EQU 0 (
    echo   √ AgEnD 安裝完成！
    echo.
    echo   使用方式：
    echo   • 打開 Telegram → 群組 Topic → 直接打字
    echo   • WSL 終端機查狀態：wsl agend ls
    echo   • WSL 終端機看日誌：wsl agend logs
) else (
    echo   ✗ 安裝過程中遇到問題
    echo   請在 Kiro IDE 中貼入 AGEND_SETUP_PROMPT.md
    echo   讓 AI 引導你完成安裝
)
echo ═══════════════════════════════════════════
echo.
pause
