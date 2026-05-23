#!/bin/bash
# 旧バージョンのフォルダから、設定（prisma/dev.db）を引き継いで新バージョンに更新するスクリプト。
# 使い方:
#   bash update.sh                 → 旧フォルダのパスを対話で聞く
#   bash update.sh /path/to/old    → 旧フォルダのパスを引数で渡す
set -e

cd "$(dirname "$0")"
NEW_DIR="$(pwd)"

echo "================================================"
echo " Threads自動投稿 WebUI アップデート（設定引き継ぎ）"
echo "================================================"
echo ""
echo " 今までのデータ（登録済みアカウント・コンセプトシート・作った投稿・"
echo " キュー・クラウドオフロード設定）は、前のフォルダの中の"
echo "   prisma/dev.db"
echo " という1ファイルに全部入っています。それをこの新しいフォルダに引き継ぎます。"
echo ""

# --- 旧フォルダのパスを取得 ---
OLD_DIR="$1"
if [ -z "$OLD_DIR" ]; then
  echo " 前のバージョンのフォルダ（中に prisma フォルダがあるフォルダ）を教えてください。"
  echo " ターミナルにフォルダをドラッグ&ドロップしてEnterでもOKです。"
  echo " 例: /Users/あなた/Desktop/nuko-threads-webapp-v1"
  echo ""
  read -r -p " 前のフォルダのパス: " OLD_DIR
fi

# クォート・前後の空白・末尾スラッシュを除去（ドラッグ&ドロップ対策）
OLD_DIR="$(printf '%s' "$OLD_DIR" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
OLD_DIR="${OLD_DIR%\"}"; OLD_DIR="${OLD_DIR#\"}"
OLD_DIR="${OLD_DIR%\'}"; OLD_DIR="${OLD_DIR#\'}"
OLD_DIR="${OLD_DIR%/}"

if [ -z "$OLD_DIR" ]; then
  echo ""
  echo "❌ 前のフォルダのパスが入力されませんでした。中止します。"
  exit 1
fi
if [ ! -d "$OLD_DIR" ]; then
  echo ""
  echo "❌ そのフォルダが見つかりません: $OLD_DIR"
  echo "   パスが正しいか確認してください。"
  exit 1
fi

# 旧フォルダ == 新フォルダ を弾く
OLD_ABS="$(cd "$OLD_DIR" && pwd)"
if [ "$OLD_ABS" = "$NEW_DIR" ]; then
  echo ""
  echo "❌ それは「今のフォルダ」と同じです。前のバージョンのフォルダを指定してください。"
  exit 1
fi

# --- 旧 dev.db を探す ---
OLD_DB=""
if [ -f "$OLD_DIR/prisma/dev.db" ]; then
  OLD_DB="$OLD_DIR/prisma/dev.db"
elif [ -f "$OLD_DIR/dev.db" ]; then
  OLD_DB="$OLD_DIR/dev.db"
fi

if [ -z "$OLD_DB" ]; then
  echo ""
  echo "❌ $OLD_DIR の中に dev.db（prisma/dev.db）が見つかりませんでした。"
  echo ""
  echo "   ・前のバージョンで一度もセットアップしていない場合は、引き継ぐデータがありません。"
  echo "     その場合はこの update.sh ではなく、ふつうに  bash setup.sh  を実行してください。"
  echo "   ・パスが間違っているだけの場合は、もう一度やり直してください。"
  exit 1
fi

# --- 引き継ぎ ---
mkdir -p prisma
if [ -f "prisma/dev.db" ]; then
  BAK="prisma/dev.db.bak.$(date +%Y%m%d%H%M%S)"
  cp "prisma/dev.db" "$BAK"
  echo "（このフォルダにあった dev.db は念のため $BAK に退避しました）"
fi
cp "$OLD_DB" "prisma/dev.db"
echo "✓ 前のデータ（アカウント・コンセプト・投稿・キュー・クラウドオフロード設定）を引き継ぎました"

# クラウドオフロード設定済みの場合、clasp の scriptId を保持する gas-deploy も必要。
# これが無いとアップデート後に setup-cloud.sh が既存GAS更新ではなく新規作成へ進み、
# 既存の Web App URL / スプシとずれる。
if [ -d "$OLD_DIR/gas-deploy" ]; then
  if [ -d "gas-deploy" ]; then
    GAS_BAK="gas-deploy.bak.$(date +%Y%m%d%H%M%S)"
    mv "gas-deploy" "$GAS_BAK"
    echo "（このフォルダにあった gas-deploy は念のため $GAS_BAK に退避しました）"
  fi
  cp -R "$OLD_DIR/gas-deploy" "gas-deploy"
  echo "✓ クラウドオフロード用のGAS作業情報（gas-deploy）も引き継ぎました"
fi
echo ""

# --- 依存・Prisma・スキーマ更新 ---
echo "[1/3] 依存パッケージを更新中... (数分かかります)"
npm install --no-audit --no-fund

echo ""
echo "[2/3] Prismaクライアントを生成中..."
npx prisma generate

echo ""
echo "[3/3] データベースを最新の形式に合わせています..."
npx prisma migrate deploy
# ※ ナレッジのシード（seed.ts / seed-buzz-patterns.ts）は実行しません。
#    既定ナレッジを自分で編集している人の編集を、初期内容で上書きしてしまわないためです。
#    既定ナレッジを最新版に戻したい場合だけ、手動で次を実行してください:
#      npx tsx prisma/seed.ts && npx tsx prisma/seed-buzz-patterns.ts

echo ""
echo "================================================"
echo " ✅ アップデート完了"
echo "================================================"
echo ""
echo " これ以降は、この新しいフォルダを使ってください:"
echo "   $NEW_DIR"
echo " 前のフォルダ（$OLD_DIR）は、念のためしばらく残しておくと安心です。"
echo " うまく動くのを確認できたら削除してOKです。"
echo ""
read -r -p " いま起動しますか？（ブラウザも自動で開きます） [Y/n]: " yn
case "$yn" in
  [nN]*)
    echo ""
    echo " 後で起動するときは:  bash start.sh"
    echo ""
    ;;
  *)
    echo ""
    exec bash "$NEW_DIR/start.sh"
    ;;
esac
