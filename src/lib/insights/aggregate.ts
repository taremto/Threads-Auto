/**
 * 分析集計（Post + HistoricalPost をマージして AnalyticsPage 用の集計を作る）
 * - P80 閾値とラベルはデータ全体から都度再計算（GAS v9.1 と同じく成長追従）
 */
import { calcEr, jstDateKey, jstHour, timeBandFromDate, percentile, type TimeBand } from "./metrics";
import { labelPost, knowledgeThreshold, type PerfLabel } from "./knowledge-label";

export type AnalyticsItem = {
  key: string;
  threadsPostId: string | null;
  source: "post" | "historical";
  status?: string;
  postedAt: Date | null;
  text: string;
  postUrl: string | null;
  views: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  quotes: number | null;
  er: number | null;
};

export type LabeledPost = {
  key: string;
  threadsPostId: string | null;
  source: "post" | "historical";
  text: string;
  postUrl: string | null;
  postedAt: string | null;
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  er: number;
  label: PerfLabel;
};

const TIME_BANDS: TimeBand[] = ["朝", "昼", "夜", "深夜"];

export type AnalyticsResult = {
  totals: {
    posts: number;
    withInsights: number;
    views: number;
    likes: number;
    replies: number;
    reposts: number;
    quotes: number;
    avgViews: number;
    avgEr: number;
  };
  statusCounts: Record<string, number>;
  p80Views: number;
  p80Er: number;
  threshold: number;
  timeSeries: { date: string; views: number; er: number; count: number }[];
  timeBands: { band: TimeBand; avgEr: number; avgViews: number; count: number }[];
  hourly: { hour: number; avgEr: number; avgViews: number; count: number }[];
  topPosts: LabeledPost[];
  distribution: {
    views: number;
    er: number;
    label: PerfLabel;
    postUrl: string | null;
    text: string;
  }[];
  labeledPosts: LabeledPost[];
};

function effEr(it: AnalyticsItem): number | null {
  if (it.er != null && Number.isFinite(it.er)) return it.er;
  return calcEr(it.views, it.likes, it.replies, it.reposts, it.quotes);
}

export function aggregate(items: AnalyticsItem[]): AnalyticsResult {
  // ステータス内訳（Post由来のみ。Historicalは投稿済み扱いで posted に加算）
  const statusCounts: Record<string, number> = {};
  for (const it of items) {
    const st = it.source === "post" ? it.status || "unknown" : "posted";
    statusCounts[st] = (statusCounts[st] || 0) + 1;
  }

  // P80 計算（views>0 / er>0 のみ対象）
  const viewsArr: number[] = [];
  const erArr: number[] = [];
  for (const it of items) {
    const v = Number(it.views);
    if (Number.isFinite(v) && v > 0) viewsArr.push(v);
    const e = effEr(it);
    if (e != null && e > 0) erArr.push(e);
  }
  const p80Views = percentile(viewsArr, 0.8);
  const p80Er = percentile(erArr, 0.8);
  const threshold = knowledgeThreshold(p80Views);

  // 集計（インサイトあり=views>0）
  let withInsights = 0;
  let sumViews = 0,
    sumLikes = 0,
    sumReplies = 0,
    sumReposts = 0,
    sumQuotes = 0,
    sumEr = 0,
    erCount = 0;

  const dailyMap = new Map<string, { views: number; erSum: number; erCount: number; count: number }>();
  const bandMap = new Map<TimeBand, { erSum: number; erCount: number; views: number; count: number }>();
  const hourlyAcc = Array.from({ length: 24 }, () => ({
    erSum: 0,
    erCount: 0,
    views: 0,
    count: 0,
  }));
  const labeled: LabeledPost[] = [];
  const distribution: AnalyticsResult["distribution"] = [];

  for (const it of items) {
    const v = Number(it.views) || 0;
    const e = effEr(it);
    const label = labelPost(it.views, e, p80Views, p80Er);

    if (v > 0) {
      withInsights++;
      sumViews += v;
      sumLikes += Number(it.likes) || 0;
      sumReplies += Number(it.replies) || 0;
      sumReposts += Number(it.reposts) || 0;
      sumQuotes += Number(it.quotes) || 0;
      if (e != null) {
        sumEr += e;
        erCount++;
        distribution.push({
          views: v,
          er: e,
          label,
          postUrl: it.postUrl,
          text: it.text,
        });
      }
    }

    // 日次時系列・時間帯（postedAt + views必須）
    if (it.postedAt && v > 0) {
      const dk = jstDateKey(it.postedAt);
      const d = dailyMap.get(dk) || { views: 0, erSum: 0, erCount: 0, count: 0 };
      d.views += v;
      d.count++;
      if (e != null) {
        d.erSum += e;
        d.erCount++;
      }
      dailyMap.set(dk, d);

      const band = timeBandFromDate(it.postedAt);
      const b = bandMap.get(band) || { erSum: 0, erCount: 0, views: 0, count: 0 };
      b.views += v;
      b.count++;
      if (e != null) {
        b.erSum += e;
        b.erCount++;
      }
      bandMap.set(band, b);

      const ha = hourlyAcc[jstHour(it.postedAt)];
      ha.views += v;
      ha.count++;
      if (e != null) {
        ha.erSum += e;
        ha.erCount++;
      }
    }

    if (label) {
      labeled.push(toLabeled(it, v, e ?? 0, label));
    }
  }

  // トップ投稿（views降順）
  const topPosts = items
    .filter((it) => (Number(it.views) || 0) > 0)
    .map((it) => {
      const e = effEr(it) ?? 0;
      const label = labelPost(it.views, e, p80Views, p80Er);
      return toLabeled(it, Number(it.views) || 0, e, label);
    })
    .sort((a, b) => b.views - a.views)
    .slice(0, 20);

  const timeSeries = [...dailyMap.entries()]
    .map(([date, d]) => ({
      date,
      views: d.views,
      er: d.erCount > 0 ? Math.round((d.erSum / d.erCount) * 100) / 100 : 0,
      count: d.count,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const timeBands = TIME_BANDS.map((band) => {
    const b = bandMap.get(band);
    return {
      band,
      avgEr: b && b.erCount > 0 ? Math.round((b.erSum / b.erCount) * 100) / 100 : 0,
      avgViews: b && b.count > 0 ? Math.round(b.views / b.count) : 0,
      count: b ? b.count : 0,
    };
  });

  const hourly = hourlyAcc.map((h, hour) => ({
    hour,
    avgEr: h.erCount > 0 ? Math.round((h.erSum / h.erCount) * 100) / 100 : 0,
    avgViews: h.count > 0 ? Math.round(h.views / h.count) : 0,
    count: h.count,
  }));

  labeled.sort((a, b) => b.views - a.views);

  return {
    totals: {
      posts: items.length,
      withInsights,
      views: sumViews,
      likes: sumLikes,
      replies: sumReplies,
      reposts: sumReposts,
      quotes: sumQuotes,
      avgViews: withInsights > 0 ? Math.round(sumViews / withInsights) : 0,
      avgEr: erCount > 0 ? Math.round((sumEr / erCount) * 100) / 100 : 0,
    },
    statusCounts,
    p80Views,
    p80Er,
    threshold,
    timeSeries,
    timeBands,
    hourly,
    topPosts,
    distribution,
    labeledPosts: labeled,
  };
}

function toLabeled(
  it: AnalyticsItem,
  views: number,
  er: number,
  label: PerfLabel
): LabeledPost {
  return {
    key: it.key,
    threadsPostId: it.threadsPostId,
    source: it.source,
    text: it.text,
    postUrl: it.postUrl,
    postedAt: it.postedAt ? it.postedAt.toISOString() : null,
    views,
    likes: Number(it.likes) || 0,
    replies: Number(it.replies) || 0,
    reposts: Number(it.reposts) || 0,
    quotes: Number(it.quotes) || 0,
    er,
    label,
  };
}
