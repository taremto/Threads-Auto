/**
 * gas-bridge.ts — GAS Web App と通信するクライアントレイヤー
 *
 * 責務:
 *   - GAS Web App URL に対する POST 通信（key付き認証）
 *   - リトライ・タイムアウト
 *   - JST変換（SQLite UTC Date → "YYYY-MM-DDTHH:mm" JST）
 *
 * 呼び出し元: bulk-queue/route.ts、cloud/setup/route.ts、gas-sync.ts(M3)
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;
export const REQUIRED_GAS_VERSION = "webapp-v1.1.11";

type GasCallOptions = {
  timeoutMs?: number;
  retries?: number;
};

export type GasEndpoint = {
  url: string;
  key: string;
};

export type GasResponse<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
  httpStatus?: number;
};

function parseWebappVersion(version: string | null | undefined): number[] | null {
  if (!version) return null;
  const m = String(version).match(/^webapp-v(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isGasVersionSupported(version: string | null | undefined): boolean {
  const current = parseWebappVersion(version);
  const required = parseWebappVersion(REQUIRED_GAS_VERSION);
  if (!current || !required) return false;
  for (let i = 0; i < required.length; i++) {
    if (current[i] > required[i]) return true;
    if (current[i] < required[i]) return false;
  }
  return true;
}

function gasVersionLabel(version: string | null | undefined): string {
  return version ? String(version).replace(/^webapp-/, "") : "不明";
}

export function gasVersionUpgradeMessage(version: string | null | undefined): string {
  return (
    "アプリ本体は更新済みです。Google側の投稿コードだけが古い状態です。" +
    ` Google側の現在版: ${gasVersionLabel(version)}。最新版: ${gasVersionLabel(REQUIRED_GAS_VERSION)}。` +
    "この画面、または設定のクラウドオフロード欄にある「Google投稿を修復する」を押してください。"
  );
}

/** UTC Date → JST "YYYY-MM-DDTHH:mm"（秒は丸めて分単位、GAS側 parseJstDateTime_ と整合） */
export function toJstString(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const mo = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const da = String(jst.getUTCDate()).padStart(2, "0");
  const h = String(jst.getUTCHours()).padStart(2, "0");
  const mi = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${da}T${h}:${mi}`;
}

/** GAS doPost に対する低レベル呼び出し。リトライ・タイムアウト付き */
async function postToGas<T = unknown>(
  endpoint: GasEndpoint,
  body: Record<string, unknown>,
  opts: { timeoutMs?: number; retries?: number } = {}
): Promise<GasResponse<T>> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES } = opts;
  const payload = JSON.stringify({ ...body, key: endpoint.key });

  let lastError = "";
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(endpoint.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: ctrl.signal,
        // GAS Web App は HTTP 302 でリダイレクトするので follow が必要
        redirect: "follow",
      });
      clearTimeout(timer);
      lastStatus = resp.status;
      const text = await resp.text();
      let parsed: { status?: string; message?: string } & Record<string, unknown>;
      try {
        parsed = JSON.parse(text);
      } catch {
        const looksLikeHtml = /<!doctype html|<html[\s>]/i.test(text);
        lastError = looksLikeHtml
          ? `Google側から確認用データではなく画面用HTMLが返りました (HTTP ${resp.status})。GASの反映待ち、またはWeb Appの公開設定を確認してください。`
          : `GAS返却がJSONとして読み取れませんでした (HTTP ${resp.status})。`;
        // JSONパース失敗は永続エラー扱い、リトライしない
        return { ok: false, error: lastError, httpStatus: resp.status };
      }
      if (parsed.status === "ok") {
        return { ok: true, data: parsed as T, httpStatus: resp.status };
      }
      lastError = parsed.message || `GAS error (status=${parsed.status})`;
      // 認証エラー・バリデーションエラーはリトライ無意味
      if (
        lastError.includes("認証エラー") ||
        lastError.includes("必要です") ||
        lastError.includes("無効です") ||
        lastError.includes("重複")
      ) {
        return { ok: false, error: lastError, httpStatus: resp.status };
      }
    } catch (e) {
      clearTimeout(timer);
      lastError = e instanceof Error ? e.message : String(e);
      // AbortErrorやネットワークエラーはリトライ対象
    }

    if (attempt < retries) {
      // 指数バックオフ: 1s, 2s, 4s
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }

  return { ok: false, error: lastError, httpStatus: lastStatus };
}

// ============================================
// アクション別ラッパー
// ============================================

export async function healthCheck(endpoint: GasEndpoint, opts: GasCallOptions = {}) {
  return postToGas<{
    version: string;
    configured: boolean;
    hasTrigger: boolean;
    hasTokenRefreshTrigger?: boolean;
    userId: string | null;
    tokenFingerprint: string | null;
    tokenStatus?: "ok" | "expiring_soon" | "failed";
    tokenExpiresAt?: string | null;
    tokenLastError?: string | null;
    scriptTimeZone?: string;
    spreadsheetTimeZone?: string;
    triggerResetAt?: string | null;
    lastProcessAttemptAt?: string | null;
    lastProcessFinishAt?: string | null;
    lastProcessSkippedAt?: string | null;
    lastProcessSummary?: string | null;
    lastProcessErrorAt?: string | null;
    lastProcessError?: string | null;
  }>(endpoint, { action: "healthCheck" }, { retries: opts.retries ?? 1, timeoutMs: opts.timeoutMs });
}

/**
 * setConfig: 初回セットアップ時のみ実行
 *   - Threads トークンを GAS Properties に保存
 *   - Threads /me でUserID自動取得・トークン検証
 *   - WEBAPP_KEY を ScriptProperties に書き込む（同 key を以降の認証で使う）
 *   - シート初期化・トークン更新トリガー設定
 *
 * 注意: 初回はまだ ScriptProperties に WEBAPP_KEY が無いので、key 検証はスキップされる
 *       （v3 GAS の挙動: storedKey が空なら認証スキップ）
 */
export async function setConfig(
  endpoint: Omit<GasEndpoint, "key"> & { key?: string },
  params: { token: string; webappKey: string; webappUrl: string },
  opts: GasCallOptions = {}
) {
  return postToGas<{
    user_id: string;
    username: string;
    hasTrigger?: boolean;
    scriptTimeZone?: string;
    spreadsheetTimeZone?: string;
  }>(
    { url: endpoint.url, key: endpoint.key || params.webappKey },
    {
      action: "setConfig",
      token: params.token,
      webapp_key: params.webappKey,
      webapp_url: params.webappUrl,
    },
    { retries: opts.retries ?? 1, timeoutMs: opts.timeoutMs ?? 30_000 }
  );
}

export type PushPostInput = {
  webPostId: string;
  groupNo: number | null;
  text: string;
  postType: "standalone" | "thread";
  publishAtJst: string; // "YYYY-MM-DDTHH:mm"
  memo?: string;
  imageUrls?: string[]; // 添付画像の公開URL（カルーセル対応）。GAS側 MEDIA列(P)へ
};

/**
 * uploadMedia: 画像をbase64でGASに送り、Drive保存→公開直リンクを受け取る
 * （クラウドオフロード設定済みアカウントのみ。GASのdrive.fileスコープを使う）
 */
export async function uploadMedia(
  endpoint: GasEndpoint,
  params: { base64: string; mimeType: string; fileName: string; webPostId?: string }
) {
  return postToGas<{ driveFileId: string; publicUrl: string; altUrl?: string }>(
    endpoint,
    { action: "uploadMedia", ...params },
    { retries: 1, timeoutMs: 60_000 }
  );
}

/** GAS が画像のクリーンアップ（deleteMedia/pruneMedia）に対応した版か（v1.1.12以降） */
export function isGasMediaCleanupSupported(version: string | null | undefined): boolean {
  const current = parseWebappVersion(version);
  const min = [1, 1, 12];
  if (!current) return false;
  for (let i = 0; i < min.length; i++) {
    if (current[i] > min[i]) return true;
    if (current[i] < min[i]) return false;
  }
  return true;
}

/**
 * deleteMedia: 指定したDriveメディアをゴミ箱へ（画像×削除/投稿削除時のクリーンアップ）。
 * ベストエフォート（旧GASや失敗時は ok:false を返すが、呼び出し側は無視してよい）。
 */
export async function deleteMedia(endpoint: GasEndpoint, fileIds: string[]) {
  const ids = fileIds.filter(Boolean);
  if (ids.length === 0) return { ok: true, data: { trashed: 0 } };
  return postToGas<{ trashed: number; failed: string[] }>(
    endpoint,
    { action: "deleteMedia", fileIds: ids },
    { retries: 1, timeoutMs: 20_000 }
  );
}

/**
 * pruneMedia: メディアフォルダ内で keepIds に無い孤立ファイルをゴミ箱へ（既存の溜まり整理）。
 */
export async function pruneMedia(endpoint: GasEndpoint, keepIds: string[]) {
  return postToGas<{ trashed: number; kept: number }>(
    endpoint,
    { action: "pruneMedia", keepIds: keepIds.filter(Boolean) },
    { retries: 1, timeoutMs: 60_000 }
  );
}

export async function pushQueue(
  endpoint: GasEndpoint,
  posts: PushPostInput[]
) {
  return postToGas<{
    rows: number;
    startRow: number;
    webPostIds: string[];
  }>(endpoint, { action: "pushQueue", posts });
}

export type QueueVerificationRow = {
  webPostId: string;
  status: string;
  row: number;
};

export async function verifyQueueByPostIds(
  endpoint: GasEndpoint,
  webPostIds: string[]
) {
  if (webPostIds.length === 0) {
    return {
      ok: true,
      data: {
        present: [] as string[],
        missing: [] as string[],
        rows: [] as QueueVerificationRow[],
      },
    };
  }
  return postToGas<{
    present: string[];
    missing: string[];
    rows: QueueVerificationRow[];
  }>(endpoint, { action: "verifyQueueByPostIds", webPostIds });
}

export async function updateByPostId(
  endpoint: GasEndpoint,
  params: {
    webPostId: string;
    text?: string;
    publishAtJst?: string;
    postType?: "standalone" | "thread";
  }
) {
  return postToGas<{ row: number }>(endpoint, {
    action: "updateByPostId",
    ...params,
  });
}

export async function cancelByPostId(
  endpoint: GasEndpoint,
  webPostId: string
) {
  return postToGas<{ row: number }>(endpoint, {
    action: "cancelByPostId",
    webPostId,
  });
}

export type PullResultRow = {
  webPostId: string;
  status: "posted" | "error";
  threadsPostId: string | null;
  postUrl: string | null;
  postedAt: string | null;
  error: string | null;
  row: number;
};

export type PullResultsResponse = {
  version: string;
  results: PullResultRow[];
  count: number;
  tokenStatus: "ok" | "expiring_soon" | "failed";
  tokenExpiresAt: string | null;
  tokenFingerprint: string | null;
  tokenLastError: string | null;
  recentErrorCount24h: number;
};

export async function pullResults(endpoint: GasEndpoint) {
  return postToGas<PullResultsResponse>(endpoint, { action: "pullResults" });
}

export async function ackResults(endpoint: GasEndpoint, webPostIds: string[]) {
  if (webPostIds.length === 0) {
    return { ok: true, data: { acked: 0, missing: [] as string[] } };
  }
  return postToGas<{ acked: number; missing: string[] }>(endpoint, {
    action: "ackResults",
    webPostIds,
  });
}

/** Account から GasEndpoint を組み立てる（無効ならnull） */
export function endpointFromAccount(acc: {
  gasWebAppUrl: string | null;
  gasWebAppKey: string | null;
}): GasEndpoint | null {
  if (!acc.gasWebAppUrl || !acc.gasWebAppKey) return null;
  return { url: acc.gasWebAppUrl, key: acc.gasWebAppKey };
}

/** Account のトークンの fingerprint を計算（GAS側 healthCheck 結果と突合用） */
export function tokenFingerprintOf(token: string | null | undefined): string | null {
  if (!token || token.length < 12) return null;
  return token.substring(0, 8) + "…" + token.substring(token.length - 4);
}
