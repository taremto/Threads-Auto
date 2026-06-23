/**
 * best-hours.ts — アカウントの実データ（時間別パフォーマンス）から
 * 「設定した投稿枠のうち、実際に伸びている時間」を割り出す。
 *
 * 下書き生成時の推奨投稿時間に使う（buildRecommendedPostingPlan の preferred）。
 * insights route には依存せず、hourly 集計に必要な最小カラムだけを読む。
 * 並べ替えの純ロジックは rank-hours.ts（DB非依存・テスト対象）。
 */
import { prisma } from "@/lib/prisma";
import { aggregate, type AnalyticsItem } from "./aggregate";
import {
  rankPostingHoursByPerformance,
  type PreferredHours,
  type RankOptions,
} from "./rank-hours";

export type { PreferredHours } from "./rank-hours";

/**
 * アカウントの Post + HistoricalPost を読み、実績の良い投稿枠を返す。
 * hourly 集計に必要な最小カラムだけ取得（text/postUrl は不要なので空で埋める）。
 * データ不足や読込失敗時は呼び出し側で null フォールバックする想定。
 */
export async function computeAccountBestHours(
  accountId: string,
  postingHours: number[],
  opts: RankOptions = {}
): Promise<PreferredHours | null> {
  const [posts, historical] = await Promise.all([
    prisma.post.findMany({
      where: { accountId },
      select: {
        id: true,
        threadsPostId: true,
        status: true,
        postedAt: true,
        lastViews: true,
        lastLikes: true,
        lastReplies: true,
        lastReposts: true,
        lastQuotes: true,
        lastEr: true,
      },
    }),
    prisma.historicalPost.findMany({
      where: { accountId },
      select: {
        id: true,
        threadsPostId: true,
        postedAt: true,
        views: true,
        likes: true,
        replies: true,
        reposts: true,
        quotes: true,
        er: true,
      },
    }),
  ]);

  const internalThreadsIds = new Set(
    posts.map((p) => p.threadsPostId).filter((x): x is string => !!x)
  );

  const items: AnalyticsItem[] = [];
  for (const p of posts) {
    items.push({
      key: p.id,
      threadsPostId: p.threadsPostId,
      source: "post",
      status: p.status,
      postedAt: p.postedAt,
      text: "",
      postUrl: null,
      views: p.lastViews,
      likes: p.lastLikes,
      replies: p.lastReplies,
      reposts: p.lastReposts,
      quotes: p.lastQuotes,
      er: p.lastEr,
    });
  }
  for (const h of historical) {
    if (h.threadsPostId && internalThreadsIds.has(h.threadsPostId)) continue;
    items.push({
      key: h.id,
      threadsPostId: h.threadsPostId,
      source: "historical",
      status: "posted",
      postedAt: h.postedAt,
      text: "",
      postUrl: null,
      views: h.views,
      likes: h.likes,
      replies: h.replies,
      reposts: h.reposts,
      quotes: h.quotes,
      er: h.er,
    });
  }

  const { hourly } = aggregate(items);
  return rankPostingHoursByPerformance(hourly, postingHours, opts);
}
