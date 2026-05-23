#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "================================================"
echo " Threads自動投稿 WebUI セットアップ"
echo "================================================"
echo ""

# Node.jsバージョンチェック
NODE_VER=$(node -v 2>/dev/null || echo "none")
if [ "$NODE_VER" = "none" ]; then
  echo "❌ Node.jsが見つかりません。"
  echo "   https://nodejs.org/ からLTS版をインストールしてください。"
  exit 1
fi
NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v\([0-9]*\)\..*/\1/')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "❌ Node.jsが古いです（現在: $NODE_VER）。20以上が必要です。"
  echo "   https://nodejs.org/ からLTS版をインストールしてください。"
  exit 1
fi
echo "✓ Node.js $NODE_VER"

# Claude CLIチェック
if ! command -v claude >/dev/null 2>&1; then
  echo "⚠ Claude Code CLIが見つかりません。"
  echo "   AI生成機能を使うには以下のコマンドでインストールしてください："
  echo "   npm install -g @anthropic-ai/claude-code"
  echo "   claude login"
  echo ""
  echo "   セットアップは続行しますが、CLI未インストールではAI生成は動きません。"
  echo ""
  read -p "   続行しますか？ [y/N]: " yn
  case "$yn" in
    [yY]*) echo "続行します。" ;;
    *) echo "中止しました。"; exit 1 ;;
  esac
else
  echo "✓ Claude Code CLI"
fi

echo ""
echo "[1/4] 依存パッケージをインストール中... (数分かかります)"
npm install --no-audit --no-fund

echo ""
echo "[2/4] Prismaクライアントを生成中..."
npx prisma generate

echo ""
echo "[3/4] データベースを初期化中..."
npx prisma migrate deploy

echo ""
echo "[4/4] ナレッジを投入中..."
npx tsx prisma/seed.ts
npx tsx prisma/seed-buzz-patterns.ts

echo ""
echo "================================================"
echo " ✅ セットアップ完了"
echo "================================================"
echo ""
echo " 初回は設定画面でアカウントを登録してください（README.md参照）"
echo ""
read -p " いま起動しますか？（ブラウザも自動で開きます） [Y/n]: " yn
case "$yn" in
  [nN]*)
    echo ""
    echo " 後で起動するときは:"
    echo "   bash start.sh"
    echo ""
    ;;
  *)
    echo ""
    exec bash "$(dirname "$0")/start.sh"
    ;;
esac
