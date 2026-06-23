#!/usr/bin/env node
/**
 * 使用量リフレッシャー（5時間 / 週間プラン使用率の自動更新）
 *
 * 背景:
 *   Claude Code の 5h/7d プラン使用率は「対話TTYセッションが API 応答を
 *   受け取ったとき」に statusLine へ渡される JSON にのみ含まれる。
 *   `claude -p`（webアプリの生成呼び出し）や SDK 経由では rate_limits が
 *   null のままで、usage-statusline-bridge.py に実データが渡らない。
 *   そのためデスクトップアプリ運用だと 5h/7d% が画面に出ない。
 *
 * このスクリプトの役割:
 *   node-pty で本物の擬似端末(ConPTY)を割り当てて claude を「対話モード」
 *   で短時間だけ起動し、極小プロンプトを1回送る。応答ヘッダのレート制限が
 *   statusLine JSON に乗り、配線済みの usage-statusline-bridge.py が
 *   ~/.claude/.ratelimit_cache.json を更新する。webアプリはそのキャッシュを
 *   読むので、画面に 5h/7d% バーが出るようになる。
 *
 * 設計方針:
 *   - 既存の動作中コードには一切触れない（このファイル単体で完結）。
 *   - 失敗しても webアプリ本体や予約投稿には影響を与えない（独立プロセス）。
 *   - claude を必要最小限（極小プロンプト1回）だけ叩く。
 *
 * 使い方:
 *   node scripts/usage-refresher.cjs            # 1回だけ更新して終了
 *   node scripts/usage-refresher.cjs --loop 20  # 20分ごとに無限ループ
 *
 * 注意（コスト）:
 *   1サイクルにつき claude へ極小プロンプトを1回送る = ごく僅かだが
 *   Pro/Max のセッション使用量を消費する。キャッシュ鮮度は約30分なので
 *   ループ間隔は 20〜25 分を推奨（短くしすぎない）。
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const CACHE_PATH = path.join(HOME, ".claude", ".ratelimit_cache.json");

// --- node-pty 読み込み（このスクリプトは webアプリ直下の scripts/ にあるので
//     webアプリの node_modules は 1つ上）------------------------------------
let pty;
try {
  pty = require(path.join(__dirname, "..", "node_modules", "node-pty"));
} catch {
  try {
    pty = require("node-pty");
  } catch (e) {
    console.error("[refresher] node-pty を読み込めません。`npm install node-pty` が必要です:", e.message);
    process.exit(2);
  }
}

// --- claude 実行ファイルの解決（node-pty は実行ファイル実体が必要）----------
// Windows は claude.exe、darwin/linux は拡張子なしの claude。
function resolveClaudeExe() {
  const candidates = [];
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
    candidates.push(
      path.join(appdata, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
    );
    const local = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
    candidates.push(
      path.join(local, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
    );
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      if (!dir) continue;
      candidates.push(path.join(dir, "claude.exe"));
      candidates.push(
        path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
      );
    }
  } else {
    // darwin / linux: Anthropic 公式インストーラは ~/.claude/local/claude に展開し
    // /usr/local/bin/claude へシンボリックリンクを張る構成。npm global / Homebrew も探索。
    candidates.push(path.join(HOME, ".claude", "local", "claude"));
    candidates.push(path.join(HOME, ".local", "bin", "claude"));
    candidates.push("/usr/local/bin/claude");
    candidates.push("/opt/homebrew/bin/claude");
    candidates.push(path.join(HOME, ".npm-global", "bin", "claude"));
    candidates.push("/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude");
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      if (!dir) continue;
      candidates.push(path.join(dir, "claude"));
      candidates.push(
        path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude")
      );
    }
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function readCacheStamp() {
  try {
    const st = fs.statSync(CACHE_PATH);
    const j = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    const has =
      j &&
      j.data &&
      ((j.data.five_hour && typeof j.data.five_hour.used_percentage === "number") ||
        (j.data.seven_day && typeof j.data.seven_day.used_percentage === "number"));
    return { mtime: st.mtimeMs, ts: j && j.timestamp, has: !!has };
  } catch {
    return { mtime: 0, ts: 0, has: false };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 1サイクル: claude を対話起動 → 極小プロンプト → キャッシュ更新を待つ → 終了
 * @returns {Promise<boolean>} 成功（キャッシュが新しく実データで更新された）なら true
 */
async function refreshOnce() {
  const claudeExe = resolveClaudeExe();
  if (!claudeExe) {
    const which = process.platform === "win32" ? "claude.exe" : "claude";
    console.error(`[refresher] ${which} が見つかりません。Claude Code がインストールされていません。`);
    return false;
  }

  const before = readCacheStamp();
  let child;
  try {
    child = pty.spawn(claudeExe, [], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: process.env,
    });
  } catch (e) {
    console.error("[refresher] claude の起動に失敗:", e.message);
    return false;
  }

  let alive = true;
  child.onExit(() => {
    alive = false;
  });
  // 出力は捨てる（statusLine の副作用＝キャッシュ書き込みだけが目的）
  child.onData(() => {});

  const kill = () => {
    try {
      if (alive) child.kill();
    } catch {
      /* ignore */
    }
  };

  try {
    // 1) 初期化待ち（CLAUDE.md 読込・プラグイン同期など）
    await sleep(12000);
    if (!alive) {
      console.error("[refresher] claude が初期化前に終了しました。");
      return false;
    }
    // 2) 極小プロンプト送信（応答ヘッダにレート制限が乗る）
    child.write("hi\r");

    // 3) 応答 → statusLine 再描画 → bridge がキャッシュ更新、を最大75秒待つ
    const deadline = Date.now() + 75000;
    let ok = false;
    while (Date.now() < deadline && alive) {
      await sleep(2000);
      const now = readCacheStamp();
      const updated =
        now.has && (now.mtime > before.mtime || (now.ts || 0) > (before.ts || 0));
      if (updated) {
        ok = true;
        break;
      }
    }

    // 4) きれいに退出
    try {
      if (alive) child.write("/exit\r");
    } catch {
      /* ignore */
    }
    await sleep(2500);
    kill();

    if (ok) {
      const s = readCacheStamp();
      console.log(
        `[refresher] OK 更新しました (timestamp=${s.ts}) ${new Date().toISOString()}`
      );
      return true;
    }
    console.error(
      "[refresher] タイムアウト: キャッシュが更新されませんでした（レート制限が応答に乗らなかった可能性）。"
    );
    return false;
  } finally {
    kill();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const loopIdx = args.indexOf("--loop");
  if (loopIdx === -1) {
    const ok = await refreshOnce();
    process.exit(ok ? 0 : 1);
  }

  // ループモード
  let minutes = parseInt(args[loopIdx + 1], 10);
  if (!Number.isFinite(minutes) || minutes < 10) minutes = 20; // 下限10分・既定20分
  console.log(`[refresher] ループ開始: ${minutes}分ごとに更新します。`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await refreshOnce();
    } catch (e) {
      console.error("[refresher] サイクル中に例外:", e && e.message);
    }
    await sleep(minutes * 60 * 1000);
  }
}

main().catch((e) => {
  console.error("[refresher] 致命的エラー:", e && e.message);
  process.exit(1);
});
