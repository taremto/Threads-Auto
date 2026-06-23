/**
 * Mock GAS Web App Server
 *
 * 本物のGAS doPostの挙動を Node.js HTTP サーバで完全エミュレート。
 * gas/appscript.gs の各アクション（healthCheck/pushQueue/verifyQueueByPostIds/
 * updateByPostId/cancelByPostId/pullResults/ackResults/setConfig）と同じレスポンス形状を返す。
 *
 * シートの代わりに「rows」配列をメモリに保持し、各 webPostId をキーに操作する。
 *
 * 使い方:
 *   node tests/mock-gas-server.mjs            # ポート5555で起動
 *   PORT=5556 node tests/mock-gas-server.mjs  # 任意ポート
 */

import http from "node:http";

const PORT = Number(process.env.MOCK_GAS_PORT || 5555);
const VERSION = "webapp-v1.1.9";

// 状態（実シートに相当）
const state = {
  webappKey: "TESTKEY_INIT", // setConfigで上書き可能
  token: "",
  userId: "",
  username: "",
  tokenRefreshedAt: null,
  tokenExpiresInSec: 5184000, // 60日
  tokenLastError: null,
  nextSetConfigToken: null,
  rows: [], // [{ webPostId, groupNo, text, postType, publishAtJst, status, threadsPostId, postUrl, postedAt, error, synced, row }]
  triggerActive: false,
  tokenRefreshTriggerActive: false,
};

let nextRowNum = 2;

function ok(data) {
  return { status: "ok", ...data };
}
function err(message) {
  return { status: "error", message };
}

function findRow(webPostId) {
  return state.rows.find((r) => r.webPostId === String(webPostId));
}

function tokenFingerprint() {
  if (!state.token || state.token.length < 12) return null;
  return state.token.substring(0, 8) + "…" + state.token.substring(state.token.length - 4);
}

function userIdFromToken(token) {
  const explicit = String(token).match(/^test_token_user_([A-Za-z0-9_-]+)/);
  if (explicit) return explicit[1];
  let hash = 0;
  for (const ch of String(token)) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return "mock_user_" + hash;
}

function getTokenStatus() {
  if (state.tokenLastError) return "failed";
  if (!state.tokenRefreshedAt) return "ok";
  const expiresAt = state.tokenRefreshedAt + state.tokenExpiresInSec * 1000;
  const left = expiresAt - Date.now();
  if (left < 7 * 24 * 60 * 60 * 1000) return "expiring_soon";
  return "ok";
}

function getTokenExpiresAt() {
  if (!state.tokenRefreshedAt) return null;
  return new Date(state.tokenRefreshedAt + state.tokenExpiresInSec * 1000).toISOString();
}

function handleAction(body) {
  const action = body.action;

  // healthCheck はキー検証なしでも答える設計（疎通確認用）
  if (action === "healthCheck") {
    return ok({
      version: VERSION,
      configured: !!(state.token && state.userId),
      hasTrigger: state.triggerActive,
      hasTokenRefreshTrigger: state.tokenRefreshTriggerActive,
      userId: state.userId || null,
      tokenFingerprint: tokenFingerprint(),
      tokenStatus: getTokenStatus(),
      tokenExpiresAt: getTokenExpiresAt(),
      tokenLastError: state.tokenLastError,
      scriptTimeZone: "Asia/Tokyo",
      spreadsheetTimeZone: "Asia/Tokyo",
    });
  }

  // setConfig は初回 webappKey 未設定なら通す
  if (action === "setConfig") {
    if (!body.token || String(body.token).length < 10) {
      return err("tokenが無効です（必須・10文字以上）");
    }
    // /me 検証はモックではスキップして即成功扱い（本物ではThreads API呼び出し）
    state.token = state.nextSetConfigToken || body.token;
    state.nextSetConfigToken = null;
    state.userId = userIdFromToken(body.token);
    state.username = "mock_username_" + state.userId;
    state.tokenRefreshedAt = Date.now();
    state.tokenExpiresInSec = 5184000;
    state.tokenLastError = null;
    if (body.webapp_key) state.webappKey = body.webapp_key;
    state.triggerActive = true; // setupTokenRefreshTrigger 相当
    state.tokenRefreshTriggerActive = true;
    return ok({
      message: "API設定完了 + シート初期化済み",
      user_id: state.userId,
      username: state.username,
      hasTrigger: state.triggerActive,
      scriptTimeZone: "Asia/Tokyo",
      spreadsheetTimeZone: "Asia/Tokyo",
    });
  }

  // 以降は webappKey 検証必須
  if (state.webappKey && body.key !== state.webappKey) {
    return err("認証エラー: keyが無効です");
  }

  if (action === "pushQueue") {
    if (!Array.isArray(body.posts) || body.posts.length === 0) {
      return err("postsフィールドが必要です（配列）");
    }
    const startRow = nextRowNum;
    const ids = [];
    let upserted = 0;
    let inserted = 0;
    for (let i = 0; i < body.posts.length; i++) {
      const p = body.posts[i];
      if (!p.webPostId || !p.text || !p.publishAtJst) {
        return err(
          `posts[${i}] に必須フィールド欠落（webPostId/text/publishAtJst）`
        );
      }
      const existing = findRow(p.webPostId);
      if (existing) {
        if (existing.status === "投稿済") {
          return err(
            `この予約はGoogle側では既に投稿済みです。Web画面で「今すぐ同期」を押して投稿結果を取り込んでください。（webPostId=${p.webPostId}）`
          );
        }
        existing.groupNo = p.groupNo;
        existing.text = p.text;
        existing.postType = p.postType;
        existing.publishAtJst = p.publishAtJst;
        existing.memo = p.memo || null;
        existing.status = "待機中";
        existing.threadsPostId = null;
        existing.postUrl = null;
        existing.postedAt = null;
        existing.error = null;
        existing.synced = "";
        ids.push(String(p.webPostId));
        upserted++;
        continue;
      }
      state.rows.push({
        webPostId: String(p.webPostId),
        groupNo: p.groupNo,
        text: p.text,
        postType: p.postType,
        publishAtJst: p.publishAtJst,
        memo: p.memo || null,
        status: "待機中",
        threadsPostId: null,
        postUrl: null,
        postedAt: null,
        error: null,
        synced: "",
        row: nextRowNum,
      });
      ids.push(String(p.webPostId));
      inserted++;
      nextRowNum++;
    }
    return ok({
      message: `${inserted + upserted}件をシートに反映しました（新規${inserted} / 上書き${upserted}）`,
      rows: body.posts.length,
      startRow,
      webPostIds: ids,
    });
  }

  if (action === "verifyQueueByPostIds") {
    if (!Array.isArray(body.webPostIds) || body.webPostIds.length === 0) {
      return ok({ present: [], missing: [], rows: [] });
    }
    const present = [];
    const missing = [];
    const rows = [];
    for (const id of body.webPostIds) {
      const r = findRow(id);
      if (r) {
        present.push(String(id));
        rows.push({ webPostId: String(id), status: r.status, row: r.row });
      } else {
        missing.push(String(id));
      }
    }
    return ok({ present, missing, rows });
  }

  if (action === "updateByPostId") {
    if (!body.webPostId) return err("webPostIdが必要です");
    const r = findRow(body.webPostId);
    if (!r) return err(`webPostId=${body.webPostId} の行が見つかりません`);
    if (r.status === "投稿済") return err(`既に投稿済のため更新できません（行${r.row}）`);
    if (body.text != null) r.text = body.text;
    if (body.publishAtJst) r.publishAtJst = body.publishAtJst;
    if (body.postType) r.postType = body.postType;
    return ok({ message: `行${r.row}を更新しました`, row: r.row });
  }

  if (action === "cancelByPostId") {
    if (!body.webPostId) return err("webPostIdが必要です");
    const r = findRow(body.webPostId);
    if (!r) return err(`webPostId=${body.webPostId} の行が見つかりません`);
    if (r.status === "投稿済")
      return err(`既に投稿済のためキャンセルできません（行${r.row}）`);
    r.status = "下書き";
    return ok({ message: `行${r.row}をキャンセルしました`, row: r.row });
  }

  if (action === "pullResults") {
    const results = [];
    let recentErrorCount24h = 0;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const r of state.rows) {
      if (r.status === "エラー" && r.postedAt && new Date(r.postedAt).getTime() >= cutoff) {
        recentErrorCount24h++;
      }
      if (r.synced === "1") continue;
      if (r.status !== "投稿済" && r.status !== "エラー") continue;
      results.push({
        webPostId: r.webPostId,
        status: r.status === "投稿済" ? "posted" : "error",
        threadsPostId: r.threadsPostId,
        postUrl: r.postUrl,
        postedAt: r.postedAt,
        error: r.error,
        row: r.row,
      });
    }
    return ok({
      version: VERSION,
      results,
      count: results.length,
      tokenStatus: getTokenStatus(),
      tokenExpiresAt: getTokenExpiresAt(),
      tokenFingerprint: tokenFingerprint(),
      tokenLastError: state.tokenLastError,
      recentErrorCount24h,
    });
  }

  if (action === "ackResults") {
    if (!Array.isArray(body.webPostIds) || body.webPostIds.length === 0) {
      return ok({ acked: 0, missing: [], message: "webPostIds空のためスキップ" });
    }
    let acked = 0;
    const missing = [];
    for (const id of body.webPostIds) {
      const r = findRow(id);
      if (r) {
        r.synced = "1";
        acked++;
      } else {
        missing.push(id);
      }
    }
    return ok({ acked, missing });
  }

  return err(`unknown action: ${action}`);
}

const server = http.createServer((req, res) => {
  // ----- テスト用バックドア（GAS本物にはない） -----
  // /__simulate_post {webPostId, threadsPostId?, postUrl?} で投稿成功をシミュレート
  // /__simulate_error {webPostId, error}
  // /__state でシート状態を取得
  // /__reset でリセット
  if (req.method === "GET" && req.url === "/__state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state));
    return;
  }
  if (req.method === "POST" && req.url === "/__reset") {
    state.rows = [];
    state.token = "";
    state.userId = "";
    state.username = "";
    state.tokenRefreshedAt = null;
    state.tokenLastError = null;
    state.nextSetConfigToken = null;
    state.webappKey = "TESTKEY_INIT";
    state.triggerActive = false;
    state.tokenRefreshTriggerActive = false;
    nextRowNum = 2;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/__next_set_config_token")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const b = JSON.parse(raw || "{}");
        if (!b.token || String(b.token).length < 10) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "token required" }));
          return;
        }
        state.nextSetConfigToken = String(b.token);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/__simulate_post")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const b = JSON.parse(raw || "{}");
        const r = findRow(b.webPostId);
        if (!r) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "row not found" }));
          return;
        }
        r.status = "投稿済";
        r.threadsPostId = b.threadsPostId || "12345" + Math.floor(Math.random() * 1000000);
        r.postUrl = b.postUrl || `https://threads.net/@mock/post/${r.threadsPostId}`;
        r.postedAt = new Date().toISOString();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, row: r.row, threadsPostId: r.threadsPostId }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/__simulate_error")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const b = JSON.parse(raw || "{}");
        const r = findRow(b.webPostId);
        if (!r) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "row not found" }));
          return;
        }
        r.status = "エラー";
        r.error = b.error || "シミュレートエラー";
        r.postedAt = new Date().toISOString();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, row: r.row }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // ----- 本物のGAS doPost を模した /exec エンドポイント -----
  if (req.method === "POST" && (req.url === "/exec" || req.url === "/")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(err("JSON parse failed")));
        return;
      }
      let response;
      try {
        response = handleAction(body);
      } catch (e) {
        response = err(e.message || String(e));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
  console.log(`[mock-gas] listening on http://localhost:${PORT}/exec`);
  console.log(`[mock-gas] backdoors: GET /__state, POST /__reset, /__simulate_post, /__simulate_error, /__next_set_config_token`);
});
