/**
 * Threads Graph API — 分析(Insights)取得レイヤー（GAS v9.1 から移植）
 * - 投稿一覧 / 投稿別Insights / リプライ(ツリー本文用)
 * - 権限不足はエラーメッセージから検知し、上位で縮退(degraded)させる
 */
import { isInsightsPermissionError } from "../threads-errors";

const THREADS_API_BASE = "https://graph.threads.net/v1.0";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ThreadsApiError extends Error {
  permission: boolean;
  constructor(message: string) {
    super(message);
    this.name = "ThreadsApiError";
    this.permission = isInsightsPermissionError(message);
  }
}

async function apiGet<T = unknown>(path: string, token: string): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${THREADS_API_BASE}/${path}${sep}access_token=${encodeURIComponent(
    token
  )}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new ThreadsApiError(`network: ${String(e)}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data && data.error)) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new ThreadsApiError(msg);
  }
  return data as T;
}

export type ThreadPost = {
  id: string;
  text?: string;
  timestamp?: string;
  permalink?: string;
};

type ThreadsListResponse = {
  data?: ThreadPost[];
  paging?: { cursors?: { after?: string } };
};

/** 投稿一覧を1ページ取得 */
export async function fetchUserThreads(
  userId: string,
  token: string,
  opts: { after?: string; limit?: number } = {}
): Promise<{ posts: ThreadPost[]; nextCursor?: string }> {
  const limit = opts.limit ?? 50;
  let path = `${userId}/threads?fields=id,text,timestamp,permalink&limit=${limit}`;
  if (opts.after) path += `&after=${encodeURIComponent(opts.after)}`;
  const json = await apiGet<ThreadsListResponse>(path, token);
  return {
    posts: json.data ?? [],
    nextCursor: json.paging?.cursors?.after,
  };
}

/**
 * 投稿一覧を全ページ取得（上限ページ数で打ち切り）
 * 大量アカウント保護のため maxPages を必ず指定
 */
export async function fetchAllUserThreads(
  userId: string,
  token: string,
  opts: { maxPages?: number; limit?: number; startAfter?: string } = {}
): Promise<{ posts: ThreadPost[]; nextCursor?: string; reachedEnd: boolean }> {
  const maxPages = opts.maxPages ?? 4;
  const out: ThreadPost[] = [];
  let after = opts.startAfter;
  let reachedEnd = false;
  for (let page = 0; page < maxPages; page++) {
    const { posts, nextCursor } = await fetchUserThreads(userId, token, {
      after,
      limit: opts.limit,
    });
    out.push(...posts);
    if (!nextCursor) {
      reachedEnd = true;
      after = undefined;
      break;
    }
    after = nextCursor;
    await sleep(100);
  }
  return { posts: out, nextCursor: after, reachedEnd };
}

export type PostInsightValues = {
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
};

type InsightsResponse = {
  data?: Array<{
    name?: string;
    values?: Array<{ value?: number }>;
    total_value?: { value?: number };
  }>;
};

const ZERO_INSIGHTS: PostInsightValues = {
  views: 0,
  likes: 0,
  replies: 0,
  reposts: 0,
  quotes: 0,
};

/** 投稿別Insights取得（views,likes,replies,reposts,quotes） */
export async function fetchPostInsights(
  postId: string,
  token: string
): Promise<PostInsightValues> {
  const json = await apiGet<InsightsResponse>(
    `${postId}/insights?metric=views,likes,replies,reposts,quotes`,
    token
  );
  const obj: Record<string, number> = {};
  for (const item of json.data ?? []) {
    if (!item.name) continue;
    const v =
      item.values && item.values.length > 0 && item.values[0].value != null
        ? item.values[0].value
        : item.total_value?.value;
    if (v != null) obj[item.name] = Number(v) || 0;
  }
  return {
    views: obj.views ?? 0,
    likes: obj.likes ?? 0,
    replies: obj.replies ?? 0,
    reposts: obj.reposts ?? 0,
    quotes: obj.quotes ?? 0,
  };
}

/** Insights取得（権限エラーは ZERO を返さず例外。それ以外の一時エラーは ZERO） */
export async function fetchPostInsightsSafe(
  postId: string,
  token: string
): Promise<PostInsightValues> {
  try {
    return await fetchPostInsights(postId, token);
  } catch (e) {
    if (e instanceof ThreadsApiError && e.permission) throw e;
    return { ...ZERO_INSIGHTS };
  }
}

export type ReplyItem = {
  id: string;
  text?: string;
  timestamp?: string;
  username?: string;
};

/** 投稿への直接リプライ一覧（ツリー本文の再構成用） */
export async function fetchDirectReplies(
  postId: string,
  token: string
): Promise<ReplyItem[]> {
  try {
    const json = await apiGet<{ data?: ReplyItem[] }>(
      `${postId}/replies?fields=id,text,timestamp,username&limit=100`,
      token
    );
    return json.data ?? [];
  } catch {
    return [];
  }
}

/**
 * ルート投稿から自分のリプライ連鎖を辿ってツリー本文を組み立てる
 * （GAS fetchTreeChain 相当）。戻りは ■2 以降の本文配列。
 */
export async function fetchTreeTexts(
  rootPostId: string,
  token: string,
  myUsername: string
): Promise<string[]> {
  const myLower = (myUsername || "").toLowerCase();
  if (!myLower) return [];
  const treeTexts: string[] = [];
  let currentPostId = rootPostId;
  for (let depth = 0; depth < 50; depth++) {
    const replies = await fetchDirectReplies(currentPostId, token);
    const mine = replies.filter(
      (r) => (r.username || "").toLowerCase() === myLower
    );
    if (mine.length === 0) break;
    mine.sort(
      (a, b) =>
        new Date(a.timestamp || 0).getTime() -
        new Date(b.timestamp || 0).getTime()
    );
    const next = mine[0];
    const text = (next.text || "").trim();
    if (text) treeTexts.push(text);
    currentPostId = String(next.id);
    await sleep(100);
  }
  return treeTexts;
}
