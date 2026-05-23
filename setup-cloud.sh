#!/bin/bash
# ================================================
#  threads-auto-webapp クラウドオフロード セットアップ
# ================================================
#
# PCを閉じても予約投稿が動くようにする「クラウドオフロード」を
# ほぼ全自動でセットアップします。
#
# ユーザー操作はたった2ヶ所:
#   ① Apps Script の OAuth 認証クリック（Google 仕様で自動化不可）
#   ② デプロイURLの貼付
#
# 残り全部 — clasp 認証/スプシ作成/コードPush/認証キー生成/
#         GAS Properties保存/Webアプリ側の設定保存/有効化 — は自動化
#
# 前提:
#   - Webアプリが http://localhost:3000 で動いている（自動起動を試みる）
#   - 設定→アカウントで Threads アクセストークンを保存済み

set -e

# UTF-8 ロケールのセーフティネット（未設定だと awk 等が日本語アカウント名を「??」に潰すことがある）
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export LANG="${LANG:-en_US.UTF-8}"

cd "$(dirname "$0")"
SCRIPT_DIR="$(pwd)"

GAS_DIR="$SCRIPT_DIR/gas"
WEB_URL="${WEB_URL:-http://localhost:3000}"

# クロスプラットフォーム対応: ブラウザを開く
open_url() {
  case "$OSTYPE" in
    darwin*) open "$1" ;;
    msys*|cygwin*) start "" "$1" ;;
    *) xdg-open "$1" 2>/dev/null || true ;;
  esac
}

# JSON 操作はすべて node 経由で行う（以前は python3 を使っていたが、Windows含め
# 環境差で「pythonがない／古い」「python3 が py に化けてる」等で詰まるケースが
# 多発していた。node は webapp の前提なので必ず存在する。後段の [1/8] で `command -v node`
# は検証するが、ここでは早めに使いたいので未検出でも node を試す）。
#
# 使い方:
#   echo "$json" | json_parse 'd.foo.bar'      → JS 式の値を 1 個取り出す（undefined→空文字）
# 注意: '式' に渡せるのは JSON ルートを `d` として参照する任意の JS 式。
#       スクリプト内で組み立てる前提（外部入力は混ぜない）。
json_parse() {
  node -e '
    let s = "";
    process.stdin.on("data", c => s += c);
    process.stdin.on("end", () => {
      try {
        const d = JSON.parse(s);
        const v = (new Function("d", "return (" + process.argv[1] + ");"))(d);
        if (v === undefined || v === null) console.log("");
        else if (typeof v === "object") console.log(JSON.stringify(v));
        else console.log(v);
      } catch (e) {
        process.stderr.write("json_parse error: " + e.message + "\n");
        process.exit(1);
      }
    });
  ' -- "$1"
}

echo ""
echo "================================================"
echo " ☁ クラウドオフロード セットアップ（ほぼ全自動）"
echo "================================================"
echo ""

# --------------------------------------------------
# Step 0: Webアプリ稼働チェック（自動起動）
# --------------------------------------------------
echo "[0/8] Webアプリの稼働確認..."
if curl -s -o /dev/null -w "%{http_code}" "$WEB_URL/api/accounts" 2>/dev/null | grep -q "200"; then
  echo "✓ Webアプリ稼働中"
else
  echo "⚠ Webアプリが起動していません。自動起動します..."
  if [ ! -f "$SCRIPT_DIR/start.sh" ]; then
    echo "❌ start.sh が見つかりません。先に bash setup.sh を実行してください。"
    exit 1
  fi
  nohup bash "$SCRIPT_DIR/start.sh" > /tmp/threads-auto-webapp.log 2>&1 &
  for i in {1..30}; do
    sleep 1
    if curl -s -o /dev/null -w "%{http_code}" "$WEB_URL/api/accounts" 2>/dev/null | grep -q "200"; then
      echo "✓ Webアプリ起動完了 (${i}秒)"
      break
    fi
    if [ "$i" = "30" ]; then
      echo "❌ Webアプリ起動タイムアウト。/tmp/threads-auto-webapp.log を確認してください。"
      exit 1
    fi
  done
fi
echo ""

# --------------------------------------------------
# Step 1: 環境チェック（clasp 自動インストール）
# --------------------------------------------------
echo "[1/8] 環境チェック..."
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js が見つかりません。https://nodejs.org/ からLTS版を入れてください。"
  exit 1
fi
if ! command -v clasp >/dev/null 2>&1; then
  echo "  clasp をインストールします（npm install -g @google/clasp）..."
  npm install -g @google/clasp
fi
echo "✓ Node.js $(node -v) / clasp $(clasp --version 2>&1 | head -1)"
echo ""

# --------------------------------------------------
# Step 2: clasp ログイン確認
# --------------------------------------------------
echo "[2/8] Google ログイン確認..."
if ! clasp login --status >/dev/null 2>&1; then
  echo "  Google にログインしていません。ブラウザで認証します..."
  echo "  （ブラウザが自動で開きます。スプシを置きたいGoogleアカウントでログインしてください）"
  clasp login
fi
echo "✓ ログイン済み"
echo ""

# --------------------------------------------------
# Step 3: アカウント選択（Webアプリから取得）
# --------------------------------------------------
echo "[3/8] アカウント選択..."
ACCOUNTS_JSON=$(curl -s "$WEB_URL/api/accounts")
NUM=$(echo "$ACCOUNTS_JSON" | json_parse 'd.length')
if [ "$NUM" = "0" ]; then
  echo "❌ Webアプリにアカウントが登録されていません。"
  echo "   先にブラウザで $WEB_URL を開いて「設定→アカウント」から登録してください。"
  exit 1
fi

# Threadsアクセストークンが入ってるか確認＆選択（gasWebAppUrl も拾う）
# 1行=1アカウント、フィールド区切りは | で、各列: 連番|id|name|HAS_TOKEN|HAS_CLOUD|URL
ACCOUNT_INFO=$(echo "$ACCOUNTS_JSON" | node -e '
  let s = "";
  process.stdin.on("data", c => s += c);
  process.stdin.on("end", () => {
    const accs = JSON.parse(s);
    accs.forEach((a, i) => {
      const hasToken = a.accessToken ? "OK" : "⚠未設定";
      const url = a.gasWebAppUrl || "";
      const hasCloud = url ? "済" : "未";
      console.log([i + 1, a.id, a.name, hasToken, hasCloud, url].join("|"));
    });
  });
')

echo "  登録済アカウント:"
echo "$ACCOUNT_INFO" | awk -F'|' '{printf "    [%s] %s （Threadsトークン:%s, クラウド設定:%s）\n", $1, $3, $4, $5}'

if [ "$NUM" = "1" ]; then
  CHOSEN_LINE=$(echo "$ACCOUNT_INFO" | head -1)
else
  echo ""
  read -r -p "  どのアカウントをセットアップしますか？ [番号]: " CHOICE || { echo "❌ 入力が読み取れませんでした。このスクリプトは（コマンドだけ渡すのではなく）ターミナルの窓の中で対話的に実行してください。"; exit 1; }
  CHOSEN_LINE=$(echo "$ACCOUNT_INFO" | sed -n "${CHOICE}p")
  if [ -z "$CHOSEN_LINE" ]; then
    echo "❌ 無効な選択です。"
    exit 1
  fi
fi

ACCOUNT_ID=$(printf '%s' "$CHOSEN_LINE" | cut -d'|' -f2)
ACCOUNT_NAME=$(printf '%s' "$CHOSEN_LINE" | cut -d'|' -f3)
HAS_TOKEN=$(printf '%s' "$CHOSEN_LINE" | cut -d'|' -f4)
GAS_WEBAPP_URL=$(printf '%s' "$CHOSEN_LINE" | cut -d'|' -f6-)

if [ "$HAS_TOKEN" != "OK" ]; then
  echo "❌ アカウント「$ACCOUNT_NAME」は Threads アクセストークンが未設定です。"
  echo "   先に $WEB_URL の「設定→アカウント編集」でトークンを保存してください。"
  exit 1
fi

echo "✓ 「$ACCOUNT_NAME」をセットアップします"
echo ""

# --------------------------------------------------
# Step 4: GASプロジェクト作成 + コードPush
#   （既に設定済みなら「GASコードだけ最新に更新」モードを提供）
# --------------------------------------------------
echo "[4/8] スプレッドシート作成 + GASコードPush..."
GAS_WORK_DIR="$SCRIPT_DIR/gas-deploy/$ACCOUNT_ID"

if [ -f "$GAS_WORK_DIR/.clasp.json" ] && [ -n "$GAS_WEBAPP_URL" ]; then
  # ── 既にセットアップ済み ──────────────────────────
  echo ""
  echo "  このアカウント「$ACCOUNT_NAME」は既にクラウドオフロード設定済みです。"
  echo "    現在の Web App URL: $GAS_WEBAPP_URL"
  echo ""
  echo "    ① GASのコードを最新版に更新する（スプシ・URL・トークンはそのまま。アップデート後はこれを推奨）"
  echo "    ② 最初からやり直す（新しいスプレッドシートを作り直す）"
  echo ""
  read -r -p "  どうしますか？ [1/2]: " SETUP_MODE || { echo "❌ 入力が読み取れませんでした。ターミナルの窓の中で対話的に実行してください。"; exit 1; }
  case "$SETUP_MODE" in
    1)
      echo ""
      echo "[GASコード更新] 最新のGASコードを反映します..."
      cd "$GAS_WORK_DIR"
      cp "$GAS_DIR/appscript.gs" .
      cp "$GAS_DIR/appsscript.json" .
      SCRIPT_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.clasp.json','utf8')).scriptId)")
      echo "  コードをPush中（scriptId: $SCRIPT_ID）..."
      clasp push --force >/dev/null
      # Web App URL からデプロイIDを取り出す: https://script.google.com/macros/s/<DEPLOY_ID>/exec
      DEPLOY_ID=$(printf '%s' "$GAS_WEBAPP_URL" | sed -E 's#.*/macros/s/([^/]+)/exec.*#\1#')
      echo "  デプロイを更新中（deploymentId: ${DEPLOY_ID:0:14}…）..."
      if [ -n "$DEPLOY_ID" ] && clasp deploy --deploymentId "$DEPLOY_ID" --description "コード更新 $(date +%F)" >/dev/null 2>&1; then
        cd "$SCRIPT_DIR"
        echo ""
        echo "════════════════════════════════════════════════"
        echo " ✅ GASコードを最新版に更新しました"
        echo "════════════════════════════════════════════════"
        echo ""
        echo "  Web App URL は変わっていません（$GAS_WEBAPP_URL）。"
        echo "  スプレッドシート・Threadsトークン・認証キーもそのままです。"
        echo "  これで「下書きに戻す」したときにスプシから行が消える／同じ投稿を再キューできる、になります。"
        echo ""
        echo "  （このターミナルの窓は閉じて大丈夫です）"
        echo ""
        exit 0
      else
        cd "$SCRIPT_DIR"
        echo ""
        echo "⚠ 自動でのデプロイ更新ができませんでした。GASエディタを開くので、手動で更新してください："
        echo "    1. 右上「デプロイ」→「デプロイを管理」"
        echo "    2. 該当の「ウェブアプリ」の行で 鉛筆アイコン（編集）をクリック"
        echo "    3. 「バージョン」を「新しいバージョン」に変更 → 「デプロイ」"
        echo "  （これでURLは変わらず、コードだけ最新になります）"
        echo ""
        echo "  エディタ: https://script.google.com/d/${SCRIPT_ID}/edit"
        sleep 2
        open_url "https://script.google.com/d/${SCRIPT_ID}/edit"
        echo ""
        echo "  手動更新が終わったら、このターミナルは閉じて大丈夫です。"
        echo ""
        exit 0
      fi
      ;;
    2)
      echo ""
      echo "  最初からやり直します（新しいスプレッドシートを作成します）。"
      echo "  旧GAS側に残っている待機中キューを、先にWeb側へ戻します..."
      DISABLE_RESP=$(curl -s -X POST "$WEB_URL/api/cloud/setup" \
        -H "Content-Type: application/json" \
        -d "{\"action\":\"disable\",\"accountId\":\"$ACCOUNT_ID\",\"transferBack\":true}")
      DISABLE_OK=$(echo "$DISABLE_RESP" | json_parse 'd.ok ? "ok" : ("ng:" + (d.error || "?"))')
      if [ "$DISABLE_OK" != "ok" ]; then
        echo "❌ 旧GAS側の待機中キューをWeb側へ戻せませんでした: $DISABLE_OK"
        echo "   レスポンス: $DISABLE_RESP"
        echo "   二重投稿や予約停止を避けるため、ここで中止します。"
        exit 1
      fi
      TRANSFERRED_BACK=$(echo "$DISABLE_RESP" | json_parse 'd.transferredBack || 0')
      if [ "$TRANSFERRED_BACK" != "0" ]; then
        echo "  旧GAS側の queued $TRANSFERRED_BACK 件をWeb側へ戻しました"
      fi
      rm -rf "$GAS_WORK_DIR"
      ;;
    *)
      echo "❌ 1 または 2 を入力してください。中止します。"
      exit 1
      ;;
  esac
elif [ -f "$GAS_WORK_DIR/.clasp.json" ]; then
  # ── .clasp.json はあるが Web側のURLが空（＝前回が途中で失敗して残った状態）→ 作り直しを案内 ──
  echo "  前回のセットアップが途中で止まった形跡があります（やり直して大丈夫です）。"
  read -r -p "  作り直しますか？ [Y/n]: " yn || { echo "❌ 入力が読み取れませんでした。ターミナルの窓の中で対話的に実行してください。"; exit 1; }
  case "$yn" in
    [nN]*) echo "中止しました。"; exit 1 ;;
    *) echo "  作り直します（新しいスプレッドシートを作成します）。"; rm -rf "$GAS_WORK_DIR" ;;
  esac
fi

mkdir -p "$GAS_WORK_DIR"
cp "$GAS_DIR/appscript.gs" "$GAS_WORK_DIR/"

cd "$GAS_WORK_DIR"
SS_TITLE="Threads自動投稿_${ACCOUNT_NAME}"
echo "  スプシ「$SS_TITLE」を作成中..."
clasp create --type sheets --title "$SS_TITLE" --rootDir "$GAS_WORK_DIR" >/dev/null

# rootDir が空のままだと push がスキップされる既知問題対策
node -e "
  const fs=require('fs');
  const j=JSON.parse(fs.readFileSync('.clasp.json','utf8'));
  j.rootDir='$GAS_WORK_DIR';
  fs.writeFileSync('.clasp.json', JSON.stringify(j, null, 2));
"

# ⚠ appsscript.json は clasp create の「後」にコピーする必要がある。
# clasp create がローカルにデフォルトのマニフェスト（ユーザーGoogleアカウントの
# ロケール由来 — America/New_York 等）を生成して上書きするため、先にコピーしても
# 消される。後ろでコピーし直すことで Asia/Tokyo の TZ を確実に push できる。
cp "$GAS_DIR/appsscript.json" "$GAS_WORK_DIR/appsscript.json"

clasp push --force >/dev/null
SCRIPT_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.clasp.json','utf8')).scriptId)")
echo "✓ scriptId: $SCRIPT_ID"
cd "$SCRIPT_DIR"
echo ""

# --------------------------------------------------
# Step 5: Apps Script エディタを開く + デプロイ手順誘導
# --------------------------------------------------
echo "[5/8] Web App デプロイ（ユーザー操作はここだけ）"
echo ""
EDITOR_URL="https://script.google.com/d/${SCRIPT_ID}/edit"
echo "  ブラウザを開きます。以下の手順をお願いします:"
echo ""
echo "    ┌─────────────────────────────────────────┐"
echo "    │ ① 「デプロイ」→「新しいデプロイ」          │"
echo "    │ ② 種類「ウェブアプリ」                      │"
echo "    │ ③ 実行ユーザー「自分」                       │"
echo "    │ ④ アクセス「全員」                           │"
echo "    │ ⑤ 「デプロイ」→ 認証画面                    │"
echo "    │     詳細 → 安全ではないリンク → 続行       │"
echo "    │ ⑥ 表示されたURLをコピー                      │"
echo "    └─────────────────────────────────────────┘"
echo ""
echo "  エディタ: $EDITOR_URL"
sleep 2
open_url "$EDITOR_URL"
echo ""
read -r -p "  ↓ ここに URL を貼り付けて Enter（https://script.google.com/macros/s/.../exec）: " WEBAPP_URL || {
  echo ""
  echo "❌ URL が読み取れませんでした。"
  echo "   このスクリプトは「ターミナルの窓の中」で対話的に実行する必要があります（コマンドだけ渡して実行する形だと、ここで止まれません）。"
  echo "   フォルダ内の「クラウドオフロード設定.command（Mac）/ .bat（Windows）」をダブルクリックするか、"
  echo "   ターミナルでこのフォルダに移動して  bash setup-cloud.sh  を実行し直してください。"
  exit 1
}
# 貼り付けられた文字列から Web App URL だけを抽出する。
# （ブラケットペーストの ESC[200~ … ESC[201~ や、前後の空白・引用符・改行が混ざっても拾えるように。
#   デプロイURLは https://script.google.com/macros/s/<id>/exec の形なので、その形だけ正規表現で取り出す）
WEBAPP_URL_RAW=$(printf '%s' "$WEBAPP_URL" | tr -d '\000-\037\177')
WEBAPP_URL=$(printf '%s' "$WEBAPP_URL_RAW" | grep -oE 'https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec' | head -1 || true)
if [ -z "$WEBAPP_URL" ]; then
  # 形が合わなければ、とりあえず前後の空白だけ落としたものを使う（この後の形式チェックで弾かれる/警告される）
  WEBAPP_URL=$(printf '%s' "$WEBAPP_URL_RAW" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
fi
if [ -z "$WEBAPP_URL" ]; then
  echo "❌ URL が空です。中止しました。もう一度実行して、デプロイで表示された https://script.google.com/macros/s/.../exec を貼り付けてください。"
  exit 1
fi
if ! echo "$WEBAPP_URL" | grep -q "^https://script.google.com/macros"; then
  echo "⚠ URL の形式が異常です: $WEBAPP_URL"
  echo "   正しくは https://script.google.com/macros/s/... で始まるURLです（「/exec」で終わるもの）。"
  read -r -p "  このまま続行しますか？ [y/N]: " yn || { echo "❌ 入力が読み取れませんでした。中止します。"; exit 1; }
  case "$yn" in
    [yY]*) ;;
    *) exit 1 ;;
  esac
fi
echo ""

# --------------------------------------------------
# Step 6: 認証キー自動生成 + Webアプリ経由でGASに送信
# --------------------------------------------------
echo "[6/8] 認証キー生成 + GAS Properties に設定..."
KEY_RESP=$(curl -s -X POST "$WEB_URL/api/cloud/setup" \
  -H "Content-Type: application/json" \
  -d '{"action":"generateKey"}')
WEBAPP_KEY=$(echo "$KEY_RESP" | json_parse 'd.key')
if [ -z "$WEBAPP_KEY" ]; then
  echo "❌ 認証キー生成失敗: $KEY_RESP"
  exit 1
fi
echo "✓ Key生成（先頭8文字: ${WEBAPP_KEY:0:8}…）"
echo ""

# 値はシェル展開でNodeソースに埋め込まず、環境変数で渡す（'や"や制御文字が混ざっても壊れない）
INIT_PAYLOAD=$(SC_ACCOUNT_ID="$ACCOUNT_ID" SC_WEBAPP_URL="$WEBAPP_URL" SC_WEBAPP_KEY="$WEBAPP_KEY" node -e 'console.log(JSON.stringify({action:"initialize",accountId:process.env.SC_ACCOUNT_ID,gasWebAppUrl:process.env.SC_WEBAPP_URL,gasWebAppKey:process.env.SC_WEBAPP_KEY}))')
if [ -z "$INIT_PAYLOAD" ]; then
  echo "❌ 送信データの生成に失敗しました（node が動かない可能性）。"
  exit 1
fi
INIT_RESP=$(curl -s -X POST "$WEB_URL/api/cloud/setup" \
  -H "Content-Type: application/json" \
  -d "$INIT_PAYLOAD")
INIT_OK=$(echo "$INIT_RESP" | json_parse 'd.ok ? "ok" : ("ng:" + (d.error || "?"))')
if [ "$INIT_OK" != "ok" ]; then
  echo "❌ GAS初期化失敗: $INIT_OK"
  echo "   レスポンス: $INIT_RESP"
  exit 1
fi
# タイムゾーン検証（webapp 側でも弾くが、ここでも明示的にチェック＝両方から保護）
SCRIPT_TZ=$(echo "$INIT_RESP" | json_parse 'd.scriptTimeZone')
if [ "$SCRIPT_TZ" != "Asia/Tokyo" ]; then
  if [ -z "$SCRIPT_TZ" ]; then
    SCRIPT_TZ_LABEL="未返却（GASコードが古い/反映されていない可能性）"
  else
    SCRIPT_TZ_LABEL="$SCRIPT_TZ"
  fi
  echo "❌ GASプロジェクトのタイムゾーンが Asia/Tokyo ではありません: $SCRIPT_TZ_LABEL"
  echo "   このままだと予約時刻がズレて投稿されません（GAS側の安全弁が発動します）。"
  echo "   GASコード更新または Apps Scriptエディタの「プロジェクトの設定（⚙️） → タイムゾーン」を Asia/Tokyo に変更してから、もう一度このスクリプトを実行してください。"
  exit 1
fi
USER_ID=$(echo "$INIT_RESP" | json_parse 'd.userId')
USERNAME=$(echo "$INIT_RESP" | json_parse 'd.username')
echo "✓ Threads APIトークン検証成功（@$USERNAME / userId=$USER_ID）"
echo "✓ シート初期化・トークン更新トリガー設定完了（TZ: $SCRIPT_TZ）"
echo ""

# --------------------------------------------------
# Step 7: クラウドオフロード有効化
# --------------------------------------------------
echo "[7/8] クラウドオフロード有効化..."
ENABLE_RESP=$(curl -s -X POST "$WEB_URL/api/cloud/setup" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"enable\",\"accountId\":\"$ACCOUNT_ID\"}")
ENABLE_OK=$(echo "$ENABLE_RESP" | json_parse 'd.ok ? "ok" : ("ng:" + (d.error || "?"))')
if [ "$ENABLE_OK" != "ok" ]; then
  echo "❌ 有効化失敗: $ENABLE_OK"
  exit 1
fi
TRANSFERRED=$(echo "$ENABLE_RESP" | json_parse 'd.transferred || 0')
echo "✓ 有効化完了"
if [ "$TRANSFERRED" != "0" ]; then
  echo "  既存の queued $TRANSFERRED 件を GAS に転送しました"
fi
echo ""

# --------------------------------------------------
# Step 8: 完了
# --------------------------------------------------
echo "[8/8] 動作確認..."
SYNC_RESP=$(curl -s "$WEB_URL/api/cloud/sync?accountId=$ACCOUNT_ID")
SYNC_OK=$(echo "$SYNC_RESP" | json_parse 'd.ok ? "ok" : "ng"')
if [ "$SYNC_OK" = "ok" ]; then
  echo "✓ 同期テスト成功"
fi
echo ""
echo "════════════════════════════════════════════════"
echo " ✅ 完了です！ クラウドオフロードの設定で、もうやることはありません。"
echo "════════════════════════════════════════════════"
echo ""
echo "  アカウント: $ACCOUNT_NAME"
echo "  scriptId:  $SCRIPT_ID"
echo "  Web App:   $WEBAPP_URL"
echo ""
echo "  ── これから何が変わる？ ──────────────────────"
echo "   PC を閉じてても・スリープ中でも・電源オフでも、"
echo "   予約時刻になれば Google 側（GAS）が自動で投稿してくれます。"
echo ""
echo "  ── じゃあ、次は何をすればいい？ ──────────────"
echo "   何もしなくてOKです。使い方は今までと同じ："
echo "     1. アプリ（http://localhost:3000）で投稿を作る（AI生成 or 編集）"
echo "     2. 「全件キューに追加」で予約する"
echo "     3. あとは予約時刻に自動で投稿されます（PCを閉じていてもOK）"
echo ""
echo "  ── ちゃんと動いてるか確認したい時は？ ────────"
echo "   アプリの「設定 → アカウント編集 → ☁ クラウドオフロード」を開くと、"
echo "   緑色の「✓ 有効」表示と、最終同期時刻・トークン状態が見られます（cron が5分おきに同期）。"
echo "   ※ アプリを開きっぱなしでもOK — 画面は自動で最新の状態に更新されます（リロード不要）。"
echo ""
echo "  ── 別のアカウントもクラウド化したい時は？ ────"
echo "   もう一度このスクリプト（bash setup-cloud.sh、または「クラウドオフロード設定」を"
echo "   ダブルクリック、または Claude Code に「クラウドオフロードをセットアップして」）を実行してください。"
echo ""
echo "  （このターミナルの窓は、もう閉じて大丈夫です）"
echo ""
