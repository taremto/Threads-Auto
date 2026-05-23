#!/bin/bash
set -e

cd "$(dirname "$0")"

if [ ! -d "node_modules" ]; then
  echo "❌ node_modulesがありません。先に setup.sh を実行してください。"
  exit 1
fi

PORT="${PORT:-3000}"
URL="http://localhost:$PORT"

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

# サーバー起動を待ってブラウザを開く（バックグラウンド）
(
  for i in {1..30}; do
    if curl --max-time 2 -s -o /dev/null -w "%{http_code}" "$URL" 2>/dev/null | grep -q "200\|301\|302"; then
      open_url "$URL"
      exit 0
    fi
    sleep 1
  done
  echo ""
  echo "⚠ サーバー起動後のページ応答を30秒以内に確認できませんでした。"
  echo "   ターミナルに Ready と出ているのにブラウザがロード中のままなら、PCのメモリ不足/高負荷で初回コンパイルが止まっている可能性があります。"
  echo "   Zoom/LINE/重いブラウザタブを閉じるか、Macを再起動してから bash start.sh を実行し直してください。"
) &

echo "================================================"
echo " Threads自動投稿 WebUI 起動中..."
echo "================================================"
echo ""
echo " アクセスURL: $URL"
echo " 停止: Ctrl+C"
echo ""

# Next.js dev サーバーをフォアグラウンドで起動
npx next dev -p "$PORT"
