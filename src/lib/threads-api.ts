/**
 * Threads API ラッパー
 *
 * 設計方針:
 * - スレッド投稿は ■1 が成功した後に ■N で失敗しても、成功部分の情報を必ず返す
 *   （呼び出し側が threadsPostId を保存できるようにし、再投稿時の二重投稿を防止）
 * - "does not exist" 系の伝播ラグはThreads API側の不具合なのでリトライで吸収
 * - 永続エラー（権限・トークン・無効リクエスト）はリトライせず即諦める
 */

import { isPermanentError } from "./threads-errors";

const THREADS_API_BASE = "https://graph.threads.net/v1.0";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type PublishedItem = {
  index: number; // items配列内のindex
  threadsPostId: string;
  postUrl: string;
};

export type PublishResult = {
  ok: boolean;
  threadsPostId?: string;
  postUrl?: string;
  error?: string;
  // 部分成功情報（スレッド投稿で途中まで成功した場合に必ず入る）
  publishedItems?: PublishedItem[];
  // どのindexで失敗したか（0始まり、items配列内）
  failedAtIndex?: number;
  // 永続エラーか（true なら呼び出し側もリトライ不要）
  permanent?: boolean;
};

// メディアコンテナ作成（テキスト投稿）
async function createContainerOnce(
  userId: string,
  accessToken: string,
  text: string,
  replyToId?: string
): Promise<{ id: string } | { error: string }> {
  const params: Record<string, string> = {
    media_type: "TEXT",
    text,
    access_token: accessToken,
  };
  if (replyToId) params.reply_to_id = replyToId;

  try {
    const res = await fetch(`${THREADS_API_BASE}/${userId}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      return { error: data.error?.message || `HTTP ${res.status}` };
    }
    return { id: data.id };
  } catch (e) {
    return { error: String(e) };
  }
}

// リトライ付きコンテナ作成
async function createContainerWithRetry(
  userId: string,
  accessToken: string,
  text: string,
  replyToId?: string
): Promise<{ id: string } | { error: string; permanent: boolean }> {
  const waits = [15000, 30000, 60000]; // 1回目失敗→15s、2回目→30s、3回目→60s
  let lastError = "";
  for (let attempt = 0; attempt < waits.length + 1; attempt++) {
    const result = await createContainerOnce(
      userId,
      accessToken,
      text,
      replyToId
    );
    if ("id" in result) return result;
    lastError = result.error;
    if (isPermanentError(result.error)) {
      return { error: result.error, permanent: true };
    }
    if (attempt < waits.length) {
      console.log(
        `[threads-api] createContainer retry ${attempt + 1}/${waits.length} after ${waits[attempt] / 1000}s (error: ${result.error})`
      );
      await sleep(waits[attempt]);
    }
  }
  return { error: lastError, permanent: false };
}

// コンテナをパブリッシュ（リトライ付き）
async function publishContainerWithRetry(
  userId: string,
  accessToken: string,
  creationId: string
): Promise<{ id: string } | { error: string; permanent: boolean }> {
  const waits = [10000, 20000, 30000];
  let lastError = "";
  for (let attempt = 0; attempt < waits.length + 1; attempt++) {
    try {
      const res = await fetch(
        `${THREADS_API_BASE}/${userId}/threads_publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            creation_id: creationId,
            access_token: accessToken,
          }),
        }
      );
      const data = await res.json();
      if (res.ok && !data.error) return { id: data.id };
      lastError = data.error?.message || `HTTP ${res.status}`;
      if (isPermanentError(lastError)) {
        return { error: lastError, permanent: true };
      }
    } catch (e) {
      lastError = String(e);
    }
    if (attempt < waits.length) {
      console.log(
        `[threads-api] publishContainer retry ${attempt + 1}/${waits.length} after ${waits[attempt] / 1000}s (error: ${lastError})`
      );
      await sleep(waits[attempt]);
    }
  }
  return { error: lastError, permanent: false };
}

// コンテナステータス確認（公開前にFINISHEDを待つ）
// ERROR を返してきても1回はリトライ受け流し（混雑時の一時ERROR対策）
async function waitForContainer(
  containerId: string,
  accessToken: string,
  maxWait = 60000
): Promise<{ ok: true } | { ok: false; error: string }> {
  const start = Date.now();
  let errorSeen = 0;
  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(
        `${THREADS_API_BASE}/${containerId}?fields=status,error_message&access_token=${accessToken}`
      );
      const data = await res.json();
      if (data.status === "FINISHED") return { ok: true };
      if (data.status === "ERROR") {
        errorSeen++;
        if (errorSeen >= 2) {
          return {
            ok: false,
            error: data.error_message || "Container ERROR status",
          };
        }
        // 1回目のERRORは混雑時の一時状態として受け流す
      }
      // IN_PROGRESS / 一時ERROR — 待機
      await sleep(2000);
    } catch (e) {
      // ネットワーク一時エラーは継続
      console.log(`[threads-api] waitForContainer transient: ${e}`);
      await sleep(2000);
    }
  }
  return { ok: false, error: "Container did not become ready in time (60s)" };
}

/**
 * 単体投稿を公開する（リトライ付き）
 */
export async function publishStandalone(
  userId: string,
  accessToken: string,
  text: string
): Promise<PublishResult> {
  // 1. コンテナ作成（リトライ付き）
  const container = await createContainerWithRetry(userId, accessToken, text);
  if ("error" in container) {
    return { ok: false, error: container.error, permanent: container.permanent };
  }

  // 2. FINISHED を待つ（最大60s）
  const ready = await waitForContainer(container.id, accessToken);
  if (!ready.ok) {
    return { ok: false, error: ready.error };
  }

  // 3. パブリッシュ（リトライ付き）
  const published = await publishContainerWithRetry(
    userId,
    accessToken,
    container.id
  );
  if ("error" in published) {
    return { ok: false, error: published.error, permanent: published.permanent };
  }

  return {
    ok: true,
    threadsPostId: published.id,
    postUrl: `https://www.threads.net/@${userId}/post/${published.id}`,
  };
}

/**
 * スレッド投稿を公開する
 * - initialReplyTo を渡すと、items[0] からリプライとして投稿（部分成功からの再開用）
 * - 失敗時、それまでに成功した投稿の threadsPostId を publishedItems で返す
 */
export async function publishThread(
  userId: string,
  accessToken: string,
  items: string[],
  options?: { initialReplyTo?: string }
): Promise<PublishResult> {
  if (items.length === 0) {
    return { ok: false, error: "No items to publish" };
  }

  const publishedItems: PublishedItem[] = [];
  let lastPostId: string | undefined = options?.initialReplyTo;

  // ■1（または再開時の起点）の前にも軽くウェイト（混雑時間帯対策）
  await sleep(3000);

  for (let i = 0; i < items.length; i++) {
    // ■2以降: PUBLISHED後10秒バッファ（伝播ラグ対策）
    if (i > 0) {
      await sleep(10000);
    }

    // コンテナ作成（リトライ込み、最大165秒耐久）
    const container = await createContainerWithRetry(
      userId,
      accessToken,
      items[i],
      lastPostId
    );
    if ("error" in container) {
      return {
        ok: false,
        error: `Item ${i + 1}/${items.length} container failed: ${container.error}`,
        publishedItems,
        failedAtIndex: i,
        permanent: container.permanent,
      };
    }

    // FINISHED待ち（60秒）
    const ready = await waitForContainer(container.id, accessToken);
    if (!ready.ok) {
      return {
        ok: false,
        error: `Item ${i + 1}/${items.length} not ready: ${ready.error}`,
        publishedItems,
        failedAtIndex: i,
      };
    }

    // パブリッシュ（リトライ込み）
    const published = await publishContainerWithRetry(
      userId,
      accessToken,
      container.id
    );
    if ("error" in published) {
      return {
        ok: false,
        error: `Item ${i + 1}/${items.length} publish failed: ${published.error}`,
        publishedItems,
        failedAtIndex: i,
        permanent: published.permanent,
      };
    }

    publishedItems.push({
      index: i,
      threadsPostId: published.id,
      postUrl: `https://www.threads.net/@${userId}/post/${published.id}`,
    });
    lastPostId = published.id;
  }

  return {
    ok: true,
    threadsPostId: publishedItems[0].threadsPostId,
    postUrl: publishedItems[0].postUrl,
    publishedItems,
  };
}
