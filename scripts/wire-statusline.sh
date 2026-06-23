#!/bin/bash
# scripts/wire-statusline.sh
# Claude Code の statusLine 経由で 5h/7d 使用率キャッシュを書く bridge を
# ~/.claude/settings.json に配線する。setup.sh / update.sh から呼ばれる。
#
# 判定（上から順）:
#   1) cur === expectedCommand           → ALREADY_WIRED (no-op)
#   2) cur が usage-statusline-bridge.py を含むがパス不一致
#                                         → 旧フォルダ参照。新パスに上書き → REWIRED
#   3) cur が空 / statusline.py 直配線   → bak 作成して新パスに上書き → WIRED
#   4) それ以外（独自カスタム）          → USER_CUSTOM (no-op)
#   5) parse失敗 / Python不在 / bridge不在 → SKIPPED (no-op)
set -e

WEBAPP_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
BRIDGE_PY="$WEBAPP_DIR/scripts/usage-statusline-bridge.py"
if [ ! -f "$BRIDGE_PY" ]; then
  exit 0
fi

PY_CMD=""
for cand in python3 py python; do
  if command -v "$cand" >/dev/null 2>&1; then
    PY_CMD="$cand"
    break
  fi
done
if [ -z "$PY_CMD" ]; then
  echo "  ⓘ Python が見つからないため、5h/週間メーターの自動更新は配線しません（任意機能）。"
  exit 0
fi

mkdir -p "$HOME/.claude" || true
STATUS=$(SL_SETTINGS="$HOME/.claude/settings.json" SL_BRIDGE="$BRIDGE_PY" SL_PY="$PY_CMD" \
  node -e "
    const fs = require('fs');
    const settings = process.env.SL_SETTINGS;
    const bridge = process.env.SL_BRIDGE;
    const py = process.env.SL_PY;
    const expected = py + ' ' + JSON.stringify(bridge);
    let j = {};
    if (fs.existsSync(settings)) {
      try { j = JSON.parse(fs.readFileSync(settings, 'utf8')); }
      catch { console.log('PARSE_ERROR'); process.exit(0); }
    }
    const cur = (j.statusLine && j.statusLine.command) || '';
    if (cur === expected) { console.log('ALREADY_WIRED'); process.exit(0); }
    const bak = () => {
      if (fs.existsSync(settings)) {
        const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        fs.copyFileSync(settings, settings + '.bak.' + ts);
      }
    };
    if (cur.includes('usage-statusline-bridge.py')) {
      bak();
      j.statusLine = j.statusLine || {};
      j.statusLine.type = j.statusLine.type || 'command';
      j.statusLine.command = expected;
      fs.writeFileSync(settings, JSON.stringify(j, null, 2) + '\n');
      console.log('REWIRED'); process.exit(0);
    }
    if (!cur || cur.includes('statusline.py')) {
      bak();
      j.statusLine = j.statusLine || {};
      j.statusLine.type = j.statusLine.type || 'command';
      j.statusLine.command = expected;
      fs.writeFileSync(settings, JSON.stringify(j, null, 2) + '\n');
      console.log('WIRED'); process.exit(0);
    }
    console.log('USER_CUSTOM');
  " 2>/dev/null | tail -1)

case "$STATUS" in
  WIRED)         echo "✓ AI使用量メーターの自動更新を配線しました（~/.claude/settings.json）" ;;
  REWIRED)       echo "✓ AI使用量メーターの参照先を新しいフォルダに更新しました（~/.claude/settings.json）" ;;
  ALREADY_WIRED) echo "✓ AI使用量メーターは既に正しく配線済みです" ;;
  USER_CUSTOM)   echo "  ⓘ 既存のカスタム statusLine 設定があるため、自動配線はスキップしました" ;;
  PARSE_ERROR)   echo "  ⓘ ~/.claude/settings.json を読めなかったため statusLine 配線をスキップしました" ;;
  *)             echo "  ⓘ statusLine 配線をスキップしました（任意機能・本体動作には影響しません）" ;;
esac
exit 0
