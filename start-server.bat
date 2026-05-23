@echo off
title Threads Auto WebApp v1.1.0
cd /d "%~dp0"
rem 従量課金チェックの誤検知を防ぐため、Claude Code から引き継いだデフォルトURLをリセット
set ANTHROPIC_BASE_URL=
set ANTHROPIC_API_KEY=
set ANTHROPIC_CUSTOM_HEADERS=
set CLAUDE_CODE_USE_BEDROCK=
set CLAUDE_CODE_USE_VERTEX=
set AWS_BEARER_TOKEN_BEDROCK=

rem このPCのローカルIPアドレスを取得（Wi-Fi / イーサネット）
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4" ^| findstr /v "169.254"') do (
    for /f "tokens=1" %%b in ("%%a") do (
        if not defined LOCAL_IP set LOCAL_IP=%%b
    )
)

echo ================================================
echo  Threads Auto WebApp v1.1.0 - Starting...
echo.
echo  このPC:      http://localhost:3000
if defined LOCAL_IP (
    echo  スマホ/iPad: http://%LOCAL_IP%:3000
    echo.
    echo  ※ Wi-Fiを同じネットワークに繋いでアクセスしてください
) else (
    echo  スマホ/iPad: ipconfig でIPv4アドレスを確認して :3000 を付けてアクセス
)
echo.
echo  このウィンドウを閉じるとサーバーが停止します
echo ================================================
echo.
npx next start --hostname 0.0.0.0
pause
