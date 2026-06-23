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
ensure_env_file

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

# npm install が node-pty のヘルパーバイナリから実行ビットを落とすことがある（特に macOS）。
# AI使用量メーター更新時の "posix_spawnp failed" を防ぐため明示的に +x を立て直す。
if [ -d node_modules/node-pty/prebuilds ]; then
  find node_modules/node-pty/prebuilds -name spawn-helper -type f -exec chmod +x {} + 2>/dev/null || true
fi

echo ""
echo "[2/3] Prismaクライアントを生成中..."
npx prisma generate

echo ""
echo "[3/3] データベースを最新の形式に合わせています..."
if ! npx prisma migrate deploy; then
  echo ""
  echo "❌ 保存用データベースの更新に失敗しました。"
  echo ""
  echo "次にやること:"
  echo "  1. この黒い画面を閉じてください。"
  echo "  2. PCを再起動してください。"
  echo "  3. もう一度 update.command（Windowsの方は update.bat）を開いてください。"
  echo "  4. それでも直らない場合は、前のフォルダを消さずに、表示された内容をサポートに送ってください。"
  exit 1
fi

echo ""
echo "既定ナレッジの不足がないか確認しています..."
if ! npx tsx prisma/ensure-default-knowledge.ts; then
  echo ""
  echo "❌ 既定ナレッジの確認に失敗しました。"
  echo ""
  echo "次にやること:"
  echo "  1. この黒い画面を閉じてください。"
  echo "  2. もう一度 update.command（Windowsの方は update.bat）を開いてください。"
  echo "  3. それでも直らない場合は、表示された内容をサポートに送ってください。"
  exit 1
fi
# ※ ここでは「足りない既定ナレッジの追加」だけを行います。
#    既にあるナレッジは上書きしないため、ユーザーが編集した内容は保持されます。

# --- Claude Code statusLine 配線の再確認 ---
# 旧フォルダのパスが ~/.claude/settings.json に残っていると AI使用量メーターが
# 旧フォルダの bridge を呼び続けてキャッシュが更新されない。毎回再点検する。
echo ""
echo "Claude Code の使用量メーター配線を確認しています..."
bash "$NEW_DIR/scripts/wire-statusline.sh" "$NEW_DIR"

echo ""
echo "クラウドオフロード設定の有無を確認しています..."
CLOUD_INFO=$(node - <<'NODE'
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
(async () => {
  const accounts = await prisma.account.findMany({
    where: {
      OR: [
        { cloudOffloadEnabled: true },
        { gasWebAppUrl: { not: null } },
      ],
    },
    select: { name: true, cloudOffloadEnabled: true, gasWebAppUrl: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(JSON.stringify(accounts));
})()
  .catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
NODE
) || CLOUD_INFO="[]"

CLOUD_COUNT=$(printf '%s' "$CLOUD_INFO" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(s).length)}catch{console.log(0)}})')
if [ "$CLOUD_COUNT" != "0" ]; then
  echo ""
  echo "================================================"
  echo " ⚠ クラウドオフロードのGoogle投稿修復が必要です"
  echo "================================================"
  echo ""
  echo " クラウドオフロードを設定済みのアカウントが ${CLOUD_COUNT} 件あります。"
  printf '%s' "$CLOUD_INFO" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{JSON.parse(s).forEach((a,i)=>console.log(`  ${i+1}. ${a.name}`))}catch{}})'
  echo ""
  echo " アプリ本体は更新できましたが、Google側に置いてあるGAS/Web Appは"
  echo " zip更新や「今すぐ同期」だけでは自動で書き換わりません。"
  echo ""
  echo " このままだと、予約投稿が「待機中」のまま止まる古いGASが残る可能性があります。"
  echo " 続けてクラウドオフロード設定を開き、"
  echo "   ① Google投稿を修復する"
  echo " を選んでください。動作するWeb App URLと予約キューまで確認します。"
  echo ""
  read -r -p " いまGoogle投稿の修復を実行しますか？ [Y/n]: " gas_yn
  case "$gas_yn" in
    [nN]*)
      echo ""
      echo "⚠ 後で必ず 04_cloud_setup_mac.command（Windowsは 04_cloud_setup_windows.bat）を開き、"
      echo "  「① Google投稿を修復する」を実行してください。"
      echo ""
      ;;
    *)
      echo ""
      echo "クラウドオフロード設定を起動します。"
      echo "複数アカウントがある場合は、アカウントごとに同じ操作を繰り返してください。"
      echo ""
      while true; do
        bash "$NEW_DIR/setup-cloud.sh"
        if [ "$CLOUD_COUNT" = "1" ]; then
          break
        fi
        echo ""
        read -r -p " 他のクラウドオフロード済みアカウントのGASも更新しますか？ [y/N]: " another_gas
        case "$another_gas" in
          [yY]*) echo "" ;;
          *) break ;;
        esac
      done
      echo ""
      echo "Google投稿修復の操作が終わりました。"
      echo ""
      ;;
  esac
else
  echo "✓ クラウドオフロード設定済みアカウントはありません"
fi

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
