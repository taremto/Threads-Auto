/**
 * アカウント単位の Insights 取得オーケストレーション
 * （/api/insights/fetch と 日次cron の両方から呼ぶ）
 *
 * 流れ: 投稿一覧取得 → 各投稿のInsights取得 → Postキャッシュ更新 + PostInsight追記
 *       → Account.insightsEnabled 判定。権限エラーは degraded で縮退。
 */
import { prisma } from "@/lib/prisma";
import {
  fetchAllUserThreads,
  fetchPostInsights,
  ThreadsApiError,
} from "./threads-insights-api";
import { calcEr, percentile } from "./metrics";
import { labelPost } from "./knowledge-label";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type FetchResult = {
  ok: boolean;
  degraded: boolean;
  accountId: string;
  fetched: number;
  postsUpdated: number;
  snapshots: number;
  historical: number;
  error?: string;
};

export async function fetchAccountInsights(
  accountId: string,
  opts: { mode?: "recent" | "backfill" } = {}
): Promise<FetchResult> {
  const mode = opts.mode ?? "recent";
  const base: FetchResult = {
    ok: false,
    degraded: false,
    accountId,
    fetched: 0,
    postsUpdated: 0,
    snapshots: 0,
    historical: 0,
  };

  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) return { ...base, error: "account not found" };
  if (!account.accessToken)
    return { ...base, error: "アクセストークンが未設定です" };
  if (!account.threadsUserId)
    return { ...base, error: "Threads User ID が未取得です" };

  const token = account.accessToken;
  const userId = account.threadsUserId;
  const maxPages = mode === "backfill" ? 12 : 2;

  // 1. 投稿一覧
  let posts;
  try {
    const r = await fetchAllUserThreads(userId, token, { maxPages, limit: 50 });
    posts = r.posts;
  } catch (e) {
    if (e instanceof ThreadsApiError && e.permission) {
      await prisma.account.update({
        where: { id: accountId },
        data: { insightsEnabled: false, insightsLastFetchedAt: new Date() },
      });
      return { ...base, degraded: true, error: e.message };
    }
    return { ...base, error: String((e as Error)?.message || e) };
  }

  // 2. 各投稿のInsights取得
  type Row = {
    id: string;
    text: string;
    timestamp: string | null;
    permalink: string | null;
    views: number;
    likes: number;
    replies: number;
    reposts: number;
    quotes: number;
    er: number | null;
  };
  const rows: Row[] = [];
  let degraded = false;
  for (const p of posts) {
    try {
      const ins = await fetchPostInsights(p.id, token);
      const er = calcEr(ins.views, ins.likes, ins.replies, ins.reposts, ins.quotes);
      rows.push({
        id: String(p.id),
        text: p.text ?? "",
        timestamp: p.timestamp ?? null,
        permalink: p.permalink ?? null,
        ...ins,
        er,
      });
    } catch (e) {
      if (e instanceof ThreadsApiError && e.permission) {
        degraded = true;
        break;
      }
      // 一時エラーはスキップ（その投稿だけ落とす）
    }
    await sleep(50);
  }

  if (degraded) {
    await prisma.account.update({
      where: { id: accountId },
      data: { insightsEnabled: false, insightsLastFetchedAt: new Date() },
    });
    return { ...base, degraded: true, fetched: rows.length, error: "insights権限なし" };
  }

  // 3. P80（このバッチ内）→ ラベル付与（Postキャッシュ用。集計側は全体で再計算）
  const viewsArr = rows.map((r) => r.views).filter((v) => v > 0);
  const erArr = rows.map((r) => r.er).filter((e): e is number => e != null && e > 0);
  const p80Views = percentile(viewsArr, 0.8);
  const p80Er = percentile(erArr, 0.8);

  // 4. 既存Postにキャッシュ反映 ＋ PostInsight追記
  const ids = rows.map((r) => r.id);
  const matched = await prisma.post.findMany({
    where: { accountId, threadsPostId: { in: ids } },
    select: { id: true, threadsPostId: true },
  });
  const postIdByThreadsId = new Map<string, string>();
  for (const m of matched) {
    if (m.threadsPostId) postIdByThreadsId.set(m.threadsPostId, m.id);
  }

  let postsUpdated = 0;
  let snapshots = 0;
  let historical = 0;
  const now = new Date();
  for (const r of rows) {
    const label = labelPost(r.views, r.er, p80Views, p80Er);
    const internalPostId = postIdByThreadsId.get(r.id);

    if (internalPostId) {
      await prisma.post.update({
        where: { id: internalPostId },
        data: {
          lastViews: r.views,
          lastLikes: r.likes,
          lastReplies: r.replies,
          lastReposts: r.reposts,
          lastQuotes: r.quotes,
          lastEr: r.er,
          insightsFetchedAt: now,
          perfLabel: label,
        },
      });
      postsUpdated++;
    }

    // webapp外で投稿されたものも含め、全取得投稿を HistoricalPost(source="api") に反映。
    // これで内部Postと紐づかない投稿も分析画面に出る（集計は Post + HistoricalPost を見るため）。
    // 既存CSV行があれば metrics を更新しつつ、CSV由来の treeBody/treeCount/tag は温存する。
    await prisma.historicalPost.upsert({
      where: { accountId_threadsPostId: { accountId, threadsPostId: r.id } },
      create: {
        accountId,
        threadsPostId: r.id,
        postedAt: r.timestamp ? new Date(r.timestamp) : null,
        text: r.text,
        postUrl: r.permalink,
        views: r.views,
        likes: r.likes,
        replies: r.replies,
        reposts: r.reposts,
        quotes: r.quotes,
        er: r.er,
        perfLabel: label,
        source: "api",
      },
      update: {
        postedAt: r.timestamp ? new Date(r.timestamp) : null,
        text: r.text,
        postUrl: r.permalink,
        views: r.views,
        likes: r.likes,
        replies: r.replies,
        reposts: r.reposts,
        quotes: r.quotes,
        er: r.er,
        perfLabel: label,
        source: "api",
      },
    });
    historical++;

    await prisma.postInsight.create({
      data: {
        postId: internalPostId ?? null,
        accountId,
        threadsPostId: r.id,
        views: r.views,
        likes: r.likes,
        replies: r.replies,
        reposts: r.reposts,
        quotes: r.quotes,
        er: r.er ?? 0,
        fetchedAt: now,
      },
    });
    snapshots++;
  }

  await prisma.account.update({
    where: { id: accountId },
    data: { insightsEnabled: true, insightsLastFetchedAt: now },
  });

  return {
    ok: true,
    degraded: false,
    accountId,
    fetched: rows.length,
    postsUpdated,
    snapshots,
    historical,
  };
}

/** 全アカウントの直近Insights更新（cron用） */
export async function fetchAllAccountsInsights(): Promise<void> {
  const accounts = await prisma.account.findMany({
    where: {
      accessToken: { not: null },
      threadsUserId: { not: null },
      // 権限なしと判定済みのアカウントは無駄打ちしない
      NOT: { insightsEnabled: false },
    },
    select: { id: true, name: true },
  });
  for (const acc of accounts) {
    try {
      const r = await fetchAccountInsights(acc.id, { mode: "recent" });
      console.log(
        `[insights-cron] ${acc.name}: fetched=${r.fetched} updated=${r.postsUpdated} degraded=${r.degraded}`
      );
    } catch (e) {
      console.error(`[insights-cron] ${acc.name} error:`, e);
    }
    await sleep(500);
  }
}
