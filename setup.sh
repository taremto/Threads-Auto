#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "================================================"
echo " Threads自動投稿 WebUI セットアップ"
echo "================================================"
echo ""

ensure_env_file() {
  mkdir -p prisma
  if [ ! -f ".env" ]; then
    printf '%s\n' 'DATABASE_URL="file:./dev.db"' > .env
    echo "✓ 保存用データベース設定を作成しました（.env）"
  elif ! grep -q '^DATABASE_URL=' .env; then
    printf '\n%s\n' 'DATABASE_URL="file:./dev.db"' >> .env
    echo "✓ 保存用データベース設定を追加しました（.env）"
  fi

  DATABASE_URL_LINE=$(grep '^DATABASE_URL=' .env | tail -1 | sed 's/^DATABASE_URL=//' | sed 's/^"//' | sed 's/"$//')
  export DATABASE_URL="${DATABASE_URL:-$DATABASE_URL_LINE}"
}

find_existing_data_dirs() {
  CURRENT_DIR="$(pwd)"
  SEARCH_ROOTS=".."
  [ -n "$HOME" ] && SEARCH_ROOTS="$SEARCH_ROOTS $HOME/Desktop $HOME/Downloads"

  for root in $SEARCH_ROOTS; do
    [ -d "$root" ] || continue
    find "$root" -maxdepth 4 -path "*/prisma/dev.db" -type f 2>/dev/null | while read -r db; do
      dir="$(cd "$(dirname "$db")/.." 2>/dev/null && pwd || true)"
      [ -n "$dir" ] || continue
      [ "$dir" = "$CURRENT_DIR" ] && continue
      case "$dir" in
        "$CURRENT_DIR"/*) continue ;;
      esac
      printf '%s\n' "$dir"
    done
  done | awk '!seen[$0]++' | head -5
}

guard_against_accidental_fresh_setup() {
  # 新しい配布フォルダで初回セットアップを押したが、近くに旧データがある場合、
  # 空のDBを作って「データが消えた」ように見える事故を防ぐ。
  if [ -f "prisma/dev.db" ]; then
    return
  fi

  EXISTING_DIRS="$(find_existing_data_dirs || true)"
  if [ -z "$EXISTING_DIRS" ]; then
    return
  fi

  echo ""
  echo "⚠ 前のデータが入っている可能性があるフォルダが見つかりました。"
  echo ""
  printf '%s\n' "$EXISTING_DIRS" | sed 's/^/  - /'
  echo ""
  echo "すでにこのツールを使ったことがある方は、初回セットアップではなく"
  echo "update.command（Windowsの方は 03_update_windows.bat）を使ってください。"
  echo ""
  echo "このまま初回セットアップを続けると、アプリは空の状態で始まります。"
  echo "アカウント、アクセストークン、下書き、予約投稿は引き継がれません。"
  echo ""
  read -r -p "本当に新規で始める場合だけ NEW と入力してください: " answer
  if [ "$answer" != "NEW" ]; then
    echo ""
    echo "中止しました。アップデートする場合は 03_update_windows.bat（Macは 03_update_mac.command）を開いてください。"
    exit 1
  fi
}

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
guard_against_accidental_fresh_setup
ensure_env_file

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

# npm install が node-pty のヘルパーバイナリから実行ビットを落とすことがある（特に macOS）。
# 落ちたまま AI使用量メーターを更新しようとすると "posix_spawnp failed" で失敗するので
# ここで明示的に +x を立て直す。Windows では .exe なので no-op（PATTERN にヒットしない）。
if [ -d node_modules/node-pty/prebuilds ]; then
  find node_modules/node-pty/prebuilds -name spawn-helper -type f -exec chmod +x {} + 2>/dev/null || true
fi

echo ""
echo "[2/4] Prismaクライアントを生成中..."
npx prisma generate

echo ""
echo "[3/4] データベースを初期化中..."
if ! npx prisma migrate deploy; then
  echo ""
  echo "❌ 保存用データベースの準備に失敗しました。"
  echo ""
  echo "次にやること:"
  echo "  1. この黒い画面を閉じてください。"
  echo "  2. PCを再起動してください。"
  echo "  3. もう一度 setup.command（Windowsの方は setup.bat）を開いてください。"
  echo "  4. それでも直らない場合は、表示された内容をサポートに送ってください。"
  exit 1
fi

echo ""
echo "[4/4] ナレッジを投入中..."
npx tsx prisma/ensure-default-knowledge.ts

# --- Claude Code statusLine 配線（5h/7d 使用率メーターの取得経路） ---
# AI生成モーダルの「現在のセッション / 週間制限」を実データで表示するには、
# Claude Code が statusLine 発火時に渡してくる JSON から rate_limits を
# ~/.claude/.ratelimit_cache.json に書き出す必要がある。これを行うのが
# scripts/usage-statusline-bridge.py。配線ロジックは update.sh と共有する
# ため scripts/wire-statusline.sh に切り出してある。
bash "$(pwd)/scripts/wire-statusline.sh" "$(pwd)"

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
