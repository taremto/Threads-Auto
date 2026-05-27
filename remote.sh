#!/bin/bash
# 外出先のスマホなどからアプリを使えるようにする（リモートアクセス）。
#   1. アプリにパスワードのカギをかける（proxy.ts の Basic 認証）
#   2. cloudflared で一時的な公開URLを発行する
#   3. そのURLをスマホのブラウザで開けば、外出先でも操作できる
#
# パスワードをかけないと外部公開しない（安全のため）。
# パソコンがスリープ/電源オフの間は外からも開けない（仕様。常時投稿はクラウドオフロードで）。

cd "$(dirname "$0")"

PORT="${PORT:-3000}"
ENV_FILE=".env.local"
URL_LOCAL="http://localhost:$PORT"

if [ ! -d "node_modules" ]; then
  echo "❌ まだセットアップされていません。先に初回セットアップを実行してください。"
  exit 1
fi

echo "================================================"
echo " 外出先からアクセス（リモートアクセス）"
echo "================================================"
echo ""
echo " アプリにパスワードのカギをかけた上で、スマホなどの"
echo " 外部からアクセスできる一時的なURLを発行します。"
echo ""

http_code() { curl --max-time 3 -s -o /dev/null -w "%{http_code}" "$1" 2>/dev/null; }

# ---- 1. パスワードの用意 ----
get_saved_password() {
  [ -f "$ENV_FILE" ] || return 1
  node -e '
    const fs=require("fs");
    try{
      const t=fs.readFileSync(process.argv[1],"utf8");
      const m=t.match(/^REMOTE_PASSWORD=(.*)$/m);
      if(m){
        let v=m[1].trim();
        if((v.startsWith("\"")&&v.endsWith("\""))||(v.startsWith("'"'"'")&&v.endsWith("'"'"'"))) v=v.slice(1,-1);
        if(v){ process.stdout.write(v); process.exit(0); }
      }
    }catch(e){}
    process.exit(1);
  ' "$ENV_FILE"
}

REMOTE_PASSWORD="$(get_saved_password || true)"

if [ -z "$REMOTE_PASSWORD" ]; then
  echo "🔑 外部からアプリを開くときの「合言葉（パスワード）」を決めます。"
  echo "   （スマホでアプリを開くと、このパスワードの入力を求められます）"
  echo ""
  while [ -z "$REMOTE_PASSWORD" ]; do
    printf "   パスワードを入力して Enter: "
    read -r REMOTE_PASSWORD
    [ -z "$REMOTE_PASSWORD" ] && echo "   空にはできません。もう一度入力してください。"
  done
  node -e '
    const fs=require("fs"); const f=process.argv[1]; const v=process.argv[2];
    let t=""; try{t=fs.readFileSync(f,"utf8");}catch(e){}
    const line="REMOTE_PASSWORD="+JSON.stringify(v);
    if(/^REMOTE_PASSWORD=.*$/m.test(t)) t=t.replace(/^REMOTE_PASSWORD=.*$/m,line);
    else t=(t && !t.endsWith("\n") ? t+"\n" : t)+line+"\n";
    fs.writeFileSync(f,t);
  ' "$ENV_FILE" "$REMOTE_PASSWORD"
  echo "   ✅ パスワードを保存しました（次回からは聞きません）。"
  echo ""
fi
export REMOTE_PASSWORD

# ---- 2. cloudflared（トンネル）の用意 ----
CF=""
if command -v cloudflared >/dev/null 2>&1; then
  CF="cloudflared"
elif [ -x "./.bin/cloudflared" ]; then
  CF="./.bin/cloudflared"
else
  echo "🌐 外部アクセス用ソフト（cloudflared）を準備します..."
  mkdir -p .bin
  OS="$(uname -s)"; ARCH="$(uname -m)"
  case "$OS" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        brew install cloudflared && CF="cloudflared"
      else
        case "$ARCH" in
          arm64) U="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz";;
          *)     U="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz";;
        esac
        if curl -L --fail -o .bin/cloudflared.tgz "$U" && tar -xzf .bin/cloudflared.tgz -C .bin; then
          rm -f .bin/cloudflared.tgz; chmod +x .bin/cloudflared; CF="./.bin/cloudflared"
        fi
      fi
      ;;
    Linux)
      case "$ARCH" in
        aarch64|arm64) U="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64";;
        *)             U="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";;
      esac
      if curl -L --fail -o .bin/cloudflared "$U"; then chmod +x .bin/cloudflared; CF="./.bin/cloudflared"; fi
      ;;
    *)
      echo "❌ この環境では cloudflared を自動インストールできませんでした。"
      echo "   https://github.com/cloudflare/cloudflared/releases から入手してください。"
      exit 1
      ;;
  esac
fi

if [ -z "$CF" ]; then
  echo "❌ cloudflared を準備できませんでした。ネット接続を確認して、もう一度お試しください。"
  exit 1
fi

# ---- 3. アプリ（パスワード保護つき）を起動 ----
STARTED_SERVER=0
SERVER_PID=""
SERVER_LOG="/tmp/threads-auto-remote-server.log"

CODE="$(http_code "$URL_LOCAL")"
if [ "$CODE" = "401" ]; then
  echo "✅ パスワード保護つきのアプリが既に起動しています。"
elif [ "$CODE" = "000" ] || [ -z "$CODE" ]; then
  echo "▶ アプリを起動します（パスワード保護つき）..."
  npx next dev -p "$PORT" >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  STARTED_SERVER=1
  for i in $(seq 1 60); do
    CODE="$(http_code "$URL_LOCAL")"
    [ "$CODE" = "401" ] && break
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then CODE="dead"; break; fi
    sleep 1
  done
  if [ "$CODE" != "401" ]; then
    echo "❌ アプリの起動を確認できませんでした。$SERVER_LOG を確認してください。"
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
    exit 1
  fi
  echo "✅ アプリを起動しました（パスワード保護つき）。"
else
  echo "⚠ アプリは起動中ですが、パスワード保護がかかっていません（HTTP $CODE）。"
  echo "   安全のため、このままでは外部公開できません。"
  echo "   いま開いている「アプリ起動」のウィンドウを Ctrl+C で一度止めてから、"
  echo "   もう一度このリモートアクセスを実行してください。"
  exit 1
fi
echo ""

# ---- 4. トンネルを開く ----
TUNNEL_PID=""
TUNNEL_LOG="/tmp/threads-auto-tunnel.log"
cleanup() {
  echo ""
  echo "リモートアクセスを終了します..."
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
  [ "$STARTED_SERVER" = "1" ] && [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

: > "$TUNNEL_LOG"
echo "🌐 外部アクセス用のURLを発行中...（数秒〜十数秒かかります）"
"$CF" tunnel --url "$URL_LOCAL" --no-autoupdate >"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

PUBLIC_URL=""
for i in $(seq 1 40); do
  PUBLIC_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1)"
  [ -n "$PUBLIC_URL" ] && break
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "❌ トンネルの起動に失敗しました。$TUNNEL_LOG を確認してください。"
    exit 1
  fi
  sleep 1
done

if [ -z "$PUBLIC_URL" ]; then
  echo "❌ 外部URLの発行を確認できませんでした。$TUNNEL_LOG を確認してください。"
  exit 1
fi

echo ""
echo "================================================================"
echo " ✅ 外出先からアクセスできます！"
echo "================================================================"
echo ""
echo "  スマホのブラウザで、次のURLを開いてください："
echo ""
echo "      $PUBLIC_URL"
echo ""
echo "  開くとログインを聞かれます："
echo "      ユーザー名: 何でもOK（例: user）"
echo "      パスワード: あなたが決めた合言葉"
echo ""
echo "  ※ このURLはこのウィンドウを閉じるまで有効です（毎回変わります）。"
echo "  ※ Ctrl+C／この窓を閉じると、外部アクセスは止まります。"
echo "  ※ パソコンがスリープ/電源オフだと外からも開けません。"
echo "     常時投稿だけしたいなら『クラウドオフロード』を使ってください。"
echo ""
echo "（このウィンドウは開いたままにしておいてください）"
echo ""

wait "$TUNNEL_PID"
