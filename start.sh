#!/bin/bash
set -e

cd "$(dirname "$0")"

mkdir -p logs
LOG_FILE="logs/startup.log"
{
  echo ""
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') start ====="
} >> "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1

if [ ! -d "node_modules" ]; then
  echo "❌ アプリを起動する準備がまだ終わっていません。"
  echo ""
  echo "次にやること:"
  echo "  1. この黒い画面を閉じてください。"
  echo "  2. このフォルダの中にある setup.command（Windowsの方は setup.bat）をダブルクリックしてください。"
  echo "  3. セットアップが終わったら、もう一度 start.command（Windowsの方は start.bat）を開いてください。"
  echo ""
  echo "サポートに連絡する場合は、このファイルを送ってください: $LOG_FILE"
  exit 1
fi

PORT="${PORT:-3000}"
URL="http://localhost:$PORT"

extra_path() {
  EXTRA_DIRS="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.volta/bin:/opt/homebrew/bin:/usr/local/bin"
  case "$OSTYPE" in
    msys*|cygwin*)
      [ -n "$APPDATA" ] && EXTRA_DIRS="$EXTRA_DIRS:$APPDATA/npm"
      [ -n "$LOCALAPPDATA" ] && EXTRA_DIRS="$EXTRA_DIRS:$LOCALAPPDATA/Programs/npm:$LOCALAPPDATA/Volta/bin"
      ;;
  esac
  export PATH="$PATH:$EXTRA_DIRS"
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "❌ Node.jsが見つかりません。"
    echo ""
    echo "次にやること:"
    echo "  1. https://nodejs.org/ を開いてください。"
    echo "  2. LTS版のNode.jsをインストールしてください。"
    echo "  3. PCを再起動してください。"
    echo "  4. もう一度 start.command（Windowsの方は start.bat）を開いてください。"
    echo ""
    echo "サポートに連絡する場合は、このファイルを送ってください: $LOG_FILE"
    exit 1
  fi

  NODE_VER=$(node -v 2>/dev/null || echo "none")
  NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v\([0-9]*\)\..*/\1/')
  if [ "$NODE_VER" = "none" ] || [ "${NODE_MAJOR:-0}" -lt 20 ]; then
    echo "❌ Node.jsのバージョンが古いです（現在: $NODE_VER）。"
    echo ""
    echo "次にやること:"
    echo "  1. https://nodejs.org/ を開いてください。"
    echo "  2. LTS版のNode.jsをインストールしてください。"
    echo "  3. PCを再起動してください。"
    echo "  4. もう一度 start.command（Windowsの方は start.bat）を開いてください。"
    echo ""
    echo "サポートに連絡する場合は、このファイルを送ってください: $LOG_FILE"
    exit 1
  fi

  echo "✓ Node.js $NODE_VER"
}

find_claude_cli() {
  for cmd in claude claude.cmd claude.exe; do
    if command -v "$cmd" >/dev/null 2>&1; then
      command -v "$cmd"
      return 0
    fi
  done
  return 1
}

warn_claude_cli() {
  echo ""
  echo "[AI投稿生成の準備チェック]"

  REMOVED_ENV=""
  CUSTOM_BASE_URL=""
  for key in ANTHROPIC_API_KEY ANTHROPIC_CUSTOM_HEADERS CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX AWS_BEARER_TOKEN_BEDROCK; do
    eval "value=\${$key:-}"
    case "$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')" in
      ""|"0"|"false"|"no") ;;
      *) REMOVED_ENV="$REMOVED_ENV $key" ;;
    esac
  done
  case "${ANTHROPIC_BASE_URL:-}" in
    ""|"https://api.anthropic.com"|"https://api.anthropic.com/") ;;
    *) CUSTOM_BASE_URL="$ANTHROPIC_BASE_URL" ;;
  esac

  # このツールは Claude Code のログイン（claude.ai）前提。
  # Claude Desktop/Claude Code から起動した時に親プロセスのAPI系envを継承すると
  # WebUI側が従量課金リスクと誤判定するため、このアプリ起動中だけ落とす。
  case "${ANTHROPIC_BASE_URL:-}" in
    ""|"https://api.anthropic.com"|"https://api.anthropic.com/") unset ANTHROPIC_BASE_URL ;;
    *) echo "ℹ ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL を維持して起動します（カスタム指定）" ;;
  esac
  unset ANTHROPIC_API_KEY ANTHROPIC_CUSTOM_HEADERS \
        CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX AWS_BEARER_TOKEN_BEDROCK

  if [ -n "$REMOVED_ENV" ]; then
    echo "✓ API従量課金につながる可能性がある設定を、このアプリ起動中だけ外しました。"
    echo "   外した設定:$REMOVED_ENV"
  fi

  if [ -n "$CUSTOM_BASE_URL" ]; then
    echo "⚠ Anthropic公式以外の接続先が指定されています。"
    echo "   ANTHROPIC_BASE_URL=$CUSTOM_BASE_URL"
    echo "   課金先を判断できないため、Web画面側でAI生成を止めます。"
    echo ""
    echo "次にやること:"
    echo "  Claudeデスクトップアプリを開いて、このフォルダを選び、"
    echo "  「従量課金にならないようにClaudeのログイン設定を直して」"
    echo "  と送ってください。"
    echo ""
    return
  fi

  CLAUDE_BIN="$(find_claude_cli || true)"
  if [ -z "$CLAUDE_BIN" ]; then
    echo "⚠ Claudeの投稿生成だけ、まだ準備が終わっていません。"
    echo "   WebUIの起動や投稿管理はできますが、AI投稿生成はまだ使えません。"
    echo ""
    echo "次にやること:"
    echo "  1. Claudeデスクトップアプリを開いてください。"
    echo "  2. Claudeでこのツールのフォルダを開いてください。"
    echo "  3. Claudeに次のように送ってください。"
    echo "     「Claude Code CLIを使えるようにセットアップして」"
    echo "  4. セットアップが終わったら、この黒い画面を閉じて、もう一度 start.command（Windowsの方は start.bat）を開いてください。"
    echo ""
    return
  fi

  CLAUDE_VERSION="$("$CLAUDE_BIN" --version 2>/dev/null || true)"
  if [ -n "$CLAUDE_VERSION" ]; then
    echo "✓ Claude Code CLI: $CLAUDE_VERSION"
  else
    echo "⚠ Claude Code CLIは見つかりましたが、ログイン確認ができませんでした。"
    echo "   AI投稿生成でエラーが出る場合は、Claudeデスクトップアプリを開いて、このフォルダを選び、"
    echo "   「Claudeにログインし直して」と送ってください。"
  fi
  echo ""
}

warn_system_pressure() {
  case "$OSTYPE" in
    darwin*)
      if ! command -v vm_stat >/dev/null 2>&1 || ! command -v sysctl >/dev/null 2>&1; then
        return
      fi
      VM_STAT="$(vm_stat 2>/dev/null || true)"
      PAGE_SIZE=$(printf '%s\n' "$VM_STAT" | awk '/page size of/ {print $8}' | tr -cd '0-9')
      FREE_PAGES=$(printf '%s\n' "$VM_STAT" | awk '/Pages free/ {gsub("\\.","",$3); print $3}')
      SPEC_PAGES=$(printf '%s\n' "$VM_STAT" | awk '/Pages speculative/ {gsub("\\.","",$3); print $3}')
      PAGE_SIZE="${PAGE_SIZE:-0}"
      FREE_PAGES="${FREE_PAGES:-0}"
      SPEC_PAGES="${SPEC_PAGES:-0}"
      AVAILABLE_MB=$(( (FREE_PAGES + SPEC_PAGES) * PAGE_SIZE / 1024 / 1024 ))
      LOAD1=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')
      NCPU=$(sysctl -n hw.ncpu 2>/dev/null || echo 1)
      LOAD_HIGH=$(awk -v l="${LOAD1:-0}" -v c="${NCPU:-1}" 'BEGIN { print (l > c * 1.5) ? 1 : 0 }')
      if [ "$AVAILABLE_MB" -gt 0 ] && { [ "$AVAILABLE_MB" -lt 512 ] || [ "$LOAD_HIGH" = "1" ]; }; then
        echo "⚠ Macの空きメモリ/負荷がかなり厳しい状態です。"
        echo "   空きメモリ目安: ${AVAILABLE_MB}MB / load average(1分): ${LOAD1:-?} / CPU: ${NCPU:-?}"
        echo "   この状態だと Next.js(Turbopack) が Ready 表示後もブラウザで開かないことがあります。"
        echo "   Zoom/LINE/ブラウザタブなどを閉じるか、Macを再起動してから再実行してください。"
        echo ""
      fi
      ;;
  esac
}

warn_duplicate_extracts() {
  DUP_COUNT=$(find . -maxdepth 2 \( -name '* 2.*' -o -name 'src 2' -o -name 'gas 2' -o -name 'prisma 2' \) -print 2>/dev/null | wc -l | tr -d ' ')
  if [ "${DUP_COUNT:-0}" != "0" ]; then
    echo "⚠ フォルダ内に重複展開の痕跡（例: '* 2.*' / 'src 2'）が見つかりました。"
    echo "   通常は無視されますが、起動が極端に重い場合は最新版zipを新しいフォルダに展開し直すと改善することがあります。"
    echo ""
  fi
}

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

guard_against_starting_without_imported_data() {
  if [ -f "prisma/dev.db" ]; then
    return
  fi

  EXISTING_DIRS="$(find_existing_data_dirs || true)"
  if [ -z "$EXISTING_DIRS" ]; then
    return
  fi

  echo "⚠ 前のデータが入っている可能性があるフォルダが見つかりました。"
  echo ""
  printf '%s\n' "$EXISTING_DIRS" | sed 's/^/  - /'
  echo ""
  echo "このまま起動すると、空の状態で始まります。"
  echo "すでにこのツールを使っていた方は、先に 03_update_windows.bat（Macは 03_update_mac.command）でデータを引き継いでください。"
  echo ""
  echo "サポートに連絡する場合は、この画面の内容を送ってください。"
  exit 1
}

ensure_database() {
  guard_against_starting_without_imported_data
  ensure_env_file

  echo "[保存データの準備チェック]"
  if ! npx prisma migrate deploy >/tmp/threads-auto-prisma-migrate.log 2>&1; then
    echo "❌ 保存用データベースの準備に失敗しました。"
    echo ""
    echo "次にやること:"
    echo "  1. この黒い画面を閉じてください。"
    echo "  2. setup.command（Windowsの方は setup.bat）をもう一度開いてください。"
    echo "  3. それでも直らない場合は、サポートにこのファイルを送ってください: $LOG_FILE"
    echo ""
    echo "詳細ログ:"
    cat /tmp/threads-auto-prisma-migrate.log
    exit 1
  fi

  echo "保存データの接続準備を確認しています..."
  if ! npx prisma generate >/tmp/threads-auto-prisma-generate.log 2>&1; then
    echo "❌ 保存用データベースの接続準備に失敗しました。"
    echo ""
    echo "次にやること:"
    echo "  1. setup.command（Windowsの方は setup.bat）をもう一度開いてください。"
    echo "  2. それでも直らない場合は、サポートにこのファイルを送ってください: $LOG_FILE"
    echo ""
    echo "詳細ログ:"
    cat /tmp/threads-auto-prisma-generate.log
    exit 1
  fi

  echo "ナレッジの準備を確認しています..."
  if ! npx tsx prisma/ensure-default-knowledge.ts >/tmp/threads-auto-knowledge-seed.log 2>&1; then
    echo "❌ 初期ナレッジの準備に失敗しました。"
    echo ""
    echo "次にやること:"
    echo "  1. setup.command（Windowsの方は setup.bat）をもう一度開いてください。"
    echo "  2. それでも直らない場合は、サポートにこのファイルを送ってください: $LOG_FILE"
    echo ""
    echo "詳細ログ:"
    cat /tmp/threads-auto-knowledge-seed.log
    exit 1
  fi
  echo "✓ 保存データの準備OK"
  echo ""
}

# クロスプラットフォーム対応: ブラウザを開く
open_url() {
  case "$OSTYPE" in
    darwin*) open "$1" ;;
    msys*|cygwin*) start "" "$1" ;;
    *) xdg-open "$1" 2>/dev/null || true ;;
  esac
}

warn_system_pressure
warn_duplicate_extracts
extra_path
check_node
ensure_database
warn_claude_cli

if curl --max-time 2 -s -o /dev/null -w "%{http_code}" "$URL" 2>/dev/null | grep -q "200\|301\|302"; then
  echo "✓ WebUIはすでに起動しています。ブラウザで開きます。"
  echo "  $URL"
  open_url "$URL"
  exit 0
fi

if command -v lsof >/dev/null 2>&1 && lsof -n -P -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "❌ WebUIを開くための $PORT 番が、別の起動処理で使われたままになっています。"
  echo ""
  echo "次にやること:"
  echo "  1. すでに開いている黒い起動画面があれば閉じてください。"
  echo "  2. それでも直らない場合は、PCを再起動してください。"
  echo "  3. 再起動後、このフォルダの start.command（Windowsの方は start.bat）をもう一度開いてください。"
  echo "  4. サポートに連絡する場合は、このファイルを送ってください: $LOG_FILE"
  exit 1
fi

# サーバー起動を待ってブラウザを開く（バックグラウンド）
(
  for i in {1..60}; do
    if curl --max-time 2 -s -o /dev/null -w "%{http_code}" "$URL" 2>/dev/null | grep -q "200\|301\|302"; then
      open_url "$URL"
      exit 0
    fi
    sleep 1
  done
  echo ""
  echo "⚠ Web画面を60秒以内に開けませんでした。"
  echo ""
  echo "よくある原因:"
  echo "  ・PCのメモリ不足で、初回読み込みが止まっている"
  echo "  ・別のアプリが $PORT 番ポートを使っている"
  echo "  ・古いフォルダ、または別のフォルダから起動している"
  echo ""
  echo "次にやること:"
  echo "  1. Zoom、LINE、重いブラウザタブを閉じてください。"
  echo "  2. それでも開かない場合は、PCを再起動してください。"
  echo "  3. 再起動後、このフォルダの start.command（Windowsの方は start.bat）をもう一度開いてください。"
  echo "  4. まだ開かない場合は、サポートにこのファイルを送ってください: $LOG_FILE"
) &

echo "================================================"
echo " Threads自動投稿 WebUI 起動中..."
echo "================================================"
echo ""
echo " アクセスURL: $URL"
echo " 停止: Ctrl+C"
echo ""

# 使用量の 5h/7d バーは「再確認 / AI生成 ボタンを押したとき」だけ
# オンデマンドで更新する（webアプリ側 /api/generate/usage が必要時に
# scripts/usage-refresher.cjs を1回だけ呼ぶ）。定期ループは行わない
# ＝ Pro セッション枠を無駄に消費しない設計。

# Next.js dev サーバーをフォアグラウンドで起動
if ! npx next dev -p "$PORT"; then
  echo ""
  echo "❌ WebUIの起動に失敗しました。"
  echo ""
  echo "よくある原因:"
  echo "  ・3000番ポートを別のアプリが使っている"
  echo "  ・Node.js / npm の準備が壊れている"
  echo "  ・node_modules が壊れている"
  echo ""
  echo "次にやること:"
  echo "  1. PCを再起動してください。"
  echo "  2. このフォルダの start.command（Windowsの方は start.bat）をもう一度開いてください。"
  echo "  3. それでも直らない場合は setup.command（Windowsの方は setup.bat）をもう一度実行してください。"
  echo "  4. サポートに連絡する場合は、このファイルを送ってください: $LOG_FILE"
  exit 1
fi
